// iPhone push straight to Apple: the phone registers its Apple push address,
// and the owner pastes one Apple push key that is checked, sealed, and never
// handed back.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterKey, claimDurableTurn, completeDurableTurn, type ApnsRequest } from '@josi-ce/core';
import { testDb, testVault, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const keyBytes = Buffer.alloc(32, 29);
const keyPath = join(mkdtempSync(join(tmpdir(), 'josi-apple-push-')), 'master.key');
writeFileSync(keyPath, keyBytes.toString('base64'));
const P8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PW = 'a-long-enough-password-123';

let db: TestDb, server: Server, base: string;
let appleSays: { status: number; body: string } | 'offline' = { status: 400, body: '{"reason":"BadDeviceToken"}' };
const asked: ApnsRequest[] = [];

function merge(existing: string | undefined, set: string[]): string {
  const jar = new Map<string, string>();
  for (const part of [...(existing ?? '').split(';'), ...set.map(raw => raw.split(';')[0]!)]) {
    const i = part.indexOf('='); if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}
async function signIn(identifier: string): Promise<string> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const jar = merge(undefined, pre.headers.getSetCookie());
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', body: JSON.stringify({ identifier, password: PW }),
    headers: { 'Content-Type': 'application/json', cookie: jar, 'x-josi-csrf': decodeURIComponent(/josi_csrf=([^;]+)/.exec(jar)?.[1] ?? '') },
  });
  expect(res.status).toBe(200);
  return merge(jar, res.headers.getSetCookie());
}
async function call(jar: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', cookie: jar, 'x-josi-csrf': decodeURIComponent(/josi_csrf=([^;]+)/.exec(jar)?.[1] ?? '') },
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

beforeEach(async () => {
  asked.length = 0; appleSays = { status: 400, body: '{"reason":"BadDeviceToken"}' };
  db = await testDb(); await ensureWorkspace(db);
  await createUser(db, { email: 'owner@fixture.test', username: 'owner', role: 'super_admin', password: PW });
  await createUser(db, { email: 'member@fixture.test', username: 'member', role: 'member', password: PW });
  await testVault(db, new MasterKey(keyBytes));
  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath },
    apnsTransport: async request => { asked.push(request); if (appleSays === 'offline') throw new Error('offline'); return appleSays; },
  });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('Apple push key', () => {
  it('is checked with Apple, sealed, and never returned', async () => {
    const owner = await signIn('owner');
    expect((await call(owner, 'GET', '/admin/push/apple')).body).toMatchObject({ configured: false, defaultTeamId: 'LRH75YR6QW', bundleId: 'com.socalreceptionist.josice' });
    const saved = await call(owner, 'PUT', '/admin/push/apple', { key_id: 'ABC123DEFG', private_key: P8 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, keyId: 'ABC123DEFG', teamId: 'LRH75YR6QW', checked: 'accepted' });
    expect(JSON.stringify(saved.body)).not.toContain('PRIVATE KEY');
    expect(asked[0]!.host).toBe('api.push.apple.com');
    expect(JSON.stringify(await db.query(`select * from server_push_keys`))).not.toContain('PRIVATE KEY');
    expect((await call(owner, 'DELETE', '/admin/push/apple')).status).toBe(204);
    expect((await call(owner, 'GET', '/admin/push/apple')).body.configured).toBe(false);
  });

  it('refuses a key Apple rejects, and says when Apple could not be asked', async () => {
    const owner = await signIn('owner');
    appleSays = { status: 403, body: '{"reason":"InvalidProviderToken"}' };
    const refused = await call(owner, 'PUT', '/admin/push/apple', { key_id: 'ABC123DEFG', private_key: P8 });
    expect(refused.status).toBe(400); expect(refused.body.code).toBe('key_rejected');
    expect(await db.query(`select 1 from server_push_keys`)).toHaveLength(0);
    expect((await call(owner, 'PUT', '/admin/push/apple', { key_id: 'nope', private_key: P8 })).body.code).toBe('invalid_key_id');
    expect((await call(owner, 'PUT', '/admin/push/apple', { key_id: 'ABC123DEFG', private_key: 'hello' })).body.code).toBe('invalid_key');
    appleSays = 'offline';
    expect((await call(owner, 'PUT', '/admin/push/apple', { key_id: 'ABC123DEFG', private_key: P8 })).body).toMatchObject({ configured: true, checked: 'unknown' });
  });

  it('belongs to the administrator alone', async () => {
    const member = await signIn('member');
    expect((await call(member, 'GET', '/admin/push/apple')).status).toBe(403);
    expect((await call(member, 'PUT', '/admin/push/apple', { key_id: 'ABC123DEFG', private_key: P8 })).status).toBe(403);
  });
});

describe('iPhone registration', () => {
  it('takes the Apple push address the phone sends and seals it', async () => {
    const member = await signIn('member');
    const token = 'ab'.repeat(32);
    const registered = await call(member, 'PUT', '/assistant/devices', {
      device_identity: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', platform: 'ios', app_state: 'background', timezone: 'America/Los_Angeles',
      apns_token: token.toUpperCase(), apns_environment: 'sandbox', apns_topic: 'com.socalreceptionist.josice',
    });
    expect(registered.status).toBe(200);
    const [stored] = await db.query<{ expo_token_enc: string; platform: string }>(`select expo_token_enc, platform from mobile_devices where id = $1`, [registered.body.device.id]);
    expect(stored!.platform).toBe('ios'); expect(stored!.expo_token_enc).not.toContain(token);
    expect(JSON.stringify((await call(member, 'GET', '/assistant/devices')).body)).not.toContain(token);
    const bad = await call(member, 'PUT', '/assistant/devices', {
      device_identity: 'ffffffff-ffff-4fff-8fff-ffffffffffff', platform: 'ios', app_state: 'background', timezone: 'UTC', apns_token: 'not-hex',
    });
    expect(bad.status).toBeGreaterThanOrEqual(400); expect(bad.status).toBeLessThan(500);
  });
});

describe('short spoken replies', () => {
  async function thread(): Promise<string> {
    const [row] = await db.query<{ id: string }>(`insert into threads(owner_user_id, title) select id, 'Siri' from users where username = 'member' returning id`);
    return row!.id;
  }
  it('hands back a line to say now when the answer needs longer, and remembers the style', async () => {
    const member = await signIn('member'), id = await thread();
    const sent = await call(member, 'POST', `/assistant/threads/${id}/turns`, { client_message_id: 'siri-1', message: 'What is on my list?', reply_style: 'spoken_short', wait_seconds: 0.4 });
    expect(sent.status).toBe(202);
    expect(sent.body.spoken).toEqual({ text: "I'm on it. I'll send the answer to your phone.", final: false });
    expect((await db.query<any>(`select reply_style from assistant_turns where id = $1`, [sent.body.turn.id]))[0].reply_style).toBe('spoken_short');
  });

  it('answers in the same request when the reply is ready in time, without a second notification', async () => {
    const member = await signIn('member'), id = await thread();
    await call(member, 'PUT', '/assistant/devices', {
      device_identity: 'abababab-abab-4bab-8bab-abababababab', platform: 'ios', app_state: 'background', timezone: 'UTC', apns_token: 'cd'.repeat(32),
    });
    const worker = (async () => {
      for (let i = 0; i < 100; i++) {
        const [queued] = await db.query<{ id: string }>(`select id from assistant_turns where thread_id = $1 and status = 'queued'`, [id]);
        if (queued) {
          const turn = await claimDurableTurn(db, queued.id);
          await completeDurableTurn(db, { turnId: turn!.id, leaseToken: turn!.lease_token, reply: 'Two things: call Alex, and the dentist at three.', toolReceipts: [] });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })();
    const sent = await call(member, 'POST', `/assistant/threads/${id}/turns`, { client_message_id: 'siri-2', message: 'What is on my list?', reply_style: 'spoken_short' });
    await worker;
    expect(sent.body.spoken).toMatchObject({ text: 'Two things: call Alex, and the dentist at three.', final: true });
    expect((await db.query<any>(`select status, last_error_code from push_deliveries`))[0]).toMatchObject({ status: 'suppressed', last_error_code: 'spoken_inline' });
  });

  it('leaves an ordinary message alone and refuses a style it does not know', async () => {
    const member = await signIn('member'), id = await thread();
    const plain = await call(member, 'POST', `/assistant/threads/${id}/turns`, { client_message_id: 'plain-1', message: 'Hello' });
    expect(plain.status).toBe(202); expect(plain.body.spoken).toBeUndefined();
    const odd = await call(member, 'POST', `/assistant/threads/${id}/turns`, { client_message_id: 'odd-1', message: 'Hello', reply_style: 'sung' });
    expect(odd.status).toBeGreaterThanOrEqual(400); expect(odd.status).toBeLessThan(500);
  });
});
