import { createECDH, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createSession, createUser } from '@josi-ce/auth';
import { CardinalDraftStore, MasterKey, protectedDeviceEnrollmentMessage } from '@josi-ce/core';
import { deviceConsentMessage, type DeviceConsentChallenge } from '@josi-ce/protocol';
import { testDb, testVault } from '../../../packages/core/test/helpers.js';
import { ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { DeviceEnrollments } from '../src/http/deviceEnrollments.js';

// Only the physical macOS consent helper is simulated. Password verification,
// sessions, possession signatures, Vault transactions and HTTP reads are real.
vi.mock('../src/http/nativeDeviceConsent.js', () => ({
  startNativeDeviceConsent: async (challenge: DeviceConsentChallenge) => {
    const message = deviceConsentMessage(challenge);
    let consumed = false;
    return {
      challengeDigest: createHash('sha256').update(message).digest('hex'),
      status: () => 'approved', close: () => {},
      consume: (expected: DeviceConsentChallenge) => {
        if (consumed || deviceConsentMessage(expected) !== message) throw new Error('fixture consent mismatch');
        consumed = true;
      },
    };
  },
}));

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
});

it('confirms enrollment after commit and keeps saved Macs readable when unrelated settings fail', async () => {
  const db = await testDb(), key = new MasterKey(Buffer.alloc(32, 49));
  await ensureWorkspace(db);
  const password = 'synthetic-device-password-49';
  const owner = await createUser(db, { email: 'owner@device.test', username: 'owner', role: 'super_admin', password });
  const member = await createUser(db, { email: 'member@device.test', username: 'member', role: 'member' });
  await testVault(db, key);
  const session = await createSession(db, { userId: owner.id });
  const memberSession = await createSession(db, { userId: member.id });
  vi.spyOn(DeviceEnrollments.prototype, 'available').mockResolvedValue(true);
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost:8080',
    masterKeyCheck: { readFile: () => Buffer.from(key.reveal().toString('base64')) } });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/admin/automation`;
  async function call(path: string, body?: unknown, token: string | null = session.token) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-josi-client': 'native', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  expect((await call('/devices', undefined, null)).status).toBe(401);
  expect((await call('/devices', undefined, memberSession.token)).status).toBe(403);
  expect((await call('/devices')).body.devices).toEqual([]);

  for (const label of ['MBP', 'Second Mac']) {
    const begin = await call('/devices/enroll/begin', { label });
    expect(begin.status).toBe(201);
    const wrapping = createECDH('prime256v1'); wrapping.generateKeys();
    const signing = generateKeyPairSync('ed25519');
    const material = { schemaVersion: 1, identity: begin.body.identity,
      wrappingPublicKey: wrapping.getPublicKey().toString('base64'),
      signingPublicKeySpki: signing.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      wrappedPrivateKey: randomBytes(80).toString('base64') };
    const prepared = await call(`/devices/enroll/${begin.body.attemptId}/prepare`, { material, password });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const possessionSignature = sign(null, Buffer.from(protectedDeviceEnrollmentMessage({
      purpose: 'device.enroll', requestDigest: prepared.body.challenge.requestDigest,
    })), signing.privateKey).toString('base64url');
    const committed = await call(`/devices/enroll/${begin.body.attemptId}/commit`, { possessionSignature });
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect(committed.body.enrolled).toBe(true);
    expect(committed.body.inventory.devices.map((d: { label: string }) => d.label)).toEqual(label === 'MBP' ? ['MBP'] : ['MBP', 'Second Mac']);
    const reread = await call('/devices');
    expect(reread.cache).toBe('private, no-store');
    expect(reread.body).toEqual(committed.body.inventory);
    expect(JSON.stringify(reread.body)).not.toContain(material.wrappedPrivateKey);
    expect((await call(`/devices/enroll/${begin.body.attemptId}/commit`, { possessionSignature })).status).toBe(409);
  }
  vi.spyOn(CardinalDraftStore.prototype, 'list').mockRejectedValueOnce(new Error('unrelated draft unavailable'));
  expect((await call('')).status).toBe(503);
  expect((await call('/devices')).body.devices.map((d: { label: string }) => d.label)).toEqual(['MBP', 'Second Mac']);
  await db.query('update vault_state set locked=true');
  const locked = await call('/devices');
  expect(locked.status).toBe(423);
  expect(locked.body).not.toHaveProperty('devices'); // Never disguise a failed read as an empty registry.
}, 30_000);
