'use strict';
const { app, BrowserWindow, Menu, ipcMain, session, dialog, shell, clipboard, Notification, systemPreferences } = require('electron');
const { randomUUID } = require('node:crypto');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { assertAllowedJosiCeUrl, sameOrigin, internalRoute, requireTrustedFrame } = require('./connection-policy.cjs');
const { LocalWorkspaceBroker } = require('./local-workspace.cjs');
const { createProtectedConfirmationSurface } = require('./protected-control.cjs');
const { LocalServer } = require('./local-server.cjs');
const { negotiateCapabilities } = require('@josi-ce/protocol');

// Development never opens the installed client's data. Until P2 supplies vault
// projections, CE session cookies and selected-folder grants are memory-only.
if (!app.isPackaged) app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'josi-unified-dev-')));
if (app.isPackaged && !app.requestSingleInstanceLock()) app.exit(0);
const shellUrl = pathToFileURL(path.join(__dirname, 'shell.html')).href;
let window = null;
let expectedOrigin = null;
let lastError = '';
let connectionGeneration = 0;
let workspace = null;
let currentSession = null;
let currentSessionOrigin = null;
let localServer = null;
let statusRequest = null;
// Main-process-only ports. No remote renderer/guest IPC can open a protected
// challenge. Enrollment and the authenticated server challenge source must be
// installed before the broker can use these ports to produce any receipt.
const protectedConfirmation = createProtectedConfirmationSurface({ BrowserWindow, ipcMain, session,
  systemPreferences, parentWindow: () => window });

function discardConnection(clearSession = true) {
  protectedConfirmation.cancel();
  workspace = null;
  if (clearSession && currentSession) {
    const previous = currentSession;
    currentSession = null;
    currentSessionOrigin = null;
    void previous.clearStorageData().catch(() => {});
  }
}

function replaceWindow(preload, partition, isolated) {
  const previous = window && !window.isDestroyed() ? window : null;
  const next = new BrowserWindow({
    title: 'Josi', width: 1120, height: 780, minWidth: 620, minHeight: 520,
    backgroundColor: '#10131a', show: false,
    webPreferences: { preload: path.join(__dirname, preload), ...(isolated ? { session: isolated } : { partition }),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window = next;
  next.once('ready-to-show', () => { if (!next.isDestroyed()) next.show(); });
  next.on('closed', () => { if (window === next) window = null; });
  if (previous) previous.destroy();
  return next;
}

function showShell(message = '') {
  connectionGeneration += 1;
  expectedOrigin = null;
  discardConnection(false);
  lastError = message;
  const next = replaceWindow('shell-preload.cjs', `shell-${randomUUID()}`);
  next.webContents.on('will-navigate', event => event.preventDefault());
  next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void next.loadURL(shellUrl);
}

async function confirmExternal(url, parent) {
  let candidate;
  try { candidate = new URL(url); } catch { return; }
  if (candidate.protocol !== 'https:' || candidate.username || candidate.password || parent.isDestroyed()) return;
  const choice = await dialog.showMessageBox(parent, { type: 'question',
    message: 'Open this site in your browser?', detail: candidate.origin,
    buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0, noLink: true });
  if (choice.response === 1 && !parent.isDestroyed()) await shell.openExternal(candidate.href);
}

async function connect(value, { local = false, route = '/' } = {}) {
  const origin = assertAllowedJosiCeUrl(value);
  connectionGeneration += 1;
  const generation = connectionGeneration;
  discardConnection(currentSessionOrigin !== origin);
  expectedOrigin = origin;
  const values = new Map();
  const store = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const isolated = currentSession || session.fromPartition(`ce-${randomUUID()}`); // memory only until Vault-backed sessions
  currentSession = isolated;
  currentSessionOrigin = origin;
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  let target = origin + route;
  if (local) {
    try {
      const setupRoute = await localServer.prepareConnection(isolated, origin);
      if (setupRoute !== '/') target = origin + setupRoute;
    } catch (error) {
      if (generation === connectionGeneration) showShell(error.message);
      return;
    }
    if (generation !== connectionGeneration) return;
  }
  const next = replaceWindow('direct-preload.cjs', undefined, isolated);
  const isCurrent = () => generation === connectionGeneration && !next.isDestroyed()
    && sameOrigin(next.webContents.getURL(), origin);
  const scopedDialog = {
    showOpenDialog: async (...args) => {
      const result = await dialog.showOpenDialog(...args);
      return isCurrent() ? result : { canceled: true, filePaths: [] };
    },
    showMessageBox: async (...args) => {
      const result = await dialog.showMessageBox(...args);
      return isCurrent() ? result : { response: 0 };
    },
  };
  workspace = new LocalWorkspaceBroker({ store, dialog: scopedDialog, parentWindow: () => next, record: () => {} });
  const guardNavigation = (event, url) => {
    if (sameOrigin(url, origin)) return;
    event.preventDefault();
  };
  next.webContents.on('will-navigate', guardNavigation);
  next.webContents.on('will-redirect', guardNavigation);
  next.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url, origin)) void next.loadURL(url);
    else void confirmExternal(url, next);
    return { action: 'deny' };
  });
  next.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && generation === connectionGeneration) showShell('Josi could not reach that server. Check the address or try again.');
  });
  next.webContents.on('render-process-gone', () => {
    if (generation === connectionGeneration) showShell('The Josi window stopped. Reconnect to continue.');
  });
  void next.loadURL(target).catch(() => {
    if (generation === connectionGeneration) showShell('Josi could not load that server.');
  });
}

function requireCe(event) {
  if (!expectedOrigin || !workspace) throw new Error('Connect to your Josi server first.');
  requireTrustedFrame(event, window, expectedOrigin);
}

ipcMain.handle('josi:shell-state', async event => {
  requireTrustedFrame(event, window, shellUrl, true);
  // A slow/offline health request does not accumulate every polling interval.
  if (!statusRequest) statusRequest = localServer.status().finally(() => { statusRequest = null; });
  return { error: lastError, local: await statusRequest };
});
ipcMain.handle('josi:shell-connect', (event, input) => {
  requireTrustedFrame(event, window, shellUrl, true);
  // Let the originating IPC reply settle before replacing its renderer.
  const origin = assertAllowedJosiCeUrl(input?.serverUrl);
  setImmediate(() => void connect(origin));
  return { accepted: true };
});
ipcMain.handle('josi:shell-local', async (event, input) => {
  requireTrustedFrame(event, window, shellUrl, true);
  const generation = connectionGeneration;
  const state = await localServer.status();
  if (generation !== connectionGeneration) throw new Error('The connection window changed.');
  if (state.phase !== 'ready' || !state.origin) throw new Error('Start the local server before opening Josi.');
  const route = input?.page === 'backups' ? '/admin/backups' : '/';
  setImmediate(() => void connect(state.origin, { local: true, route }));
  return { accepted: true };
});
ipcMain.handle('josi:shell-operation', async (event, input) => {
  requireTrustedFrame(event, window, shellUrl, true);
  const generation = connectionGeneration;
  const operation = input?.operation;
  const labels = { install: ['Set up Josi on this Mac?', 'This installs or updates the local server. Existing Josi accounts, Vault and data are retained.', 'Set up locally'],
    start: ['Start the local server?', 'Your other devices can reconnect when Josi is ready.', 'Start'],
    stop: ['Stop the local server?', 'Background tasks and connected devices will be interrupted. Your data stays on this Mac.', 'Stop server'],
    restart: ['Restart the local server?', 'Connected devices will briefly disconnect and active tasks may need to recover.', 'Restart'],
    'recover-latest': ['Repair the local installation?', 'Josi only restores settings or a previous version when its recovery journal says it is safe. Existing data is retained.', 'Repair'],
    uninstall: ['Remove this Mac’s local server?', 'This stops its background tasks and disconnects other devices. Accounts, Vault, data and recovery copies stay on this Mac for reinstalling. The Josi app remains available to connect to another server.', 'Remove local server'] };
  if (!Object.hasOwn(labels, operation)) throw new Error('Unsupported server operation.');
  const [message, detail, action] = labels[operation];
  const answer = await dialog.showMessageBox(window, { type: 'question', message, detail,
    buttons: ['Cancel', action], defaultId: 0, cancelId: 0, noLink: true });
  if (answer.response !== 1 || generation !== connectionGeneration) return { cancelled: true };
  return { cancelled: false, local: await localServer.operate(operation) };
});
ipcMain.handle('josi:shell-diagnostics', async event => {
  requireTrustedFrame(event, window, shellUrl, true);
  const generation = connectionGeneration;
  const report = await localServer.diagnostics();
  if (generation !== connectionGeneration) throw new Error('The connection window changed.');
  clipboard.writeText(JSON.stringify(report, null, 2));
  return { copied: true };
});
ipcMain.handle('josi:workspace-state', event => { requireCe(event); return workspace.publicState(); });
ipcMain.handle('josi:capabilities', async event => {
  requireCe(event);
  const generation = connectionGeneration;
  try {
    const response = await currentSession.fetch(`${expectedOrigin}/api/assistant/capabilities`, {
      method: 'GET', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    // Bound a server-supplied discovery response before parsing it.
    const reader = response.body?.getReader();
    const chunks = []; let length = 0;
    if (reader) try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 16384) { await reader.cancel(); return negotiateCapabilities(200, null); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (generation !== connectionGeneration) return negotiateCapabilities(null, null);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* preserve invalid/legacy distinction */ }
    return negotiateCapabilities(response.status, body);
  } catch { return negotiateCapabilities(null, null); }
});
ipcMain.handle('josi:workspace-select-folder', (event, input) => { requireCe(event); return workspace.selectFolder(input?.writable === true); });
ipcMain.handle('josi:workspace-revoke', (event, input) => { requireCe(event); return workspace.revoke(String(input?.rootId || '')); });
ipcMain.handle('josi:workspace-execute', (event, input) => {
  requireCe(event);
  return workspace.execute(String(input?.rootId || ''), String(input?.operation || ''), input?.payload || {});
});
ipcMain.handle('josi:desktop-notify', (event, input) => {
  requireCe(event);
  if (!Notification.isSupported()) return false;
  const ownerWindow = window;
  const generation = connectionGeneration;
  const route = internalRoute(input?.route, expectedOrigin);
  const notification = new Notification({ title: String(input?.title || 'Josi').slice(0, 80), body: String(input?.body || '').slice(0, 240) });
  notification.on('click', () => {
    if (generation !== connectionGeneration || ownerWindow.isDestroyed()) return;
    ownerWindow.show(); ownerWindow.focus();
    if (route) void ownerWindow.loadURL(route);
  });
  notification.show();
  return true;
});
ipcMain.handle('josi:confirm-approval', async (event, input) => {
  requireCe(event);
  const generation = connectionGeneration;
  const summary = String(input?.summary || '').slice(0, 1200);
  if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
    try { await systemPreferences.promptTouchID(`Approve in Josi: ${summary.slice(0, 120)}`); return generation === connectionGeneration; } catch { return false; }
  }
  const result = await dialog.showMessageBox(window, { type: 'warning', title: 'Confirm approval',
    message: 'Approve this action?', detail: summary, buttons: ['Cancel', 'Approve'], defaultId: 0, cancelId: 0, noLink: true });
  return result.response === 1 && generation === connectionGeneration;
});

app.whenReady().then(() => {
  localServer = new LocalServer({ app, session });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Josi server', submenu: [{ label: 'Server and connection…', click: () => showShell() },
      { label: 'Backups…', click: () => { if (expectedOrigin) void window.loadURL(expectedOrigin + '/admin/backups'); else showShell('Open a server to manage its backups.'); } }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  showShell();
  app.on('activate', () => { if (!window) showShell(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } else if (app.isReady()) showShell(); });
app.on('before-quit', () => protectedConfirmation.dispose());
