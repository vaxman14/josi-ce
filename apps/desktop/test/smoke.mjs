// Live Electron integration using only synthetic loopback servers and a fresh
// temporary workspace. Run with a verified Electron executable as argv[2].
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const executablePath = process.argv[2];
assert(executablePath, 'Pass the verified Electron executable as argv[2]');
const output = resolve(root, 'build/unified-p1');
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(tmpdir(), 'josi-ce-shell-fixture-'));
await writeFile(join(folder, 'note.txt'), 'synthetic fixture');
let capabilitiesStatus = 404;
let capabilities = { product: 'josi-ce', protocolVersions: [1], capabilities: [{ id: 'chat.messages', version: 1 }] };
const foreign = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>Untrusted fixture frame</h1>'); });
await new Promise((ok, fail) => { foreign.once('error', fail); foreign.listen(0, '127.0.0.1', ok); });
const foreignOrigin = `http://127.0.0.1:${foreign.address().port}`;
const server = createServer((req, res) => {
  if (req.url === '/api/assistant/capabilities') {
    res.writeHead(capabilitiesStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify(capabilities)); return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(`<h1>Josi CE synthetic server</h1><iframe title="foreign" src="${foreignOrigin}"></iframe>`);
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
const origin = `http://127.0.0.1:${server.address().port}`;
let application;
try {
  application = await _electron.launch({ executablePath, args: [resolve(root, 'apps/desktop')], cwd: root,
    chromiumSandbox: true, acceptDownloads: false, timeout: 30000 });
  const welcome = await application.firstWindow();
  await welcome.getByRole('heading', { name: 'Welcome to Josi.' }).waitFor();
  await welcome.screenshot({ path: resolve(output, 'shell.png') });
  assert.equal(await welcome.evaluate(() => typeof window.require), 'undefined');
  const nextWindow = application.waitForEvent('window');
  await welcome.getByLabel('Server address').fill(origin);
  await welcome.getByRole('button', { name: /Connect to Josi/ }).click();
  const page = await nextWindow;
  await page.getByRole('heading', { name: 'Josi CE synthetic server' }).waitFor();
  assert.equal(application.windows().length, 1);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.deepEqual((await page.evaluate(() => window.josiDesktop.localWorkspace.state())).roots, []);
  assert.deepEqual(await page.evaluate(() => window.josiDesktop.capabilities()), { status: 'legacy', capabilities: [] });
  capabilitiesStatus = 200;
  assert.deepEqual(await page.evaluate(() => window.josiDesktop.capabilities()), { status: 'ready', version: 1, capabilities: capabilities.capabilities });
  capabilitiesStatus = 401;
  assert.deepEqual(await page.evaluate(() => window.josiDesktop.capabilities()), { status: 'unavailable', reason: 'authentication' });
  capabilitiesStatus = 200; capabilities = { ...capabilities, protocolVersions: [99] };
  assert.deepEqual(await page.evaluate(() => window.josiDesktop.capabilities()), { status: 'unavailable', reason: 'incompatible' });

  await application.evaluate(({ dialog }, selectedFolder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedFolder] });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, folder);
  const granted = await page.evaluate(() => window.josiDesktop.localWorkspace.selectFolder(true));
  assert(granted.id);
  assert.equal((await page.evaluate(rootId => window.josiDesktop.localWorkspace.execute({ rootId, operation: 'read', payload: { path: 'note.txt' } }), granted.id)).text, 'synthetic fixture');
  await page.evaluate(rootId => window.josiDesktop.localWorkspace.execute({ rootId, operation: 'create', payload: { path: 'created.txt', content: 'synthetic write' } }), granted.id);
  assert.equal(await readFile(join(folder, 'created.txt'), 'utf8'), 'synthetic write');
  await page.evaluate(rootId => window.josiDesktop.localWorkspace.revoke(rootId), granted.id);
  await assert.rejects(page.evaluate(rootId => window.josiDesktop.localWorkspace.execute({ rootId, operation: 'read', payload: { path: 'note.txt' } }), granted.id));

  const foreignFrame = page.frames().find(frame => frame.url().startsWith(foreignOrigin));
  assert(foreignFrame);
  assert.equal(await foreignFrame.evaluate(() => typeof window.josiDesktop), 'undefined');
  // User navigation cannot give another origin the preloaded native bridge.
  await page.evaluate(target => { window.location.href = target; }, foreignOrigin);
  // A cancelled Electron navigation can leave Playwright's navigation waiter
  // pending. Read the actual owned window after the main-process guard runs.
  const blockedNavigation = await application.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    return { url: contents.getURL(), heading: await contents.executeJavaScript('document.querySelector("h1")?.textContent') };
  });
  assert(blockedNavigation.url.startsWith(origin));
  assert.equal(blockedNavigation.heading, 'Josi CE synthetic server');
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration };
  });
  assert.deepEqual(preferences, { contextIsolation: true, sandbox: true, nodeIntegration: false });
  const reconnectWindow = application.waitForEvent('window');
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === 'Connection').submenu.items[0].click());
  const reconnect = await reconnectWindow;
  await reconnect.getByRole('heading', { name: 'Welcome to Josi.' }).waitFor();
  assert.equal(await reconnect.evaluate(() => typeof window.josiDesktop), 'undefined');
  const result = { passed: true, runtime: 'Electron 43.2.0', syntheticOnly: true,
    checks: ['connection-window-replacement', 'legacy-discovery', 'capability-negotiation', 'authentication-failure',
      'incompatible-version', 'native-folder-read-write-revoke', 'foreign-frame-no-bridge', 'origin-navigation-block',
      'renderer-sandbox', 'reconnect-shell'] };
  await writeFile(resolve(output, 'desktop-smoke.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (application) await application.close();
  await Promise.all([new Promise(ok => server.close(ok)), new Promise(ok => foreign.close(ok))]);
  await rm(folder, { recursive: true, force: true });
}
