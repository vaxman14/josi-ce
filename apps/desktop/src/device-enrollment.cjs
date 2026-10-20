'use strict';
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createNativeProtectedKeyBridge } = require('./protected-key.cjs');
const { createProtectedConfirmationSurface } = require('./protected-control.cjs');
const { openLocalDeviceConsent } = require('./device-consent.cjs');
const { isProtectedControlOrigin, parseDeviceConsentChallenge, deviceConsentMessage } = require('@josi-ce/protocol');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sameIdentity = (a, b) => a && b && ['serverOrigin', 'serverId', 'userId', 'deviceId'].every(k => a[k] === b[k]);
const refused = () => new Error('Device enrollment is unavailable, expired or cancelled.');
async function responseJson(response) {
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel(); throw refused();
  }
  const reader = response.body?.getReader(), chunks = []; let size = 0;
  if (!reader) throw refused();
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) { await reader.cancel(); throw refused(); }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    try { return JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
  } finally { chunks.forEach(value => value.fill(0)); reader.releaseLock(); }
}

/** No enrollment material, possession signature, socket or approval method is
 * exposed to the CE page. Main owns the exact native review and final commit. */
function createDeviceEnrollmentFlow({ app, BrowserWindow, ipcMain, session, systemPreferences, dialog, parentWindow, connection }) {
  let flight = null, disposed = false;
  const surface = createProtectedConfirmationSurface({ BrowserWindow, ipcMain, session, systemPreferences,
    parentWindow, mode: 'enrollment',
    authenticateNative: async (challenge, signal) => {
      const entry = flight;
      if (!entry || signal.aborted || deviceConsentMessage(challenge) !== entry.message) throw refused();
      if (entry.mode === 'enroll') {
        if (!entry.bridge || !entry.material) throw refused();
        entry.possession = await entry.bridge.enrollmentProof(challenge.requestDigest, entry.material,
          challenge.id, challenge.expiresAtMs, signal);
      } else {
        await systemPreferences.promptTouchID('Approve the exact Josi device enrollment on this server Mac');
      }
    },
  });
  function cancel() { flight?.controller.abort(); flight?.bridge?.cancel(); flight?.local?.close(); surface.cancel(); }
  function available() {
    try { return !disposed && app.isPackaged && process.platform === 'darwin'
      && systemPreferences.canPromptTouchID() === true && isProtectedControlOrigin(connection()?.origin); }
    catch { return false; }
  }
  async function run(mode, input) {
    if (flight || !available()) return { status: 'unavailable', message: 'Use the installed Josi app and supported Touch ID, with no other protected review open.' };
    const source = connection(), controller = new AbortController();
    if (!source?.session || !source.isCurrent()) throw refused();
    const entry = { mode, controller, bridge: null, material: null, possession: null, local: null, message: null };
    flight = entry;
    let id = null, commitSent = false;
    const timer = setTimeout(() => controller.abort(), 120_000); timer.unref();
    const live = () => { if (disposed || flight !== entry || controller.signal.aborted || !source.isCurrent()) throw refused(); };
    const abort = () => { entry.bridge?.cancel(); entry.local?.close(); surface.cancel(); };
    controller.signal.addEventListener('abort', abort, { once: true });
    async function request(stage, method = 'GET', body) {
      live();
      if (!['begin', 'prepare', 'status', 'review', 'commit', 'cancel'].includes(stage) || stage !== 'begin' && !uuid(id)) throw refused();
      const url = `${source.origin}/api/admin/automation/devices/enroll/${stage === 'begin' ? 'begin' : `${id}/${stage}`}`;
      const headers = { Accept: 'application/json', Origin: source.origin };
      if (method === 'POST') {
        const cookies = await source.session.cookies.get({ url, name: 'josi_csrf' });
        if (cookies.length !== 1 || !/^[A-Za-z0-9_-]{16,256}$/.test(cookies[0].value)) throw refused();
        headers['Content-Type'] = 'application/json'; headers['x-josi-csrf'] = cookies[0].value;
      }
      live(); if (stage === 'commit') commitSent = true;
      const response = await source.session.fetch(url, { method, headers, credentials: 'include', cache: 'no-store', redirect: 'error',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      const value = await responseJson(response); live(); return value;
    }
    try {
      let challenge;
      if (mode === 'enroll') {
        if (!input || Object.keys(input).sort().join(',') !== 'label,mfaCode,password'
          || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 120
          || typeof input.password !== 'string' || !input.password || input.password.length > 4096
          || typeof input.mfaCode !== 'string' || input.mfaCode.length > 200) throw refused();
        const begin = await request('begin', 'POST', { label: input.label.trim() });
        const identity = begin?.identity;
        if (!uuid(begin?.attemptId) || !uuid(begin.enrollmentId) || !identity || identity.serverOrigin !== source.origin
          || ![identity.serverId, identity.userId, identity.deviceId].every(uuid)) throw refused();
        id = begin.attemptId;
        const answer = await dialog.showMessageBox(parentWindow(), { type: 'question', buttons: ['Cancel', 'Create device key'],
          defaultId: 0, cancelId: 0, noLink: true, message: `Enroll ${input.label.trim()} with Josi?`,
          detail: `Server: ${source.origin}\nAdministrator: ${identity.userId}\nYou will review the exact device and fingerprints next. The server Mac must also approve this enrollment. No automation permissions are granted.` });
        live(); if (answer.response !== 1) throw refused();
        entry.bridge = createNativeProtectedKeyBridge(identity);
        entry.material = await entry.bridge.createEnrollmentMaterial(controller.signal);
        live();
        const prepared = await request('prepare', 'POST', { material: entry.material, password: input.password, mfaCode: input.mfaCode });
        input.password = ''; input.mfaCode = '';
        challenge = parseDeviceConsentChallenge(prepared?.challenge);
        if (!challenge || challenge.id !== id || challenge.enrollmentId !== begin.enrollmentId || !sameIdentity(challenge, identity)
          || challenge.issuedAtMs > Date.now() || challenge.expiresAtMs <= Date.now()
          || createHash('sha256').update(deviceConsentMessage(challenge)).digest('hex') !== prepared.challengeDigest) throw refused();
        entry.local = await openLocalDeviceConsent({ id, identity, expiresAtMs: challenge.expiresAtMs,
          challengeDigest: prepared.challengeDigest }, controller.signal);
        if (entry.local && deviceConsentMessage(entry.local.challenge) !== deviceConsentMessage(challenge)) throw refused();
      } else {
        if (!uuid(input)) throw refused();
        id = input;
        const review = await request('review');
        if (!review?.identity || review.identity.serverOrigin !== source.origin || review.id !== id) throw refused();
        entry.local = await openLocalDeviceConsent(review, controller.signal);
        if (!entry.local) return { status: 'unavailable', message: 'Open this request in Josi on the Mac that runs this server, using the same administrator account.' };
        challenge = entry.local.challenge;
      }
      live(); entry.message = deviceConsentMessage(challenge);
      if (!await surface.present(challenge, controller.signal, () => controller.abort())) throw refused();
      live(); await surface.authenticate(challenge, controller.signal); live();
      // Recheck the live server/account/Vault after human review, before
      // publishing local consent. No UI result alone can enroll a device.
      if (mode === 'enroll') await request('status');
      else await request('review');
      if (entry.local) await entry.local.approve(challenge);
      if (mode === 'review') return { status: 'reviewed', message: 'Local approval sent. The target Mac must finish enrollment before its key is trusted.' };
      surface.waitingForServer();
      while (true) {
        const status = await request('status');
        if (status.state === 'approved') break;
        if (status.state !== 'waiting') throw refused();
        await delay(1000, undefined, { signal: controller.signal }); live();
      }
      const result = await request('commit', 'POST', { possessionSignature: entry.possession });
      if (result?.enrolled !== true || result.deviceId !== challenge.deviceId || result.enrollmentId !== challenge.enrollmentId) throw refused();
      return { status: 'enrolled', message: 'Device enrollment saved to the Vault. Automation permissions are managed separately.' };
    } catch {
      return commitSent
        ? { status: 'uncertain', message: 'The final server response was not confirmed. Refresh the device list before trying another enrollment.' }
        : { status: 'cancelled', message: 'Enrollment did not finish. Check that the server Mac approved it, then start a fresh attempt.' };
    } finally {
      if (input && typeof input === 'object') { input.password = ''; input.mfaCode = ''; }
      // Only the initiating session cancels the attempt. Closing a separate
      // server-side review must not silently erase another Mac's pending work.
      if (mode === 'enroll' && id && !commitSent && !controller.signal.aborted && source.isCurrent()) {
        try { await request('cancel', 'POST', {}); } catch { /* Attempt expires; no replay. */ }
      }
      clearTimeout(timer); controller.abort(); entry.bridge?.cancel(); entry.local?.close(); surface.cancel();
      entry.material = null; entry.possession = null; entry.message = null;
      if (flight === entry) flight = null;
    }
  }
  return Object.freeze({ available, busy: () => !!flight, cancel,
    enroll: input => run('enroll', input), review: id => run('review', id),
    dispose() { disposed = true; cancel(); surface.dispose(); },
  });
}
module.exports = { createDeviceEnrollmentFlow };
