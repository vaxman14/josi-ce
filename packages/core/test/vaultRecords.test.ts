import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createUser } from '../../auth/src/users.js';
import { testDb, type TestDb } from './helpers.js';
import { MasterKey } from '../src/masterKey.js';
import { asSecret, openSealed, seal } from '../src/sealing.js';
import { deleteVaultItem, getVaultSecret, initializeVault, listVaultItems, openCredentialPayload,
  openCredentialEnvelope, putVaultItem, recoverVault, setVaultLock, storeCredentialPayload, vaultRecords,
  VaultLockedError, VaultRecordConflictError } from '../src/vault.js';

let db: TestDb, owner: string, member: string, recovery: string;
const key = new MasterKey(Buffer.alloc(32, 23));
const content = 'Only publish a listing on the explicitly approved storefront.';
beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'admin@example.test', username: 'admin', role: 'super_admin' })).id;
  member = (await createUser(db, { email: 'member@example.test', username: 'member', role: 'member' })).id;
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
});
const draft = () => ({ actorUserId: owner, kind: 'cardinal_draft' as const, value: asSecret(content) });

describe('protected Vault record storage', () => {
  it('encrypts content under the existing vault and keeps generic credentials/audits free of it', async () => {
    const records = vaultRecords(db, key), reference = await records.write(draft());
    const opened = await records.read({ actorUserId: owner, recordId: reference.recordId, expected: reference });
    expect(opened.value.reveal()).toBe(content);
    expect(JSON.stringify(opened)).not.toContain(content);
    const rows = await db.query<{ value_enc: string }>('select * from vault_record_versions');
    expect(JSON.stringify(rows)).not.toContain(content);
    expect(() => openSealed(key, rows[0].value_enc)).toThrow(); // independent existing vault key
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(content);
    expect(await listVaultItems(db, owner)).toEqual([]);
    expect(await deleteVaultItem(db, { ownerUserId: owner, itemId: reference.recordId, actorUserId: owner })).toBe(false);
    expect((await records.read({ actorUserId: owner, recordId: reference.recordId })).value.reveal()).toBe(content);
  });

  it('checks the live super-admin role for both reads and edits', async () => {
    const records = vaultRecords(db, key), reference = await records.write(draft());
    await expect(records.write({ ...draft(), actorUserId: member })).rejects.toThrow(/super admin/);
    await expect(records.read({ actorUserId: member, recordId: reference.recordId })).rejects.toThrow(/super admin/);
    await db.query(`update users set status='disabled' where id=$1`, [owner]);
    await expect(records.write({ ...draft(), expected: reference })).rejects.toThrow(/super admin/);
    await expect(records.read({ actorUserId: owner, recordId: reference.recordId })).rejects.toThrow(/super admin/);
  });

  it('preserves versions and lets only one concurrent edit consume the same reference', async () => {
    const records = vaultRecords(db, key), first = await records.write(draft());
    const result = await Promise.allSettled([
      records.write({ ...draft(), value: asSecret('revision one'), expected: first }),
      records.write({ ...draft(), value: asSecret('revision two'), expected: first }),
    ]);
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(value => value.status === 'rejected')).toHaveLength(1);
    const versions = await db.query<{ version: number; previous_digest: string }>('select version,previous_digest from vault_record_versions order by version');
    expect(versions.map(row => row.version)).toEqual([1, 2]);
    expect(versions[1].previous_digest).toBe(first.digest);
    await expect(records.read({ actorUserId: owner, recordId: first.recordId, expected: first })).rejects.toBeInstanceOf(VaultRecordConflictError);
  });

  it('rejects cached references after lock/unlock and denies all reads while locked', async () => {
    const records = vaultRecords(db, key), first = await records.write(draft());
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    await expect(records.read({ actorUserId: owner, recordId: first.recordId })).rejects.toBeInstanceOf(VaultLockedError);
    await expect(records.write(draft())).rejects.toBeInstanceOf(VaultLockedError);
    await setVaultLock(db, { master: true, locked: false, actorUserId: owner });
    await expect(records.read({ actorUserId: owner, recordId: first.recordId, expected: first })).rejects.toBeInstanceOf(VaultRecordConflictError);
    const fresh = await records.read({ actorUserId: owner, recordId: first.recordId });
    expect(fresh.reference.epoch).toBeGreaterThan(first.epoch);
    expect(fresh.value.reveal()).toBe(content);
  });

  it('recovers existing credentials and records with a replacement install key while invalidating authority', async () => {
    const records = vaultRecords(db, key), first = await records.write(draft());
    const reference = await storeCredentialPayload(db, key, { ownerUserId: owner, kind: 'api_key', service: 'fixture', slot: 'reference', label: 'Fixture reference', payload: { token: 'synthetic-recovery-token' } });
    await putVaultItem(db, key, { ownerUserId: owner, kind: 'password', service: 'fixture', slot: 'main', label: 'Fixture', value: asSecret('recovery-fixture-value') });
    const replacement = new MasterKey(Buffer.alloc(32, 24));
    await recoverVault(db, replacement, recovery, owner);
    const restored = vaultRecords(db, replacement);
    expect((await restored.read({ actorUserId: owner, recordId: first.recordId })).value.reveal()).toBe(content);
    expect((await getVaultSecret(db, replacement, { ownerUserId: owner, service: 'fixture', slot: 'main' })).reveal()).toBe('recovery-fixture-value');
    expect(await openCredentialPayload(db, replacement, { ownerUserId: owner, service: 'fixture', slot: 'reference', stored: reference })).toEqual({ token: 'synthetic-recovery-token' });
    const current = await restored.read({ actorUserId: owner, recordId: first.recordId });
    await expect(restored.read({ actorUserId: owner, recordId: first.recordId, expected: current.reference })).rejects.toThrow(/reconciliation/);
    await expect(restored.write(draft())).rejects.toThrow(/reconciliation/);
    await expect(records.read({ actorUserId: owner, recordId: first.recordId })).rejects.toThrow();
  });

  it('detects a ciphertext transplanted with a matching index digest', async () => {
    const records = vaultRecords(db, key), a = await records.write(draft()), b = await records.write(draft());
    const [row] = await db.query<{ value_enc: string }>('select value_enc from vault_record_versions where record_id=$1', [a.recordId]);
    const hash = createHash('sha256').update(row.value_enc).digest('hex');
    await db.query('update vault_record_versions set value_enc=$2,digest=$3 where record_id=$1', [b.recordId, row.value_enc, hash]);
    await db.query('update vault_record_heads set digest=$2 where id=$1', [b.recordId, hash]);
    await expect(records.read({ actorUserId: owner, recordId: b.recordId })).rejects.toThrow(/context/);
  });

  it('rolls back the record and epoch if the audit write fails', async () => {
    const records = vaultRecords(db, key), first = await records.write(draft());
    const broken = vaultRecords({ query: db.query, transaction: work => db.transaction!(tx => work({
      query: (sql, params) => {
        if (sql.includes('insert into events')) throw new Error('synthetic audit outage');
        return tx.query(sql, params);
      },
    })) }, key);
    await expect(broken.write({ ...draft(), expected: first })).rejects.toThrow('synthetic audit outage');
    expect((await records.read({ actorUserId: owner, recordId: first.recordId, expected: first })).reference).toEqual(first);
    expect(await db.query('select * from vault_record_versions')).toHaveLength(1);
  });

  it('fails closed on uninitialized vaults, unknown kinds, oversized values and unavailable transactions', async () => {
    const records = vaultRecords(db, key);
    await expect(records.write({ ...draft(), kind: 'active_rule' as never })).rejects.toThrow(/Unsupported/);
    await expect(records.write({ ...draft(), value: asSecret('x'.repeat(256 * 1024 + 1)) })).rejects.toThrow(/oversized/);
    await expect(vaultRecords({ query: db.query }, key).read({ actorUserId: owner, recordId: owner })).rejects.toThrow(/transactions/);
    await expect(vaultRecords({ query: db.query }, key).write(draft())).rejects.toThrow(/transactions/);
    await db.query('update vault_state set initialized_at=null');
    await expect(records.write(draft())).rejects.toBeInstanceOf(VaultLockedError);
    expect(await db.query('select * from vault_record_heads')).toHaveLength(0);
  });
});

describe('credential reference identity', () => {
  it('rejects a different or deleted item even if the requested service/slot exists', async () => {
    const args = { ownerUserId: owner, kind: 'api_key' as const, service: 'fixture', slot: 'one', label: 'Fixture', payload: { token: 'synthetic-one' } };
    const one = await storeCredentialPayload(db, key, args);
    const two = await storeCredentialPayload(db, key, { ...args, slot: 'two', payload: { token: 'synthetic-two' } });
    const load = (stored: string) => openCredentialPayload(db, key, { ownerUserId: owner, service: 'fixture', slot: 'one', stored });
    expect(await load(one)).toEqual({ token: 'synthetic-one' });
    await expect(load(two)).rejects.toThrow(/context/);
    await expect(load(seal(key, { vaultItemId: '' }))).rejects.toThrow(/invalid/);
    const pointer = await openCredentialEnvelope(db, key, one);
    await deleteVaultItem(db, { ownerUserId: owner, actorUserId: owner, itemId: pointer.vaultItemId! });
    await storeCredentialPayload(db, key, args);
    await expect(load(one)).rejects.toThrow(/not found/);
  });
});
