import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from 'otplib';
import { MasterKey, initializeVault, setVaultLock } from '@josi-ce/core';
import { beginMfaSetup, enableMfa, createSession } from '@josi-ce/auth';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const keyBytes = Buffer.alloc(32, 65), key = new MasterKey(keyBytes);
const keyPath = join(mkdtempSync(join(tmpdir(), 'josi-mfa-vault-')), 'master.key');
writeFileSync(keyPath, keyBytes.toString('base64'));
const password = 'synthetic-mfa-password';
let db: TestDb, user: string, secret: string, codes: string[], session: string;
let servers: Server[];
async function start(hasKey = true) {
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: hasKey ? { path: keyPath } : false });
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function request(base: string, path: string, body: unknown, method = 'POST', bearer?: string) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    'content-type': 'application/json', 'x-josi-client': 'native', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
beforeEach(async () => {
  servers = []; db = await testDb(); await ensureWorkspace(db);
  user = (await createUser(db, { email: 'mfa@fixture.test', username: 'mfa', role: 'super_admin', password })).id;
  await initializeVault(db, key, user);
  secret = await beginMfaSetup(db, key, user);
  codes = await enableMfa(db, key, user, await generate({ secret }));
  session = (await createSession(db, { userId: user })).token;
});
afterEach(async () => { for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve())); });

describe('MFA Vault HTTP boundary', () => {
  it('keeps browser CSRF enforcement when a page supplies the native marker', async () => {
    const base = await start();
    const login = await request(base, '/api/auth/login', { identifier: 'mfa', password });
    const response = await fetch(`${base}/api/auth/mfa/verify-login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-josi-client': 'native', origin: 'https://untrusted.fixture.test' },
      body: JSON.stringify({ challenge: login.body.challenge, code: codes[0] }),
    });
    expect(response.status).toBe(403);
    expect((await db.query('select used_at from auth_mfa_challenges'))[0].used_at).toBeNull();
  });

  it.each([true, false])('never skips enabled MFA when key availability is %s or its secret is missing', async hasKey => {
    const base = await start(hasKey);
    await db.query('update users set totp_secret_enc=null where id=$1', [user]);
    const login = await request(base, '/api/auth/login', { identifier: 'mfa', password });
    expect(login.status).toBe(202); expect(login.body.sessionToken).toBeUndefined();
    const rejected = await request(base, '/api/auth/mfa/verify-login', { challenge: login.body.challenge, code: await generate({ secret }) });
    expect(rejected.status).toBe(hasKey ? 409 : 423);
    const accepted = await request(base, '/api/auth/mfa/verify-login', { challenge: login.body.challenge, code: codes[0] });
    expect(accepted.status).toBe(200); expect(accepted.body.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const [remaining] = await db.query<{ seconds: number }>('select extract(epoch from (expires_at-created_at))::int seconds from sessions order by created_at desc limit 1');
    expect(remaining.seconds).toBeGreaterThan(13 * 86400);
  });

  it('reports a Vault lock without burning the challenge and honors native short sessions', async () => {
    const base = await start();
    const login = await request(base, '/api/auth/login', { identifier: 'mfa', password, rememberMe: false });
    await setVaultLock(db, { master: true, locked: true, actorUserId: user });
    const refused = await request(base, '/api/auth/mfa/verify-login', { challenge: login.body.challenge, code: await generate({ secret }) });
    expect(refused).toMatchObject({ status: 423, body: { code: 'vault_locked' } });
    expect((await db.query('select attempts,used_at from auth_mfa_challenges'))[0]).toEqual({ attempts: 0, used_at: null });
    const accepted = await request(base, '/api/auth/mfa/verify-login', { challenge: login.body.challenge, code: codes[0] });
    expect(accepted.status).toBe(200);
    const [remaining] = await db.query<{ seconds: number }>('select extract(epoch from (expires_at-created_at))::int seconds from sessions order by created_at desc limit 1');
    expect(remaining.seconds).toBeLessThanOrEqual(12 * 3600 + 1);
  });

  it('requires Security settings to replace or remove the authenticator even with an unlocked Vault UI', async () => {
    const base = await start();
    expect((await request(base, '/api/vault/unlock', { password }, 'POST', session)).status).toBe(200);
    const [item] = await db.query<{ id: string }>("select id from vault_items where service='auth.totp' and owner_user_id=$1", [user]);
    const value = { secret: 'untrusted-replacement' };
    expect((await request(base, '/api/vault/items', { kind: 'other', service: 'auth.totp', slot: 'authenticator', label: 'Replacement', value }, 'POST', session)).status).toBe(403);
    expect((await request(base, `/api/vault/items/${item.id}`, { value }, 'PUT', session)).status).toBe(403);
    expect((await request(base, `/api/vault/items/${item.id}`, {}, 'DELETE', session)).status).toBe(403);
    expect((await request(base, '/api/auth/mfa/setup', {}, 'POST', session)).status).toBe(409);
    const login = await request(base, '/api/auth/login', { identifier: 'mfa', password });
    expect((await request(base, '/api/auth/mfa/verify-login', { challenge: login.body.challenge, code: await generate({ secret }) })).status).toBe(200);
    expect((await request(base, '/api/auth/mfa/disable', { password }, 'POST', session)).status).toBe(200);
    expect(await db.query("select id from vault_items where service='auth.totp'")).toHaveLength(0);
  });
});
