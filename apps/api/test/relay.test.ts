// Pairing, revocation, key rotation and the Google handoff, against the real API.
//
// Devices reach the real `TunnelHost` over an in-memory pipe, and their requests
// reach the real API through the real bridge. The relay itself is covered in
// packages/tunnel/test; heyjosi.com is a stand-in here, built on the real RPC.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterKey } from '@josi-ce/core';
import { accessTokenFor, connectionsFor, heyJosiClient, useKeyStore } from '@josi-ce/connectors';
import {
  Handshake, TunnelClient, encodeJson, decodeJson, fromB64url, generateKeyPair, normalizeCode, parsePairingLink, rpcAnswer, staticKeyFrom, toB64url, utf8,
  type HostedCall, type StaticKey, type Transport,
} from '@josi-ce/tunnel';
import { fileKeyStore } from '@josi-ce/tunnel/node';
import { testDb, testVault, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { RelayService } from '../src/relay/relayService.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-relay-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 21);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const master = new MasterKey(KEY_BYTES);
const keyDir = join(dir, 'keys');
const PW = { admin: 'admin-password-123', alice: 'alice-password-123', bob: 'bob-password-123' };
const ACCESS = 'GOOGLE-ACCESS-value', REFRESH = 'GOOGLE-REFRESH-value';
// Nothing listens here, so the link keeps retrying harmlessly. The relay is tested elsewhere.
const RELAY_URL = 'http://127.0.0.1:9';
const relayCalls: Array<{ method: string; path: string; body: string }> = [];

let db: TestDb, server: Server, base: string, relay: RelayService, peers = 0;
const ids: Record<string, string> = {}, jars: Record<string, string> = {};

// The hosted stand-in. Everything arrives sealed, through rpcAnswer.
const hostedKey = staticKeyFrom(generateKeyPair().privateKey);
const hostedCalls: Array<HostedCall & { caller: string }> = [];
let plan: 'free' | 'connect' | 'connect_ai' = 'connect';
let pendingRevoke: string[] = [];
let refreshError: string | null = null;
const usage = { plan: 'connect', periodEnd: null, allowance: 0, topUps: 0, spent: 0, reserved: 0, remaining: 0, accountCap: null, accountSpent: 0, models: [] };

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = String(input);
  if (href.endsWith('/v1/noise-key')) return Response.json({ publicKey: toB64url(hostedKey.publicKey) });
  if (href.endsWith('/v1/rpc')) {
    const answer = await rpcAnswer({
      key: hostedKey, message: new Uint8Array(init!.body as Uint8Array), seen: () => false,
      async handle(call, caller) {
        hostedCalls.push({ ...call, caller: toB64url(caller) });
        if (call.op === 'link') return call.code === 'GOODCODE'
          ? { ok: true, serverId: 'srv-1', site: 'a'.repeat(32), name: 'alice', hostedPublic: toB64url(hostedKey.publicKey), relayUrl: RELAY_URL, plan }
          : { ok: false, error: 'bad_code' };
        if (call.op === 'sync') { const revoke = pendingRevoke; pendingRevoke = []; return { ok: true, plan, name: 'alice', grant: plan === 'free' ? null : 'SIGNED-GRANT', aiToken: null, aiBaseUrl: null, usage, revoke }; }
        if (call.op === 'google.authorize') return { ok: true, url: `https://accounts.google.test/auth?state=${encodeURIComponent(call.state)}&code_challenge=${call.codeChallenge}` };
        if (call.op === 'google.refresh') return refreshError ? { ok: false, error: refreshError } : { ok: true, accessToken: 'GOOGLE-ACCESS-2', expiresIn: 3600, scope: null };
        return { ok: true };
      },
    });
    return new Response(answer as Uint8Array<ArrayBuffer>, { status: 200 });
  }
  if (href.startsWith(RELAY_URL)) {
    const path = href.slice(RELAY_URL.length), method = init?.method ?? 'GET';
    relayCalls.push({ method, path, body: String(init?.body ?? '') });
    return path === '/v1/sites' ? Response.json({ site: 'a'.repeat(32), secret: 'RELAY-SECRET-value', name: 'alice' }, { status: 201 }) : Response.json({ ok: true });
  }
  throw new Error(`unexpected request: ${href}`);
}) as unknown as typeof fetch;

const connectorFetch = (async () => Response.json({ sub: 'g-1', email: 'alice@gmail.test' })) as unknown as typeof fetch;

async function call(path: string, opts: { method?: string; body?: unknown; jar?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const res = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' });
  return { status: res.status, body: await res.json().catch(() => null) as any, setCookie: res.headers.getSetCookie?.() ?? [] };
}

const mergeJar = (old: string | undefined, set: string[]) => {
  const jar = new Map((old ?? '').split(';').filter(p => p.includes('=')).map(p => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()]));
  for (const raw of set) { const first = raw.split(';')[0]; jar.set(first.slice(0, first.indexOf('=')), first.slice(first.indexOf('=') + 1)); }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
};

async function signIn(identifier: string, password: string) {
  const jar = mergeJar(undefined, (await call('/api/auth/csrf')).setCookie);
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier, password }, jar });
  expect(res.status).toBe(200);
  return mergeJar(jar, res.setCookie);
}

/** A pipe into the host, as the relay or LAN listener would give it. */
function pipe(): Transport {
  const id = `test-${++peers}`, host = relay.tunnelHost;
  const transport: Transport = { onMessage: null, onClose: null, send: data => host.data(id, data), close: () => host.gone(id) };
  host.open(id, { send: data => queueMicrotask(() => transport.onMessage?.(data)), close: reason => queueMicrotask(() => transport.onClose?.(reason ?? 'closed')) });
  return transport;
}

const serverPublic = async () => fromB64url(await relay.publicKey());
const newDevice = () => { const { privateKey } = generateKeyPair(); return { privateKey, key: staticKeyFrom(privateKey) }; };
const connect = async (key: StaticKey, server?: Uint8Array) => TunnelClient.connect({ transport: pipe(), key, serverPublic: server ?? await serverPublic(), hello: { v: 1, op: 'connect', client: 'web', ts: Date.now() } });
const pairWith = async (key: StaticKey, code: string) => TunnelClient.connect({ transport: pipe(), key, serverPublic: await serverPublic(), hello: { v: 1, op: 'pair', code, name: 'Phone', platform: 'ios', ts: Date.now() } });
const newCode = async (who = 'alice') => { const res = await call('/api/hey-josi/pairing', { method: 'POST', jar: jars[who], body: {} }); expect(res.status).toBe(201); return { ...res.body, raw: normalizeCode(res.body.code) as string }; };

async function get(client: TunnelClient, path: string, method = 'GET', body?: unknown) {
  const res = await client.request({ method, path, headers: body ? [['content-type', 'application/json']] : [] }, body ? utf8(JSON.stringify(body)) : null);
  const text = await new Response(res.body).text();
  return { status: res.status, headers: res.headers, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

/** What hosted does to reach a server: one handshake, one reply. */
async function hostedHello(key: StaticKey, hello: Record<string, unknown>) {
  const transport = pipe(), handshake = new Handshake(true, key, await serverPublic());
  const reply = new Promise<Uint8Array>((resolve, reject) => { transport.onMessage = resolve; transport.onClose = reason => reject(new Error(reason)); });
  transport.send(await handshake.writeFirst(encodeJson({ v: 1, ts: Date.now(), ...hello })));
  return decodeJson<Record<string, any>>(await handshake.readSecond(await reply));
}

beforeAll(async () => {
  process.env.JOSI_VERSION = 'test';
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW.bob })).id;
  await testVault(db, master);
  const keyStore = fileKeyStore(keyDir);
  useKeyStore(keyStore);
  // Bound first, so the bridge knows the port.
  let app: ReturnType<typeof createApp> | undefined;
  server = (await import('node:http')).createServer((req, res) => app!(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  relay = new RelayService({ db, apiPort: port, hostedUrl: 'https://hosted.test', lanPort: null, fetchImpl, connectorFetch, keyStore, masterKey: { path: keyPath } });
  app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost:3000', masterKeyCheck: { path: keyPath }, connectorFetch: fetchImpl, relay });
  jars.admin = await signIn('admin', PW.admin);
  jars.alice = await signIn('alice', PW.alice);
  jars.bob = await signIn('bob', PW.bob);
  const linked = await call('/api/admin/hey-josi/link', { method: 'POST', jar: jars.admin, body: { code: 'GOODCODE', password: PW.admin } });
  expect(linked.status).toBe(200);
});

afterAll(async () => { await relay.stop(); useKeyStore(null); await new Promise<void>(r => server.close(() => r())); });

beforeEach(() => { hostedCalls.length = 0; pendingRevoke = []; plan = 'connect'; refreshError = null; });

describe('pairing', () => {
  it('makes a long code, keeps only its hash, and puts the QR secret in the fragment', async () => {
    const pairing = await newCode();
    expect(pairing.raw).toHaveLength(32);
    const stored = await db.query<{ code_hash: string }>('select code_hash from relay_pairing_codes');
    expect(JSON.stringify(stored)).not.toContain(pairing.raw);
    expect(parsePairingLink(pairing.link)?.code).toBe(pairing.raw);
    expect(new Date(pairing.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 600_000 + 1000);
  });

  it('gives the relay a sealed box and a hash, never the code', async () => {
    const pairing = await newCode();
    const put = relayCalls.filter(c => c.method === 'PUT').at(-1)!;
    expect(put.path).toMatch(/^\/v1\/sites\/a{32}\/invites\/[0-9a-f]{32}$/);
    expect(put.path + put.body).not.toContain(pairing.raw);
    expect(put.body).not.toContain(await relay.publicKey());
  });

  it('works once', async () => {
    const pairing = await newCode();
    const first = await pairWith(newDevice().key, pairing.raw);
    expect(first.welcome.device).toMatch(/^[0-9a-f-]{36}$/);
    first.close();
    await expect(pairWith(newDevice().key, pairing.raw)).rejects.toMatchObject({ code: 'bad_code' });
  });

  it('lets exactly one of two racing devices have a code', async () => {
    const pairing = await newCode();
    const results = await Promise.allSettled([pairWith(newDevice().key, pairing.raw), pairWith(newDevice().key, pairing.raw)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('expires', async () => {
    const pairing = await newCode();
    await db.query(`update relay_pairing_codes set expires_at = now() - interval '1 second' where used_at is null`);
    await expect(pairWith(newDevice().key, pairing.raw)).rejects.toMatchObject({ code: 'bad_code' });
  });

  it('gives no one a session: a paired device still meets the sign-in', async () => {
    const client = await pairWith(newDevice().key, (await newCode('admin')).raw);
    expect((await get(client, '/api/auth/me')).status).toBe(401);
    expect((await get(client, '/api/admin/hey-josi')).status).toBe(401);
    client.close();
  });

  it('keeps a tunnelled browser\'s session on the server, out of the page\'s reach', async () => {
    const client = await pairWith(newDevice().key, (await newCode()).raw);
    const csrf = await get(client, '/api/auth/csrf');
    expect(csrf.headers.some(([k]) => k === 'set-cookie')).toBe(false);
    const login = await get(client, '/api/auth/login', 'POST', { identifier: 'alice', password: PW.alice });
    expect(login.status).toBe(200);
    expect(login.headers.some(([k]) => k === 'set-cookie')).toBe(false);
    expect((await get(client, '/api/auth/me')).json.user.username).toBe('alice');
    client.close();
  });

  it('cannot be started from the hosted side', async () => {
    await expect(hostedHello(hostedKey, { op: 'pair', code: 'X'.repeat(32), name: 'x', platform: 'x' })).resolves.toMatchObject({ ok: false, error: 'bad_code' });
    const before = (await relay.devices(null)).length;
    await hostedHello(hostedKey, { op: 'add-device', publicKey: toB64url(newDevice().key.publicKey) }).catch(() => null);
    expect((await relay.devices(null)).length).toBe(before);
  });
});

describe('revocation', () => {
  it('lists a person\'s own devices, and the owner sees everyone\'s', async () => {
    const client = await pairWith(newDevice().key, (await newCode('bob')).raw);
    const bob = (await call('/api/hey-josi/devices', { jar: jars.bob })).body.devices;
    expect(bob.every((d: { ownerUserId: string }) => d.ownerUserId === ids.bob)).toBe(true);
    expect(bob.some((d: { id: string }) => d.id === client.welcome.device)).toBe(true);
    expect(JSON.stringify(bob)).not.toContain('public');
    const alice = (await call('/api/hey-josi/devices?all=1', { jar: jars.alice })).body.devices;
    expect(alice.some((d: { id: string }) => d.id === client.welcome.device)).toBe(false);
    const all = (await call('/api/hey-josi/devices?all=1', { jar: jars.admin })).body.devices;
    expect(all.some((d: { id: string }) => d.id === client.welcome.device)).toBe(true);
    client.close();
  });

  it('cuts a device off at once, and refuses it afterwards', async () => {
    const { key } = newDevice(), client = await pairWith(key, (await newCode('bob')).raw);
    const told = new Promise<void>(resolve => { client.onRevoked = () => resolve(); });
    expect((await call(`/api/hey-josi/devices/${client.welcome.device}`, { method: 'DELETE', jar: jars.alice })).status).toBe(404);
    expect((await call(`/api/hey-josi/devices/${client.welcome.device}`, { method: 'DELETE', jar: jars.bob })).status).toBe(200);
    await told;
    await expect(connect(key)).rejects.toMatchObject({ code: 'revoked' });
  });

  it('won\'t let a revoked key pair its way back in', async () => {
    const { key } = newDevice(), client = await pairWith(key, (await newCode('bob')).raw);
    await relay.revoke(client.welcome.device, ids.bob);
    await expect(pairWith(key, (await newCode('bob')).raw)).rejects.toMatchObject({ code: 'bad_code' });
  });

  it('takes a revocation from the account page, by sync and directly', async () => {
    const first = await pairWith(newDevice().key, (await newCode()).raw), second = await pairWith(newDevice().key, (await newCode()).raw);
    pendingRevoke = [first.welcome.device];
    await relay.sync();
    expect((await relay.devices(null)).find(d => d.id === first.welcome.device)?.revoked_at).toBeTruthy();
    await expect(hostedHello(hostedKey, { op: 'revoke-device', device: second.welcome.device })).resolves.toMatchObject({ ok: true });
    expect((await relay.devices(null)).find(d => d.id === second.welcome.device)?.revoked_at).toBeTruthy();
  });

  it('runs one sync at a time, so a first link can\'t register with the relay twice', async () => {
    const before = hostedCalls.length;
    let running = 0, most = 0;
    const original = (relay as unknown as { syncOnce(): Promise<void> }).syncOnce.bind(relay);
    (relay as unknown as { syncOnce(): Promise<void> }).syncOnce = async () => { most = Math.max(most, ++running); try { await original(); } finally { running--; } };
    await Promise.all([relay.sync(), relay.sync(), relay.sync()]);
    delete (relay as unknown as { syncOnce?: unknown }).syncOnce;
    expect(most).toBe(1);
    expect(hostedCalls.length - before).toBeGreaterThanOrEqual(3);
  });

  it('refuses a device revocation from any key but the pinned hosted one', async () => {
    const client = await pairWith(newDevice().key, (await newCode()).raw);
    await expect(hostedHello(staticKeyFrom(generateKeyPair().privateKey), { op: 'revoke-device', device: client.welcome.device })).resolves.toMatchObject({ ok: false });
    expect((await relay.devices(null)).find(d => d.id === client.welcome.device)?.revoked_at).toBeNull();
    client.close();
  });
});

describe('key rotation', () => {
  it('keeps the private key out of the database and out of the config', async () => {
    const status = (await call('/api/admin/hey-josi', { jar: jars.admin })).body;
    expect(status.keyStore).toBe('file');
    expect(JSON.stringify(status)).not.toContain('RELAY-SECRET-value');
    expect(JSON.stringify(await db.query('select * from hey_josi_link'))).not.toContain('RELAY-SECRET-value');
    const raw = JSON.parse(Buffer.from(readFileSync(join(keyDir, 'noise-keys.key'), 'utf8').slice(4), 'base64url').toString());
    const dump = JSON.stringify(await db.query('select * from hey_josi_link'));
    expect(dump).not.toContain(raw.current);
    expect(JSON.stringify(status)).not.toContain(raw.current);
    expect(readdirSync(keyDir).every(name => name.endsWith('.key'))).toBe(true);
  });

  it('asks for the password', async () => {
    expect((await call('/api/admin/hey-josi/keys/rotate', { method: 'POST', jar: jars.admin, body: { password: 'wrong-password-12' } })).status).toBe(401);
    expect((await call('/api/admin/hey-josi/keys/rotate', { method: 'POST', jar: jars.alice, body: { password: PW.alice } })).status).toBe(403);
  });

  it('tells connected devices, tells hosted, and keeps the old key for stragglers', async () => {
    const online = newDevice(), away = newDevice();
    const oldPublic = await serverPublic();
    const client = await pairWith(online.key, (await newCode()).raw);
    (await pairWith(away.key, (await newCode()).raw)).close();
    const notice = new Promise<{ publicKey: string }>(resolve => { client.onServerRotation = resolve; });
    const rotated = await call('/api/admin/hey-josi/keys/rotate', { method: 'POST', jar: jars.admin, body: { password: PW.admin } });
    expect(rotated.status).toBe(200);
    expect((await notice).publicKey).toBe(rotated.body.publicKey);
    const told = hostedCalls.find(c => c.op === 'rotate-key') as { publicKey: string; caller: string };
    expect(told.publicKey).toBe(rotated.body.publicKey);
    expect(told.caller).toBe(toB64url(oldPublic));
    const late = await connect(away.key, oldPublic);
    expect(late.welcome.rotate?.publicKey).toBe(rotated.body.publicKey);
    late.close();
    (await connect(away.key, fromB64url(rotated.body.publicKey))).close();
    client.close();
  });

  it('destroys the old key at once when asked to, and drops every session', async () => {
    const device = newDevice(), oldPublic = await serverPublic();
    const client = await pairWith(device.key, (await newCode()).raw);
    const closed = new Promise<void>(resolve => { client.onClose = () => resolve(); });
    const rotated = await call('/api/admin/hey-josi/keys/rotate', { method: 'POST', jar: jars.admin, body: { password: PW.admin, immediate: true } });
    expect(rotated.body.previousUntil).toBeNull();
    await closed;
    await expect(connect(device.key, oldPublic)).rejects.toThrow();
    (await connect(device.key, fromB64url(rotated.body.publicKey))).close();
  });

  it('moves a device to a new key without losing it, and retires the old one', async () => {
    const before = newDevice(), after = newDevice();
    const client = await pairWith(before.key, (await newCode()).raw);
    await client.rotateDeviceKey(after.key.publicKey);
    client.close();
    const second = await connect(after.key);
    expect(second.welcome.device).toBe(client.welcome.device);
    second.close();
    await db.query(`update relay_devices set previous_until = now() - interval '1 second' where id = $1`, [client.welcome.device]);
    await expect(connect(before.key)).rejects.toMatchObject({ code: 'unknown_device' });
  });
});

describe('Google through the shared client', () => {
  it('hands tokens to this server\'s Vault, and refreshes through hosted', async () => {
    const started = await call('/api/connections/google/start', { method: 'POST', jar: jars.alice, body: {} });
    expect(started.status).toBe(200);
    const url = new URL(started.body.url), state = url.searchParams.get('state')!;
    expect(url.hostname).toBe('accounts.google.test');
    const asked = hostedCalls.find(c => c.op === 'google.authorize') as { scopes: string };
    expect(asked.scopes.split(' ').sort()).toEqual([
      'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/contacts',
      'https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email', 'openid',
    ].sort());

    const begun = await hostedHello(hostedKey, { op: 'google-begin', state });
    expect(begun.ok).toBe(true);
    expect(begun.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    await expect(hostedHello(hostedKey, { op: 'google-begin', state })).resolves.toMatchObject({ ok: false });

    const done = await hostedHello(hostedKey, { op: 'google-tokens', state, accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 1, scope: asked.scopes });
    expect(done).toMatchObject({ ok: true, returnPath: '/app/connections' });

    const [connection] = await connectionsFor(db, { ownerUserId: ids.alice, provider: 'google' });
    expect(connection.account_email).toBe('alice@gmail.test');
    expect(connection.meta?.oauthClient).toBe('hey-josi');
    expect(JSON.stringify(connection)).not.toContain(REFRESH);

    await db.query(`update connections set token_expires_at = now() - interval '1 hour' where id = $1`, [connection.id]);
    expect(await accessTokenFor(db, master, { connection, client: heyJosiClient() }, { fetchImpl })).toBe('GOOGLE-ACCESS-2');
    expect(hostedCalls.find(c => c.op === 'google.refresh')).toMatchObject({ refreshToken: REFRESH });
  });

  it('marks a connection for reconnecting when Google has withdrawn the grant', async () => {
    const [connection] = await connectionsFor(db, { ownerUserId: ids.alice, provider: 'google' });
    await db.query(`update connections set token_expires_at = now() - interval '1 hour' where id = $1`, [connection.id]);
    refreshError = 'invalid_grant';
    await expect(accessTokenFor(db, master, { connection, client: heyJosiClient() }, { fetchImpl })).rejects.toMatchObject({ category: 'revoked', revoked: true });
  });

  it('accepts tokens only from the pinned hosted key', async () => {
    const started = await call('/api/connections/google/start', { method: 'POST', jar: jars.bob, body: {} });
    const state = new URL(started.body.url).searchParams.get('state')!;
    const stranger = staticKeyFrom(generateKeyPair().privateKey);
    await expect(hostedHello(stranger, { op: 'google-begin', state })).resolves.toMatchObject({ ok: false });
    await expect(hostedHello(stranger, { op: 'google-tokens', state, accessToken: 'x', refreshToken: 'y', expiresIn: 1, scope: 'openid' })).resolves.toMatchObject({ ok: false });
    expect(await connectionsFor(db, { ownerUserId: ids.bob, provider: 'google' })).toHaveLength(0);
  });

  it('refuses tokens for a handshake that was never begun', async () => {
    await expect(hostedHello(hostedKey, { op: 'google-tokens', state: 'nope', accessToken: 'x', refreshToken: 'y', expiresIn: 1, scope: 'openid' })).resolves.toMatchObject({ ok: false, error: 'expired' });
  });

  it('leaves a self-hoster\'s own Google client in charge', async () => {
    const saved = await call('/api/admin/connectors/clients/google', { method: 'PUT', jar: jars.admin, body: { clientId: 'own-client', clientSecret: 'own-secret', redirectUri: 'http://localhost:3000/api/connections/google/callback' } });
    expect(saved.status).toBe(200);
    const started = await call('/api/connections/google/start', { method: 'POST', jar: jars.bob, body: {} });
    expect(new URL(started.body.url).searchParams.get('client_id')).toBe('own-client');
    expect(hostedCalls.some(c => c.op === 'google.authorize')).toBe(false);
    await call('/api/admin/connectors/clients/google', { method: 'DELETE', jar: jars.admin });
  });

  it('isn\'t offered on the free plan', async () => {
    plan = 'free';
    await relay.sync();
    const res = await call('/api/connections/google/start', { method: 'POST', jar: jars.bob, body: {} });
    expect(res.status).toBe(409);
    plan = 'connect';
    await relay.sync();
  });
});

describe('with nothing linked', () => {
  it('unlinks, and forgets the relay secret', async () => {
    expect((await call('/api/admin/hey-josi/unlink', { method: 'POST', jar: jars.admin, body: { password: PW.admin } })).status).toBe(200);
    expect(await relay.row()).toBeNull();
    expect((await call('/api/admin/hey-josi', { jar: jars.admin })).body).toMatchObject({ linked: false, plan: 'free', address: null });
  });

  it('a free server contacts nobody', async () => {
    hostedCalls.length = 0;
    await relay.sync();
    expect(hostedCalls).toHaveLength(0);
  });
});
