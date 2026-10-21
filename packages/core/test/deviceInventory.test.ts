import { createECDH, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createUser } from '../../auth/src/users.js';
import { MasterKey } from '../src/masterKey.js';
import { Secret } from '../src/sealing.js';
import { vaultRecords } from '../src/vault.js';
import { protectedDeviceEnrollmentMessage, type ProtectedDeviceAuthority } from '../src/protectedDevices.js';
import { testDb, testVault } from './helpers.js';

describe('saved device inventory', () => {
  it('reads a committed enrollment from a fresh store and retains it after a second enrollment', async () => {
    const db = await testDb(), key = new MasterKey(Buffer.alloc(32, 29));
    const owner = await createUser(db, { email: 'devices@test.invalid', username: 'devices', role: 'super_admin' });
    await testVault(db, key);
    const [installation] = await db.query<{ install_id: string }>('select install_id from install_identity where id=true');
    const authority: ProtectedDeviceAuthority = {
      requireServerIdentity: vi.fn(async (_tx, identity) => { expect(identity.serverId).toBe(installation.install_id); }),
      verifyFreshAdministrator: vi.fn(async (_tx, actor) => { expect(actor).toBe(owner.id); }),
      verifyEnrollmentConsent: vi.fn(async (_tx, actor) => { expect(actor).toBe(owner.id); }),
      verifyProtectedRevocation: async () => { throw new Error('not authorized by this fixture'); },
      verifyHostProjection: async () => { throw new Error('not authorized by this fixture'); },
    };
    for (const label of ['MBP', 'Second Mac']) {
      const store = vaultRecords(db, key).protectedDevices(authority);
      const before = await store.inventory(owner.id);
      const wrapping = createECDH('prime256v1'); wrapping.generateKeys();
      const signing = generateKeyPairSync('ed25519');
      const material = new Secret(JSON.stringify({ schemaVersion: 1,
        identity: { serverOrigin: 'http://localhost:8080', serverId: installation.install_id, userId: owner.id, deviceId: randomUUID() },
        wrappingPublicKey: wrapping.getPublicKey().toString('base64'),
        signingPublicKeySpki: signing.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        wrappedPrivateKey: randomBytes(80).toString('base64'),
      }));
      const request = { actorUserId: owner.id, enrollmentId: randomUUID(), label, material,
        expected: before.reference, epoch: before.authorityEpoch };
      const prepared = await store.prepareEnrollment(request);
      const possessionSignature = sign(null, Buffer.from(protectedDeviceEnrollmentMessage(prepared.command)), signing.privateKey).toString('base64url');
      const saved = await store.enroll({ ...request, possessionSignature, consentProof: undefined });
      const reread = await vaultRecords(db, key).protectedDevices(authority).inventory(owner.id);
      expect(reread).toEqual(saved);
      expect(reread.devices.map(device => device.label)).toEqual(label === 'MBP' ? ['MBP'] : ['MBP', 'Second Mac']);
      expect(reread.devices.every(device => device.revokedAt === null)).toBe(true);
    }
    expect(authority.verifyFreshAdministrator).toHaveBeenCalledTimes(2);
    expect(authority.verifyEnrollmentConsent).toHaveBeenCalledTimes(2);
  });
});
