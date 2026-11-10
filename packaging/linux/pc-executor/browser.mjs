// The Josi browser extension's bridge for josi-pc.service: the Linux port of
// apps/windows-native/src/BrowserBridge.cs. A browser of the owner's Linux
// account links to this service through the native messaging host
// (josi-browser-host.mjs, which Chrome/Chromium/Brave/Edge/Firefox start), over
// a Unix socket only that account can open. The server's PC Control decides
// every read or action; this bridge hands approved work to the extension one
// command at a time and returns what it reports. Page content passes through
// to the server result and is not kept here.
//
// Where Windows asks the person in a dialog to allow a browser profile it has
// discovered, a server has no window: a profile is allowed by itself only when
// the host process runs as this service's own Linux account (checked in
// /proc), and the allowed profiles are kept 0600 in <stateDir>/browser-profiles.json.
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.heyjosi.browser';
export const CHROMIUM_EXTENSION_ID = 'peopadjeldgefmbfllgjgdndhabbagpl';
export const FIREFOX_EXTENSION_ID = 'josi-browser@heyjosi.com';
/** Store-assigned Chromium IDs; keep in step with BrowserHost.StoreExtensionIds
 * and chromiumStoreIds in apps/browser-extension/development-identity.json. */
export const STORE_EXTENSION_IDS = [];
export const MAX_FRAME = 200 * 1024;
const PEER_FRAME = 4096;
const SESSION_MS = 55000, COMMAND_MS = 20000, OBSERVATION_BYTES = 60000;
const UPLOAD_BYTES = 8 * 1024 * 1024, CHUNK_BYTES = 120 * 1024, PRESENCE_TABS = 30;
const ACTIONS = ['click', 'fill', 'photo', 'select', 'drag', 'scroll', 'upload'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = value => typeof value === 'string' && UUID.test(value);
const isInt = value => Number.isSafeInteger(value);
const str = value => typeof value === 'string' ? value : '';
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const validId = id => typeof id === 'string' && /^[a-p]{32}$/.test(id);

/** Every Chromium ID this bridge answers: development, store, and an operator
 * override file (<stateDir>/extension-ids.json, a JSON array of 32-letter IDs). */
export function chromiumExtensionIds(stateDir) {
  let extra = [];
  try {
    const file = join(stateDir, 'extension-ids.json');
    if (statSync(file).size <= 8192) {
      const list = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(list)) extra = list.filter(validId).slice(0, 16);
    }
  } catch { /* none */ }
  return [...new Set([CHROMIUM_EXTENSION_ID, ...STORE_EXTENSION_IDS, ...extra])];
}

/** The host manifests for a system-wide installation. `hostPath` is the
 * executable the browser starts (see nativeHostWrapper). Brave on Linux reads
 * Google Chrome's system folder, so one file serves both. */
export function nativeHostManifests(hostPath, { extensionIds = [CHROMIUM_EXTENSION_ID, ...STORE_EXTENSION_IDS] } = {}) {
  const ids = [...new Set(extensionIds.filter(validId))];
  const chromium = JSON.stringify({ name: HOST_NAME, description: 'Josi browser control', path: hostPath, type: 'stdio',
    allowed_origins: ids.map(id => `chrome-extension://${id}/`) }, null, 2) + '\n';
  const firefox = JSON.stringify({ name: HOST_NAME, description: 'Josi browser control', path: hostPath, type: 'stdio',
    allowed_extensions: [FIREFOX_EXTENSION_ID] }, null, 2) + '\n';
  return [
    '/etc/opt/chrome/native-messaging-hosts', // Google Chrome and Brave
    '/etc/chromium/native-messaging-hosts',
    '/etc/opt/edge/native-messaging-hosts',
  ].map(folder => ({ path: `${folder}/${HOST_NAME}.json`, json: chromium }))
    .concat([{ path: `/usr/lib/mozilla/native-messaging-hosts/${HOST_NAME}.json`, json: firefox }]);
}
/** A launcher for the manifests' `path`: browsers start it with no node on
 * their PATH, so it names the node binary; `exec` keeps the host's parent the browser. */
export function nativeHostWrapper(nodePath, scriptPath, stateDir = '/var/lib/josi-pc') {
  const q = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\nJOSI_PC_STATE=${q(stateDir)} exec ${q(nodePath)} ${q(scriptPath)} "$@"\n`;
}

// ------------------------------------------------------------- the peer

const deleted = path => path.replace(/ \(deleted\)$/, '');
function procStatus(pid, root) {
  const text = readFileSync(`${root}/${pid}/status`, 'utf8');
  const field = name => (text.match(new RegExp(`^${name}:\\s*(.*)$`, 'm')) ?? [])[1] ?? '';
  return { uids: field('Uid').split(/\s+/).map(Number), ppid: Number(field('PPid')) };
}
/** The browser family of an executable, or null. */
export function familyOf(path) {
  const name = basename(path).toLowerCase();
  if (name === 'msedge' || name === 'microsoft-edge') return 'edge';
  if (name === 'brave' || name === 'brave-browser') return 'brave';
  if (name.startsWith('chromium')) return 'chromium';
  if (name === 'chrome') return /chromium/i.test(path) ? 'chromium' : 'chrome';
  if (name === 'google-chrome' || name === 'google-chrome-stable') return 'chrome';
  if (name === 'firefox' || name === 'firefox-esr' || name === 'firefox-bin') return 'firefox';
  return null;
}
/** The host process runs as this service's account and is node (or the host script). */
export function sameUser(pid, uid, { root = '/proc', myUid = process.getuid?.(), hostScript } = {}) {
  if (!isInt(pid) || pid <= 1 || uid !== myUid || !isInt(myUid)) return false;
  try {
    const status = procStatus(pid, root);
    if (status.uids.length < 2 || status.uids.slice(0, 4).some(u => u !== myUid)) return false;
    const exe = deleted(readlinkSync(`${root}/${pid}/exe`));
    if (/^node(js)?(\d+)?$/.test(basename(exe))) return true;
    const argv = readFileSync(`${root}/${pid}/cmdline`, 'utf8').split('\0');
    return !!hostScript && argv.includes(hostScript);
  } catch { return false; }
}
/** The browser that started the host: its parent (a few levels up, for a launcher that does not exec). */
export function browserParent(pid, { root = '/proc', myUid = process.getuid?.() } = {}) {
  try {
    for (let depth = 0, at = pid; depth < 4; depth++) {
      const parent = procStatus(at, root).ppid;
      if (!isInt(parent) || parent <= 1) return null;
      const status = procStatus(parent, root);
      if (status.uids[0] !== myUid) return null;
      const exe = deleted(readlinkSync(`${root}/${parent}/exe`));
      const family = familyOf(exe);
      if (family) return { family, application: exe, processId: parent };
      at = parent;
    }
  } catch { /* gone */ }
  return null;
}
function defaultIdentify(peer, hostScript) {
  if (!sameUser(peer.pid, peer.uid, { hostScript })) return null;
  return browserParent(peer.pid);
}

// ------------------------------------------------------------ the bridge

function originOf(url) {
  try {
    const u = new URL(String(url ?? ''));
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && String(url).length <= 4096 ? u.origin : null;
  } catch { return null; }
}
function tabFrom(value, active) {
  const v = obj(value);
  if (!isInt(v.tabId) || v.tabId < 0) return null;
  const origin = originOf(v.url); if (!origin) return null;
  return { id: v.tabId, origin, title: str(v.title).slice(0, 300), active: !!active };
}
const describe = t => t ? `${t.id} ${t.origin} ${t.title} ${t.active}` : '';
const reply = (requestId, ok, payload) => ({ version: 1, requestId, ok, payload: payload ?? {} });
function refusal(code, extra = {}) { const e = new Error(code); e.code = code; e.extra = extra; e.browserRefusal = true; return e; }
const MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

/**
 * @param {object} options
 * @param {string} options.stateDir   folder for browser.sock and browser-profiles.json (0700)
 * @param {(...a)=>void} [options.log]
 * @param {()=>boolean} [options.isPaused]       true while josi-pc is paused: polls say paused, no command is handed out
 * @param {(path:string)=>boolean} [options.isProtected]  refuse uploads from these paths
 * @param {(peer:{pid,uid})=>({family,application}|null)} [options.identifyPeer]  tests only
 * @param {string} [options.socketPath]  default <stateDir>/browser.sock
 * @param {string} [options.application] the desktop presence's application (default process.execPath)
 */
export function createBrowserBridge({ stateDir, log = () => {}, isPaused = () => false, isProtected = () => false,
  identifyPeer, socketPath, application = process.execPath, hostScript = join(dirname(fileURLToPath(import.meta.url)), 'josi-browser-host.mjs') } = {}) {
  if (!stateDir) throw new Error('stateDir is required');
  const sock = socketPath ?? join(stateDir, 'browser.sock');
  const profilesFile = join(stateDir, 'browser-profiles.json');
  const identify = identifyPeer ?? (peer => defaultIdentify(peer, hostScript));
  const sockets = new Set();
  let server = null, link = null;

  // ---------------------------------------------------------- stored state
  function load() {
    try { const v = JSON.parse(readFileSync(profilesFile, 'utf8')); return { workspaceId: isUuid(v.workspaceId) ? v.workspaceId : null, profiles: Array.isArray(v.profiles) ? v.profiles : [] }; }
    catch { return { workspaceId: null, profiles: [] }; }
  }
  function save(state) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${profilesFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, profilesFile);
  }
  let stored = load();
  if (!stored.workspaceId) { stored.workspaceId = randomUUID(); try { save(stored); } catch (e) { log('browser: cannot save', profilesFile, e.message); } }
  const workspaceId = stored.workspaceId;

  const live = () => !!link && Date.now() - link.lastPoll < 10000;
  const session = () => ({ sessionId: link.sessionId, workspaceId, profileId: link.profileId, family: link.family,
    expiresAt: Date.now() + SESSION_MS, origins: [...link.origins], currentDesktop: true });
  function hide(pending) { if (pending) pending.shown = false; }
  function fail(pending, code) { if (!pending) return; hide(pending); pending.settle(false, { code }); }
  function endLink(code) { if (!link) return; fail(link.sent, code); fail(link.queued, code); link = null; }
  const findTab = id => link.active?.id === id ? link.active : link.tabs.find(t => t.id === id);

  // ------------------------------------------------ the host's operations
  function handle(owner, peer, request) {
    const r = obj(request), id = r.requestId, payload = obj(r.payload), operation = r.operation;
    if (r.version !== 1 || !isUuid(id)) throw new Error('format');
    if (operation === 'browser.hello') {
      const family = str(payload.family), nativeProfileId = payload.nativeProfileId, url = str(payload.url);
      const chromiumFamily = ['chrome', 'chromium', 'brave', 'edge'].includes(family);
      const knownExtension = family === 'firefox' ? payload.extensionId === FIREFOX_EXTENSION_ID
        : chromiumFamily && chromiumExtensionIds(stateDir).includes(payload.extensionId);
      const withTab = typeof payload.attachedTabId === 'number';
      if (!knownExtension || !isUuid(nativeProfileId) || !(withTab || payload.attachedTabId === null)
        || (withTab && (!isInt(payload.attachedTabId) || payload.attachedTabId < 0 || !originOf(url)))) return reply(id, false);
      // A Chromium extension in Firefox (or the reverse) is not this browser.
      if ((peer.family === 'firefox') !== (family === 'firefox')) return reply(id, false);
      stored = load();
      let known = stored.profiles.find(a => a.nativeProfileId === nativeProfileId && a.application === peer.application);
      if (!known) {
        // Windows asks the person; here the host is already proven to run as this account.
        if (!peer.verified) return reply(id, true, { profileDiscovered: true });
        known = { nativeProfileId, profileId: randomUUID(), browser: peer.family, application: peer.application, profile: 'Default', allowedAt: new Date().toISOString() };
        stored.profiles = stored.profiles.filter(a => a.nativeProfileId !== nativeProfileId).concat([known]);
        try { save(stored); } catch (e) { log('browser: cannot save', profilesFile, e.message); return reply(id, false); }
        log('browser: allowed', peer.family, 'profile', nativeProfileId, 'of', peer.application);
      }
      endLink('replaced');
      link = { owner, sessionId: randomUUID(), profileId: known.profileId, family, browser: peer.family, application: known.application,
        profile: known.profile || 'Default', url: withTab ? url : null, title: withTab ? str(payload.title).slice(0, 300) : null,
        tabId: withTab ? payload.attachedTabId : -1, origins: withTab ? [originOf(url)] : [], lastPoll: Date.now(), active: null, tabs: [], queued: null, sent: null };
      return reply(id, true, session());
    }
    if (operation === 'browser.chunk') {
      // Pieces of an approved upload's file, only for the command in flight.
      if (!link || link.owner !== owner || r.sessionId !== link.sessionId) return reply(id, false);
      const sent = link.sent;
      if (!sent?.file || payload.commandId !== sent.commandId || !isInt(payload.index)) return reply(id, false);
      const count = Math.ceil(sent.file.length / CHUNK_BYTES), index = payload.index;
      if (index < 0 || index >= count) return reply(id, false);
      const start = index * CHUNK_BYTES;
      return reply(id, true, { index, base64: sent.file.subarray(start, Math.min(start + CHUNK_BYTES, sent.file.length)).toString('base64'), last: index === count - 1 });
    }
    if (!link || link.owner !== owner || r.sessionId !== link.sessionId) return reply(id, false);
    const blocked = isPaused();
    if (operation === 'browser.poll') {
      link.lastPoll = Date.now();
      if (link.tabId >= 0) {
        // The extension reports the attached tab; a tab it no longer has detaches.
        if (payload.tabId === null || payload.tabId === undefined) { link.tabId = -1; link.url = link.title = null; }
        else {
          const origin = originOf(payload.url);
          if (origin && (payload.url !== link.url || str(payload.title) !== link.title)) {
            link.url = payload.url; link.title = str(payload.title).slice(0, 300);
            if (!link.origins.includes(origin) && link.origins.length < 128) link.origins.push(origin);
          }
        }
      }
      link.active = tabFrom(payload.active, true);
      link.tabs = (Array.isArray(payload.tabs) ? payload.tabs : []).map(t => tabFrom(t, obj(t).active === true)).filter(Boolean).slice(0, PRESENCE_TABS);
      let command = null;
      if (!blocked && link.queued && !link.sent) {
        link.sent = link.queued; link.queued = null; command = link.sent.command; link.sent.shown = true;
      }
      return reply(id, true, { session: session(), command, paused: blocked });
    }
    if (operation === 'browser.authorize') {
      const sent = link.sent, command = obj(payload.command), actual = payload.actual;
      // An attach names its tab in the command; everything else runs in the attached tab.
      const expectedTab = sent && 'tabId' in sent.command ? sent.command.tabId : link.tabId;
      const allowed = !blocked && sent && command.id === sent.commandId && command.kind === sent.command.kind
        && command.sessionId === link.sessionId && (actual === null || actual === undefined || obj(actual).tabId === expectedTab);
      if (!allowed) return reply(id, false);
      const authority = { commandId: sent.commandId, sessionId: link.sessionId, allowed: true };
      if (sent.value !== null) authority.value = sent.value;
      if (sent.file) authority.file = { name: sent.fileName, mediaType: sent.mediaType, size: sent.file.length, chunks: Math.ceil(sent.file.length / CHUNK_BYTES) };
      return reply(id, true, authority);
    }
    if (operation === 'browser.receipt') {
      const sent = link.sent;
      if (!sent || payload.commandId !== sent.commandId) return reply(id, false);
      link.sent = null; hide(sent);
      let ok = payload.outcome === 'observed_or_issued';
      const result = obj(payload.result);
      if (ok && sent.command.kind === 'attach') {
        // The tab the person approved is now the attached one.
        const origin = originOf(result.url);
        if (result.tabId !== sent.command.tabId || !origin || origin !== sent.command.origin) ok = false;
        else { link.tabId = result.tabId; link.url = result.url; link.title = str(result.title).slice(0, 300); if (!link.origins.includes(origin)) link.origins.push(origin); }
      }
      if (ok && sent.command.kind === 'openTab') {
        if (!isInt(result.tabId) || result.tabId < 0 || originOf(result.url) !== sent.command.origin) ok = false;
        else link.tabId = result.tabId;
      }
      if (ok && result.kind === 'observation' && originOf(result.url)) { link.url = result.url; link.title = str(result.title).slice(0, 300); }
      sent.settle(ok, ok ? payload.result : { code: str(payload.code) || 'not_verified' });
      return reply(id, true);
    }
    if (operation === 'browser.stop') { endLink('local_takeover'); return reply(id, true); }
    return reply(id, false);
  }

  // ------------------------------------------------------- the socket
  function serve(socket) {
    const owner = {};
    let peer = null, buffer = Buffer.alloc(0), dead = false;
    sockets.add(socket);
    const kill = () => { if (!dead) { dead = true; socket.destroy(); } };
    socket.on('data', chunk => {
      if (dead) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (!dead && buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (length <= 0 || length > (peer ? MAX_FRAME : PEER_FRAME)) return kill();
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length); buffer = buffer.subarray(4 + length);
        let message; try { message = JSON.parse(body.toString('utf8')); } catch { return kill(); }
        if (!peer) {
          const m = obj(message);
          if (m.kind !== 'peer') return kill();
          const found = identify({ pid: m.pid, uid: m.uid });
          if (!found || !found.family || !found.application) { log('browser: refused a host that is not a browser of this account'); return kill(); }
          peer = { family: found.family, application: found.application, verified: found.verified !== false };
          continue;
        }
        let answer; try { answer = handle(owner, peer, message); } catch { return kill(); }
        const out = Buffer.from(JSON.stringify(answer), 'utf8');
        const header = Buffer.alloc(4); header.writeInt32LE(out.length, 0);
        socket.write(Buffer.concat([header, out]));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { dead = true; sockets.delete(socket); if (link && link.owner === owner) endLink('connection_lost'); });
  }

  // ------------------------------------------------------- dispatch
  function loadUpload(pending, path, requirements) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || posix.normalize(path) !== path || path.endsWith('/')) return 'invalid_path';
    const folder = posix.dirname(path);
    const trim = v => v.length > 1 ? v.replace(/\/+$/, '') : v;
    if (!requirements.some(r => r?.action === 'folder.read' && trim(str(r?.scope?.target)) === folder)) return 'folder_not_approved';
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) return 'file_not_found';
      if (realpathSync(path) !== path) return 'invalid_path';
      if (isProtected(path) || path === stateDir || path.startsWith(stateDir + '/')) return 'protected_surface';
      if (stat.size === 0 || stat.size > UPLOAD_BYTES) return 'file_too_large';
      pending.file = readFileSync(path);
      if (pending.file.length === 0 || pending.file.length > UPLOAD_BYTES) return 'file_too_large';
    } catch (e) { return e?.code === 'ENOENT' ? 'file_not_found' : 'file_unreadable'; }
    pending.fileName = posix.basename(path);
    pending.mediaType = MEDIA[posix.extname(path).toLowerCase()] ?? 'application/octet-stream';
    return null;
  }

  async function run(claim, signal) {
    const payload = obj(claim?.payload), requirements = Array.isArray(claim?.requirements) ? claim.requirements : [];
    const scope = obj(requirements.find(r => r?.scope?.kind === 'browser')?.scope ?? requirements[0]?.scope);
    if (!live()) throw refusal('browser_not_linked');
    if (scope.application !== link.application || scope.profile !== link.profile) throw refusal('browser_changed');
    const target = str(scope.target), kind = payload.kind;
    if (originOf(target) !== target) throw refusal('invalid_site');
    const site = new URL(target).host;
    let resolve;
    const done = new Promise(r => { resolve = r; });
    const pending = { commandId: randomUUID(), value: null, file: null, shown: false, settled: false,
      settle(ok, value) { if (this.settled) return; this.settled = true; resolve({ ok, value }); } };
    const command = { id: pending.commandId, sessionId: link.sessionId, profileId: link.profileId, expiresAt: Date.now() + COMMAND_MS };
    if (kind === 'attach') {
      // The tab must still be open on the approved site.
      const tab = isInt(payload.tabId) ? findTab(payload.tabId) : null;
      if (!tab) throw refusal('tab_not_found');
      if (tab.origin !== target) throw refusal('attached_site_changed');
      if (!link.origins.includes(target)) link.origins.push(target);
      Object.assign(command, { kind: 'attach', tabId: tab.id, origin: target });
      pending.activity = `Attaching a tab on ${site}`;
    } else if (kind === 'open') {
      const url = str(payload.url);
      if (originOf(url) !== target || !url.startsWith('https://')) throw refusal('invalid_page');
      if (!link.origins.includes(target)) link.origins.push(target);
      // No tab attached: the page opens in a new tab, which becomes the attached one.
      Object.assign(command, { kind: link.tabId < 0 ? 'openTab' : 'openPage', url, origin: target, maxOutputBytes: OBSERVATION_BYTES });
      pending.activity = `Opening ${site}`;
    } else if (link.tabId < 0) throw refusal('no_attached_tab');
    else {
      // The approved site must still be the one in the attached tab.
      if (originOf(link.url) !== target) throw refusal('attached_site_changed');
      command.tabId = link.tabId;
      if (kind === 'read') {
        Object.assign(command, { kind: 'inspect', origin: target, maxOutputBytes: OBSERVATION_BYTES }); delete command.tabId;
        pending.activity = `Reading ${site}`;
      } else if (kind === 'download') {
        const url = str(payload.url);
        if (originOf(url) !== target || !url.startsWith('https://')) throw refusal('invalid_download');
        Object.assign(command, { kind: 'download', url }); pending.activity = `Downloading from ${site}`;
      } else if (ACTIONS.includes(kind)) {
        Object.assign(command, { kind, observationId: str(payload.observationId), elementId: str(payload.elementId) });
        if (kind === 'fill') pending.value = str(payload.text);
        if (kind === 'select') pending.value = str(payload.option);
        if (kind === 'drag') { if (!isUuid(payload.toElementId)) throw refusal('invalid_target'); command.toElementId = payload.toElementId; }
        if (kind === 'scroll') { command.deltaY = payload.direction === 'up' ? -1 : 1; command.maxOutputBytes = OBSERVATION_BYTES; }
        // A photo comes back with a fresh read of the page; leave room for both under the host frame size.
        if (kind === 'photo') command.maxOutputBytes = 163840;
        if (kind === 'upload') { const problem = loadUpload(pending, payload.path, requirements); if (problem) throw refusal(problem); }
        pending.activity = `${{ click: 'Clicking on', fill: 'Typing on', photo: 'Looking at a picture on', select: 'Choosing an option on', drag: 'Dragging on', scroll: 'Scrolling', upload: 'Uploading a file to' }[kind]} ${site}`;
      } else throw refusal('unsupported_operation');
    }
    pending.command = command;
    fail(link.queued, 'replaced'); link.queued = pending;
    log('browser:', pending.activity);
    // An upload streams its file in chunks; give it longer than a click.
    const timer = setTimeout(() => {
      if (link) { if (link.queued === pending) link.queued = null; if (link.sent === pending) link.sent = null; }
      hide(pending); pending.settle(false, { code: 'browser_not_responding' });
    }, COMMAND_MS + (pending.file ? 40000 : 10000));
    const onAbort = () => {
      if (link) { if (link.queued === pending) link.queued = null; if (link.sent === pending) link.sent = null; }
      fail(pending, 'control_stopped');
    };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const outcome = await done;
      if (!outcome.ok) throw refusal(outcome.value?.code ?? 'not_verified');
      return outcome.value;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); pending.file = null; pending.value = null; }
  }

  return {
    socketPath: sock,
    start() {
      if (server) return Promise.resolve();
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      if (!sock.startsWith('\\\\')) {
        try { if (lstatSync(sock).isSocket() || lstatSync(sock).isFile()) unlinkSync(sock); } catch { /* none */ }
      }
      return new Promise((resolve, reject) => {
        const s = createServer({ allowHalfOpen: false }, serve);
        s.once('error', reject);
        const umask = sock.startsWith('\\\\') ? null : process.umask(0o177);
        s.listen(sock, () => {
          if (umask !== null) process.umask(umask);
          try { if (!sock.startsWith('\\\\')) chmodSync(sock, 0o600); } catch { /* checked by the folder */ }
          s.off('error', reject); s.on('error', e => log('browser: socket error', e.message));
          server = s; log('browser: listening on', sock); resolve();
        });
      });
    },
    stop() {
      endLink('connection_lost');
      for (const s of sockets) s.destroy();
      const s = server; server = null;
      if (!s) return Promise.resolve();
      return new Promise(resolve => s.close(() => { try { if (!sock.startsWith('\\\\')) unlinkSync(sock); } catch { /* gone */ } resolve(); }));
    },
    /** The `browser` field of PUT /executor/presence. */
    presence() {
      if (!live()) return { family: 'desktop', application, profile: 'Default', origin: null, title: null };
      const attached = link.tabId >= 0;
      const browser = { family: link.browser, application: link.application, profile: link.profile,
        origin: attached ? originOf(link.url) : null, title: attached ? link.title : null,
        // Sites and titles only, so chat can name a tab and attach it; never paths or page content.
        tabs: link.tabs.map(t => ({ tabId: t.id, origin: t.origin, title: t.title, active: t.active })) };
      if (link.active) Object.assign(browser, { activeTabId: link.active.id, activeOrigin: link.active.origin, activeTitle: link.active.title });
      return browser;
    },
    handles: kind => typeof kind === 'string' && kind.length > 0 && !kind.startsWith('desktop.'),
    run,
    /** Control stopped or paused: queued and in-flight browser work fails. */
    pause() { if (link) { fail(link.queued, 'control_stopped'); fail(link.sent, 'control_stopped'); link.queued = link.sent = null; } },
    /** For status and tests. */
    state: () => ({ linked: live(), attached: live() && link.tabId >= 0, browser: live() ? link.browser : null, profiles: load().profiles.length }),
  };
}
