#!/usr/bin/env node
// Self-contained test of the browser bridge and the native host:
//   node test-browser.mjs
// Starts the bridge in a temporary state folder, runs the real
// josi-browser-host.mjs as the browser would, and speaks the extension's
// protocol through it. On Linux the host's account is checked in /proc for
// real; only "which browser started it" is stubbed (the test is its parent).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserParent, CHROMIUM_EXTENSION_ID, createBrowserBridge, familyOf, nativeHostManifests, nativeHostWrapper, sameUser } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HOST = join(here, 'josi-browser-host.mjs');
const linux = process.platform === 'linux';
const CHROME = '/opt/google/chrome/chrome';
const ORIGIN = `chrome-extension://${CHROMIUM_EXTENSION_ID}/`;
const state = mkdtempSync(join(tmpdir(), 'josi-browser-test-'));
const socketPath = linux ? join(state, 'browser.sock') : `\\\\.\\pipe\\josi-browser-test-${process.pid}`;
let passed = 0;
const ok = (name) => { passed++; console.log('ok', passed, '-', name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const logs = [], children = [];
let paused = false;
const bridge = createBrowserBridge({ stateDir: state, socketPath, log: (...a) => logs.push(a.join(' ')), isPaused: () => paused,
  // The real account check on Linux; the browser parent is stubbed because the test is the parent.
  identifyPeer: peer => (linux ? sameUser(peer.pid, peer.uid) : true) ? { family: 'chrome', application: CHROME } : null });

/** The extension's side: a host process and framed JSON over its stdin/stdout. */
function extension(args = [ORIGIN], env = {}) {
  const child = spawn(process.execPath, [HOST, ...args], { env: { ...process.env, JOSI_BROWSER_SOCK: socketPath, JOSI_PC_STATE: state, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let buffer = Buffer.alloc(0); const waiters = [];
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
      const n = buffer.readInt32LE(0); const body = JSON.parse(buffer.subarray(4, 4 + n).toString('utf8')); buffer = buffer.subarray(4 + n);
      waiters.shift()?.(body);
    }
  });
  const exited = new Promise(r => child.on('exit', code => r(code)));
  let sessionId = null;
  return {
    child, exited,
    set session(v) { sessionId = v; },
    async native(operation, payload = {}, session = sessionId) {
      const request = { version: 1, requestId: randomUUID(), operation, sessionId: session, payload };
      const body = Buffer.from(JSON.stringify(request)); const header = Buffer.alloc(4); header.writeInt32LE(body.length, 0);
      const reply = new Promise((resolve, reject) => { waiters.push(resolve); setTimeout(() => reject(new Error('no reply to ' + operation)), 5000); });
      child.stdin.write(Buffer.concat([header, body]));
      const r = await reply;
      assert.equal(r.version, 1); assert.equal(r.requestId, request.requestId);
      return r;
    },
  };
}
const claim = (payload, target = 'https://example.com', extra = {}) => ({ id: randomUUID(), payload,
  requirements: [{ action: 'browser.view', scope: { kind: 'browser', target, application: CHROME, profile: 'Default', ...extra } }] });
const quiet = p => { p.catch(() => {}); return p; };
const refusedWith = async (promise, code) => { await assert.rejects(promise, e => { assert.equal(e.code, code); assert.equal(e.browserRefusal, true); return true; }); };

try {
  // ------------------------------------------------------------- pure parts
  assert.equal(familyOf('/opt/google/chrome/chrome'), 'chrome');
  assert.equal(familyOf('/usr/lib/chromium/chromium'), 'chromium');
  assert.equal(familyOf('/usr/lib/chromium-browser/chromium-browser'), 'chromium');
  assert.equal(familyOf('/opt/brave.com/brave/brave'), 'brave');
  assert.equal(familyOf('/opt/microsoft/msedge/msedge'), 'edge');
  assert.equal(familyOf('/usr/lib/firefox-esr/firefox-esr'), 'firefox');
  assert.equal(familyOf('/usr/bin/bash'), null);
  const manifests = nativeHostManifests('/usr/lib/josi/josi-browser-host');
  assert.deepEqual(manifests.map(m => m.path), ['/etc/opt/chrome/native-messaging-hosts/com.heyjosi.browser.json',
    '/etc/chromium/native-messaging-hosts/com.heyjosi.browser.json', '/etc/opt/edge/native-messaging-hosts/com.heyjosi.browser.json',
    '/usr/lib/mozilla/native-messaging-hosts/com.heyjosi.browser.json']);
  assert.deepEqual(JSON.parse(manifests[0].json).allowed_origins, [ORIGIN]);
  assert.deepEqual(JSON.parse(manifests[3].json).allowed_extensions, ['josi-browser@heyjosi.com']);
  assert.match(nativeHostWrapper('/usr/lib/josi/node/bin/node', HOST), /^#!\/bin\/sh\nJOSI_PC_STATE='\/var\/lib\/josi-pc' exec '/);
  ok('browser families, manifests and the launcher');
  if (linux) {
    assert.equal(sameUser(process.pid, process.getuid()), true);
    assert.equal(sameUser(process.pid, process.getuid() + 1), false);
    assert.equal(sameUser(1, process.getuid()), false);
    assert.equal(browserParent(process.pid), null, 'the test was not started by a browser');
    ok('/proc: same account accepted, another uid refused, no browser parent found');
  }

  await bridge.start();
  if (linux) assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  ok('bridge listening' + (linux ? ' (socket 0600)' : ''));

  // ---------------------------------------------------------- not linked
  assert.deepEqual(bridge.presence(), { family: 'desktop', application: process.execPath, profile: 'Default', origin: null, title: null });
  assert.equal(bridge.handles('read'), true); assert.equal(bridge.handles('desktop.command'), false);
  await refusedWith(bridge.run(claim({ kind: 'read' })), 'browser_not_linked');
  ok('nothing linked: desktop presence, read refused with browser_not_linked');

  // -------------------------------------------------- the host's own checks
  const stranger = extension(['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']);
  assert.equal(await stranger.exited, 1);
  const away = extension([ORIGIN], { JOSI_BROWSER_SOCK: linux ? join(state, 'missing.sock') : '\\\\.\\pipe\\josi-missing-' + process.pid });
  assert.equal((await away.native('browser.hello', {})).ok, false);
  away.child.stdin.end(); assert.equal(await away.exited, 0);
  ok('host: unknown extension exits 1; no service answers ok:false; closing stdin exits 0');

  // --------------------------------------------------------------- hello
  const ext = extension();
  const nativeProfileId = randomUUID();
  const wrongId = await ext.native('browser.hello', { family: 'chrome', extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', nativeProfileId, attachedTabId: null }, null);
  assert.equal(wrongId.ok, false);
  const hello = await ext.native('browser.hello', { family: 'chrome', extensionId: CHROMIUM_EXTENSION_ID, nativeProfileId, attachedTabId: null }, null);
  assert.equal(hello.ok, true); assert.equal(hello.payload.currentDesktop, true); assert.equal(hello.payload.family, 'chrome');
  assert.deepEqual(hello.payload.origins, []); assert.ok(hello.payload.expiresAt > Date.now());
  ext.session = hello.payload.sessionId;
  const saved = JSON.parse(readFileSync(join(state, 'browser-profiles.json'), 'utf8'));
  assert.equal(saved.profiles.length, 1); assert.equal(saved.profiles[0].nativeProfileId, nativeProfileId); assert.equal(saved.profiles[0].application, CHROME);
  assert.equal(saved.workspaceId, hello.payload.workspaceId);
  if (linux) assert.equal(statSync(join(state, 'browser-profiles.json')).mode & 0o777, 0o600);
  ok('hello: unknown extension refused; this account\'s profile allowed by itself and saved 0600; standing link session');

  // ------------------------------------------------------ poll with tabs
  const tabs = [{ tabId: 7, url: 'https://example.com/shop?q=1', title: 'Shop', active: true }, { tabId: 9, url: 'https://news.example.org/a', title: 'News', active: false },
    { tabId: 11, url: 'chrome://settings', title: 'Settings', active: false }];
  const place = { url: null, title: null, tabId: null, active: { tabId: 7, url: tabs[0].url, title: 'Shop' }, tabs };
  let poll = await ext.native('browser.poll', place);
  assert.equal(poll.ok, true); assert.equal(poll.payload.command, null); assert.equal(poll.payload.paused, false);
  assert.equal(poll.payload.session.sessionId, hello.payload.sessionId);
  assert.deepEqual(bridge.presence(), { family: 'chrome', application: CHROME, profile: 'Default', origin: null, title: null,
    tabs: [{ tabId: 7, origin: 'https://example.com', title: 'Shop', active: true }, { tabId: 9, origin: 'https://news.example.org', title: 'News', active: false }],
    activeTabId: 7, activeOrigin: 'https://example.com', activeTitle: 'Shop' });
  ok('poll: presence names web tabs (sites and titles only) and the active tab; no origin until attached');

  await refusedWith(bridge.run(claim({ kind: 'read' })), 'no_attached_tab');
  await refusedWith(bridge.run(claim({ kind: 'read' }, 'https://example.com', { profile: 'Other' })), 'browser_changed');
  await refusedWith(bridge.run(claim({ kind: 'attach', tabId: 99 })), 'tab_not_found');
  ok('refusals: no_attached_tab, browser_changed, tab_not_found');

  // -------------------------------------------------------------- attach
  const attaching = bridge.run(claim({ kind: 'attach', tabId: 7 }));
  poll = await ext.native('browser.poll', place);
  const attach = poll.payload.command;
  assert.equal(attach.kind, 'attach'); assert.equal(attach.tabId, 7); assert.equal(attach.origin, 'https://example.com');
  assert.equal((await ext.native('browser.authorize', { command: attach, actual: { tabId: 8, windowId: 1, url: tabs[0].url } })).ok, false, 'another tab is refused');
  const authority = await ext.native('browser.authorize', { command: attach, actual: { tabId: 7, windowId: 1, url: tabs[0].url } });
  assert.deepEqual(authority.payload, { commandId: attach.id, sessionId: hello.payload.sessionId, allowed: true });
  assert.equal((await ext.native('browser.receipt', { commandId: attach.id, outcome: 'observed_or_issued', result: { kind: 'attached', tabId: 7, url: tabs[0].url, title: 'Shop' } })).ok, true);
  assert.deepEqual(await attaching, { kind: 'attached', tabId: 7, url: tabs[0].url, title: 'Shop' });
  assert.equal(bridge.presence().origin, 'https://example.com'); assert.equal(bridge.presence().title, 'Shop');
  ok('attach: queued, delivered on poll, wrong tab refused, authorized, receipt resolves; presence has the origin');

  // ---------------------------------------------------------------- read
  const attachedPlace = { ...place, url: tabs[0].url, title: 'Shop', tabId: 7 };
  const reading = bridge.run(claim({ kind: 'read' }));
  poll = await ext.native('browser.poll', attachedPlace);
  const inspect = poll.payload.command;
  assert.equal(inspect.kind, 'inspect'); assert.equal(inspect.origin, 'https://example.com'); assert.equal(inspect.maxOutputBytes, 60000);
  assert.equal(inspect.sessionId, hello.payload.sessionId); assert.equal(inspect.profileId, hello.payload.profileId); assert.equal('tabId' in inspect, false);
  assert.deepEqual(poll.payload.session.origins, ['https://example.com']);
  assert.equal((await ext.native('browser.authorize', { command: inspect, actual: { tabId: 7, windowId: 1, url: tabs[0].url } })).payload.allowed, true);
  const observation = { kind: 'observation', observationId: randomUUID(), url: 'https://example.com/shop?q=2', title: 'Shop page 2', text: 'Hello', elements: [], tabId: 7, windowId: 1 };
  await ext.native('browser.receipt', { commandId: inspect.id, outcome: 'observed_or_issued', result: observation });
  assert.deepEqual(await reading, observation);
  assert.equal(bridge.presence().title, 'Shop page 2');
  ok('read: inspect command on poll, authorize, receipt; run() resolves with the observation');

  // -------------------------------------------- fill value, failure, pause
  const filling = quiet(bridge.run(claim({ kind: 'fill', observationId: observation.observationId, elementId: randomUUID(), text: 'secret-ish text' })));
  poll = await ext.native('browser.poll', attachedPlace);
  assert.equal(poll.payload.command.kind, 'fill'); assert.equal(JSON.stringify(poll.payload.command).includes('secret-ish'), false, 'the value is not in the command');
  const fillAuthority = await ext.native('browser.authorize', { command: poll.payload.command, actual: { tabId: 7 } });
  assert.equal(fillAuthority.payload.value, 'secret-ish text');
  await ext.native('browser.receipt', { commandId: poll.payload.command.id, outcome: 'uncertain_or_denied', code: 'page_agent_missing', verificationRequired: true });
  await refusedWith(filling, 'page_agent_missing');
  paused = true;
  const waitingClick = quiet(bridge.run(claim({ kind: 'click', observationId: observation.observationId, elementId: randomUUID() })));
  poll = await ext.native('browser.poll', attachedPlace);
  assert.equal(poll.payload.paused, true); assert.equal(poll.payload.command, null);
  bridge.pause();
  await refusedWith(waitingClick, 'control_stopped');
  paused = false;
  const aborted = new AbortController();
  const scrolling = bridge.run(claim({ kind: 'scroll', observationId: observation.observationId, direction: 'up' }), aborted.signal);
  aborted.abort('lease');
  await refusedWith(scrolling, 'control_stopped');
  ok('fill value only in authorize; extension failure code returned; paused hands out nothing; pause() and abort fail the work');

  // -------------------------------------------------------------- upload
  const folder = mkdtempSync(join(tmpdir(), 'josi-upload-'));
  const file = join(folder, 'photo.jpg'); const bytes = Buffer.alloc(300 * 1024, 7); writeFileSync(file, bytes);
  const uploadClaim = claim({ kind: 'upload', observationId: observation.observationId, elementId: randomUUID(), path: file });
  if (linux) {
    await refusedWith(bridge.run(uploadClaim), 'folder_not_approved');
    uploadClaim.requirements.push({ action: 'folder.read', scope: { kind: 'folder', target: folder } });
    const uploading = bridge.run(uploadClaim);
    poll = await ext.native('browser.poll', attachedPlace);
    const up = poll.payload.command;
    const a = await ext.native('browser.authorize', { command: up, actual: { tabId: 7 } });
    assert.deepEqual(a.payload.file, { name: 'photo.jpg', mediaType: 'image/jpeg', size: bytes.length, chunks: 3 });
    const parts = [];
    for (let index = 0; index < 3; index++) {
      const piece = (await ext.native('browser.chunk', { commandId: up.id, index })).payload;
      assert.equal(piece.index, index); assert.equal(piece.last, index === 2); parts.push(Buffer.from(piece.base64, 'base64'));
    }
    assert.equal((await ext.native('browser.chunk', { commandId: up.id, index: 3 })).ok, false);
    assert.ok(Buffer.concat(parts).equals(bytes));
    await ext.native('browser.receipt', { commandId: up.id, outcome: 'observed_or_issued', result: { kind: 'uploaded', file: 'photo.jpg' } });
    assert.deepEqual(await uploading, { kind: 'uploaded', file: 'photo.jpg' });
    ok('upload: folder approval required; file streamed in 120 KB chunks and reassembled');
  }
  rmSync(folder, { recursive: true, force: true });

  // ------------------------------------------------------------- stop/close
  assert.equal((await ext.native('browser.stop', { reason: 'local_takeover' })).ok, true);
  assert.equal(bridge.presence().family, 'desktop');
  assert.equal((await ext.native('browser.poll', attachedPlace)).ok, false, 'the old session is gone');
  const again = await ext.native('browser.hello', { family: 'chrome', extensionId: CHROMIUM_EXTENSION_ID, nativeProfileId, attachedTabId: 7, url: tabs[0].url, title: 'Shop' }, null);
  assert.equal(again.ok, true); assert.equal(again.payload.profileId, hello.payload.profileId, 'the allowed profile is remembered');
  assert.deepEqual(again.payload.origins, ['https://example.com']);
  ext.session = again.payload.sessionId;
  await ext.native('browser.poll', attachedPlace);
  assert.equal(bridge.presence().origin, 'https://example.com');
  ext.child.stdin.end();
  assert.equal(await ext.exited, 0);
  await sleep(100);
  assert.equal(bridge.presence().family, 'desktop');
  await refusedWith(bridge.run(claim({ kind: 'read' })), 'browser_not_linked');
  ok('stop ends the link; hello with a tab relinks the same profile; host exits when stdin closes and the link ends');

  console.log(`\nall ${passed} passed on ${process.platform} (node ${process.version})`);
} catch (error) {
  console.error('FAILED:', error); console.error(logs.join('\n')); process.exitCode = 1;
} finally {
  for (const c of children) if (c.exitCode === null) c.kill();
  await bridge.stop();
  rmSync(state, { recursive: true, force: true });
}
