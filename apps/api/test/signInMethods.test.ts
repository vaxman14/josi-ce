import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, generateSecret } from 'otplib';
import { MasterKey, initializeVault } from '@josi-ce/core';
import { adoptMfa, createSession, MAX_ATTEMPTS_PER_CODE, MAX_CODES_PER_EMAIL_PER_HOUR, MAX_CODES_PER_IP_PER_HOUR } from '@josi-ce/auth';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

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
    const secret = generateSecret();
    await adoptMfa(db, key, userId, secret);
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
