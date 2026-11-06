// Holding someone's mailbox or Google account is one factor. These are the two
// ways in that used to stop there: a password-reset link and Google sign-in.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from 'otplib';
import { MasterKey, initializeVault } from '@josi-ce/core';
import { beginMfaSetup, createSession, enableMfa, issueAuthToken } from '@josi-ce/auth';
import { saveClient } from '@josi-ce/connectors';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const keyBytes = Buffer.alloc(32, 71), key = new MasterKey(keyBytes);
const keyPath = join(mkdtempSync(join(tmpdir(), 'josi-mfa-gates-')), 'master.key');
writeFileSync(keyPath, keyBytes.toString('base64'));
const password = 'synthetic-mfa-password', newPassword = 'a-brand-new-password';

let db: TestDb, server: Server, base: string, userId: string, secret: string, recoveryCodes: string[], providerCalls = 0;

const connectorFetch = (async (url: RequestInfo | URL) => {
  providerCalls += 1;
  return new Response(JSON.stringify(
    String(url).includes('userinfo')
      ? { sub: 'google-linked-1', email: 'linked@google.test' }
      : { access_token: 'access-token', scope: 'openid email profile' },
  ), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

/** A browser's cookies, and the CSRF pair the API wants on every POST. */
function browser() {
  const jar = new Map<string, string>(), set: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.has('josi_csrf')) headers['x-josi-csrf'] = jar.get('josi_csrf')!;
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${base}/api${path}`, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of res.headers.getSetCookie()) {
      set.push(cookie);
      const [pair] = cookie.split(';'); const at = pair!.indexOf('='), value = pair!.slice(at + 1);
      if (value) jar.set(pair!.slice(0, at), value); else jar.delete(pair!.slice(0, at));
    }
    return { status: res.status, location: res.headers.get('location'), body: await res.json().catch(() => null) as any };
  };
  return { jar, set, get: (path: string) => call('GET', path), post: (path: string, body: unknown = {}) => call('POST', path, body) };
}

async function native(path: string, body: unknown) {
  const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-josi-client': 'native' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

const sessions = async () => (await db.query<{ n: number }>(`select count(*)::int n from sessions where user_id = $1 and revoked_at is null`, [userId]))[0]!.n;
const resetToken = async () => (await issueAuthToken(db, { userId, purpose: 'reset' })).token;
const turnMfaOff = () => db.query(`update users set mfa_enabled_at = null where id = $1`, [userId]);

/** Google's half of the sign-in: what the app's browser arrives with at the callback. */
async function nativeState() {
  const started = await fetch(`${base}/api/auth/google/native/start?redirect_uri=josi%3A%2F%2Fauth%2Fcallback`, { redirect: 'manual' });
  return new URL(started.headers.get('location')!).searchParams.get('state')!;
}

/** The same on the web, where the browser that starts it is the one that has to finish. */
async function webState(b: ReturnType<typeof browser>) {
  const started = await b.get('/auth/google/start?canonical=1');
  return new URL(started.location!).searchParams.get('state')!;
}
const callbackFor = (state: string) => `/auth/google/callback?state=${encodeURIComponent(state)}&code=provider-code`;

beforeEach(async () => {
  db = await testDb(); await ensureWorkspace(db);
  userId = (await createUser(db, { email: 'mfa@fixture.test', username: 'mfa', role: 'super_admin', password })).id;
  await initializeVault(db, key, userId);
  await saveClient(db, key, { actorUserId: userId, provider: 'google', clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:3000/api/auth/google/callback' });
  await db.query(
    `insert into connections (owner_user_id, provider, status, provider_account_id, account_email, granted_scopes, secrets_enc)
     values ($1, 'google', 'active', 'google-linked-1', 'linked@google.test', 'openid email profile', 'sealed-test')`, [userId],
  );
  secret = await beginMfaSetup(db, key, userId);
  recoveryCodes = await enableMfa(db, key, userId, await generate({ secret }));
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath }, connectorFetch });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('POST /auth/set-password', () => {
  it('changes the password but makes no session until the authenticator answers', async () => {
    const old = (await createSession(db, { userId })).token;
    const b = browser(); await b.get('/auth/csrf');
    const reset = await b.post('/auth/set-password', { token: await resetToken(), password: newPassword });

    expect(reset.status).toBe(202);
    expect(reset.body).toEqual({ mfaRequired: true, challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(b.jar.has('josi_session')).toBe(false);
    expect(await sessions()).toBe(0);
    expect((await b.get('/auth/me')).status).toBe(401);
    // The link's other job still happens: the old password and sessions are gone.
    expect((await native('/auth/login', { identifier: 'mfa', password })).status).toBe(401);
    expect((await native('/auth/login', { identifier: 'mfa', password: newPassword })).status).toBe(202);
    const me = await fetch(`${base}/api/auth/me`, { headers: { 'x-josi-client': 'native', authorization: `Bearer ${old}` } });
    expect(me.status).toBe(401);

    const finished = await b.post('/auth/mfa/verify-login', { challenge: reset.body.challenge, code: await generate({ secret }) });
    expect(finished.status).toBe(200);
    expect(b.jar.has('josi_session')).toBe(true);
    expect((await b.get('/auth/me')).body.user.id).toBe(userId);
  });

  it('gives the mailbox nothing for a wrong code, and the link works once', async () => {
    const b = browser(); await b.get('/auth/csrf');
    const token = await resetToken();
    await b.post('/auth/set-password', { token, password: newPassword });
    expect((await b.post('/auth/mfa/verify-login', { code: '000000' })).status).toBe(401);
    expect(b.jar.has('josi_session')).toBe(false);
    expect(await sessions()).toBe(0);
    expect((await b.post('/auth/set-password', { token, password: newPassword })).status).toBe(400);
  });

  it('lets a recovery code answer, from the cookie the redirect left', async () => {
    const b = browser(); await b.get('/auth/csrf');
    await b.post('/auth/set-password', { token: await resetToken(), password: newPassword });
    expect(b.jar.has('josi_mfa_challenge')).toBe(true);
    expect((await b.post('/auth/mfa/verify-login', { code: recoveryCodes[0] })).status).toBe(200);
    expect(b.jar.has('josi_session')).toBe(true);
    expect(b.jar.has('josi_mfa_challenge')).toBe(false);
  });

  it('keeps the native signIn:false path: password changed, nothing else', async () => {
    const b = browser(); await b.get('/auth/csrf');
    const reset = await b.post('/auth/set-password', { token: await resetToken(), password: newPassword, signIn: false });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ ok: true, passwordChanged: true });
    expect(b.jar.has('josi_session')).toBe(false);
    expect(b.jar.has('josi_mfa_challenge')).toBe(false);
    expect(await sessions()).toBe(0);
    expect((await db.query(`select 1 from auth_mfa_challenges where user_id = $1`, [userId]))).toHaveLength(0);
  });

  it('still signs in straight away when the account has no authenticator', async () => {
    await turnMfaOff();
    const b = browser(); await b.get('/auth/csrf');
    const reset = await b.post('/auth/set-password', { token: await resetToken(), password: newPassword });
    expect(reset.status).toBe(200);
    expect(reset.body.user.id).toBe(userId);
    expect(b.jar.has('josi_session')).toBe(true);
  });
});

describe('Google sign-in on the web', () => {
  it('stops at the authenticator, then finishes in the browser that started it', async () => {
    const b = browser(); await b.get('/auth/csrf');
    const callback = await b.get(callbackFor(await webState(b)));

    expect(callback.status).toBe(302);
    expect(callback.location).toBe('/login?mfa=pending');
    expect(b.jar.has('josi_session')).toBe(false);
    expect(await sessions()).toBe(0);
    const cookie = b.set.find(value => value.startsWith('josi_mfa_challenge='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/auth/mfa');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=300');

    // Google alone, or a code with no challenge from this browser, opens nothing.
    const stranger = browser(); await stranger.get('/auth/csrf');
    expect((await stranger.post('/auth/mfa/verify-login', { code: await generate({ secret }) })).status).toBe(401);
    expect(await sessions()).toBe(0);

    const finished = await b.post('/auth/mfa/verify-login', { code: await generate({ secret }) });
    expect(finished.status).toBe(200);
    expect(finished.body.user.id).toBe(userId);
    expect(b.jar.has('josi_session')).toBe(true);
    expect(b.jar.has('josi_mfa_challenge')).toBe(false);
  });

  it('still goes straight in when the account has no authenticator', async () => {
    await turnMfaOff();
    const b = browser(); await b.get('/auth/csrf');
    const callback = await b.get(callbackFor(await webState(b)));
    expect(callback.location).toBe('/app');
    expect(b.jar.has('josi_session')).toBe(true);
  });
});

describe('whose browser a Google sign-in belongs to', () => {
  beforeEach(turnMfaOff);

  it('refuses a finished callback link opened in another browser', async () => {
    const attacker = browser(), victim = browser();
    const link = callbackFor(await webState(attacker));
    await victim.get('/auth/csrf');
    providerCalls = 0;
    const landed = await victim.get(link);
    expect(landed.status).toBe(302);
    expect(landed.location).toBe('/login?error=google_signin_failed');
    expect(victim.jar.has('josi_session')).toBe(false);
    expect(await sessions()).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it('refuses it too while that browser has a sign-in of its own under way', async () => {
    const attacker = browser(), victim = browser();
    const link = callbackFor(await webState(attacker));
    await webState(victim);
    expect((await victim.get(link)).location).toBe('/login?error=google_signin_failed');
    expect(await sessions()).toBe(0);
  });

  it('finishes in the browser that started it, once', async () => {
    const b = browser(), link = callbackFor(await webState(b));
    expect((await b.get(link)).location).toBe('/app');
    expect(b.jar.has('josi_google_state')).toBe(false);
    b.jar.delete('josi_session');
    expect((await b.get(link)).location).toBe('/login?error=google_signin_expired');
  });

  it('keeps the cookie from page script, on the Google routes, for as long as the state lives', async () => {
    const b = browser();
    await webState(b);
    const cookie = b.set.find(value => value.startsWith('josi_google_state='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/auth/google');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
  });

  it('starts at APP_URL, where Google will come back to, and only hops once', async () => {
    const elsewhere = await browser().get('/auth/google/start');
    expect(elsewhere.status).toBe(302);
    expect(elsewhere.location).toBe('http://localhost/api/auth/google/start?canonical=1');
    // Host rewritten by a proxy still reaches Google instead of going round again.
    expect(new URL((await browser().get('/auth/google/start?canonical=1')).location!).hostname).toBe('accounts.google.com');
    const direct = await new Promise<string | undefined>((resolve, reject) => {
      const req = request(`${base}/api/auth/google/start`, { headers: { host: 'localhost' } }, (res) => { res.resume(); resolve(res.headers.location); });
      req.on('error', reject); req.end();
    });
    expect(new URL(direct!).hostname).toBe('accounts.google.com');
  });

  it('leaves the native flow alone: no cookie to set, and none asked for', async () => {
    const started = await fetch(`${base}/api/auth/google/native/start?redirect_uri=josi%3A%2F%2Fauth%2Fcallback`, { redirect: 'manual' });
    expect(started.headers.getSetCookie()).toEqual([]);
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    const callback = await fetch(`${base}/api${callbackFor(state)}`, { redirect: 'manual' });
    expect(new URL(callback.headers.get('location')!).searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});

describe('Google sign-in from a native app', () => {
  async function nativeCode() {
    const state = await nativeState();
    const callback = await fetch(`${base}/api/auth/google/callback?state=${encodeURIComponent(state)}&code=provider-code`, { redirect: 'manual' });
    return new URL(callback.headers.get('location')!).searchParams.get('code')!;
  }

  it('answers the exchange like /auth/login: a challenge, and no session until the code', async () => {
    const code = await nativeCode();
    const exchange = await native('/auth/google/native/exchange', { code });
    expect(exchange.status).toBe(202);
    expect(exchange.body).toEqual({ mfaRequired: true, challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(await sessions()).toBe(0);
    expect((await native('/auth/google/native/exchange', { code })).status).toBe(401);

    expect((await native('/auth/mfa/verify-login', { challenge: exchange.body.challenge, code: '000000' })).status).toBe(401);
    expect(await sessions()).toBe(0);
    const finished = await native('/auth/mfa/verify-login', { challenge: exchange.body.challenge, code: await generate({ secret }) });
    expect(finished.status).toBe(200);
    expect(finished.body.user.id).toBe(userId);
    expect(finished.body.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('asks at the exchange, so an authenticator added after the callback still counts', async () => {
    await turnMfaOff();
    const code = await nativeCode();
    await db.query(`update users set mfa_enabled_at = now() where id = $1`, [userId]);
    const exchange = await native('/auth/google/native/exchange', { code });
    expect(exchange.status).toBe(202);
    expect(await sessions()).toBe(0);
  });

  it('still answers with a session when the account has no authenticator', async () => {
    await turnMfaOff();
    const exchange = await native('/auth/google/native/exchange', { code: await nativeCode() });
    expect(exchange.status).toBe(200);
    expect(exchange.body.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});
