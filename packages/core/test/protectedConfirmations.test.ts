import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AUTOMATION_PERMISSION_SEMANTICS, protectedControlMessage, type AutomationPermissionPolicy, type ProtectedControlChallenge, type ProtectedControlReceipt } from '@josi-ce/protocol';
import { createSession } from '../../auth/src/sessions.js';
import { hashPassword } from '../../auth/src/passwords.js';
import { reauthenticateProtectedAdmin, type ProtectedAdminProof } from '../../auth/src/protectedAdmin.js';
import { testDb, type TestDb } from './helpers.js';
import { MasterKey } from '../src/masterKey.js';
import { initializeVault, recoverVault, setVaultLock, vaultRecords, putVaultItem } from '../src/vault.js';
import { Secret } from '../src/sealing.js';
import { automationPolicyChangeBinding } from '../src/automationPolicy.js';
import type { ProtectedConfirmationAuthority, ProtectedConfirmationCommand } from '../src/protectedConfirmations.js';
import type { Db } from '../src/db.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = new MasterKey(Buffer.alloc(32, 91)), password = 'synthetic-confirmation-password';
let db: TestDb, admin: string, member: string, sessionId: string, recovery: string;
let keys: { publicKey: KeyObject; privateKey: KeyObject }, keyVersion: number;
beforeEach(async () => {
  db = await testDb(); keyVersion = 1; keys = generateKeyPairSync('ed25519');
  [{ id: admin }] = await db.query<{ id: string }>("insert into users(email,username,role,password_hash) values('confirmation@fixture.test','confirmation','super_admin',$1) returning id", [await hashPassword(password)]);
  [{ id: member }] = await db.query<{ id: string }>("insert into users(email,username,role) values('member@fixture.test','member','member') returning id");
  recovery = (await initializeVault(db, key, admin)).recoveryKey.reveal();
  sessionId = (await createSession(db, { userId: admin })).sessionId;
});
const identity = () => ({ serverOrigin: 'https://josi.example', serverId: id(1), userId: admin, deviceId: id(2) });
const policy = (): AutomationPermissionPolicy => ({ schemaVersion: 1, semanticsVersion: AUTOMATION_PERMISSION_SEMANTICS,
  identity: { userId: member, serverId: id(1), deviceId: id(2), workspaceId: id(3) }, enabled: false, unmatched: 'deny', rules: [] });
const args = () => ({ actorUserId: admin, policy: policy(), expected: null });
const command = () => automationPolicyChangeBinding(args());
const presentation = { wording: 'Disable automation for the finance workspace.', meaning: 'No automation permissions are granted.', advisory: ['Synthetic model advice, never approval.'] };
const fresh = (binding = command()) => reauthenticateProtectedAdmin(db, key, { userId: admin, sessionId, password, ...binding });

function authority(proof?: ProtectedAdminProof): ProtectedConfirmationAuthority {
  return {
    // Explicit fixture: NOT real device enrollment or a production Vault key
    // projection. Tests exercise the challenge journal with generated keys.
    resolveDeviceKey: async (tx, requested) => {
      expect(requested).toEqual(identity());
      const [{ authority_epoch }] = await tx.query<{ authority_epoch: string }>('select authority_epoch from vault_state');
      return { reference: { recordId: id(4), version: keyVersion, digest: 'a'.repeat(64), epoch: Number(authority_epoch) },
        publicKeySpki: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
    },
    verifyFreshAdministrator: async (tx, actorUserId, binding) => {
      if (!proof) throw new Error('Fresh proof missing');
      await proof.check(tx, { actorUserId, ...binding, consume: false });
    },
    verifyDelivery: async (_tx, challenge, proof) => {
      if (proof !== 'synthetic-host-channel' || challenge.deviceId !== id(2)) throw new Error('Host proof missing');
    },
  };
}
function signReceipt(challenge: ProtectedControlChallenge): ProtectedControlReceipt {
  const message = Buffer.from(protectedControlMessage(challenge));
  return { schemaVersion: 1, challengeId: challenge.id, challengeDigest: createHash('sha256').update(message).digest('hex'),
    signature: sign(null, message, keys.privateKey).toString('base64url') };
}
async function prepare(binding = command()) {
  const proof = await fresh(binding), ports = authority(proof), store = vaultRecords(db, key).protectedConfirmations(ports);
  const issued = await store.issue({ actorUserId: admin, identity: identity(), command: binding, presentation });
  const challenge = await store.deliver({ actorUserId: admin, challengeId: issued.challengeId, proof: 'synthetic-host-channel' });
  return { proof, ports, store, issued, challenge, receipt: signReceipt(challenge) };
}
const verify = (f: Awaited<ReturnType<typeof prepare>>, receipt = f.receipt, binding: ProtectedConfirmationCommand = command()) =>
  db.transaction!(tx => f.store.verifier(receipt)(tx, admin, binding));

describe('Vault-backed protected confirmation challenge journal', () => {
  it('encrypts the full presentation, preserves the authority epoch and requires protected delivery', async () => {
    const [{ authority_epoch: before }] = await db.query('select authority_epoch from vault_state');
    const f = await prepare();
    expect(f.challenge.presentation).toEqual(presentation);
    expect(f.challenge.expiresAtMs - f.challenge.issuedAtMs).toBe(120000);
    expect((await db.query('select authority_epoch from vault_state'))[0].authority_epoch).toBe(before);
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
    const rows = JSON.stringify(await db.query('select * from protected_control_challenges'));
    const events = JSON.stringify(await db.query('select * from events'));
    for (const value of [presentation.wording, presentation.meaning, f.challenge.requestDigest, f.receipt.signature]) {
      expect(rows).not.toContain(value); expect(events).not.toContain(value);
    }
    await expect(f.store.deliver({ actorUserId: admin, challengeId: f.challenge.id, proof: true })).rejects.toThrow(/Host proof/);
    await expect(f.store.deliver({ actorUserId: member, challengeId: f.challenge.id, proof: 'synthetic-host-channel' })).rejects.toThrow(/super admin/);
  });
  it('requires current fresh account verification and a real key-resolver port before issue', async () => {
    const input = { actorUserId: admin, identity: identity(), command: command(), presentation };
    await expect(vaultRecords(db, key).protectedConfirmations(undefined as never).issue(input)).rejects.toThrow(/administrator verification/);
    await expect(vaultRecords(db, key).protectedConfirmations(authority()).issue(input)).rejects.toThrow(/Fresh proof/);
    const proof = await fresh(), ports = authority(proof); ports.resolveDeviceKey = undefined as never;
    await expect(vaultRecords(db, key).protectedConfirmations(ports).issue(input)).rejects.toThrow(/enrollment/);
    const f = await prepare(); await db.query('update sessions set revoked_at=now() where id=$1', [sessionId]);
    await expect(f.store.issue(input)).rejects.toThrow(/Confirm/);
    expect(await db.query('select id from protected_control_challenges')).toHaveLength(1);
  });
  it('consumes a real fixture signature only for its exact command and only once, across store recreation', async () => {
    const f = await prepare();
    await expect(verify(f, f.receipt, { ...command(), requestDigest: 'b'.repeat(64) })).rejects.toThrow(/exact/);
    await expect(verify(f, { ...f.receipt, signature: sign(null, Buffer.from('different'), keys.privateKey).toString('base64url') })).rejects.toThrow(/did not match/);
    const changed = signReceipt({ ...f.challenge, presentation: { ...presentation, meaning: 'A different meaning.' } });
    await expect(verify(f, changed)).rejects.toThrow(/did not match/);
    await verify(f);
    expect((await db.query('select state from protected_control_challenges'))[0].state).toBe('consumed');
    const reopened = vaultRecords(db, key).protectedConfirmations(f.ports);
    await expect(db.transaction!(tx => reopened.verifier(f.receipt)(tx, admin, command()))).rejects.toThrow(/consumed/);
  });
  it('uses the same policy transaction for fresh proof, signed receipt, policy, epoch and audit', async () => {
    const f = await prepare(), human = f.store.verifier(f.receipt);
    const proofs = { verifyFreshAdministrator: async (tx: Db, actorUserId: string, binding: ProtectedConfirmationCommand) => f.proof.check(tx, { actorUserId, ...binding, consume: true }),
      verifyProtectedHuman: human };
    const broken: TestDb = { ...db, transaction: async work => db.transaction!(tx => work({ ...tx, query: async (sql, params) => {
      if (/insert into events/i.test(sql) && params?.includes('vault.record_written')) throw new Error('synthetic audit failure');
      return tx.query(sql, params);
    } })) };
    await expect(vaultRecords(broken, key).automationPolicy(proofs).replace(args())).rejects.toThrow(/audit failure/);
    expect((await db.query('select state from protected_control_challenges'))[0].state).toBe('pending');
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
    expect(await db.query("select id from vault_record_heads where kind='automation_policy'")).toHaveLength(0);
    const saved = await vaultRecords(db, key).automationPolicy(proofs).replace(args());
    expect(saved.document.policies).toEqual([policy()]);
    expect((await db.query('select state from protected_control_challenges'))[0].state).toBe('consumed');
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).not.toBeNull();
  });
  it('only one concurrent verifier can consume a confirmation', async () => {
    const f = await prepare(), results = await Promise.allSettled([verify(f), verify(f)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('cancel is idempotent, prevents receipt consumption and cannot unconsume a receipt', async () => {
    const f = await prepare(); await f.store.cancel(admin, f.challenge.id); await f.store.cancel(admin, f.challenge.id);
    await expect(verify(f)).rejects.toThrow(/consumed or stale/);
    const g = await prepare(); await verify(g);
    await expect(g.store.cancel(admin, g.challenge.id)).rejects.toThrow(/already consumed/);
  });
  it('checks live role, device-key revision and public-key identity again', async () => {
    const f = await prepare(); keyVersion++;
    await expect(verify(f)).rejects.toThrow(/authority changed/); keyVersion--;
    const original = keys; keys = generateKeyPairSync('ed25519');
    await expect(verify(f)).rejects.toThrow(/authority changed/); keys = original;
    await db.query("update users set role='member' where id=$1", [admin]);
    await expect(verify(f)).rejects.toThrow(/super admin/);
  });
  it('master and private-box lock cannot be bypassed; unlock does not revive a stale challenge', async () => {
    await putVaultItem(db, key, { ownerUserId: admin, kind: 'secure_note', service: 'fixture', slot: 'note', label: 'Fixture', value: new Secret('synthetic') });
    const f = await prepare();
    await setVaultLock(db, { ownerUserId: admin, locked: true, actorUserId: admin });
    await expect(verify(f)).rejects.toThrow(/locked/);
    await setVaultLock(db, { ownerUserId: admin, locked: false, actorUserId: admin });
    await expect(verify(f)).rejects.toThrow(/stale/);
    const g = await prepare(); await setVaultLock(db, { master: true, locked: true, actorUserId: admin });
    await expect(verify(g)).rejects.toThrow(/locked/i);
  });
  it('replacement-key recovery cannot reactivate outstanding human proofs', async () => {
    const f = await prepare(), replacement = new MasterKey(Buffer.alloc(32, 92));
    await recoverVault(db, replacement, recovery, admin);
    const reopened = vaultRecords(db, replacement).protectedConfirmations(f.ports);
    await expect(reopened.deliver({ actorUserId: admin, challengeId: f.challenge.id, proof: 'synthetic-host-channel' })).rejects.toThrow(/reconciliation/);
    await expect(db.transaction!(tx => reopened.verifier(f.receipt)(tx, admin, command()))).rejects.toThrow(/reconciliation/);
  });
  it('detects row identity/expiry/ciphertext and consumed-state tampering', async () => {
    const f = await prepare(), [original] = await db.query('select * from protected_control_challenges where id=$1', [f.challenge.id]);
    for (const [column, value] of [['device_id', id(90)], ['expires_at', new Date(f.challenge.expiresAtMs + 1000).toISOString()], ['challenge_enc', 'corrupt']]) {
      await db.query(`update protected_control_challenges set ${column}=$2 where id=$1`, [f.challenge.id, value]);
      await expect(verify(f)).rejects.toThrow(/unreadable or changed/);
      await db.query(`update protected_control_challenges set ${column}=$2 where id=$1`, [f.challenge.id, original[column]]);
    }
    await verify(f); await db.query("update protected_control_challenges set state='pending' where id=$1", [f.challenge.id]);
    await expect(verify(f)).rejects.toThrow(/unreadable or changed/);
  });
  it('limits pending prompts per administrator and allows a new one after cancellation', async () => {
    const f = await prepare(), input = { actorUserId: admin, identity: identity(), command: command(), presentation };
    for (let i = 1; i < 16; i++) await f.store.issue(input);
    await expect(f.store.issue(input)).rejects.toThrow(/Too many/);
    await f.store.cancel(admin, f.challenge.id); await f.store.issue(input);
    expect(await db.query("select id from protected_control_challenges where state='pending'")).toHaveLength(16);
  });
  it('checks expiry both before and after a device verifier, without a real two-minute wait', async () => {
    const f = await prepare(); let advanced = false;
    const clockDb: Db = { ...db, transaction: work => db.transaction!(tx => work({ ...tx, query: async <T>(sql: string, params?: unknown[]) => {
      const rows = await tx.query<T>(sql, params);
      if (advanced && sql.startsWith('select floor(extract(epoch from clock_timestamp())')) {
        (rows[0] as { now_ms: string }).now_ms = String(Date.now() + 120000);
      }
      return rows;
    } })) };
    const expired = vaultRecords(clockDb, key).protectedConfirmations(f.ports);
    advanced = true;
    await expect(clockDb.transaction!(tx => expired.verifier(f.receipt)(tx, admin, command()))).rejects.toThrow(/expired/);
    advanced = false;
    const delayed = vaultRecords(clockDb, key).protectedConfirmations({ ...f.ports, resolveDeviceKey: async (tx, requested) => {
      const result = await f.ports.resolveDeviceKey(tx, requested); advanced = true; return result;
    } });
    await expect(clockDb.transaction!(tx => delayed.verifier(f.receipt)(tx, admin, command()))).rejects.toThrow(/expired/);
    expect((await db.query('select state from protected_control_challenges'))[0].state).toBe('pending');
  });
  it('rejects unknown receipt fields and missing protected-delivery verification', async () => {
    const f = await prepare();
    await expect(verify(f, { ...f.receipt, approved: true } as never)).rejects.toThrow(/proof required/);
    const unavailable = vaultRecords(db, key).protectedConfirmations({ ...f.ports, verifyDelivery: undefined as never });
    await expect(unavailable.deliver({ actorUserId: admin, challengeId: f.challenge.id, proof: true })).rejects.toThrow(/authentication unavailable/);
    await verify(f);
  });
});
