// Admin: which account sends Josi's own email, after setup.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSession, SESSION_TTL_SECONDS } from '@josi-ce/auth';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

let db: TestDb, server: Server, base: string, ownerId: string, ownerToken: string, memberToken: string;
const session = async (userId: string) => (await createSession(db, { userId, ip: '127.0.0.1', userAgent: 'test', ttlSeconds: SESSION_TTL_SECONDS })).token;
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'x-josi-client': 'native', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
async function connection(owner: string, provider: 'google' | 'microsoft', email: string, scopes: string) {
  return (await db.query<{ id: string }>(`insert into connections (owner_user_id, provider, account_email, granted_scopes, secrets_enc) values ($1, $2, $3, $4, 'sealed') returning id`,
    [owner, provider, email, scopes]))[0].id;
}

beforeEach(async () => {
  db = await testDb(); await ensureWorkspace(db);
  ownerId = (await createUser(db, { email: 'owner@fixture.test', username: 'owner', role: 'super_admin', password: 'synthetic-owner-password' })).id;
  const memberId = (await createUser(db, { email: 'member@fixture.test', username: 'member', role: 'member', password: 'synthetic-member-password' })).id;
  ownerToken = await session(ownerId); memberToken = await session(memberId);
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: false });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('the account that sends Josi\'s own email', () => {
  it('is for the owner only', async () => {
    expect((await call(memberToken, 'GET', '/admin/mail-account')).status).toBe(403);
    expect((await call(memberToken, 'PUT', '/admin/mail-account', { connectionId: '00000000-0000-4000-8000-000000000001' })).status).toBe(403);
  });

  it('starts with nothing, lists only accounts that can send, and sends from the one chosen', async () => {
    const readOnly = await connection(ownerId, 'google', 'reader@gmail.test', 'https://www.googleapis.com/auth/gmail.readonly');
    const sender = await connection(ownerId, 'google', 'owner@gmail.test', 'https://www.googleapis.com/auth/gmail.send');
    const first = await call(ownerToken, 'GET', '/admin/mail-account');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ account: null, sending: 'none' });
    expect(first.body.candidates.map((c: any) => [c.accountEmail, c.canSend]).sort()).toEqual([['owner@gmail.test', true], ['reader@gmail.test', false]]);

    const refused = await call(ownerToken, 'PUT', '/admin/mail-account', { connectionId: readOnly });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/allow sending/);

    const chosen = await call(ownerToken, 'PUT', '/admin/mail-account', { connectionId: sender, fromName: 'Josi at home' });
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ sending: 'account', account: { accountEmail: 'owner@gmail.test', fromName: 'Josi at home', active: true } });
    expect(JSON.stringify(chosen.body)).not.toMatch(/sealed|token|secret/i);

    const cleared = await call(ownerToken, 'DELETE', '/admin/mail-account');
    expect(cleared.body).toMatchObject({ account: null, sending: 'none' });
  });

  it('refuses a request that is not a connected account', async () => {
    expect((await call(ownerToken, 'PUT', '/admin/mail-account', { connectionId: 'nope' })).status).toBe(400);
  });
});
