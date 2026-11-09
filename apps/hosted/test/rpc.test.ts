import { ed25519 } from '@noble/curves/ed25519.js';
import { Handshake, encodeJson, decodeJson, fromB64url, generateKeyPair, randomBytes, staticKeyFrom, toB64url, toHex, utf8 } from '@josi-ce/tunnel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeServerKey, Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => { h = await new Harness().start(); });
afterAll(() => h.stop());

const RPC_PROLOGUE = utf8('josi-rpc/1');

function readGrant(grant: string): Record<string, unknown> {
  const [body, signature] = grant.split('.') as [string, string];
  expect(ed25519.verify(fromB64url(signature), utf8(body), ed25519.getPublicKey(h.config.grantPrivateKey))).toBe(true);
  return JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
}

describe('the noise key', () => {
  it('is public, and is what the RPC answers with', async () => {
    const res = await fetch(`${h.base}/v1/noise-key`);
    expect(await res.json()).toEqual({ publicKey: h.ctx.hostedPublic });
    expect(fromB64url(h.ctx.hostedPublic)).toHaveLength(32);
  });
});

describe('a login', () => {
  it('yields nothing to do with the server', async () => {
    const { account } = await h.aiCustomer();
    const login = await h.browser().post('/api/login', { email: account.email, password: account.password });
    const page = await account.browser.get('/api/account');
    const seen = JSON.stringify([login.body, page.body, [...login.headers]]);
    for (const word of ['grant', 'aiToken', 'ai_token', 'site', 'secret', 'noise', 'pairing', 'relaySecret', 'hj_ai_']) expect(seen).not.toContain(word);
    expect(Object.keys(page.body.server as object).sort()).toEqual(['hasAiToken', 'lastSyncAt', 'linked', 'version']);
  });

  it('has no route that opens a server session or starts pairing', async () => {
    const account = await h.account();
    for (const path of ['/api/server/session', '/api/server/login', '/api/pair', '/api/devices/pair', '/api/pairing-code', '/api/tunnel']) {
      expect((await account.browser.post(path, {})).status).toBe(404);
    }
  });

  it('can\'t be used as a server: a link code is not a pairing code for anything else', async () => {
    const account = await h.account();
    const { code } = (await account.browser.post('/api/link-code', {})).body as { code: string };
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    const [row] = await h.db.query<{ code_hash: string }>('select code_hash from heyjosi.link_codes where account_id = $1', [account.id]);
    expect(row!.code_hash).not.toContain(code.replaceAll('-', ''));
    expect(await h.dump()).not.toContain(code.replaceAll('-', ''));
  });
});

describe('linking', () => {
  it('records the key the handshake proved and replies as LinkReply says', async () => {
    const account = await h.account(), server = new FakeServerKey(h);
    const reply = await server.link(account.browser);
    expect(reply).toMatchObject({ ok: true, name: account.handle, hostedPublic: h.ctx.hostedPublic, relayUrl: h.config.relayUrl, plan: 'free' });
    expect(server.site).toMatch(/^[0-9a-f]{32}$/);
    const [row] = await h.db.query<{ noise_public: string; version: string }>('select noise_public, version from heyjosi.servers where account_id = $1', [account.id]);
    expect(row).toEqual({ noise_public: server.publicKey, version: '1.2.3' });
  });

  it('takes a code once', async () => {
    const account = await h.account();
    const { code } = (await account.browser.post('/api/link-code', {})).body as { code: string };
    expect((await new FakeServerKey(h).call({ op: 'link', code, version: '1' })).ok).toBe(true);
    expect(await new FakeServerKey(h).call({ op: 'link', code, version: '1' })).toMatchObject({ ok: false, error: 'bad_code' });
  });

  it('refuses an expired code, and a code replaced by a newer one', async () => {
    const account = await h.account();
    const old = (await account.browser.post('/api/link-code', {})).body as { code: string };
    const fresh = (await account.browser.post('/api/link-code', {})).body as { code: string };
    expect(await new FakeServerKey(h).call({ op: 'link', code: old.code, version: '1' })).toMatchObject({ error: 'bad_code' });
    h.advance(11 * 60_000);
    expect(await new FakeServerKey(h).call({ op: 'link', code: fresh.code, version: '1' })).toMatchObject({ error: 'bad_code' });
    h.advance(-11 * 60_000);
  });

  it('won\'t let one key serve two accounts', async () => {
    const server = new FakeServerKey(h);
    await server.link((await h.account()).browser);
    const other = await h.account();
    const { code } = (await other.browser.post('/api/link-code', {})).body as { code: string };
    expect(await server.call({ op: 'link', code, version: '1' })).toMatchObject({ ok: false, error: 'key_in_use' });
  });

  it('gives a new machine on the same account a new site', async () => {
    const account = await h.account(), first = new FakeServerKey(h), second = new FakeServerKey(h);
    await first.link(account.browser);
    await second.link(account.browser);
    expect(second.site).not.toBe(first.site);
    expect(await first.sync()).toMatchObject({ ok: false, error: 'unknown_server' });
  });
});

describe('who is calling', () => {
  it('knows callers only by their key', async () => {
    expect(await new FakeServerKey(h).sync()).toMatchObject({ ok: false, error: 'unknown_server' });
  });

  it('refuses a replayed message', async () => {
    const { server } = await h.aiCustomer('connect');
    const envelope = { v: 1, ts: Date.now(), nonce: toHex(randomBytes(16)), op: 'sync', devices: [], version: '1', lan: false };
    const ephemeral = randomBytes(32), hostedPublic = fromB64url(h.ctx.hostedPublic);
    const handshake = () => new Handshake(true, server.key, hostedPublic, RPC_PROLOGUE);
    const first = handshake(), second = handshake();
    const message = await first.writeFirst(encodeJson(envelope), ephemeral);
    expect(await second.writeFirst(encodeJson(envelope), ephemeral)).toEqual(message);
    const post = async () => new Uint8Array(await (await fetch(`${h.base}/v1/rpc`, { method: 'POST', body: Buffer.from(message), headers: { 'content-type': 'application/octet-stream' } })).arrayBuffer());
    expect(decodeJson<{ ok: boolean }>(await first.readSecond(await post())).ok).toBe(true);
    expect(decodeJson(await second.readSecond(await post()))).toEqual({ ok: false, error: 'stale' });
  });

  it('refuses a message outside the time window', async () => {
    const { server } = await h.aiCustomer('connect');
    const shake = new Handshake(true, server.key, fromB64url(h.ctx.hostedPublic), RPC_PROLOGUE);
    const message = await shake.writeFirst(encodeJson({ v: 1, ts: Date.now() - 10 * 60_000, nonce: toHex(randomBytes(16)), op: 'sync', devices: [] }));
    const res = await fetch(`${h.base}/v1/rpc`, { method: 'POST', body: Buffer.from(message) });
    expect(decodeJson(await shake.readSecond(new Uint8Array(await res.arrayBuffer())))).toEqual({ ok: false, error: 'stale' });
  });

  it('answers garbage with a plain 400', async () => {
    expect((await fetch(`${h.base}/v1/rpc`, { method: 'POST', body: Buffer.from('not noise at all, sorry about that, friend') })).status).toBe(400);
  });

  it('keeps nonces only for the window', async () => {
    const { sweep } = await import('../src/sweep.js');
    const { server } = await h.aiCustomer('connect');
    await server.sync();
    const before = (await h.db.query('select 1 from heyjosi.rpc_nonces')).length;
    expect(before).toBeGreaterThan(0);
    h.advance(60 * 60_000);
    await sweep(h.ctx);
    h.advance(-60 * 60_000);
    expect(await h.db.query('select 1 from heyjosi.rpc_nonces')).toHaveLength(0);
  });
});

describe('sync', () => {
  it('gives a free plan no grant and no AI, but its usage shape', async () => {
    const account = await h.account(), server = new FakeServerKey(h);
    await server.link(account.browser);
    const reply = await server.sync() as Record<string, unknown>;
    expect(reply).toMatchObject({ ok: true, plan: 'free', name: account.handle, grant: null, aiToken: null, aiBaseUrl: null, revoke: [] });
    expect((reply.usage as { models: unknown[] }).models).toEqual([{ id: 'gpt-5.6-luna', label: 'Luna', multiplier: 1, default: true }, { id: 'gpt-5.6-sol', label: 'Sol', multiplier: 1, default: false }]);
  });

  it('grants a Connect server seven days on its own site and name', async () => {
    const { account, server } = await h.aiCustomer('connect');
    const reply = await server.sync() as { grant: string; aiToken: string | null; plan: string };
    expect(reply.plan).toBe('connect');
    expect(reply.aiToken).toBeNull();
    const claims = readGrant(reply.grant);
    expect(claims).toMatchObject({ typ: 'relay-grant', site: server.site, name: account.handle });
    expect((claims.exp as number) - (claims.iat as number)).toBe(7 * 86_400);
    expect(Math.abs((claims.iat as number) - h.ctx.now() / 1000)).toBeLessThan(5);
  });

  it('stops granting when the plan lapses, without touching the relay', async () => {
    const account = await h.account();
    const sub = await h.subscribe(account.id, 'connect');
    const server = new FakeServerKey(h);
    await server.link(account.browser);
    expect(((await server.sync()) as { grant: string | null }).grant).toBeTruthy();
    h.subs.get(sub)!.status = 'canceled';
    h.calls = [];
    await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.deleted', data: { object: { id: sub } } });
    expect(h.calls.filter(call => call.url.includes('/names/revoke'))).toEqual([]);
    expect(await server.sync()).toMatchObject({ plan: 'free', grant: null });
  });

  it('stops granting a past-due plan', async () => {
    const account = await h.account();
    const sub = await h.subscribe(account.id, 'connect');
    const server = new FakeServerKey(h);
    await server.link(account.browser);
    h.subs.get(sub)!.status = 'past_due';
    await h.webhook({ id: h.id('evt_'), type: 'invoice.payment_failed', data: { object: { subscription: sub } } });
    expect(await server.sync()).toMatchObject({ plan: 'free', grant: null });
    expect(((await account.browser.get('/api/account')).body.plan as { paymentProblem: boolean }).paymentProblem).toBe(true);
  });

  it('stops trusting an "active" row long after its period ended', async () => {
    const { server } = await h.aiCustomer('connect');
    h.advance(34 * 86_400_000);
    expect(await server.sync()).toMatchObject({ plan: 'free', grant: null });
    h.advance(-34 * 86_400_000);
  });

  it('issues the AI token once, hashed, and again only after a reset', async () => {
    const { account, server, token } = await h.aiCustomer();
    expect(token).toMatch(/^hj_ai_/);
    expect(await h.dump()).not.toContain(token);
    expect(await server.sync()).toMatchObject({ aiToken: null, aiBaseUrl: 'https://heyjosi.test/ai/v1' });
    await account.browser.post('/api/ai-token/reset', {});
    const fresh = await server.sync() as { aiToken: string };
    expect(fresh.aiToken).toMatch(/^hj_ai_/);
    expect(fresh.aiToken).not.toBe(token);
    expect((await h.chat(token, { messages: [{ role: 'user', content: 'hi' }] })).status).toBe(401);
  });

  it('drops the AI token when AI ends, and issues a new one when it returns', async () => {
    const account = await h.account();
    const sub = await h.subscribe(account.id, 'connect_ai');
    const server = new FakeServerKey(h);
    await server.link(account.browser);
    const { aiToken: first } = await server.sync() as { aiToken: string };
    h.subs.get(sub)!.items.data[0]!.price.id = 'price_connect';
    await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.updated', data: { object: { id: sub } } });
    expect(await server.sync()).toMatchObject({ plan: 'connect', aiToken: null, aiBaseUrl: null });
    h.subs.get(sub)!.items.data[0]!.price.id = 'price_ai';
    await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.updated', data: { object: { id: sub } } });
    const { aiToken: second } = await server.sync() as { aiToken: string };
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('mirrors the server\'s device list', async () => {
    const { account, server } = await h.aiCustomer('connect');
    const device = (id: string) => ({ id, name: `Phone ${id}`, platform: 'ios', pairedAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null });
    await server.sync([device('a'), device('b')]);
    expect(((await account.browser.get('/api/account')).body.devices as unknown[])).toHaveLength(2);
    await server.sync([device('a')]);
    expect(((await account.browser.get('/api/account')).body.devices as Array<{ id: string }>).map(row => row.id)).toEqual(['a']);
  });
});

describe('revoking a device', () => {
  const device = { id: 'dev-1', name: 'Old phone', platform: 'android', pairedAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null };

  it('tells a connected server at once, over the tunnel with the hosted key', async () => {
    const { account, server } = await h.aiCustomer('connect');
    await server.sync([device]);
    const heard: Array<Record<string, unknown>> = [], from: string[] = [];
    h.fakeServer(server.site, server.key, async (hello, remote) => { heard.push(hello); from.push(toB64url(remote)); return { ok: true }; });
    const res = await account.browser.post('/api/devices/dev-1/revoke', {});
    expect(res.body).toEqual({ delivered: true });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ v: 1, op: 'revoke-device', device: 'dev-1' });
    expect(from[0]).toBe(h.ctx.hostedPublic);
  });

  it('carries it in the next sync when the server is offline, until the server reports it done', async () => {
    const { account, server } = await h.aiCustomer('connect');
    await server.sync([device]);
    expect((await account.browser.post('/api/devices/dev-1/revoke', {})).body).toEqual({ delivered: false });
    expect(await server.sync([device])).toMatchObject({ revoke: ['dev-1'] });
    expect(await server.sync([{ ...device, revokedAt: new Date().toISOString() }])).toMatchObject({ revoke: [] });
  });

  it('can\'t reach another account\'s device', async () => {
    const owner = await h.aiCustomer('connect');
    await owner.server.sync([device]);
    const other = await h.aiCustomer('connect');
    expect((await other.account.browser.post('/api/devices/dev-1/revoke', {})).status).toBe(404);
    expect(await owner.server.sync([device])).toMatchObject({ revoke: [] });
  });

  it('counts a server refusing the hosted key as not delivered', async () => {
    const { account, server } = await h.aiCustomer('connect');
    await server.sync([device]);
    h.fakeServer(server.site, server.key, async () => null);
    expect((await account.browser.post('/api/devices/dev-1/revoke', {})).body).toEqual({ delivered: false });
  });
});

describe('rotating the key', () => {
  it('moves to the new key and keeps the old one only for the overlap', async () => {
    const { server } = await h.aiCustomer('connect');
    const next = staticKeyFrom(generateKeyPair().privateKey), nextPublic = toB64url(next.publicKey);
    expect(await server.call({ op: 'rotate-key', publicKey: nextPublic })).toEqual({ ok: true });
    expect((await server.call({ op: 'sync', devices: [], version: '1', lan: false }, next)).ok).toBe(true);
    expect((await server.sync()).ok).toBe(true);
    // A lost reply: the old key asks again and is told it worked.
    expect(await server.call({ op: 'rotate-key', publicKey: nextPublic })).toEqual({ ok: true });
    // But the old key can't steer anything else.
    expect(await server.call({ op: 'rotate-key', publicKey: toB64url(generateKeyPair().publicKey) })).toMatchObject({ ok: false, error: 'stale_key' });
    h.advance(25 * 3_600_000);
    expect(await server.sync()).toMatchObject({ ok: false, error: 'unknown_server' });
    expect((await server.call({ op: 'sync', devices: [], version: '1', lan: false }, next)).ok).toBe(true);
    h.advance(-25 * 3_600_000);
  });

  it('refuses a key that can\'t be one, or one in use', async () => {
    const one = await h.aiCustomer('connect'), two = await h.aiCustomer('connect');
    expect(await one.server.call({ op: 'rotate-key', publicKey: toB64url(new Uint8Array(32)) })).toMatchObject({ error: 'bad_key' });
    expect(await one.server.call({ op: 'rotate-key', publicKey: 'short' })).toMatchObject({ error: 'bad_key' });
    expect(await one.server.call({ op: 'rotate-key', publicKey: two.server.publicKey })).toMatchObject({ error: 'key_in_use' });
  });
});

describe('unlinking', () => {
  it('forgets the server', async () => {
    const { account, server } = await h.aiCustomer('connect');
    expect(await server.call({ op: 'unlink' })).toEqual({ ok: true });
    expect(await server.sync()).toMatchObject({ error: 'unknown_server' });
    expect((await account.browser.get('/api/account')).body.server).toEqual({ linked: false });
  });
});

describe('a key in its overlap', () => {
  it('can\'t be taken by another server', async () => {
    const one = await h.aiCustomer('connect'), two = await h.aiCustomer('connect');
    const old = one.server.publicKey;
    expect(await one.server.call({ op: 'rotate-key', publicKey: toB64url(generateKeyPair().publicKey) })).toEqual({ ok: true });
    expect(await two.server.call({ op: 'rotate-key', publicKey: old })).toMatchObject({ error: 'key_in_use' });
  });
});

describe('the refresh key', () => {
  it('is good for google.refresh and nothing else', async () => {
    const { FakeServerKey } = await import('./helpers.js');
    const { generateKeyPair, staticKeyFrom, toB64url } = await import('@josi-ce/tunnel');
    const { server } = await h.aiCustomer('connect');
    const pair = generateKeyPair();
    await server.call({ op: 'sync', devices: [], version: 'test', lan: false, refreshKey: toB64url(pair.publicKey) });
    h.google = () => new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    const worker = new FakeServerKey(h);
    worker.key = staticKeyFrom(pair.privateKey);
    expect(await worker.call({ op: 'google.refresh', refreshToken: 'r', scopes: 'openid' })).toMatchObject({ ok: true, accessToken: 'fresh' });
    for (const call of [{ op: 'sync', devices: [], version: 'x', lan: false }, { op: 'rotate-key', publicKey: toB64url(generateKeyPair().publicKey) }, { op: 'unlink' }, { op: 'google.authorize', state: 's', codeChallenge: 'c'.repeat(43), scopes: 'openid' }] as const) {
      expect(await worker.call(call as never)).toMatchObject({ ok: false, error: 'unknown_server' });
    }
  });
});
