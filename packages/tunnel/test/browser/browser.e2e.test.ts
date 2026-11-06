// The browser path, for real: Cloudflare's own runtime (wrangler dev), a real
// Josi API with the built web client, and real Chrome. Slow and needs Chrome, so
// it only runs when asked:
//
//   (cd services/relay && npx wrangler dev -c wrangler.dev.toml --port 8799 --ip 127.0.0.1)
//   (cd apps/web && npx vite build)
//   JOSI_BROWSER_E2E=1 npx vitest run packages/tunnel/test/browser
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { MasterKey } from '@josi-ce/core';
import { useKeyStore } from '@josi-ce/connectors';
import { fileKeyStore } from '@josi-ce/tunnel/node';
import { testDb, testVault } from '../../../core/test/helpers.js';
import { createUser, ensureWorkspace } from '../../../../apps/api/test/fixtures.js';
import { createApp } from '../../../../apps/api/src/app.js';
import { RelayService } from '../../../../apps/api/src/relay/relayService.js';

const RELAY = 'http://127.0.0.1:8799';
const NAME = `e2e${Date.now().toString(36)}`;
const ORIGIN = `http://${NAME}.localhost:8799`;
const PASSWORD = 'browser-e2e-password';

describe.runIf(process.env.JOSI_BROWSER_E2E === '1')('a browser through the relay', () => {
  let server: Server, relay: RelayService, browser: Browser, owner: string;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-browser-e2e-'));
    const keyPath = join(dir, 'master.key'), bytes = Buffer.alloc(32, 31);
    writeFileSync(keyPath, bytes.toString('base64'));
    const db = await testDb();
    await ensureWorkspace(db);
    owner = (await createUser(db, { email: 'owner@ce.test', username: 'owner', role: 'super_admin', password: PASSWORD })).id;
    await testVault(db, new MasterKey(bytes));
    const keyStore = fileKeyStore(join(dir, 'keys'));
    useKeyStore(keyStore);
    let app: ReturnType<typeof createApp> | undefined;
    server = createServer((req, res) => app!(req, res));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    relay = new RelayService({ db, apiPort: (server.address() as AddressInfo).port, lanPort: null, keyStore, masterKey: { path: keyPath } });
    app = createApp(db, { cookieSecure: false, appUrl: ORIGIN, masterKeyCheck: { path: keyPath }, webDir: join(process.cwd(), 'apps/web/dist'), relay });
    await relay.useOwnRelay({ relayUrl: RELAY, name: NAME, actorUserId: owner });
    for (let i = 0; i < 50 && (await relay.status()).relay.state !== 'online'; i++) await new Promise(resolve => setTimeout(resolve, 100));
    browser = await chromium.launch({ channel: 'chrome' });
  }, 60_000);

  afterAll(async () => { await browser?.close(); await relay?.stop(); useKeyStore(null); server?.close(); });

  it('pairs, loads the real app from the server, signs in, and is cut off when revoked', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const sockets: string[] = [];
    page.on('websocket', socket => { sockets.push(socket.url()); });

    await page.goto(ORIGIN);
    await page.waitForSelector('#code', { state: 'visible' });
    const { code } = await relay.createPairing(owner);
    await page.fill('#code', code);
    await page.click('button[type=submit]');

    // The server's own web client, through the tunnel, at the person's address.
    await page.waitForSelector('input[type=password]', { timeout: 20_000 });
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain('/__josi/sw.js');
    expect(await page.evaluate(() => document.cookie)).toBe('');

    const inputs = page.locator('input');
    await inputs.first().fill('owner');
    await page.fill('input[type=password]', PASSWORD);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/(app|admin)/, { timeout: 20_000 });
    const me = await page.evaluate(async () => (await fetch('/api/auth/me')).json()) as { user: { username: string } };
    expect(me.user.username).toBe('owner');
    expect(await page.evaluate(() => document.cookie)).toBe('');

    // A cross-site style form post, as a navigation, gets nothing done.
    const status = await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-josi-csrf': 'wrong' } })).status);
    expect(status).toBeLessThan(500);

    const [device] = await relay.devices(owner);
    expect(device.platform).toBe('web');
    await relay.revoke(device.id, owner);
    await page.reload();
    await page.waitForSelector('#code', { state: 'visible', timeout: 20_000 });
    expect(errors).toEqual([]);
    await context.close();
  }, 90_000);

  it('hands the relay no page of the app', async () => {
    const res = await fetch(`${RELAY}/`, { headers: { host: `${NAME}.localhost:8799` } });
    expect(await res.text()).not.toContain('Sign in');
  });
});
