// Sign in with Microsoft on the web. It is Google sign-in's twin: the owner's
// registered application, a state the starting browser has to hold, and a
// Josi account found through that person's own connected Microsoft account.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterKey, initializeVault } from '@josi-ce/core';
import { saveClient } from '@josi-ce/connectors';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const keyBytes = Buffer.alloc(32, 73), key = new MasterKey(keyBytes);
const keyPath = join(mkdtempSync(join(tmpdir(), 'josi-ms-signin-')), 'master.key');
writeFileSync(keyPath, keyBytes.toString('base64'));

let db: TestDb, server: Server, base: string, userId: string;
let asked: Array<{ url: string; body: string }> = [];

const connectorFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  asked.push({ url: String(url), body: String(init?.body ?? '') });
  const body = String(url).includes('graph.microsoft.com')
    ? { id: 'ms-linked-1', mail: 'linked@outlook.test' }
    : String(url).includes('userinfo') ? { sub: 'google-linked-1', email: 'linked@google.test' }
      : { access_token: 'access-token', scope: 'openid email profile User.Read' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

function browser() {
  const jar = new Map<string, string>();
  const get = async (path: string) => {
    const headers: Record<string, string> = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${base}/api${path}`, { headers, redirect: 'manual' });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const at = pair!.indexOf('='), value = pair!.slice(at + 1);
      if (value) jar.set(pair!.slice(0, at), value); else jar.delete(pair!.slice(0, at));
    }
    return { status: res.status, location: res.headers.get('location'), body: await res.json().catch(() => null) as any };
  };
  return { jar, get };
}
const start = async (b: ReturnType<typeof browser>, provider = 'microsoft') => new URL((await b.get(`/auth/${provider}/start?canonical=1`)).location!);
const callback = (state: string, provider = 'microsoft') => `/auth/${provider}/callback?state=${encodeURIComponent(state)}&code=provider-code`;
const link = (provider: string, account: string, email: string) => db.query(
  `insert into connections (owner_user_id, provider, status, provider_account_id, account_email, granted_scopes, secrets_enc)
   values ($1, $2, 'active', $3, $4, 'openid email', 'sealed-test')`, [userId, provider, account, email]);

beforeEach(async () => {
  asked = [];
  db = await testDb(); await ensureWorkspace(db);
  userId = (await createUser(db, { email: 'owner@fixture.test', username: 'owner', role: 'super_admin', password: 'synthetic-password-1' })).id;
  await initializeVault(db, key, userId);
  await saveClient(db, key, { actorUserId: userId, provider: 'microsoft', clientId: 'ms-client-id', clientSecret: 'ms-client-secret', redirectUri: 'http://localhost/api/connections/microsoft/callback' });
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath }, connectorFetch });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('Sign in with Microsoft', () => {
  it('is offered on the sign-in page only once its application is registered', async () => {
    const methods = (await browser().get('/auth/methods')).body;
    expect(methods.microsoft).toBe(true);
    expect(methods.google).toBe(false);
    await db.query(`delete from oauth_clients where provider='microsoft'`);
    expect((await browser().get('/auth/methods')).body.microsoft).toBe(false);
    expect((await browser().get('/auth/microsoft/start?canonical=1')).location).toBe('/login?error=microsoft_unavailable');
  });

  it('sends the browser to Microsoft with the sign-in return address and a PKCE challenge', async () => {
    const consent = await start(browser());
    expect(consent.origin + consent.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(consent.searchParams.get('client_id')).toBe('ms-client-id');
    expect(consent.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/microsoft/callback');
    expect(consent.searchParams.get('scope')).toBe('openid email profile User.Read');
    expect(consent.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('signs in the person whose connected Microsoft account it is', async () => {
    await link('microsoft', 'ms-linked-1', 'linked@outlook.test');
    const b = browser();
    const landed = await b.get(callback((await start(b)).searchParams.get('state')!));
    expect(landed.status).toBe(302);
    expect(landed.location).toBe('/app');
    expect(b.jar.has('josi_session')).toBe(true);
    const exchange = asked.find((request) => request.url.includes('/token'))!;
    expect(exchange.url).toContain('login.microsoftonline.com');
    expect(exchange.body).toContain(encodeURIComponent('http://localhost/api/auth/microsoft/callback'));
    expect(await db.query(`select 1 from events where kind='auth.microsoft_login'`)).toHaveLength(1);
  });

  it('refuses a Microsoft account nobody here connected', async () => {
    // The same person's Google connection is not a Microsoft one.
    await link('google', 'ms-linked-1', 'linked@outlook.test');
    const b = browser();
    const landed = await b.get(callback((await start(b)).searchParams.get('state')!));
    expect(landed.location).toBe('/login?error=microsoft_not_linked');
    expect(b.jar.has('josi_session')).toBe(false);
  });

  it('refuses a finished link opened in another browser', async () => {
    await link('microsoft', 'ms-linked-1', 'linked@outlook.test');
    const state = (await start(browser())).searchParams.get('state')!;
    const victim = browser();
    const landed = await victim.get(callback(state));
    expect(landed.location).toBe('/login?error=microsoft_signin_failed');
    expect(victim.jar.has('josi_session')).toBe(false);
  });

  it('never redeems a state at the other provider, and does not spend it there', async () => {
    await link('microsoft', 'ms-linked-1', 'linked@outlook.test');
    const b = browser();
    const state = (await start(b)).searchParams.get('state')!;
    expect((await b.get(callback(state, 'google'))).location).toBe('/login?error=google_signin_expired');
    expect(b.jar.has('josi_session')).toBe(false);
    expect((await b.get(callback(state))).location).toBe('/app');
  });

  it('tells a native app whether it is set up, and where to start', async () => {
    const config = await (await fetch(`${base}/api/auth/native/config`)).json() as Record<string, unknown>;
    expect(config.microsoftSignIn).toBe(true);
    expect(config.nativeMicrosoftStart).toBe('http://localhost/api/auth/microsoft/native/start');
    expect(config.googleSignIn).toBe(false);
    await db.query(`delete from oauth_clients where provider='microsoft'`);
    expect((await (await fetch(`${base}/api/auth/native/config`)).json() as Record<string, unknown>).microsoftSignIn).toBe(false);
  });

  it('hands a native app a one-time code that becomes a session, under either parameter name', async () => {
    await link('microsoft', 'ms-linked-1', 'linked@outlook.test');
    for (const name of ['return_uri', 'redirect_uri']) {
      const started = await fetch(`${base}/api/auth/microsoft/native/start?${name}=josi%3A%2F%2Fauth%2Fcallback`, { redirect: 'manual' });
      const consent = new URL(started.headers.get('location')!);
      expect(consent.hostname).toBe('login.microsoftonline.com');
      // The app's browser holds no cookie; the state alone carries it.
      const back = await fetch(`${base}/api${callback(consent.searchParams.get('state')!)}`, { redirect: 'manual' });
      const returned = new URL(back.headers.get('location')!);
      expect(returned.origin + returned.pathname === 'josi://auth/callback' || back.headers.get('location')!.startsWith('josi://auth/callback?')).toBe(true);
      const code = returned.searchParams.get('code')!;
      expect(code).toBeTruthy();
      const exchanged = await fetch(`${base}/api/auth/microsoft/native/exchange`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-josi-client': 'native' }, body: JSON.stringify({ code }) });
      expect(exchanged.status).toBe(200);
      const answer = await exchanged.json() as { user: { id: string }; sessionToken: string };
      expect(answer.user.id).toBe(userId);
      expect(answer.sessionToken).toBeTruthy();
    }
    expect(await db.query(`select 1 from events where kind='auth.microsoft_native_login'`)).toHaveLength(2);
  });

  it('refuses a native return address that is not the app\'s', async () => {
    const res = await fetch(`${base}/api/auth/microsoft/native/start?return_uri=https%3A%2F%2Fevil.example%2Fcb`, { redirect: 'manual' });
    expect(res.status).toBe(400);
  });
});
