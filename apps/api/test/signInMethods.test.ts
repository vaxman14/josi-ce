import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { generate } from 'otplib';
import { MasterKey, initializeVault } from '@josi-ce/core';
import { beginMfaSetup, createSession, enableMfa, MAX_ATTEMPTS_PER_CODE, MAX_CODES_PER_EMAIL_PER_HOUR, MAX_CODES_PER_IP_PER_HOUR } from '@josi-ce/auth';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { NATIVE_PASSKEY_ADD_SCRIPT, NATIVE_PASSKEY_SCRIPT } from '../src/http/nativePasskeyPage.js';

const keyBytes = Buffer.alloc(32, 73), key = new MasterKey(keyBytes);
const keyPath = join(mkdtempSync(join(tmpdir(), 'josi-sign-in-')), 'master.key');
writeFileSync(keyPath, keyBytes.toString('base64'));
const password = 'synthetic-sign-in-password';
const ORIGIN = 'https://josi.fixture.test', RP_ID = 'josi.fixture.test';

let db: TestDb, server: Server, base: string, userId: string, session: string;
let sent: Array<{ to: string[]; subject: string; text: string }>;

/** A browser's cookies, and the CSRF pair the API wants on every POST. */
function browser(ip = '203.0.113.7') {
  const jar = new Map<string, string>();
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'x-forwarded-for': ip };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.has('josi_csrf')) headers['x-josi-csrf'] = jar.get('josi_csrf')!;
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of res.headers.getSetCookie()) { const [pair] = cookie.split(';'); const at = pair!.indexOf('='); jar.set(pair!.slice(0, at), pair!.slice(at + 1)); }
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  return { jar, get: (path: string) => call('GET', path), post: (path: string, body: unknown = {}) => call('POST', path, body), del: (path: string) => call('DELETE', path) };
}

async function signedIn(token: string) {
  const b = browser(); await b.get('/auth/csrf'); b.jar.set('josi_session', token); return b;
}

// A software authenticator: what a phone or a security key does, in thirty lines.
const cborHead = (major: number, n: number) => n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24, n]) : Buffer.from([major << 5 | 25, n >> 8, n & 255]);
const cborInt = (n: number) => n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n);
const cborBytes = (b: Buffer) => Buffer.concat([cborHead(2, b.length), b]);
const cborText = (s: string) => Buffer.concat([cborHead(3, s.length), Buffer.from(s)]);

function authenticator(rpId = RP_ID) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(32);
  const cose = Buffer.concat([cborHead(5, 5), cborInt(1), cborInt(2), cborInt(3), cborInt(-7), cborInt(-1), cborInt(1),
    cborInt(-2), cborBytes(Buffer.from(jwk.x!, 'base64url')), cborInt(-3), cborBytes(Buffer.from(jwk.y!, 'base64url'))]);
  const rpHash = createHash('sha256').update(rpId).digest();
  const count = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const clientData = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    credentialId,
    create(challenge: string, { origin = ORIGIN, flags = 0x45 } = {}) {
      const id = this.credentialId;
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), count(0), Buffer.alloc(16), Buffer.from([id.length >> 8, id.length & 255]), id, cose]);
      const attestationObject = Buffer.concat([cborHead(5, 3), cborText('fmt'), cborText('none'), cborText('attStmt'), cborHead(5, 0), cborText('authData'), cborBytes(authData)]);
      return { clientDataJSON: clientData('webauthn.create', challenge, origin).toString('base64url'), attestationObject: attestationObject.toString('base64url') };
    },
    get(challenge: string, { origin = ORIGIN, flags = 0x05, counter = 1, signer = privateKey as KeyObject } = {}) {
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), count(counter)]);
      const client = clientData('webauthn.get', challenge, origin);
      const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(client).digest()]), signer);
      return { credentialId: this.credentialId.toString('base64url'), clientDataJSON: client.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') };
    },
  };
}

async function start(extra: Record<string, unknown> = {}) {
  const app = createApp(db, { cookieSecure: false, appUrl: ORIGIN, masterKeyCheck: { path: keyPath }, mailTransport: { send: async (message: never) => { sent.push(message); return { messageId: 'x' }; } }, ...extra } as never);
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  sent = [];
  db = await testDb(); await ensureWorkspace(db);
  userId = (await createUser(db, { email: 'owner@fixture.test', username: 'owner', role: 'super_admin', password })).id;
  await initializeVault(db, key, userId);
  await db.query(`insert into smtp_profiles (kind, host, port, from_name, from_address) values ('system', 'mail.fixture.test', 587, 'Josi', 'josi@fixture.test')`);
  session = (await createSession(db, { userId })).token;
  await start();
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function registered(device = authenticator()) {
  const b = await signedIn(session);
  const { body } = await b.post('/auth/passkeys/options', { password });
  const added = await b.post('/auth/passkeys', { ...device.create(body.options.challenge), name: 'Test phone', transports: ['internal'] });
  expect(added.status).toBe(200);
  return { device, passkey: added.body.passkey };
}
async function challenge(b: ReturnType<typeof browser>) {
  await b.get('/auth/csrf');
  return (await b.post('/auth/passkey/options')).body.options.challenge as string;
}

describe('what the sign-in page offers', () => {
  it('reports passkeys and email codes when the server can do them', async () => {
    expect((await browser().get('/auth/methods')).body).toEqual({ passkey: true, passkeyOrigin: ORIGIN, emailCode: true, appleUrl: null });
  });

  it('hides each one when its feature is off', async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await start({ passkeysEnabled: false, emailCodesEnabled: false });
    const b = browser();
    expect((await b.get('/auth/methods')).body).toMatchObject({ passkey: false, passkeyOrigin: null, emailCode: false });
    await b.get('/auth/csrf');
    expect((await b.post('/auth/passkey/options')).status).toBe(404);
    expect((await b.post('/auth/email-code/request', { email: 'owner@fixture.test' })).status).toBe(404);
  });

  it('has no passkeys on a plain http address or a bare IP, which browsers refuse', async () => {
    for (const appUrl of ['http://josi.lan:8080', 'https://10.10.1.5']) {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await start({ appUrl });
      expect((await browser().get('/auth/methods')).body.passkey).toBe(false);
    }
  });

  it('has no email codes without a system mail profile', async () => {
    await db.query(`delete from smtp_profiles`);
    expect((await browser().get('/auth/methods')).body.emailCode).toBe(false);
  });
});

describe('passkeys', () => {
  it('registers with the password, then signs in with no other factor', async () => {
    const { device, passkey } = await registered();
    expect(passkey.name).toBe('Test phone');
    const b = browser();
    const result = await b.post('/auth/passkey/verify', device.get(await challenge(b)));
    expect(result.status).toBe(200);
    expect(result.body.user.email).toBe('owner@fixture.test');
    expect(b.jar.get('josi_session')).toBeTruthy();
    expect((await b.get('/auth/me')).status).toBe(200);
    const [row] = await db.query<{ last_used_at: string | null; sign_count: string }>('select last_used_at, sign_count from auth_passkeys');
    expect(row!.last_used_at).not.toBeNull();
    expect(Number(row!.sign_count)).toBe(1);
  });

  it('refuses to add one without the password', async () => {
    const b = await signedIn(session);
    expect((await b.post('/auth/passkeys/options', { password: 'not the password' })).status).toBe(401);
    expect((await b.post('/auth/passkeys/options', {})).status).toBe(401);
  });

  it('needs a session to add, list or remove one', async () => {
    const b = browser(); await b.get('/auth/csrf');
    expect((await b.post('/auth/passkeys/options', { password })).status).toBe(401);
    expect((await b.get('/auth/passkeys')).status).toBe(401);
  });

  it('refuses a registration answering someone else\'s challenge', async () => {
    const other = (await createUser(db, { email: 'other@fixture.test', username: 'other', role: 'member', password })).id;
    const mine = await signedIn(session), theirs = await signedIn((await createSession(db, { userId: other })).token);
    const { body } = await mine.post('/auth/passkeys/options', { password });
    expect((await theirs.post('/auth/passkeys', { ...authenticator().create(body.options.challenge), name: 'Theirs' })).status).toBe(400);
  });

  it('refuses a registration from another address or without user verification', async () => {
    const b = await signedIn(session);
    const first = (await b.post('/auth/passkeys/options', { password })).body.options.challenge;
    expect((await b.post('/auth/passkeys', { ...authenticator().create(first, { origin: 'https://evil.test' }), name: 'x' })).status).toBe(400);
    const second = (await b.post('/auth/passkeys/options', { password })).body.options.challenge;
    expect((await b.post('/auth/passkeys', { ...authenticator().create(second, { flags: 0x41 }), name: 'x' })).status).toBe(400);
    const third = (await b.post('/auth/passkeys/options', { password })).body.options.challenge;
    expect((await b.post('/auth/passkeys', { ...authenticator('other.test').create(third), name: 'x' })).status).toBe(400);
    expect(await db.query('select 1 from auth_passkeys')).toHaveLength(0);
  });

  it('refuses a control character in the name, and keeps the challenge', async () => {
    const b = await signedIn(session), device = authenticator();
    const value = (await b.post('/auth/passkeys/options', { password })).body.options.challenge;
    expect((await b.post('/auth/passkeys', { ...device.create(value), name: 'bad\u0000name' })).status).toBe(400);
    expect((await b.post('/auth/passkeys', { ...device.create(value), name: 'Good name', transports: ['bad\u0000', 'internal'] })).status).toBe(200);
  });

  it('refuses a credential ID past the limit in the spec', async () => {
    const b = await signedIn(session), device = authenticator();
    device.credentialId = randomBytes(1024);
    const value = (await b.post('/auth/passkeys/options', { password })).body.options.challenge;
    expect((await b.post('/auth/passkeys', { ...device.create(value), name: 'Too long' })).status).toBe(400);
  });

  it('uses a challenge once', async () => {
    const { device } = await registered();
    // A counter of 0 stays allowed, so only the spent challenge can stop this.
    const b = browser(), proof = device.get(await challenge(b), { counter: 0 });
    expect((await b.post('/auth/passkey/verify', proof)).status).toBe(200);
    expect((await b.post('/auth/passkey/verify', { ...proof })).status).toBe(401);
  });

  it('refuses an expired challenge', async () => {
    const { device } = await registered();
    const b = browser(), value = await challenge(b);
    await db.query(`update auth_passkey_challenges set expires_at = now() - interval '1 second' where used_at is null`);
    expect((await b.post('/auth/passkey/verify', device.get(value))).status).toBe(401);
  });

  it('refuses a made-up challenge, another address and a wrong key', async () => {
    const { device } = await registered();
    const b = browser();
    expect((await b.post('/auth/passkey/verify', (await (async () => { await b.get('/auth/csrf'); return device.get(randomBytes(32).toString('base64url')); })()))).status).toBe(401);
    expect((await b.post('/auth/passkey/verify', device.get(await challenge(b), { origin: 'https://evil.test' }))).status).toBe(401);
    expect((await b.post('/auth/passkey/verify', device.get(await challenge(b), { flags: 0x01 }))).status).toBe(401);
    const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect((await b.post('/auth/passkey/verify', device.get(await challenge(b), { signer: stranger }))).status).toBe(401);
    expect(b.jar.get('josi_session')).toBeUndefined();
  });

  it('refuses a key it does not know', async () => {
    const b = browser();
    expect((await b.post('/auth/passkey/verify', authenticator().get(await challenge(b)))).status).toBe(401);
  });

  it('checks the sign counter', async () => {
    const { device } = await registered();
    const b = browser();
    expect((await b.post('/auth/passkey/verify', device.get(await challenge(b), { counter: 5 }))).status).toBe(200);
    expect((await b.post('/auth/passkey/verify', device.get(await challenge(b), { counter: 5 }))).status).toBe(401);
    expect((await b.post('/auth/passkey/verify', device.get(await challenge(b), { counter: 3 }))).status).toBe(401);
    expect((await b.post('/auth/passkey/verify', device.get(await challenge(b), { counter: 6 }))).status).toBe(200);
  });

  it('accepts a synced passkey whose counter stays at 0', async () => {
    const { device } = await registered();
    const b = browser();
    for (let i = 0; i < 2; i++) expect((await b.post('/auth/passkey/verify', device.get(await challenge(b), { counter: 0 }))).status).toBe(200);
  });

  it('will not sign in a disabled account', async () => {
    const { device } = await registered();
    await db.query(`update users set status = 'disabled' where id = $1`, [userId]);
    const b = browser();
    expect((await b.post('/auth/passkey/verify', device.get(await challenge(b)))).status).toBe(401);
  });

  it('lists and removes only your own', async () => {
    const { passkey } = await registered();
    const other = (await createUser(db, { email: 'other@fixture.test', username: 'other', role: 'member', password })).id;
    const theirs = await signedIn((await createSession(db, { userId: other })).token), mine = await signedIn(session);
    expect((await theirs.get('/auth/passkeys')).body.passkeys).toEqual([]);
    expect((await theirs.del(`/auth/passkeys/${passkey.id}`)).status).toBe(404);
    expect((await mine.get('/auth/passkeys')).body.passkeys).toHaveLength(1);
    expect((await mine.del(`/auth/passkeys/${passkey.id}`)).status).toBe(200);
    expect((await mine.get('/auth/passkeys')).body.passkeys).toEqual([]);
  });
});

describe('email codes', () => {
  const codeIn = (message: { text: string }) => /\b(\d{6})\b/.exec(message.text)![1]!;
  async function requested(email = 'owner@fixture.test', b = browser()) {
    await b.get('/auth/csrf');
    const res = await b.post('/auth/email-code/request', { email });
    return { b, res };
  }

  it('mails a code that signs in once', async () => {
    const { b, res } = await requested('Owner@Fixture.test');
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.to).toEqual(['owner@fixture.test']);
    const code = codeIn(sent[0]!);
    const signed = await b.post('/auth/email-code/verify', { email: 'owner@fixture.test', code });
    expect(signed.status).toBe(200);
    expect(signed.body.user.username).toBe('owner');
    expect((await b.get('/auth/me')).status).toBe(200);
    const again = browser(); await again.get('/auth/csrf');
    expect((await again.post('/auth/email-code/verify', { email: 'owner@fixture.test', code })).status).toBe(401);
  });

  it('answers an unknown address exactly as it answers a real one', async () => {
    const real = await requested(), unknown = await requested('nobody@fixture.test', browser('203.0.113.8'));
    expect(unknown.res.status).toBe(real.res.status);
    expect(unknown.res.body).toEqual(real.res.body);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.to).toEqual(['owner@fixture.test']);
    expect((await unknown.b.post('/auth/email-code/verify', { email: 'nobody@fixture.test', code: '000000' })).status).toBe(401);
  });

  it('keeps no address that matched no account', async () => {
    await requested('nobody@fixture.test');
    const [row] = await db.query<Record<string, unknown>>('select * from auth_email_codes');
    expect(JSON.stringify(row)).not.toContain('nobody');
    expect(row!.code_hash).toBeNull();
  });

  it('expires after ten minutes', async () => {
    const { b } = await requested();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const [row] = await db.query<{ minutes: number }>(`select round(extract(epoch from expires_at - created_at) / 60)::int minutes from auth_email_codes`);
    expect(row!.minutes).toBe(10);
    await db.query(`update auth_email_codes set expires_at = now() - interval '1 second'`);
    expect((await b.post('/auth/email-code/verify', { email: 'owner@fixture.test', code: codeIn(sent[0]!) })).status).toBe(401);
  });

  it('stops accepting guesses, even the right one, after five wrong tries', async () => {
    const { b } = await requested();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const code = codeIn(sent[0]!), wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < MAX_ATTEMPTS_PER_CODE; i++) expect((await b.post('/auth/email-code/verify', { email: 'owner@fixture.test', code: wrong })).status).toBe(401);
    expect((await b.post('/auth/email-code/verify', { email: 'owner@fixture.test', code })).status).toBe(401);
  });

  it('holds a resend inside the cooldown without changing the answer, and a new code replaces the old', async () => {
    const { b, res } = await requested();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const quiet = await b.post('/auth/email-code/request', { email: 'owner@fixture.test' });
    expect(quiet.body).toEqual(res.body);
    expect(await db.query('select 1 from auth_email_codes')).toHaveLength(1);
    await db.query(`update auth_email_codes set created_at = now() - interval '2 minutes'`);
    await b.post('/auth/email-code/request', { email: 'owner@fixture.test' });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    if (codeIn(sent[0]!) !== codeIn(sent[1]!)) expect((await b.post('/auth/email-code/verify', { email: 'owner@fixture.test', code: codeIn(sent[0]!) })).status).toBe(401);
    expect((await b.post('/auth/email-code/verify', { email: 'owner@fixture.test', code: codeIn(sent[1]!) })).status).toBe(200);
  });

  it('limits per email, the same for a real address and an unknown one', async () => {
    for (const email of ['owner@fixture.test', 'nobody@fixture.test']) {
      const b = browser('203.0.113.9'); await b.get('/auth/csrf');
      for (let i = 0; i < MAX_CODES_PER_EMAIL_PER_HOUR; i++) {
        expect((await b.post('/auth/email-code/request', { email })).status).toBe(200);
        await db.query(`update auth_email_codes set created_at = now() - interval '2 minutes'`);
      }
      expect((await b.post('/auth/email-code/request', { email })).status).toBe(429);
    }
  });

  it('limits per IP across addresses', async () => {
    const b = browser('203.0.113.10'); await b.get('/auth/csrf');
    for (let i = 0; i < MAX_CODES_PER_IP_PER_HOUR; i++) expect((await b.post('/auth/email-code/request', { email: `person${i}@fixture.test` })).status).toBe(200);
    expect((await b.post('/auth/email-code/request', { email: 'one-more@fixture.test' })).status).toBe(429);
  });

  it('holds a burst of parallel requests to one code', async () => {
    const b = browser(); await b.get('/auth/csrf');
    await Promise.all(Array.from({ length: 12 }, () => b.post('/auth/email-code/request', { email: 'owner@fixture.test' })));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(await db.query('select 1 from auth_email_codes')).toHaveLength(1);
  });

  it('treats an address that only looks like an account as unknown', async () => {
    const { res } = await requested('owner@f\u0130xture.test');
    expect(res.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sent).toHaveLength(0);
    expect((await db.query<{ code_hash: string | null }>('select code_hash from auth_email_codes'))[0]!.code_hash).toBeNull();
  });

  it('counts a guess against an unknown address too', async () => {
    const { b } = await requested('nobody@fixture.test');
    await b.post('/auth/email-code/verify', { email: 'nobody@fixture.test', code: '000000' });
    expect((await db.query<{ attempts: number }>('select attempts from auth_email_codes'))[0]!.attempts).toBe(1);
  });

  it('refuses control characters rather than failing on them', async () => {
    const b = browser(); await b.get('/auth/csrf');
    expect((await b.post('/auth/email-code/request', { email: 'a\u0000@fixture.test' })).status).toBe(400);
  });

  it('still asks an account with an authenticator for its second factor', async () => {
    const secret = await beginMfaSetup(db, key, userId);
    await enableMfa(db, key, userId, await generate({ secret }));
    const { b } = await requested();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const first = await b.post('/auth/email-code/verify', { email: 'owner@fixture.test', code: codeIn(sent[0]!) });
    expect(first.status).toBe(202);
    expect(first.body.mfaRequired).toBe(true);
    expect(b.jar.get('josi_session')).toBeUndefined();
    const finished = await b.post('/auth/mfa/verify-login', { challenge: first.body.challenge, code: await generate({ secret }) });
    expect(finished.status).toBe(200);
    expect(b.jar.get('josi_session')).toBeTruthy();
  });

  it('needs the CSRF pair like every other sign-in', async () => {
    const res = await fetch(`${base}/api/auth/email-code/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
  });
});

const RETURN = 'josi://auth/callback', STATE = 'app-state_0123456789.~';

/** Runs a served bridge script against a stand-in browser. */
function runPage(fake: { get?: () => Promise<unknown>; create?: (options: any) => Promise<unknown>; verify?: { status: number; body: unknown }; options?: { status: number; body: unknown }; noWebAuthn?: boolean; script?: string; ticket?: string }) {
  const elements = new Map<string, { hidden: boolean; disabled: boolean; textContent: string; href: string; listeners: Array<() => unknown>; addEventListener: (type: string, fn: () => unknown) => void }>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      const made = { hidden: false, disabled: id === 'continue', textContent: '', href: '', listeners: [] as Array<() => unknown>, addEventListener(_type: string, fn: () => unknown) { made.listeners.push(fn); } };
      elements.set(id, made);
    }
    return elements.get(id)!;
  };
  const posted: Array<{ path: string; csrf: string; body: Record<string, unknown> }> = [];
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  const location = { search: `?state=${encodeURIComponent(STATE)}${fake.ticket ? `&ticket=${fake.ticket}` : ''}`, href: '' };
  const window = { PublicKeyCredential: fake.noWebAuthn ? undefined : class {} };
  runInNewContext(fake.script ?? NATIVE_PASSKEY_SCRIPT, {
    location, window, URLSearchParams, Uint8Array, atob, btoa, JSON, String,
    document: { getElementById: element },
    navigator: { credentials: { get: fake.get, create: fake.create } },
    fetch: async (path: string, init?: { method?: string; headers: Record<string, string>; body: string }) => {
      if (path === '/api/auth/csrf') return reply(200, { csrfToken: 'csrf-token' });
      posted.push({ path, csrf: init!.headers['x-josi-csrf']!, body: JSON.parse(init!.body) as Record<string, unknown> });
      if (path.endsWith('/options')) return fake.options ? reply(fake.options.status, fake.options.body) : reply(200, { options: { challenge: 'AQID', rpId: RP_ID, userVerification: 'required', timeout: 1000, allowCredentials: [], user: { id: 'AQI', name: 'owner', displayName: 'owner' }, excludeCredentials: [{ type: 'public-key', id: 'BAU' }] } });
      return reply(fake.verify!.status, fake.verify!.body);
    },
  });
  const press = async (id: string) => { await vi.waitFor(() => expect(element('continue').disabled).toBe(false)); for (const listener of element(id).listeners) await listener(); };
  return { location, posted, element, press };
}

describe('a passkey for a native app', () => {
  const startPath = (query: string) => `${base}/api/auth/passkey/native/start?${query}`;
  const goodQuery = `redirect_uri=${encodeURIComponent(RETURN)}&state=${encodeURIComponent(STATE)}`;
  const native = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-josi-client': 'native', ...headers }, body: JSON.stringify(body),
  });
  const sessionCount = async () => (await db.query<{ n: number }>('select count(*)::int n from sessions'))[0]!.n;
  const events = async (kind: string) => db.query('select 1 from events where kind = $1', [kind]);

  /** Everything the bridge page does, in order, keeping the raw cookies it was sent. */
  async function bridge(device: ReturnType<typeof authenticator>, state: unknown = STATE, proofOptions: Parameters<ReturnType<typeof authenticator>['get']>[1] = {}) {
    const b = browser();
    const proof = device.get(await challenge(b), proofOptions);
    const res = await fetch(`${base}/api/auth/passkey/native/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', 'x-josi-csrf': b.jar.get('josi_csrf')!, cookie: `josi_csrf=${b.jar.get('josi_csrf')}` },
      body: JSON.stringify({ ...proof, state }),
    });
    return { res, setCookies: res.headers.getSetCookie(), body: await res.json().catch(() => null) as any };
  }
  const codeFrom = (redirect: string) => new URL(redirect).searchParams.get('code')!;

  describe('the start page', () => {
    it('allows only the exact app callback', async () => {
      for (const redirect of ['https://attacker.test/callback', 'josi://evil/callback', 'josi://auth/callback/extra', 'josi://auth/callback?next=https://attacker.test', 'JOSI://auth/callback', '']) {
        const res = await fetch(startPath(`redirect_uri=${encodeURIComponent(redirect)}&state=${STATE}`), { redirect: 'manual' });
        expect(res.status, redirect).toBe(400);
        expect(res.headers.get('content-type'), redirect).toContain('json');
      }
      expect((await fetch(startPath(`state=${STATE}`), { redirect: 'manual' })).status).toBe(400);
      const twice = `redirect_uri=${encodeURIComponent(RETURN)}&redirect_uri=${encodeURIComponent('https://attacker.test/')}&state=${STATE}`;
      expect((await fetch(startPath(twice), { redirect: 'manual' })).status).toBe(400);
    });

    it('needs a state it can hand back safely', async () => {
      for (const state of ['', 'a'.repeat(513), 'line%0Abreak', 'with%20space']) {
        const res = await fetch(startPath(`redirect_uri=${encodeURIComponent(RETURN)}&state=${state}`), { redirect: 'manual' });
        expect(res.status, state).toBe(400);
      }
      expect((await fetch(startPath(`redirect_uri=${encodeURIComponent(RETURN)}`), { redirect: 'manual' })).status).toBe(400);
    });

    it('serves a page the content security policy lets run, on the Plum & Gold colours', async () => {
      const res = await fetch(startPath(goodQuery));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      const policy = res.headers.get('content-security-policy')!;
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
      const html = await res.text();
      // Every script is an external same-origin file, because an inline one is blocked.
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(match => match[0]);
      expect(scripts).toEqual(['<script src="/api/auth/passkey/native/page.js" defer>']);
      expect(html).not.toMatch(/\son[a-z]+=/);
      for (const colour of ['#150B19', '#2C1A33', '#F3E9F2', '#F0CF7A']) expect(html).toContain(colour);

      const script = await fetch(`${base}/api/auth/passkey/native/page.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toContain('text/javascript');
      expect(script.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await script.text()).toContain('navigator.credentials.get');
    });

    it('writes nothing from the request into the page', async () => {
      const probe = '"><script>alert(1)</script>';
      const res = await fetch(startPath(`redirect_uri=${encodeURIComponent(RETURN)}&state=${encodeURIComponent(probe.replace(/ /g, ''))}`));
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('alert(1)');
    });

    it('sets no cookie of any kind', async () => {
      expect((await fetch(startPath(goodQuery))).headers.getSetCookie()).toEqual([]);
    });

    it('sends the app straight back when this server has no passkeys', async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await start({ passkeysEnabled: false });
      const res = await fetch(startPath(goodQuery), { redirect: 'manual' });
      expect(res.status).toBe(302);
      const back = new URL(res.headers.get('location')!);
      expect(`${back.protocol}//${back.host}${back.pathname}`).toBe(RETURN);
      expect(back.searchParams.get('error')).toBe('passkey_failed');
      expect(back.searchParams.get('state')).toBe(STATE);
    });
  });

  describe('after the passkey verifies', () => {
    it('gives a one-time code for the app and no browser session', async () => {
      const { device } = await registered();
      const before = await sessionCount();
      const { res, setCookies, body } = await bridge(device);
      expect(res.status).toBe(200);
      expect(body.redirect.startsWith(`${RETURN}?`)).toBe(true);
      const back = new URL(body.redirect);
      expect(back.searchParams.get('state')).toBe(STATE);
      expect(back.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(body.redirect).not.toContain('sessionToken');

      expect(setCookies.filter(cookie => cookie.startsWith('josi_session'))).toEqual([]);
      expect(await sessionCount()).toBe(before);
      expect(await events('auth.passkey_login')).toHaveLength(0);
      expect(await events('auth.passkey_native_code_issued')).toHaveLength(1);

      const code = codeFrom(body.redirect);
      const [stored] = await db.query<{ code_hash: string; user_id: string; minutes: number }>(
        `select code_hash, user_id, round(extract(epoch from expires_at - now()) / 60)::int minutes from auth_native_codes`,
      );
      expect(stored!.code_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored!.code_hash).not.toBe(code);
      expect(stored!.user_id).toBe(userId);
      expect(stored!.minutes).toBe(2);
    });

    it('redeems the code once at the neutral route, and logs it as no provider in particular', async () => {
      const { device } = await registered();
      const { body } = await bridge(device);
      const code = codeFrom(body.redirect);

      const exchange = await native('/auth/native/exchange', { code });
      expect(exchange.status).toBe(200);
      const signed = await exchange.json() as any;
      expect(signed.user.id).toBe(userId);
      expect(signed.user.email).toBe('owner@fixture.test');
      expect(signed.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      const me = await fetch(`${base}/api/auth/me`, { headers: { 'x-josi-client': 'native', authorization: `Bearer ${signed.sessionToken}` } });
      expect(me.status).toBe(200);
      expect(await events('auth.native_login')).toHaveLength(1);
      expect(await events('auth.google_native_login')).toHaveLength(0);

      expect((await native('/auth/native/exchange', { code })).status).toBe(401);
      expect((await native('/auth/google/native/exchange', { code })).status).toBe(401);
    });

    it('also redeems at the Google route, once', async () => {
      const { device } = await registered();
      const code = codeFrom((await bridge(device)).body.redirect);
      expect((await native('/auth/google/native/exchange', { code })).status).toBe(200);
      expect((await native('/auth/native/exchange', { code })).status).toBe(401);
    });

    it('does not ask an account with an authenticator for its code', async () => {
      const secret = await beginMfaSetup(db, key, userId);
      await enableMfa(db, key, userId, await generate({ secret }));
      const { device } = await registered();
      const exchange = await native('/auth/native/exchange', { code: codeFrom((await bridge(device)).body.redirect) });
      expect(exchange.status).toBe(200);
      expect((await exchange.json() as any).sessionToken).toBeTruthy();
    });

    it('still asks for the code when the same code did not come from a passkey', async () => {
      const secret = await beginMfaSetup(db, key, userId);
      await enableMfa(db, key, userId, await generate({ secret }));
      const code = randomBytes(32).toString('base64url');
      await db.query(`insert into auth_native_codes (code_hash, user_id, expires_at) values ($1, $2, now() + interval '2 minutes')`,
        [createHash('sha256').update(code).digest('hex'), userId]);
      const exchange = await native('/auth/native/exchange', { code });
      expect(exchange.status).toBe(202);
      expect((await exchange.json() as any).sessionToken).toBeUndefined();
    });

    it('only a native client can redeem it', async () => {
      const { device } = await registered();
      const code = codeFrom((await bridge(device)).body.redirect);
      const b = browser(); await b.get('/auth/csrf');
      expect((await b.post('/auth/native/exchange', { code })).status).toBe(403);
      expect((await native('/auth/native/exchange', { code }, { origin: ORIGIN })).status).toBe(403);
      expect((await native('/auth/native/exchange', { code })).status).toBe(200);
    });

    it('refuses an expired code, a made-up code and no code', async () => {
      const { device } = await registered();
      const code = codeFrom((await bridge(device)).body.redirect);
      await db.query(`update auth_native_codes set expires_at = now() - interval '1 second'`);
      expect((await native('/auth/native/exchange', { code })).status).toBe(401);
      expect((await native('/auth/native/exchange', { code: randomBytes(32).toString('base64url') })).status).toBe(401);
      expect((await native('/auth/native/exchange', {})).status).toBe(400);
    });

    it('will not let a code outlive the account', async () => {
      const { device } = await registered();
      const code = codeFrom((await bridge(device)).body.redirect);
      await db.query(`update users set status = 'disabled' where id = $1`, [userId]);
      expect((await native('/auth/native/exchange', { code })).status).toBe(401);
    });

    it('takes the return address from nowhere but the server', async () => {
      const { device } = await registered();
      const b = browser(), proof = device.get(await challenge(b));
      const res = await b.post('/auth/passkey/native/verify', { ...proof, state: STATE, redirect_uri: 'https://attacker.test/', redirect: 'https://attacker.test/' });
      expect(res.status).toBe(200);
      expect(res.body.redirect.startsWith(`${RETURN}?`)).toBe(true);
    });
  });

  describe('when it does not verify', () => {
    const expectFailed = async (result: Awaited<ReturnType<typeof bridge>>, status = 401) => {
      expect(result.res.status).toBe(status);
      const back = new URL(result.body.redirect);
      expect(`${back.protocol}//${back.host}${back.pathname}`).toBe(RETURN);
      expect(back.searchParams.get('error')).toBe('passkey_failed');
      expect(back.searchParams.get('state')).toBe(STATE);
      expect(back.searchParams.has('code')).toBe(false);
      expect(await db.query('select 1 from auth_native_codes')).toHaveLength(0);
      expect(await events('auth.passkey_native_code_issued')).toHaveLength(0);
      expect(result.setCookies.filter(cookie => cookie.startsWith('josi_session'))).toEqual([]);
    };

    it('sends the app an error for a key it does not know', async () => {
      await expectFailed(await bridge(authenticator()));
    });

    it('sends the app an error for a wrong signature, origin or missing verification', async () => {
      const { device } = await registered();
      await expectFailed(await bridge(device, STATE, { signer: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }));
      await expectFailed(await bridge(device, STATE, { origin: 'https://evil.test' }));
      await expectFailed(await bridge(device, STATE, { flags: 0x01 }));
    });

    it('sends the app an error for a disabled account', async () => {
      const { device } = await registered();
      await db.query(`update users set status = 'disabled' where id = $1`, [userId]);
      await expectFailed(await bridge(device));
    });

    it('uses a challenge once', async () => {
      const { device } = await registered();
      const b = browser(), proof = device.get(await challenge(b), { counter: 0 });
      expect((await b.post('/auth/passkey/native/verify', { ...proof, state: STATE })).status).toBe(200);
      const again = await b.post('/auth/passkey/native/verify', { ...proof, state: STATE });
      expect(again.status).toBe(401);
      expect(new URL(again.body.redirect).searchParams.get('error')).toBe('passkey_failed');
    });

    it('shares the sign-in limit, and still tells the app where to go', async () => {
      const { device } = await registered();
      for (let i = 0; i < 8; i++) await bridge(authenticator());
      const limited = await bridge(device);
      expect(limited.res.status).toBe(429);
      expect(limited.res.headers.get('retry-after')).toBeTruthy();
      expect(new URL(limited.body.redirect).searchParams.get('error')).toBe('passkey_failed');
    });

    it('refuses a request without a state before spending the challenge', async () => {
      const { device } = await registered();
      const missing = await bridge(device, null);
      expect(missing.res.status).toBe(400);
      expect(missing.body.redirect).toBeUndefined();
      expect((await bridge(device, 'bad\nstate')).res.status).toBe(400);
      expect(await db.query('select 1 from auth_passkey_challenges where used_at is not null and purpose = $1', ['login'])).toHaveLength(0);
    });

    it('needs the CSRF pair like every other sign-in', async () => {
      const res = await fetch(`${base}/api/auth/passkey/native/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(403);
    });
  });

  describe('what the app is told', () => {
    it('reports the flag and the start address', async () => {
      const res = await fetch(`${base}/api/auth/native/config`);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toMatchObject({ passkeySignIn: true, nativePasskeyStart: `${ORIGIN}/api/auth/passkey/native/start` });
    });

    it('reports false when passkeys are off, or the address cannot have them', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ passkeysEnabled: false }, ORIGIN], [{ appUrl: 'http://josi.lan:8080' }, 'http://josi.lan:8080'], [{ appUrl: 'https://10.10.1.5/' }, 'https://10.10.1.5'],
      ];
      for (const [config, appUrl] of cases) {
        await new Promise<void>(resolve => server.close(() => resolve()));
        await start(config);
        const body = await (await fetch(`${base}/api/auth/native/config`)).json() as any;
        expect(body.passkeySignIn, appUrl).toBe(false);
        expect(body.nativePasskeyStart, appUrl).toBe(`${appUrl}/api/auth/passkey/native/start`);
      }
    });
  });

  describe('the page script', () => {
    const bytes = (...values: number[]) => new Uint8Array(values).buffer;
    const credential = { rawId: bytes(1, 2), response: { clientDataJSON: bytes(3), authenticatorData: bytes(4), signature: bytes(5), userHandle: bytes(6) } };
    const named = (name: string) => Object.assign(new Error(name), { name });
    const errorUrl = (error: string) => `${RETURN}?${new URLSearchParams({ error, state: STATE })}`;

    it('goes where the server says after a verified passkey, with the fields it wants', async () => {
      const target = `${RETURN}?code=abc&state=${STATE}`;
      const page = runPage({ get: async () => credential, verify: { status: 200, body: { redirect: target } } });
      await page.press('continue');
      expect(page.location.href).toBe(target);
      expect(page.element('back').href).toBe(target);
      expect(page.element('back').hidden).toBe(false);
      const verify = page.posted.at(-1)!;
      expect(verify.path).toBe('/api/auth/passkey/native/verify');
      expect(verify.csrf).toBe('csrf-token');
      expect(verify.body).toEqual({ state: STATE, credentialId: 'AQI', clientDataJSON: 'Aw', authenticatorData: 'BA', signature: 'BQ', userHandle: 'Bg' });
    });

    it('reports a dismissed prompt as cancelled', async () => {
      for (const name of ['NotAllowedError', 'AbortError']) {
        const page = runPage({ get: async () => { throw named(name); } });
        await page.press('continue');
        expect(page.location.href, name).toBe(errorUrl('passkey_cancelled'));
      }
    });

    it('reports the Cancel button as cancelled', async () => {
      const page = runPage({ get: async () => credential });
      await page.press('cancel');
      expect(page.location.href).toBe(errorUrl('passkey_cancelled'));
      expect(new URL(page.location.href).searchParams.get('state')).toBe(STATE);
    });

    it('reports anything else as failed', async () => {
      const failed = errorUrl('passkey_failed');
      const threw = runPage({ get: async () => { throw named('SecurityError'); } });
      await threw.press('continue');
      expect(threw.location.href).toBe(failed);
      const refused = runPage({ get: async () => credential, verify: { status: 401, body: { error: 'no', redirect: failed } } });
      await refused.press('continue');
      expect(refused.location.href).toBe(failed);
      const broken = runPage({ get: async () => credential, verify: { status: 500, body: null } });
      await broken.press('continue');
      expect(broken.location.href).toBe(failed);
    });

    it('will not follow a redirect that is not the app', async () => {
      const page = runPage({ get: async () => credential, verify: { status: 200, body: { redirect: 'https://attacker.test/' } } });
      await page.press('continue');
      expect(page.location.href).toBe(errorUrl('passkey_failed'));
    });

    it('fails at once when the browser has no passkeys or the server starts none', async () => {
      const failed = errorUrl('passkey_failed');
      const old = runPage({ get: async () => credential, noWebAuthn: true });
      await vi.waitFor(() => expect(old.location.href).toBe(failed));
      const limited = runPage({ get: async () => credential, options: { status: 400, body: { error: 'Too many passkey attempts.' } } });
      await vi.waitFor(() => expect(limited.location.href).toBe(failed));
    });
  });
});

describe('adding a passkey from a native app', () => {
  const LABEL = 'Roman\u2019s MacBook';
  const enrol = (body: Record<string, unknown>, headers: Record<string, string> = { 'x-josi-client': 'native', authorization: `Bearer ${session}` }) =>
    fetch(`${base}/api/auth/passkey/native/enrol`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const events = async (kind: string) => db.query('select 1 from events where kind = $1', [kind]);
  const sessionCount = async () => (await db.query<{ n: number }>('select count(*)::int n from sessions'))[0]!.n;

  async function ticketed(name = LABEL, state = STATE) {
    const res = await enrol({ password, name, state });
    expect(res.status).toBe(200);
    const url = new URL((await res.json() as { url: string }).url);
    return { url, ticket: url.searchParams.get('ticket')!, state: url.searchParams.get('state')! };
  }
  const openPage = (ticket: string, state = STATE) => fetch(`${base}/api/auth/passkey/native/add?${new URLSearchParams({ ticket, state })}`, { redirect: 'manual' });

  /** What the page does: the CSRF pair, the options, then the answer. */
  async function page(ticket: string, state = STATE) {
    const b = browser(); await b.get('/auth/csrf');
    const options = await b.post('/auth/passkey/native/add/options', { ticket, state });
    return { b, options, finish: (proof: unknown) => b.post('/auth/passkey/native/add/finish', { ticket, state, ...(proof as object) }) };
  }
  const expectPlainFailure = (redirect: string) => {
    const back = new URL(redirect);
    expect(`${back.protocol}//${back.host}${back.pathname}`).toBe(RETURN);
    expect(back.searchParams.get('error')).toBe('passkey_failed');
    expect(back.searchParams.get('state')).toBe(STATE);
    expect(back.searchParams.has('added')).toBe(false);
  };
  const expectNothingAdded = async () => expect(await db.query('select 1 from auth_passkeys')).toHaveLength(0);

  describe('asking for a ticket', () => {
    it('gives a short-lived ticket on the server\'s own address, stored only as a hash', async () => {
      const { url, ticket, state } = await ticketed();
      expect(url.origin).toBe(ORIGIN);
      expect(url.pathname).toBe('/api/auth/passkey/native/add');
      expect([...url.searchParams.keys()].sort()).toEqual(['state', 'ticket']);
      expect(state).toBe(STATE);
      const rows = await db.query<{ challenge_hash: string; purpose: string; user_id: string; seconds: number }>(
        `select challenge_hash, purpose, user_id, round(extract(epoch from expires_at - created_at))::int seconds from auth_passkey_challenges`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.challenge_hash).toMatch(/^ticket:[a-f0-9]{64}$/);
      expect(JSON.stringify(rows)).not.toContain(ticket);
      expect(rows[0]!.user_id).toBe(userId);
      expect(rows[0]!.seconds).toBe(300);
      expect(await events('auth.passkey_add_ticket_issued')).toHaveLength(1);
      expect(JSON.stringify(await db.query('select * from events'))).not.toContain(ticket);
    });

    it('needs a native client with a bearer session', async () => {
      expect((await enrol({ password, name: LABEL, state: STATE }, {})).status).toBe(403);
      // No bearer means no exemption from CSRF, so this stops before the route.
      expect((await enrol({ password, name: LABEL, state: STATE }, { 'x-josi-client': 'native' })).status).toBe(403);
      expect((await enrol({ password, name: LABEL, state: STATE }, { 'x-josi-client': 'native', authorization: 'Bearer not-a-session' })).status).toBe(401);
      const b = await signedIn(session);
      expect((await b.post('/auth/passkey/native/enrol', { password, name: LABEL, state: STATE })).status).toBe(403);
      expect(await db.query('select 1 from auth_passkey_challenges')).toHaveLength(0);
    });

    it('needs the password, and counts a wrong one on the same limit as the browser route', async () => {
      const wrong = await enrol({ password: 'not the password', name: LABEL, state: STATE });
      expect(wrong.status).toBe(401);
      expect(await db.query('select 1 from auth_passkey_challenges')).toHaveLength(0);
      for (let i = 0; i < 7; i++) await enrol({ password: 'not the password', name: LABEL, state: STATE });
      const limited = await enrol({ password, name: LABEL, state: STATE });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
      const b = await signedIn(session);
      expect((await b.post('/auth/passkeys/options', { password })).status).toBe(429);
    });

    it('refuses a bad state or label before spending a password guess', async () => {
      for (const body of [{ name: LABEL }, { name: LABEL, state: 'bad\nstate' }, { state: STATE }, { name: '   ', state: STATE }, { name: 'bad\u0000name', state: STATE }]) {
        expect((await enrol({ password: 'not the password', ...body })).status, JSON.stringify(body)).toBe(400);
      }
      expect(await db.query(`select 1 from login_attempts where identifier like 'passkey-add:%'`)).toHaveLength(0);
    });

    it('answers 404 when this server has no passkeys', async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await start({ passkeysEnabled: false });
      expect((await enrol({ password, name: LABEL, state: STATE })).status).toBe(404);
    });

    it('replaces a ticket the person still holds', async () => {
      const first = await ticketed(), second = await ticketed();
      expect((await openPage(first.ticket)).status).toBe(302);
      expect((await openPage(second.ticket)).status).toBe(200);
    });
  });

  describe('the page', () => {
    it('serves under the policy, on the Plum & Gold colours, and sets no cookie', async () => {
      const { ticket } = await ticketed();
      const res = await openPage(ticket);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(res.headers.getSetCookie()).toEqual([]);
      const html = await res.text();
      expect([...html.matchAll(/<script\b[^>]*>/g)].map(match => match[0])).toEqual(['<script src="/api/auth/passkey/native/add.js" defer>']);
      expect(html).toContain('>Add passkey<');
      expect(html).not.toContain(ticket);
      for (const colour of ['#150B19', '#2C1A33', '#F3E9F2', '#F0CF7A']) expect(html).toContain(colour);
      const script = await fetch(`${base}/api/auth/passkey/native/add.js`);
      expect(script.headers.get('content-type')).toContain('text/javascript');
      expect(await script.text()).toContain('navigator.credentials.create');
    });

    it('costs nothing to open, so a reload still works', async () => {
      const { ticket } = await ticketed();
      expect((await openPage(ticket)).status).toBe(200);
      expect((await openPage(ticket)).status).toBe(200);
    });

    it('answers a wrong, expired or used ticket the same way, with nothing to tell them apart', async () => {
      const answers: Array<string | null> = [];
      const ask = async (ticket: string) => {
        const res = await openPage(ticket);
        expect(res.status).toBe(302);
        answers.push(res.headers.get('location'));
      };
      await ask('made-up');
      await ask(`${randomBytes(32).toString('base64url')}.${Buffer.from(LABEL).toString('base64url')}`);
      const expired = await ticketed();
      await db.query(`update auth_passkey_challenges set expires_at = now() - interval '1 second'`);
      await ask(expired.ticket);
      const used = await ticketed(), device = authenticator(), { options, finish } = await page(used.ticket);
      expect((await finish(device.create(options.body.options.challenge))).status).toBe(200);
      await ask(used.ticket);
      expectPlainFailure(answers[0]!);
      expect(new Set(answers).size).toBe(1);
    });

    it('needs a state before it answers at all', async () => {
      const { ticket } = await ticketed();
      expect((await fetch(`${base}/api/auth/passkey/native/add?ticket=${ticket}`, { redirect: 'manual' })).status).toBe(400);
    });
  });

  describe('finishing', () => {
    it('adds the passkey to that person, with the label from the app, and no session', async () => {
      const { ticket } = await ticketed();
      const before = await sessionCount();
      const device = authenticator(), { b, options, finish } = await page(ticket);
      expect(options.status).toBe(200);
      expect(options.body.options.user.name).toBe('owner@fixture.test');
      const done = await finish({ ...device.create(options.body.options.challenge), transports: ['internal'] });
      expect(done.status).toBe(200);
      const back = new URL(done.body.redirect);
      expect(`${back.protocol}//${back.host}${back.pathname}`).toBe(RETURN);
      expect(back.searchParams.get('added')).toBe('1');
      expect(back.searchParams.get('state')).toBe(STATE);
      expect(back.searchParams.has('code')).toBe(false);

      const [saved] = await db.query<{ user_id: string; name: string; transports: string[] }>('select user_id, name, transports from auth_passkeys');
      expect(saved).toEqual({ user_id: userId, name: LABEL, transports: ['internal'] });
      expect(b.jar.has('josi_session')).toBe(false);
      expect(await sessionCount()).toBe(before);
      expect(await events('auth.passkey_added')).toHaveLength(1);
      expect(await db.query('select 1 from auth_native_codes')).toHaveLength(0);
    });

    it('leaves a passkey that really signs in', async () => {
      const { ticket } = await ticketed();
      const device = authenticator(), { options, finish } = await page(ticket);
      await finish(device.create(options.body.options.challenge));
      const b = browser();
      expect((await b.post('/auth/passkey/verify', device.get(await challenge(b)))).status).toBe(200);
    });

    it('works once', async () => {
      const { ticket } = await ticketed();
      const device = authenticator(), { options, finish } = await page(ticket);
      const proof = device.create(options.body.options.challenge);
      expect((await finish(proof)).status).toBe(200);
      const again = await finish(proof);
      expect(again.status).toBe(401);
      expectPlainFailure(again.body.redirect);
      expect((await page(ticket)).options.status).toBe(401);
      expect(await db.query('select 1 from auth_passkeys')).toHaveLength(1);
    });

    it('lets one of two racing calls win', async () => {
      const { ticket } = await ticketed();
      const first = await page(ticket), second = await page(ticket), device = authenticator(), other = authenticator();
      const results = await Promise.all([
        first.finish(device.create(first.options.body.options.challenge)),
        second.finish(other.create(second.options.body.options.challenge)),
      ]);
      expect(results.map(result => result.status).sort()).toEqual([200, 401]);
      expect(await db.query('select 1 from auth_passkeys')).toHaveLength(1);
    });

    it('spends the ticket on a response that does not verify', async () => {
      const { ticket } = await ticketed();
      const device = authenticator(), { options, finish } = await page(ticket);
      const value = options.body.options.challenge;
      for (const [proof, status] of [[device.create(value, { origin: 'https://evil.test' }), 400], [device.create(value), 401]] as const) {
        const result = await finish(proof);
        expect(result.status).toBe(status);
        expectPlainFailure(result.body.redirect);
      }
      await expectNothingAdded();
    });

    it('refuses a response without user verification', async () => {
      const { ticket } = await ticketed();
      const { options, finish } = await page(ticket);
      const result = await finish(authenticator().create(options.body.options.challenge, { flags: 0x41 }));
      expect(result.status).toBe(400);
      await expectNothingAdded();
    });

    it('refuses an expired ticket, however far the page got', async () => {
      const { ticket } = await ticketed();
      const { options, finish } = await page(ticket);
      await db.query(`update auth_passkey_challenges set expires_at = now() - interval '1 second' where challenge_hash like 'ticket:%'`);
      const late = await finish(authenticator().create(options.body.options.challenge));
      expect(late.status).toBe(401);
      expectPlainFailure(late.body.redirect);
      await expectNothingAdded();
    });

    it('refuses a ticket with another state, or with its label changed', async () => {
      const { ticket } = await ticketed();
      expect((await page(ticket, 'another-state')).options.status).toBe(401);
      const [secret] = ticket.split('.');
      expect((await page(`${secret}.${Buffer.from('Someone else').toString('base64url')}`)).options.status).toBe(401);
      expect((await openPage(ticket, 'another-state')).status).toBe(302);
      expect((await openPage(ticket)).status).toBe(200);
    });

    it('stops working if the account is disabled', async () => {
      const { ticket } = await ticketed();
      const { options, finish } = await page(ticket);
      await db.query(`update users set status = 'disabled' where id = $1`, [userId]);
      expect((await openPage(ticket)).status).toBe(302);
      expect((await page(ticket)).options.status).toBe(401);
      expect((await finish(authenticator().create(options.body.options.challenge))).status).toBe(401);
    });

    it('is only good for adding a passkey', async () => {
      const { ticket } = await ticketed();
      const native = (path: string, body: unknown) => fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-josi-client': 'native' }, body: JSON.stringify(body) });
      expect((await native('/auth/native/exchange', { code: ticket })).status).toBe(401);
      expect((await native('/auth/google/native/exchange', { code: ticket })).status).toBe(401);
      // Neither the ticket nor what it is stored under can stand in for a challenge.
      const b = await signedIn(session), device = authenticator();
      expect((await b.post('/auth/passkeys', { ...device.create(ticket), name: 'x' })).status).toBe(400);
      const [row] = await db.query<{ challenge_hash: string }>('select challenge_hash from auth_passkey_challenges');
      expect((await b.post('/auth/passkeys', { ...device.create(row!.challenge_hash), name: 'x' })).status).toBe(400);
      await expectNothingAdded();
      expect((await openPage(ticket)).status).toBe(200);
    });

    it('a browser challenge is not a ticket', async () => {
      const b = await signedIn(session);
      const value = (await b.post('/auth/passkeys/options', { password })).body.options.challenge;
      expect((await page(value)).options.status).toBe(401);
    });

    it('needs the CSRF pair and a state', async () => {
      const { ticket } = await ticketed();
      for (const path of ['options', 'finish']) {
        const res = await fetch(`${base}/api/auth/passkey/native/add/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, state: STATE }) });
        expect(res.status, path).toBe(403);
      }
      const b = browser(); await b.get('/auth/csrf');
      expect((await b.post('/auth/passkey/native/add/options', { ticket })).status).toBe(400);
      expect((await b.post('/auth/passkey/native/add/finish', { ticket })).status).toBe(400);
      expect((await openPage(ticket)).status).toBe(200);
    });
  });

  describe('the page script', () => {
    const bytes = (...values: number[]) => new Uint8Array(values).buffer;
    const credential = { response: { clientDataJSON: bytes(3), attestationObject: bytes(4), getTransports: () => ['internal'] } };
    const named = (name: string) => Object.assign(new Error(name), { name });
    const errorUrl = (error: string) => `${RETURN}?${new URLSearchParams({ error, state: STATE })}`;
    const add = (fake: Parameters<typeof runPage>[0]) => runPage({ script: NATIVE_PASSKEY_ADD_SCRIPT, ticket: 'the-ticket', ...fake });

    it('sends the ticket and the answer, then goes where the server says', async () => {
      const target = `${RETURN}?added=1&state=${STATE}`;
      let asked: any;
      const page = add({ create: async (options: any) => { asked = options; return credential; }, verify: { status: 200, body: { redirect: target } } });
      await page.press('continue');
      expect(page.posted[0]).toEqual({ path: '/api/auth/passkey/native/add/options', csrf: 'csrf-token', body: { ticket: 'the-ticket', state: STATE } });
      expect(page.posted[1]).toEqual({ path: '/api/auth/passkey/native/add/finish', csrf: 'csrf-token', body: { ticket: 'the-ticket', state: STATE, clientDataJSON: 'Aw', attestationObject: 'BA', transports: ['internal'] } });
      expect(Array.from(new Uint8Array(asked.publicKey.challenge))).toEqual([1, 2, 3]);
      expect(Array.from(new Uint8Array(asked.publicKey.user.id))).toEqual([1, 2]);
      expect(Array.from(new Uint8Array(asked.publicKey.excludeCredentials[0].id))).toEqual([4, 5]);
      expect(page.location.href).toBe(target);
      expect(page.element('back').href).toBe(target);
    });

    it('reports a dismissed prompt and the Cancel button as cancelled', async () => {
      for (const name of ['NotAllowedError', 'AbortError']) {
        const page = add({ create: async () => { throw named(name); } });
        await page.press('continue');
        expect(page.location.href, name).toBe(errorUrl('passkey_cancelled'));
      }
      const button = add({ create: async () => credential });
      await button.press('cancel');
      expect(button.location.href).toBe(errorUrl('passkey_cancelled'));
    });

    it('reports anything else as failed, including a key this device already holds', async () => {
      const threw = add({ create: async () => { throw named('InvalidStateError'); } });
      await threw.press('continue');
      expect(threw.location.href).toBe(errorUrl('passkey_failed'));
      const refused = add({ create: async () => credential, verify: { status: 400, body: { error: 'no', redirect: errorUrl('passkey_failed') } } });
      await refused.press('continue');
      expect(refused.location.href).toBe(errorUrl('passkey_failed'));
      const elsewhere = add({ create: async () => credential, verify: { status: 200, body: { redirect: 'https://attacker.test/' } } });
      await elsewhere.press('continue');
      expect(elsewhere.location.href).toBe(errorUrl('passkey_failed'));
    });

    it('fails at once when the ticket is refused', async () => {
      const page = add({ create: async () => credential, options: { status: 401, body: { error: 'no' } } });
      await vi.waitFor(() => expect(page.location.href).toBe(errorUrl('passkey_failed')));
    });
  });
});

describe('the saved skin', () => {
  it('is kept per person and refuses anything else', async () => {
    const b = await signedIn(session);
    expect((await b.get('/persona/settings')).body.settings.skin ?? null).toBeNull();
    const put = async (body: unknown) => { const res = await fetch(`${base}/api/persona/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-josi-csrf': b.jar.get('josi_csrf')!, cookie: `josi_csrf=${b.jar.get('josi_csrf')}; josi_session=${session}` }, body: JSON.stringify(body) }); return res.status; };
    expect(await put({ skin: 'classic-navy' })).toBe(200);
    expect((await b.get('/persona/settings')).body.settings.skin).toBe('classic-navy');
    expect(await put({ skin: 'hot-pink' })).toBe(400);
    expect(await put({ memoryMode: 'manual' })).toBe(200);
    expect((await b.get('/persona/settings')).body.settings.skin).toBe('classic-navy');
  });
});
