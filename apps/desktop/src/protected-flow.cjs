'use strict';
const { createNativeProtectedKeyBridge } = require('./protected-key.cjs');
const { createProtectedConfirmationSurface } = require('./protected-control.cjs');
const { isProtectedControlOrigin, parseProtectedHostChallenge, parseProtectedControlChallenge, protectedControlMessage } = require('@josi-ce/protocol');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sameIdentity = (a, b) => ['serverOrigin', 'serverId', 'userId', 'deviceId'].every(key => a[key] === b[key]);
const refused = () => new Error('Protected review is unavailable, expired or cancelled.');

/** The renderer supplies only a prepared review ID. All network paths, host
 * proof, wrapped material, exact presentation and commit receipt stay here. */
function createNativeProtectedFlow({ app, BrowserWindow, ipcMain, session, systemPreferences, parentWindow, connection }) {
  let flight = null, disposed = false;
  const surface = createProtectedConfirmationSurface({ BrowserWindow, ipcMain, session, systemPreferences, parentWindow,
    authenticateNative: async (challenge, signal) => {
      const entry = flight;
      if (!entry || signal.aborted || !entry.bridge || !entry.hostProof
        || protectedControlMessage(challenge) !== entry.message) throw refused();
      const value = await entry.request('projection', 'POST', { proof: entry.hostProof }, signal);
      entry.hostProof = null;
      if (!value?.projection) throw refused();
      entry.projection = value.projection;
      await entry.bridge.authenticate(challenge, entry.projection, signal);
    },
  });
  function cancel() {
    const entry = flight;
    entry?.controller.abort(); entry?.broker?.cancel(); entry?.bridge?.cancel();
    surface.cancel();
  }
  function available() {
    try {
      return !disposed && app.isPackaged && process.platform === 'darwin'
        && systemPreferences.canPromptTouchID() === true && isProtectedControlOrigin(connection()?.origin);
    } catch { return false; }
  }
  async function readResponse(response) {
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      await response.body?.cancel(); throw refused();
    }
    const reader = response.body?.getReader();
    if (!reader) throw refused();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) { await reader.cancel(); throw refused(); }
        chunks.push(Buffer.from(value));
      }
      const buffer = Buffer.concat(chunks);
      try { return JSON.parse(buffer.toString('utf8')); }
      finally { buffer.fill(0); }
    } finally { chunks.forEach(value => value.fill(0)); reader.releaseLock(); }
  }
  return Object.freeze({
    available, cancel, busy: () => !!flight,
    dispose() { disposed = true; cancel(); surface.dispose(); },
    async run(challengeId) {
      if (flight) return { status: 'unavailable', message: 'Another protected review is already open.' };
      if (!uuid(challengeId) || !available()) return { status: 'unavailable', message: 'Use the installed Josi app on a Mac with supported biometric authentication.' };
      const source = connection(), controller = new AbortController();
      if (!source?.session || typeof source.isCurrent !== 'function' || !source.isCurrent()) throw refused();
      const entry = { controller, bridge: null, broker: null, hostProof: null, projection: null, message: null, request: null };
      flight = entry;
      let commitSent = false;
      const timer = setTimeout(() => controller.abort(), 120_000); timer.unref();
      const live = () => {
        if (disposed || flight !== entry || controller.signal.aborted || !source.isCurrent()) throw refused();
      };
      entry.request = async (stage, method = 'GET', body, signal = controller.signal) => {
        live();
        if (!['host-challenge', 'current', 'presentation', 'projection', 'commit', 'cancel'].includes(stage)) throw refused();
        const headers = { Accept: 'application/json', Origin: source.origin };
        if (method === 'POST') {
          const cookies = await source.session.cookies.get({ url: `${source.origin}/api/admin/automation/protected/${challengeId}/${stage}`, name: 'josi_csrf' });
          if (cookies.length !== 1 || !/^[A-Za-z0-9_-]{16,256}$/.test(cookies[0].value)) throw refused();
          headers['Content-Type'] = 'application/json'; headers['x-josi-csrf'] = cookies[0].value;
        }
        live();
        if (stage === 'commit') commitSent = true; // Lost response is never a safe automatic retry.
        const response = await source.session.fetch(`${source.origin}/api/admin/automation/protected/${challengeId}/${stage}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'include', cache: 'no-store', redirect: 'error',
          signal: AbortSignal.any([controller.signal, signal, AbortSignal.timeout(10_000)]),
        });
        const value = await readResponse(response);
        live(); return value;
      };
      const abort = () => { entry.broker?.cancel(); entry.bridge?.cancel(); surface.cancel(); };
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        const { createProtectedConfirmationBroker } = await import('@josi-ce/automation');
        live();
        const publicResult = await entry.request('host-challenge');
        const host = parseProtectedHostChallenge(publicResult?.challenge);
        if (!host || host.id !== challengeId || host.serverOrigin !== source.origin) throw refused();
        const identity = { serverOrigin: host.serverOrigin, serverId: host.serverId, userId: host.userId, deviceId: host.deviceId };
        entry.bridge = createNativeProtectedKeyBridge(identity);
        entry.hostProof = await entry.bridge.proveHost(host, controller.signal);
        live();
        const result = await entry.request('presentation', 'POST', { proof: entry.hostProof });
        const challenge = parseProtectedControlChallenge(result?.challenge);
        if (!challenge || challenge.id !== challengeId || !sameIdentity(challenge, identity)
          || ['recordId', 'version', 'digest', 'epoch'].some(key => challenge.keyReference[key] !== host.keyReference[key])) throw refused();
        entry.message = protectedControlMessage(challenge);
        entry.broker = createProtectedConfirmationBroker(identity, {
          loadChallenge: async id => { live(); if (id !== challengeId) throw refused(); return challenge; },
          present: (value, signal, stop) => surface.present(value, signal, stop),
          authenticate: (value, signal) => surface.authenticate(value, signal),
          isCurrent: async (_value, signal) => (await entry.request('current', 'GET', undefined, signal))?.current === true,
          sign: async (value, message, signal) => {
            live();
            if (!entry.projection || Buffer.from(message).toString('utf8') !== entry.message) throw refused();
            try { return await entry.bridge.sign(value, entry.projection, signal); }
            finally { entry.projection = null; }
          },
        });
        const confirmation = await entry.broker.confirm(challengeId);
        live();
        if (confirmation.status !== 'confirmed') {
          try { await entry.request('cancel', 'POST', {}); } catch { /* The server's bounded review expires. */ }
          return { status: 'cancelled', message: 'No protected change was submitted. Start a new review when ready.' };
        }
        const committed = await entry.request('commit', 'POST', { receipt: confirmation.receipt });
        if (committed?.applied !== true || !['cardinal', 'permissions', 'devices'].includes(committed.kind)) throw refused();
        return { status: 'applied', message: 'The protected change was saved to the Vault.' };
      } catch {
        if (!commitSent && source.isCurrent() && !controller.signal.aborted) {
          try { await entry.request('cancel', 'POST', {}); } catch { /* Never replay a proof or fabricate cancellation. */ }
        }
        return commitSent
          ? { status: 'uncertain', message: 'The server response was not confirmed. Refresh current settings before starting another review; this change may have been saved.' }
          : { status: 'unavailable', message: 'The protected review could not finish. Check the selected device and current settings, then start a new review.' };
      } finally {
        clearTimeout(timer); controller.abort(); controller.signal.removeEventListener('abort', abort);
        entry.bridge?.cancel(); surface.cancel(); entry.hostProof = null; entry.projection = null; entry.message = null;
        if (flight === entry) flight = null;
      }
    },
  });
}
module.exports = { createNativeProtectedFlow };
