'use strict';
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseProtectedControlChallenge, protectedControlMessage } = require('@josi-ce/protocol');
const { requireTrustedFrame } = require('./connection-policy.cjs');

const channels = Object.freeze({ state: 'josi:protected-state', decide: 'josi:protected-decide', changed: 'josi:protected-state-changed' });
const titles = Object.freeze({ 'cardinal.activate': 'Make this Cardinal Rule permanent',
  'cardinal.retire': 'Retire this Cardinal Rule', 'automation.policy.replace': 'Change automation permissions' });

/** Main-process ports for createProtectedConfirmationBroker. No renderer can
 * open a challenge, authenticate, access a key or sign. This is presentation
 * and local presence only; enrollment and the server's verification are separate. */
function createProtectedConfirmationSurface({ BrowserWindow, ipcMain, session, systemPreferences, parentWindow,
  platform = process.platform, clock = () => ({ wallMs: Date.now(), monotonicMs: performance.now() }) }) {
  const pageUrl = pathToFileURL(path.join(__dirname, 'protected-control.html')).href;
  const resourceUrls = new Set(['protected-control.html', 'protected-control.css', 'protected-control.js']
    .map(name => pathToFileURL(path.join(__dirname, name)).href));
  let active = null, disposed = false, authenticating = false;
  const available = () => {
    try { return platform === 'darwin' && systemPreferences.canPromptTouchID() === true; } catch { return false; }
  };
  function live(entry) {
    const now = clock();
    if (disposed || active !== entry || entry.signal.aborted || entry.window.isDestroyed()
      || entry.parent.isDestroyed() || !Number.isSafeInteger(now.wallMs) || !Number.isFinite(now.monotonicMs)
      || now.wallMs < entry.previous.wallMs || now.monotonicMs < entry.previous.monotonicMs
      || now.wallMs >= entry.challenge.expiresAtMs || now.monotonicMs >= entry.deadline) return false;
    entry.previous = now;
    return true;
  }
  function state(entry) {
    const c = entry.challenge;
    return { challengeId: c.id, title: titles[c.purpose], serverOrigin: c.serverOrigin, userId: c.userId, deviceId: c.deviceId,
      wording: c.presentation.wording, meaning: c.presentation.meaning, advisory: [...c.presentation.advisory],
      expiresAtMs: c.expiresAtMs, authenticationAvailable: available(), phase: entry.phase };
  }
  function update(entry) { if (live(entry)) entry.window.webContents.send(channels.changed, state(entry)); }
  function close(entry) {
    if (active !== entry) return;
    active = null;
    // Review/authentication may already have resolved. Invalidate the broker
    // through its final authority check and signing stage as well.
    entry.cancel();
    clearTimeout(entry.timer);
    entry.signal.removeEventListener('abort', entry.abort);
    entry.parent.removeListener('closed', entry.abort);
    entry.resolve(false);
    entry.rejectAuthentication?.(new Error('Protected confirmation cancelled.'));
    if (!entry.window.isDestroyed()) entry.window.destroy();
    // Unique nonpersistent session; never leave rule content in a cache.
    void entry.session.clearStorageData().catch(() => {});
    void entry.session.clearCache().catch(() => {});
  }
  function trusted(event) {
    const entry = active;
    if (!entry || !live(entry)) { if (entry) close(entry); throw new Error('Protected confirmation is unavailable.'); }
    requireTrustedFrame(event, entry.window, pageUrl, true);
    return entry;
  }
  ipcMain.handle(channels.state, event => state(trusted(event)));
  ipcMain.handle(channels.decide, (event, input) => {
    const entry = trusted(event);
    if (!input || Object.keys(input).sort().join(',') !== 'challengeId,decision' || input.challengeId !== entry.challenge.id
      || !['continue', 'cancel'].includes(input.decision)) throw new Error('Invalid protected confirmation response.');
    if (input.decision === 'cancel') { close(entry); return { accepted: false }; }
    if (entry.phase !== 'review' || !entry.window.isFocused() || !available()) throw new Error('Review the current confirmation on this Mac.');
    entry.phase = 'reviewed'; update(entry); entry.resolve(true);
    return { accepted: true }; // Review acknowledgement only, never OS proof.
  });

  return Object.freeze({
    present(value, signal, cancel) {
      if (disposed || active || authenticating || !signal || signal.aborted || typeof cancel !== 'function') return Promise.resolve(false);
      const challenge = parseProtectedControlChallenge(value), start = clock(), parent = parentWindow();
      if (!challenge || !parent || parent.isDestroyed() || !Number.isSafeInteger(start.wallMs)
        || !Number.isFinite(start.monotonicMs) || start.monotonicMs < 0 || challenge.issuedAtMs > start.wallMs
        || challenge.expiresAtMs <= start.wallMs) return Promise.resolve(false);
      const partition = `protected-${randomUUID()}`, isolated = session.fromPartition(partition, { cache: false });
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resourceUrls.has(details.url) }));
      isolated.on('will-download', event => event.preventDefault());
      const window = new BrowserWindow({ title: 'Josi — Protected confirmation', parent, modal: true,
        width: 760, height: 820, minWidth: 620, minHeight: 540, show: false, backgroundColor: '#10131a',
        fullscreenable: false, minimizable: false, autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'protected-control-preload.cjs'), partition,
          contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
          devTools: false, webviewTag: false, navigateOnDragDrop: false } });
      window.setMenu(null);
      return new Promise(resolve => {
        const entry = { challenge, message: protectedControlMessage(challenge), signal, cancel, window, parent, session: isolated,
          phase: 'review', previous: start, deadline: start.monotonicMs + challenge.expiresAtMs - start.wallMs,
          resolve, rejectAuthentication: null, timer: null, abort: null };
        active = entry;
        entry.abort = () => close(entry);
        entry.timer = setTimeout(entry.abort, challenge.expiresAtMs - start.wallMs); entry.timer.unref();
        signal.addEventListener('abort', entry.abort, { once: true });
        parent.once('closed', entry.abort);
        window.once('closed', entry.abort);
        window.once('ready-to-show', () => { if (live(entry)) { window.show(); window.focus(); } else close(entry); });
        window.webContents.on('will-navigate', event => { event.preventDefault(); close(entry); });
        window.webContents.on('will-redirect', event => { event.preventDefault(); close(entry); });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-attach-webview', event => { event.preventDefault(); close(entry); });
        window.webContents.on('render-process-gone', entry.abort);
        window.webContents.on('did-fail-load', (_event, _code, _description, _url, mainFrame) => { if (mainFrame) close(entry); });
        let loaded = false;
        window.webContents.on('did-start-navigation', (_event, url, _inPlace, mainFrame) => {
          if (!mainFrame) return;
          if (loaded || url !== pageUrl) close(entry);
          loaded = true;
        });
        if (signal.aborted) close(entry);
        else void window.loadURL(pageUrl).catch(entry.abort);
      });
    },
    async authenticate(value, signal) {
      const entry = active;
      if (!entry || !live(entry) || signal !== entry.signal || entry.phase !== 'reviewed' || authenticating
        || protectedControlMessage(value) !== entry.message || !entry.window.isFocused() || !available()) {
        if (entry) close(entry);
        throw new Error('Protected local authentication is unavailable.');
      }
      entry.phase = 'authenticating'; authenticating = true; update(entry);
      const cancelled = new Promise((_resolve, reject) => { entry.rejectAuthentication = reject; });
      // Never substitute a password collected in the renderer, ordinary dialog
      // or boolean IPC result. The system API must resolve successfully itself.
      const prompt = Promise.resolve().then(() => {
        if (!live(entry)) throw new Error('Protected confirmation cancelled.');
        return systemPreferences.promptTouchID(titles[entry.challenge.purpose]);
      }).finally(() => { authenticating = false; });
      try {
        const result = await Promise.race([prompt, cancelled]);
        if (result !== undefined || !live(entry)) throw new Error('Protected local authentication failed.');
        entry.phase = 'authenticated'; update(entry);
      } catch {
        close(entry);
        throw new Error('Protected local authentication failed.');
      } finally { entry.rejectAuthentication = null; }
    },
    cancel() { if (active) close(active); },
    dispose() {
      disposed = true;
      if (active) close(active);
      ipcMain.removeHandler(channels.state); ipcMain.removeHandler(channels.decide);
    },
  });
}

module.exports = { createProtectedConfirmationSurface };
