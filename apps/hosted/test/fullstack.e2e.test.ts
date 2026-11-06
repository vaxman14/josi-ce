// Everything together, with nothing standing in for our own parts: the real relay
// in Cloudflare's runtime (wrangler dev), the real hosted service, and a real Josi
// server. Only Google and Stripe are fakes. It starts its own relay, so it only
// runs when asked:
//
//   JOSI_BROWSER_E2E=1 npx vitest run apps/hosted/test/fullstack
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { MasterKey } from '@josi-ce/core';
import { accessTokenFor, connectionsFor, heyJosiClient, useKeyStore } from '@josi-ce/connectors';
import { TunnelClient, fromB64url, generateKeyPair, inviteId, normalizeCode, openInvite, staticKeyFrom, toB64url, utf8, webSocketTransport } from '@josi-ce/tunnel';
import { fileKeyStore } from '@josi-ce/tunnel/node';
import { testDb, testVault, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from '../../api/test/fixtures.js';
import { createApp } from '../../api/src/app.js';
import { RelayService } from '../../api/src/relay/relayService.js';
import { Harness } from './helpers.js';

const PORT = 8801, RELAY = `http://127.0.0.1:${PORT}`, PASSWORD = 'full-stack-password';
const ACCESS = 'REAL-FLOW-ACCESS-TOKEN', REFRESH = 'REAL-FLOW-REFRESH-TOKEN';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe.runIf(process.env.JOSI_BROWSER_E2E === '1')('the whole system', () => {
  let relayProcess: ChildProcess, h: Harness, db: TestDb, api: Server, server: RelayService, owner: string, base: string, jar = '';
  let customer: Awaited<ReturnType<Harness['account']>>;
  const master = new MasterKey(Buffer.alloc(32, 41));

  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const token = /josi_csrf=([^;]+)/.exec(jar)?.[1];
    const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', redirect: 'manual', body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: { 'content-type': 'application/json', ...(jar ? { cookie: jar } : {}), ...(token ? { 'x-josi-csrf': decodeURIComponent(token) } : {}) } });
    for (const line of res.headers.getSetCookie()) jar = [...jar.split('; ').filter(p => p && !p.startsWith(line.split('=')[0] + '=')), line.split(';')[0]].join('; ');
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };

  beforeAll(async () => {
    const grantKey = randomBytes(32);
    const publicGrant = toB64url(ed25519.getPublicKey(grantKey));
    relayProcess = spawn('npx', ['wrangler', 'dev', '-c', 'wrangler.dev.toml', '--port', String(PORT), '--ip', '127.0.0.1', '--var', `ACCOUNTS_KEYS:${publicGrant}`, '--var', 'OPEN_RELAY:0', '--persist-to', mkdtempSync(join(tmpdir(), 'josi-relay-state-'))],
      { cwd: join(process.cwd(), 'services/relay'), detached: true, stdio: 'ignore' });
    for (let i = 0; i < 150; i++) {
      if (await fetch(`${RELAY}/v1/health`).then(r => r.ok).catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    h = await new Harness().start({ RELAY_URL: RELAY, RELAY_GRANT_PRIVATE_KEY: toB64url(grantKey) });
    h.ctx.peerTransport = url => webSocketTransport(url, { relay: true, timeoutMs: 10_000 });
    h.google = form => form.get('grant_type') === 'refresh_token'
      ? json({ access_token: 'REAL-FLOW-ACCESS-2', expires_in: 3600, scope: 'openid' })
      : json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: form.get('code_verifier') ? 'openid' : 'no-verifier' });

    const dir = mkdtempSync(join(tmpdir(), 'josi-fullstack-'));
    const keyPath = join(dir, 'master.key');
    writeFileSync(keyPath, Buffer.alloc(32, 41).toString('base64'));
    db = await testDb();
    await ensureWorkspace(db);
    owner = (await createUser(db, { email: 'owner@ce.test', username: 'owner', role: 'super_admin', password: PASSWORD })).id;
    await testVault(db, master);
    const keyStore = fileKeyStore(join(dir, 'keys'));
    useKeyStore(keyStore);
    let app: ReturnType<typeof createApp> | undefined;
    api = createServer((req, res) => app!(req, res));
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const port = (api.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    const identity = (async () => json({ sub: 'g-1', email: 'real@gmail.test' })) as unknown as typeof fetch;
    server = new RelayService({ db, apiPort: port, hostedUrl: h.base, lanPort: null, keyStore, masterKey: { path: keyPath }, connectorFetch: identity });
    app = createApp(db, { cookieSecure: false, appUrl: base, masterKeyCheck: { path: keyPath }, relay: server });
    await call('/api/auth/csrf');
    expect((await call('/api/auth/login', { method: 'POST', body: { identifier: 'owner', password: PASSWORD } })).status).toBe(200);
    customer = await h.account();
    await h.subscribe(customer.id, 'connect_ai');
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    useKeyStore(null);
    api?.close();
    await h?.stop();
    if (relayProcess?.pid) { try { process.kill(-relayProcess.pid); } catch { /* already gone */ } }
  });

  it('links with a code from the account page, and comes online at the relay on a signed grant', async () => {
    const code = (await customer.browser.post('/api/link-code', {})).body.code as string;
    const linked = await call('/api/admin/hey-josi/link', { method: 'POST', body: { code, password: PASSWORD } });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body).toMatchObject({ linked: true, plan: 'connect_ai', aiReady: true });
    for (let i = 0; i < 50 && (await server.status()).relay.state !== 'online'; i++) await new Promise(resolve => setTimeout(resolve, 100));
    const status = await server.status();
    expect(status.relay.state, status.relay.error ?? '').toBe('online');
    expect(status.address).toBe(`${customer.handle}.127.0.0.1`);
  });

  let device: TunnelClient, deviceKey: ReturnType<typeof staticKeyFrom>, site: string, serverPublic: Uint8Array;

  it('pairs a device by typed code through the relay, and the code never reaches it', async () => {
    const pairing = await server.createPairing(owner);
    const code = normalizeCode(pairing.code);
    const found = await fetch(`${RELAY}/v1/invites/${inviteId(code)}`);
    expect(found.status).toBe(200);
    const box = openInvite(code, (await found.json() as { box: string }).box);
    site = box.site; serverPublic = fromB64url(box.server);
    deviceKey = staticKeyFrom(generateKeyPair().privateKey);
    const transport = await webSocketTransport(`${RELAY.replace('http', 'ws')}/v1/sites/${site}/peer`, { relay: true });
    device = await TunnelClient.connect({ transport, key: deviceKey, serverPublic, hello: { v: 1, op: 'pair', code, name: 'Test phone', platform: 'ios', ts: Date.now() } });
    expect(device.welcome.device).toMatch(/^[0-9a-f-]{36}$/);
    expect((await fetch(`${RELAY}/v1/invites/${inviteId(code)}`)).status).toBe(404);
  });

  it('reaches the server\'s API through the relay, and still meets the sign-in', async () => {
    const res = await device.request({ method: 'GET', path: '/api/auth/me', headers: [] });
    expect(res.status).toBe(401);
    await new Response(res.body).text();
    const login = await device.request({ method: 'POST', path: '/api/auth/login', headers: [['content-type', 'application/json']] }, utf8(JSON.stringify({ identifier: 'owner', password: PASSWORD })));
    expect(login.status).toBe(403);   // no CSRF yet: the same rule as any browser
    await new Response(login.body).text();
  });

  it('shows the device on the account page, and the account page can remove it', async () => {
    await server.sync();
    const view = (await customer.browser.get('/api/account')).body as { devices: Array<{ id: string; name: string }> };
    expect(view.devices.map(d => d.name)).toContain('Test phone');
    const closed = new Promise<void>(resolve => { device.onClose = () => resolve(); });
    const res = await customer.browser.post(`/api/devices/${device.welcome.device}/revoke`, {});
    expect(res.status).toBe(200);
    await closed;
    const transport = await webSocketTransport(`${RELAY.replace('http', 'ws')}/v1/sites/${site}/peer`, { relay: true });
    await expect(TunnelClient.connect({ transport, key: deviceKey, serverPublic, hello: { v: 1, op: 'connect', client: 'ios', ts: Date.now() } })).rejects.toMatchObject({ code: 'revoked' });
  });

  it('connects Google through heyjosi.com, over the relay, into this server\'s Vault', async () => {
    const started = await call('/api/connections/google/start', { method: 'POST', body: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const url = new URL(started.body.url);
    expect(url.searchParams.get('client_id')).toBe('fixture-client');
    const back = await fetch(`${h.base}/oauth/google/callback?code=google-code&state=${encodeURIComponent(url.searchParams.get('state')!)}`, { redirect: 'manual' });
    expect(back.status, await back.clone().text()).toBe(302);
    const [connection] = await connectionsFor(db, { ownerUserId: owner, provider: 'google' });
    expect(connection.account_email).toBe('real@gmail.test');
    expect(connection.meta?.oauthClient).toBe('hey-josi');
    expect(connection.granted_scopes).toBe('openid');   // proves the verifier made the trip
    const everything = await h.dump() + h.logs.join('\n');
    for (const secret of [ACCESS, REFRESH, 'google-code']) expect(everything).not.toContain(secret);

    await db.query(`update connections set token_expires_at = now() - interval '1 hour' where id = $1`, [connection.id]);
    expect(await accessTokenFor(db, master, { connection, client: heyJosiClient() }, {})).toBe('REAL-FLOW-ACCESS-2');
    expect(await h.dump() + h.logs.join('\n')).not.toContain('REAL-FLOW-ACCESS-2');
  });

  it('rotates the server key, and the hosted side keeps recognising it', async () => {
    expect((await call('/api/admin/hey-josi/keys/rotate', { method: 'POST', body: { password: PASSWORD } })).status).toBe(200);
    await server.sync();
    expect((await server.status()).lastSyncError).toBeNull();
  });

  it('pauses the address when the plan ends, and brings it back on renewal', async () => {
    const [sub] = await h.db.query<{ id: string }>('select id from heyjosi.subscriptions where account_id = $1', [customer.id]);
    h.subs.get(sub.id)!.status = 'canceled';
    await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.deleted', data: { object: { id: sub.id } } });
    await server.sync();
    expect(await server.status()).toMatchObject({ plan: 'free', relay: { enabled: false, state: 'stopped' } });
    await h.subscribe(customer.id, 'connect');
    await server.sync();
    for (let i = 0; i < 50 && (await server.status()).relay.state !== 'online'; i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(await server.status()).toMatchObject({ plan: 'connect', relay: { enabled: true, state: 'online' } });
  });
});
