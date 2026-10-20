'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createProtectedConfirmationSurface } = require('../src/protected-control.cjs');

function fixture() {
  const handlers = new Map(), windows = [], partitions = [];
  let now = { wallMs: 10_000, monotonicMs: 50 }, auth = async () => {}, supported = true, prompts = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.focused = true;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' };
      this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
      this.webContents.send = (_channel, state) => { this.lastState = state; };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isFocused() { return this.focused; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    setMenu() {}
    show() {}
    focus() { this.focused = true; }
    async loadURL(url) {
      this.webContents.mainFrame.url = url;
      this.webContents.emit('did-start-navigation', {}, url, false, true);
      this.emit('ready-to-show');
    }
  }
  const parent = new Window({});
  const session = { fromPartition(name, options) {
    const isolated = new EventEmitter();
    isolated.webRequest = { onBeforeRequest: fn => { isolated.request = fn; } };
    isolated.setPermissionRequestHandler = fn => { isolated.permission = fn; };
    isolated.setPermissionCheckHandler = fn => { isolated.checkPermission = fn; };
    isolated.clearStorageData = async () => { isolated.cleared = true; };
    isolated.clearCache = async () => {};
    partitions.push({ name, options, isolated }); return isolated;
  } };
  const surface = createProtectedConfirmationSurface({ BrowserWindow: Window,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    session, systemPreferences: { canPromptTouchID: () => supported, promptTouchID: () => { prompts++; return auth(); } },
    parentWindow: () => parent, platform: 'darwin', clock: () => ({ ...now }) });
  const challenge = { schemaVersion: 1, id: randomUUID(), nonce: 'a'.repeat(43), serverOrigin: 'https://josi.example',
    serverId: randomUUID(), userId: randomUUID(), deviceId: randomUUID(), purpose: 'cardinal.activate', requestDigest: 'b'.repeat(64),
    keyReference: { recordId: randomUUID(), version: 1, digest: 'c'.repeat(64), epoch: 1 }, issuedAtMs: 9000, expiresAtMs: 20000,
    presentation: { wording: '<script>not executable</script>', meaning: 'Deny file deletion in this workspace.', advisory: ['Model advice only.'] } };
  const controller = new AbortController();
  const event = (window = windows.at(-1)) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const invoke = (channel, input, e = event()) => handlers.get(`josi:protected-${channel}`)(e, input);
  const review = () => invoke('decide', { challengeId: challenge.id, decision: 'continue' });
  return { surface, challenge, controller, windows, partitions, parent, event, invoke, review, handlers,
    setAuth: fn => { auth = fn; }, unsupported: () => { supported = false; }, time: value => { now = value; }, prompts: () => prompts };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('review and OS authentication are separate; only the protected main frame may review', async () => {
  const f = fixture(), shown = f.surface.present(f.challenge, f.controller.signal, () => f.controller.abort()), window = f.windows.at(-1);
  const prefs = window.options.webPreferences;
  assert.deepEqual([prefs.contextIsolation, prefs.sandbox, prefs.nodeIntegration, prefs.devTools, prefs.webviewTag], [true, true, false, false, false]);
  assert.equal(f.invoke('state').wording, '<script>not executable</script>');
  assert.throws(() => f.invoke('state', null, f.event(f.parent)));
  assert.throws(() => f.invoke('state', null, { ...f.event(), senderFrame: { ...window.webContents.mainFrame } }));
  assert.throws(() => f.invoke('decide', { challengeId: f.challenge.id, decision: 'continue', authenticated: true }));
  window.focused = false; assert.throws(f.review); window.focused = true;
  assert.deepEqual(f.review(), { accepted: true }); assert.equal(await shown, true); assert.equal(f.prompts(), 0);
  assert.throws(f.review);
  await f.surface.authenticate(f.challenge, f.controller.signal);
  assert.equal(f.prompts(), 1); assert.equal(window.lastState.phase, 'authenticated');
  // The local Cancel control remains connected after authentication resolves,
  // through any later server verification or signing in the broker.
  f.invoke('decide', { challengeId: f.challenge.id, decision: 'cancel' });
  assert.equal(f.controller.signal.aborted, true); assert.equal(window.isDestroyed(), true); f.surface.dispose();
});

test('the dedicated session has no network, permissions, downloads or external windows', async () => {
  const f = fixture(), shown = f.surface.present(f.challenge, f.controller.signal, () => f.controller.abort()), window = f.windows.at(-1);
  const { name, options, isolated } = f.partitions[0];
  assert(!name.startsWith('persist:')); assert.equal(options.cache, false);
  assert.equal(isolated.checkPermission(), false);
  isolated.permission({}, 'media', allowed => assert.equal(allowed, false));
  for (const url of ['https://josi.example', 'file:///private/secret', 'data:text/html,hello', `${window.webContents.mainFrame.url}?changed`]) {
    isolated.request({ url }, response => assert.equal(response.cancel, true));
  }
  isolated.request({ url: window.webContents.mainFrame.url }, response => assert.equal(response.cancel, false));
  let blocked = false; isolated.emit('will-download', { preventDefault: () => { blocked = true; } }); assert(blocked);
  assert.deepEqual(window.openHandler({ url: 'https://josi.example' }), { action: 'deny' });
  f.surface.cancel(); assert.equal(await shown, false); assert.equal(isolated.cleared, true); f.surface.dispose();
});

test('unsupported OS presence has no ordinary-dialog or renderer-boolean fallback', async () => {
  const f = fixture(); f.unsupported();
  const shown = f.surface.present(f.challenge, f.controller.signal, () => f.controller.abort());
  assert.equal(f.invoke('state').authenticationAvailable, false); assert.throws(f.review);
  await assert.rejects(f.surface.authenticate(f.challenge, f.controller.signal));
  assert.equal(await shown, false); assert.equal(f.prompts(), 0); f.surface.dispose();
  const g = fixture(); g.setAuth(async () => true);
  const displayed = g.surface.present(g.challenge, g.controller.signal, () => g.controller.abort()); g.review(); await displayed;
  await assert.rejects(g.surface.authenticate(g.challenge, g.controller.signal)); g.surface.dispose();
});

test('cancelled system prompts cannot finish a challenge or overlap a new prompt', async () => {
  const f = fixture(); let finish;
  f.setAuth(() => new Promise(resolve => { finish = resolve; }));
  const shown = f.surface.present(f.challenge, f.controller.signal, () => f.controller.abort()); f.review(); await shown;
  const authentication = assert.rejects(f.surface.authenticate(f.challenge, f.controller.signal));
  await tick(); f.controller.abort(); await authentication;
  assert.equal(await f.surface.present({ ...f.challenge, id: randomUUID() }, new AbortController().signal, () => {}), false);
  finish(); await tick(); assert.equal(f.windows.at(-1).isDestroyed(), true);
  const next = f.surface.present({ ...f.challenge, id: randomUUID() }, new AbortController().signal, () => {});
  f.surface.cancel(); assert.equal(await next, false); f.surface.dispose();
});

test('a changed challenge or another AbortSignal cannot inherit reviewed presence', async () => {
  for (const changed of ['meaning', 'signal']) {
    const f = fixture(), shown = f.surface.present(f.challenge, f.controller.signal, () => f.controller.abort()); f.review(); await shown;
    const value = structuredClone(f.challenge); if (changed === 'meaning') value.presentation.meaning = 'Changed meaning';
    await assert.rejects(f.surface.authenticate(value, changed === 'signal' ? new AbortController().signal : f.controller.signal));
    assert.equal(f.prompts(), 0); f.surface.dispose();
  }
});

test('source mutation cannot change the displayed challenge; invalid inputs never open a window', async () => {
  const f = fixture(), original = structuredClone(f.challenge), shown = f.surface.present(f.challenge, f.controller.signal, () => f.controller.abort());
  f.challenge.presentation.wording = 'Changed after display';
  assert.equal(f.invoke('state').wording, original.presentation.wording);
  f.surface.cancel(); await shown;
  for (const value of [{ ...original, extra: true }, { ...original, serverOrigin: 'http://remote.example' }, { ...original, expiresAtMs: 10000 }]) {
    assert.equal(await f.surface.present(value, f.controller.signal, () => f.controller.abort()), false);
  }
  assert.equal(f.windows.length, 2); f.surface.dispose();
});

test('expiry and clock rollback invalidate a reviewed request before authentication', async () => {
  for (const now of [{ wallMs: 20000, monotonicMs: 51 }, { wallMs: 9999, monotonicMs: 51 }, { wallMs: 10001, monotonicMs: 49 }, { wallMs: 10001, monotonicMs: 10050 }]) {
    const f = fixture(), shown = f.surface.present(f.challenge, f.controller.signal, () => f.controller.abort()); f.review(); await shown; f.time(now);
    await assert.rejects(f.surface.authenticate(f.challenge, f.controller.signal)); assert.equal(f.prompts(), 0); f.surface.dispose();
  }
});

test('close, reconnect cancellation, parent loss, reload, crash and disposal invalidate pending review', async () => {
  for (const operation of ['close', 'cancel', 'parent', 'reload', 'crash', 'dispose']) {
    const f = fixture(), shown = f.surface.present(f.challenge, f.controller.signal, () => f.controller.abort()), window = f.windows.at(-1);
    if (operation === 'close') window.destroy();
    if (operation === 'cancel') f.surface.cancel();
    if (operation === 'parent') f.parent.destroy();
    if (operation === 'reload') window.webContents.emit('did-start-navigation', {}, window.webContents.mainFrame.url, false, true);
    if (operation === 'crash') window.webContents.emit('render-process-gone');
    if (operation === 'dispose') f.surface.dispose();
    assert.equal(await shown, false); assert(window.isDestroyed()); assert.equal(f.prompts(), 0); f.surface.dispose();
    assert.equal(f.handlers.size, 0);
  }
});

test('one presentation at a time and only a live parent can own the window', async () => {
  const f = fixture(), shown = f.surface.present(f.challenge, f.controller.signal, () => f.controller.abort());
  assert.equal(await f.surface.present({ ...f.challenge, id: randomUUID() }, f.controller.signal, () => f.controller.abort()), false);
  f.parent.destroy(); assert.equal(await shown, false);
  assert.equal(await f.surface.present(f.challenge, f.controller.signal, () => f.controller.abort()), false); f.surface.dispose();
});
