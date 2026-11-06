// The Hey Josi service key is built in. A link to heyjosi.com never asks the
// network for it, so whoever answers there has to hold the real private key.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useKeyStore } from '@josi-ce/connectors';
import { fromB64url, generateKeyPair, rpcAnswer, staticKeyFrom, toB64url } from '@josi-ce/tunnel';
import { fileKeyStore } from '@josi-ce/tunnel/node';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { HOSTED_PUBLIC_KEY, HOSTED_URL, RelayService, type RelayServiceOptions } from '../src/relay/relayService.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-relay-pin-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 22).toString('base64'));
const keyStore = fileKeyStore(join(dir, 'keys'));
const usage = { plan: 'free', periodEnd: null, allowance: 0, topUps: 0, spent: 0, reserved: 0, remaining: 0, accountCap: null, accountSpent: 0, models: [] };

let db: TestDb, admin: string;

/** Some other service: its own key, offered freely at /v1/noise-key. */
function impostor() {
  const key = staticKeyFrom(generateKeyPair().privateKey);
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(input);
    seen.push(href);
    if (href.endsWith('/v1/noise-key')) return Response.json({ publicKey: toB64url(key.publicKey) });
    try {
      const answer = await rpcAnswer({
        key, message: new Uint8Array(init!.body as Uint8Array), seen: () => false,
        async handle(call) {
          if (call.op === 'link') return { ok: true, serverId: 'srv-1', site: 'a'.repeat(32), name: 'alice', hostedPublic: toB64url(generateKeyPair().publicKey), relayUrl: 'http://127.0.0.1:9', plan: 'free' };
          return { ok: true, plan: 'free', name: 'alice', grant: null, aiToken: null, aiBaseUrl: null, usage, revoke: [] };
        },
      });
      return new Response(answer as Uint8Array<ArrayBuffer>);
    } catch { return new Response('', { status: 400 }); }
  }) as typeof fetch;
  return { key, seen, fetchImpl };
}

const service = (opts: Partial<RelayServiceOptions>) => new RelayService({ db, apiPort: 9, lanPort: null, keyStore, masterKey: { path: keyPath }, ...opts });
const stored = async () => (await db.query<{ hosted_public: string }>('select hosted_public from hey_josi_link'))[0]?.hosted_public;

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: 'admin-password-123' })).id;
  useKeyStore(keyStore);
});

afterEach(async () => { await db.query('delete from hey_josi_link'); });
afterAll(() => { useKeyStore(null); });

describe('the built-in service key', () => {
  it('is a whole key', () => { expect(fromB64url(HOSTED_PUBLIC_KEY)).toHaveLength(32); });

  it('refuses a service that can\'t prove it, however it answers /v1/noise-key', async () => {
    const fake = impostor();
    await expect(service({ fetchImpl: fake.fetchImpl }).linkAccount({ code: 'GOODCODE', actorUserId: admin })).rejects.toThrow();
    expect(fake.seen).toEqual([`${HOSTED_URL}/v1/rpc`]);
    expect(await stored()).toBeUndefined();
  });

  it('gives way to JOSI_HOSTED_PUBLIC_KEY', async () => {
    const own = impostor();
    await service({ hostedPublicKey: toB64url(own.key.publicKey), fetchImpl: own.fetchImpl }).linkAccount({ code: 'GOODCODE', actorUserId: admin });
    expect(own.seen.some(href => href.endsWith('/v1/noise-key'))).toBe(false);
    expect(await stored()).toBe(toB64url(own.key.publicKey));
  });

  it('stays out of a self-hosted service\'s way', async () => {
    const own = impostor();
    await service({ hostedUrl: 'https://hosted.test/', fetchImpl: own.fetchImpl }).linkAccount({ code: 'GOODCODE', actorUserId: admin });
    expect(own.seen[0]).toBe('https://hosted.test/v1/noise-key');
    expect(await stored()).toBe(toB64url(own.key.publicKey));
  });
});
