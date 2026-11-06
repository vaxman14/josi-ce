import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, generateSecret } from 'otplib';
import { MasterKey, initializeVault } from '@josi-ce/core';
import { createSession, verifyMfaFactor } from '@josi-ce/auth';
import { hostedCall, hostedLink } from '@josi-ce/connectors';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

vi.mock('@josi-ce/connectors', async original => ({ ...await original<typeof import('@josi-ce/connectors')>(), hostedCall: vi.fn(), hostedLink: vi.fn() }));

const keyBytes = Buffer.alloc(32, 66), key = new MasterKey(keyBytes);
const keyPath = join(mkdtempSync(join(tmpdir(), 'josi-mfa-share-')), 'master.key');
writeFileSync(keyPath, keyBytes.toString('base64'));
const password = 'synthetic-share-password';
let db: TestDb, user: string, session: string, server: Server, base: string;

const post = async (body: unknown) => {
  const response = await fetch(`${base}/api/auth/mfa/share`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-josi-client': 'native', authorization: `Bearer ${session}` }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};

beforeEach(async () => {
  vi.mocked(hostedCall).mockReset(); vi.mocked(hostedLink).mockReset();
  vi.mocked(hostedLink).mockResolvedValue({ hosted_url: 'https://accounts.heyjosi.test' } as never);
  db = await testDb(); await ensureWorkspace(db);
  user = (await createUser(db, { email: 'share@fixture.test', username: 'share', role: 'super_admin', password })).id;
  await initializeVault(db, key, user);
  session = (await createSession(db, { userId: user })).token;
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath } } as never);
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('POST /auth/mfa/share', () => {
  it('turns on the Hey Josi authenticator for this person', async () => {
    const secret = generateSecret();
    vi.mocked(hostedCall).mockResolvedValue({ ok: true, secret } as never);
    const res = await post({ password, code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(vi.mocked(hostedCall).mock.calls[0]![1]).toEqual({ op: 'totp.share', code: '123456' });
    expect(await verifyMfaFactor(db, key, user, await generate({ secret }))).toBe(true);
  });

  it('checks the password before spending the code', async () => {
    expect((await post({ password: 'wrong password', code: '123456' })).status).toBe(401);
    expect(hostedCall).not.toHaveBeenCalled();
  });

  it('passes on what Hey Josi refused, and changes nothing', async () => {
    vi.mocked(hostedCall).mockResolvedValue({ ok: false, error: 'bad_code', message: 'That code didn\'t match.' } as never);
    const res = await post({ password, code: '123456' });
    expect(res).toMatchObject({ status: 400, body: { error: 'That code didn\'t match.' } });
    const [row] = await db.query<{ mfa_enabled_at: string | null }>('select mfa_enabled_at from users where id=$1', [user]);
    expect(row!.mfa_enabled_at).toBeNull();
  });

  it('needs a linked server', async () => {
    vi.mocked(hostedLink).mockResolvedValue(null);
    expect((await post({ password, code: '123456' })).status).toBe(409);
    expect(hostedCall).not.toHaveBeenCalled();
  });
});
