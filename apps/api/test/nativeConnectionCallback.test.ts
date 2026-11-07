// The browser that comes back from Google or Microsoft in a native app's sign-in
// sheet has no Josi cookie: the app holds a bearer session the sheet never sees.
// So the callback lets exactly one thing through without a session, a live
// handshake that the app started as native, and only to pass it on to the app.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterKey } from '@josi-ce/core';
import { createSession } from '@josi-ce/auth';
import { saveClient } from '@josi-ce/connectors';
import { testDb, testVault, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const keyBytes = Buffer.alloc(32, 57);
const keyPath = join(mkdtempSync(join(tmpdir(), 'josi-ce-native-connection-')), 'master.key');
writeFileSync(keyPath, keyBytes.toString('base64'));

let db: TestDb, server: Server, base: string, userId: string, otherId: string, session: string, otherSession: string;
let providerCalls: string[] = [];

const connectorFetch = (async (url: RequestInfo | URL) => {
  providerCalls.push(String(url));
  const body = String(url).includes('userinfo')
    ? { sub: 'g-account-1', email: 'alice@google.test' }
    : { access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, scope: 'openid email profile' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const bearer = (token: string) => ({ 'content-type': 'application/json', 'x-josi-client': 'native', authorization: `Bearer ${token}` });

async function startNative(token = session) {
  const res = await fetch(`${base}/api/connections/google/start`, { method: 'POST', headers: bearer(token), body: JSON.stringify({ native: true }) });
  expect(res.status).toBe(200);
  return new URL((await res.json() as { url: string }).url).searchParams.get('state')!;
}

/** A browser with a session cookie and its CSRF pair. */
async function webHeaders(token: string) {
  const csrf = (await (await fetch(`${base}/api/auth/csrf`)).json() as { csrfToken: string }).csrfToken;
  return { 'content-type': 'application/json', 'x-josi-csrf': csrf, cookie: `josi_csrf=${csrf}; josi_session=${token}` };
}
async function startWeb(token = session) {
  const res = await fetch(`${base}/api/connections/google/start`, { method: 'POST', headers: await webHeaders(token), body: JSON.stringify({ returnPath: '/app/connections' }) });
  expect(res.status).toBe(200);
  return new URL((await res.json() as { url: string }).url).searchParams.get('state')!;
}

const callback = (query: string, headers: Record<string, string> = {}, provider = 'google') =>
  fetch(`${base}/api/connections/${provider}/callback?${query}`, { redirect: 'manual', headers });
const complete = (token: string, body: unknown) =>
  fetch(`${base}/api/connections/google/native/complete`, { method: 'POST', headers: bearer(token), body: JSON.stringify(body) });
const connections = () => db.query<{ owner_user_id: string }>(`select owner_user_id from connections where provider = 'google'`);

beforeAll(async () => {
  db = await testDb(); await ensureWorkspace(db);
  userId = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: 'alice-password-123' })).id;
  otherId = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: 'bob-password-1234' })).id;
  await testVault(db, new MasterKey(keyBytes));
  const [admin] = await db.query<{ id: string }>(`select id from users where role = 'super_admin'`);
  await saveClient(db, new MasterKey(keyBytes), {
    actorUserId: admin!.id, provider: 'google', clientId: 'client-id', clientSecret: 'client-secret',
    redirectUri: 'https://native.ce.test/api/connections/google/callback',
  });
  session = (await createSession(db, { userId })).token;
  otherSession = (await createSession(db, { userId: otherId })).token;
  const app = createApp(db, { cookieSecure: false, appUrl: 'https://native.ce.test', masterKeyCheck: { path: keyPath }, connectorFetch });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => { providerCalls = []; await db.query(`delete from connections where provider = 'google'`); });

describe('a native handshake, coming back with no session', () => {
  it('passes on to the app, which finishes it with the session that started it', async () => {
    const state = await startNative();
    const res = await callback(`state=${encodeURIComponent(state)}&code=provider-code`);
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect(`${back.protocol}//${back.host}${back.pathname}`).toBe('josi://connections/callback');
    expect(back.searchParams.get('provider')).toBe('google');
    expect(back.searchParams.get('state')).toBe(state);
    expect(back.searchParams.get('code')).toBe('provider-code');
    expect(res.headers.getSetCookie()).toEqual([]);
    // Nothing was redeemed here: no provider call, no connection, the state still live.
    expect(providerCalls).toEqual([]);
    expect(await connections()).toHaveLength(0);

    const done = await complete(session, { state, code: 'provider-code' });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ ok: true, provider: 'google' });
    expect((await connections()).map(row => row.owner_user_id)).toEqual([userId]);
  });

  it('passes a refusal on too, without a code', async () => {
    const state = await startNative();
    const res = await callback(`state=${encodeURIComponent(state)}&error=access_denied`);
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect(back.searchParams.get('error')).toBe('declined');
    expect(back.searchParams.has('code')).toBe(false);
  });

  it('takes the person from the stored handshake, whatever the browser sends', async () => {
    const state = await startNative();
    const res = await callback(`state=${encodeURIComponent(state)}&code=provider-code&user_id=${otherId}&userId=${otherId}&session_id=x`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).not.toContain(otherId);
    // Someone else's session cannot finish it, and trying does not use it up.
    const stolen = await complete(otherSession, { state, code: 'provider-code' });
    expect(stolen.status).toBe(409);
    expect((await stolen.json() as { reason: string }).reason).toBe('session_mismatch');
    expect(await connections()).toHaveLength(0);
    expect((await complete(session, { state, code: 'provider-code' })).status).toBe(200);
    expect((await connections()).map(row => row.owner_user_id)).toEqual([userId]);
  });

  it('stops once the handshake is used', async () => {
    const state = await startNative();
    expect((await complete(session, { state, code: 'provider-code' })).status).toBe(200);
    expect((await callback(`state=${encodeURIComponent(state)}&code=provider-code`)).status).toBe(401);
  });

  it('stops once the handshake expires', async () => {
    const state = await startNative();
    await db.query(`update oauth_states set expires_at = now() - interval '1 second' where id = $1`, [state]);
    expect((await callback(`state=${encodeURIComponent(state)}&code=provider-code`)).status).toBe(401);
  });

  it('refuses a state brought to another provider\'s callback', async () => {
    const state = await startNative();
    expect((await callback(`state=${encodeURIComponent(state)}&code=provider-code`, {}, 'microsoft')).status).toBe(401);
  });

  it('refuses a state sent twice, which would read as a list', async () => {
    const state = await startNative();
    expect((await callback(`state=${encodeURIComponent(state)}&state=other&code=provider-code`)).status).toBe(401);
  });
});

describe('everything else without a session', () => {
  it('refuses an unknown, missing or oversized state', async () => {
    for (const query of ['state=made-up-state&code=provider-code', 'code=provider-code', '', `state=${'a'.repeat(600)}&code=provider-code`]) {
      const res = await callback(query);
      expect(res.status, query).toBe(401);
      expect(res.headers.get('location'), query).toBeNull();
    }
  });

  it('refuses a web handshake, and leaves it for the browser that started it', async () => {
    const state = await startWeb();
    const res = await callback(`state=${encodeURIComponent(state)}&code=provider-code`);
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(providerCalls).toEqual([]);
    expect(await connections()).toHaveLength(0);
    const [row] = await db.query<{ consumed_at: string | null }>('select consumed_at from oauth_states where id = $1', [state]);
    expect(row!.consumed_at).toBeNull();
  });

  it('refuses a provider it does not know', async () => {
    expect((await callback('state=made-up-state', {}, 'not-a-provider')).status).toBe(401);
  });
});

describe('the web flow stays as strict', () => {
  const cookie = (token: string) => ({ cookie: `josi_session=${token}` });

  it('finishes in the browser that started it', async () => {
    const state = await startWeb();
    const res = await callback(`state=${encodeURIComponent(state)}&code=provider-code`, cookie(session));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/connections');
    expect((await connections()).map(row => row.owner_user_id)).toEqual([userId]);
  });

  it('refuses another person\'s browser', async () => {
    const state = await startWeb();
    const res = await callback(`state=${encodeURIComponent(state)}&code=provider-code`, cookie(otherSession));
    expect(res.headers.get('location')).toBe('/app/connections?error=session_mismatch');
    expect(await connections()).toHaveLength(0);
  });

  it('a signed-in browser still cannot redeem a native handshake', async () => {
    const state = await startNative();
    const res = await callback(`state=${encodeURIComponent(state)}&code=provider-code`, cookie(session));
    expect(new URL(res.headers.get('location')!).protocol).toBe('josi:');
    expect(providerCalls).toEqual([]);
    expect(await connections()).toHaveLength(0);
  });

  it('native completion still refuses a web handshake', async () => {
    const state = await startWeb();
    expect((await complete(session, { state, code: 'provider-code' })).status).toBe(409);
    expect(await connections()).toHaveLength(0);
  });
});
