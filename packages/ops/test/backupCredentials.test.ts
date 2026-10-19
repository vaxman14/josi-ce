import { beforeEach, describe, expect, it } from 'vitest';
import { createDecipheriv } from 'node:crypto';
import { initializeVault, isVaultCredentialReference, MasterKey, recoverVault, seal, setVaultLock, storeVaultCredentialPayload, VaultLockedError } from '@josi-ce/core';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { prepareBackupDestinationSave, commitBackupDestinationSave, loadBackupDestination, recordBackupDestinationCheck, removeBackupDestination,
  type BackupDestinationInput } from '../src/backupCredentials.js';
import { encryptBackupContents } from '../src/destination.js';

const key = new MasterKey(Buffer.alloc(32, 75));
let db: TestDb, owner: string, recovery: string;
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role) values('backup@fixture.test','backup','super_admin') returning id");
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
});
const input = (): BackupDestinationInput => ({ kind: 's3', label: 'Archive', bucket: 'fixture', region: 'us-east-1', accountId: null, endpoint: null,
  objectPrefix: 'daily', shareProtocol: null, shareHost: null, shareName: null, encryptionEnabled: true,
  credentials: { accessKeyId: 'synthetic-id', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-session' } });
async function save(value = input(), actor = owner) {
  const plan = await prepareBackupDestinationSave(db, key, value, actor);
  const row = await commitBackupDestinationSave(db, key, plan);
  return { row, recoveryKey: plan.recoveryKey };
}
const items = () => db.query("select id from vault_items where service='backup'");

describe('backup Vault credentials', () => {
  it('recovers both keys with a replacement installation key and opens an archive using only the separately held archive key', async () => {
    const saved = await save();
    const payload = Buffer.from('synthetic archive');
    const encrypted = encryptBackupContents(payload, Buffer.from(saved.recoveryKey!, 'base64url'));
    // No database or Vault is needed to open the outer backup envelope.
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(saved.recoveryKey!, 'base64url'), encrypted.subarray(5, 17));
    decipher.setAuthTag(encrypted.subarray(17, 33));
    expect(Buffer.concat([decipher.update(encrypted.subarray(33)), decipher.final()])).toEqual(payload);
    const replacement = new MasterKey(Buffer.alloc(32, 76));
    await recoverVault(db, replacement, recovery, owner);
    const prepared = await loadBackupDestination(db, replacement);
    expect(prepared.credentials).toEqual(input().credentials);
    expect(prepared.encryptionKey?.toString('base64url')).toBe(saved.recoveryKey);
    expect(isVaultCredentialReference(prepared.row.credentials_enc)).toBe(true);
    expect(isVaultCredentialReference(prepared.row.encryption_key_ref)).toBe(true);
  });

  it('retains the archive key when encryption is disabled and re-enabled', async () => {
    const first = await save();
    const disabled = await save({ ...input(), encryptionEnabled: false, credentials: {} });
    expect(disabled.recoveryKey).toBeNull(); expect(disabled.row.encryption_key_ref).toBeTruthy();
    expect((await loadBackupDestination(db, key)).encryptionKey).toBeUndefined();
    const enabled = await save({ ...input(), credentials: {} });
    expect(enabled.recoveryKey).toBeNull();
    expect((await loadBackupDestination(db, key)).encryptionKey?.toString('base64url')).toBe(first.recoveryKey);
    expect(await items()).toHaveLength(2);
  });

  it.each(['master', 'box'])('refuses a %s lock without modifying configuration, health or references', async kind => {
    const { row } = await save();
    await recordBackupDestinationCheck(db, row.configuration_revision, { ok: true, detail: 'synthetic success' });
    await setVaultLock(db, { ...(kind === 'master' ? { master: true } : { ownerUserId: owner }), locked: true, actorUserId: owner });
    await expect(loadBackupDestination(db, key)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(save()).rejects.toBeInstanceOf(VaultLockedError);
    expect((await db.query('select last_check_ok,configuration_revision from backup_destination'))[0]).toEqual({ last_check_ok: true, configuration_revision: row.configuration_revision });
  });

  it('rolls back both canonical items if the encryption write fails', async () => {
    const plan = await prepareBackupDestinationSave(db, key, input(), owner);
    await db.exec("create function reject_backup_key() returns trigger as $$ begin if new.service='backup' and new.slot='encryption' then raise exception 'synthetic key failure'; end if; return new; end; $$ language plpgsql; create trigger reject_backup_key before insert on vault_items for each row execute function reject_backup_key();");
    await expect(commitBackupDestinationSave(db, key, plan)).rejects.toThrow('synthetic key failure');
    expect(await items()).toHaveLength(0); expect(await db.query('select * from backup_destination')).toHaveLength(0);
  });

  it('rolls back changed keys and metadata if audit insertion fails', async () => {
    const before = await save();
    await db.exec("create function reject_backup_audit() returns trigger as $$ begin if new.kind='backup.destination_configured' then raise exception 'synthetic audit failure'; end if; return new; end; $$ language plpgsql; create trigger reject_backup_audit before insert on events for each row execute function reject_backup_audit();");
    await expect(save({ ...input(), bucket: 'changed', credentials: { accessKeyId: 'new-id', secretAccessKey: 'new-secret' } })).rejects.toThrow('synthetic audit failure');
    const after = await loadBackupDestination(db, key);
    expect(after.credentials).toEqual(input().credentials); expect(after.row.configuration_revision).toBe(before.row.configuration_revision);
  });

  it('preserves partial updates only at the same endpoint and refuses account/password mismatches', async () => {
    await save();
    await save({ ...input(), credentials: { secretAccessKey: 'rotated' } });
    expect((await loadBackupDestination(db, key)).credentials).toEqual({ ...input().credentials, secretAccessKey: 'rotated' });
    await expect(save({ ...input(), endpoint: 'https://elsewhere.fixture.test', credentials: {} })).rejects.toThrow(/needs/);
    await expect(save({ ...input(), credentials: { accessKeyId: 'other-account' } })).rejects.toThrow(/secret again/);
    await save({ ...input(), credentials: { accessKeyId: 'other-account', secretAccessKey: 'other-secret' } });
    expect((await loadBackupDestination(db, key)).credentials).not.toHaveProperty('sessionToken');
  });

  it('binds independently owned historical references instead of assigning them to the editing administrator', async () => {
    await save();
    const [historical] = await db.query<{ id: string }>("insert into users(email,username,role) values('previous@fixture.test','previous','member') returning id");
    const ref = await storeVaultCredentialPayload(db, key, { ownerUserId: historical.id, kind: 'api_key', service: 'backup', slot: 'encryption', label: 'Old archive key', payload: { key: Buffer.alloc(32, 77).toString('base64url') } });
    await db.query('update backup_destination set encryption_key_ref=$1,credentials_owner_user_id=null,encryption_owner_user_id=null', [ref]);
    const loaded = await loadBackupDestination(db, key);
    expect(loaded.row.credentials_owner_user_id).toBe(owner); expect(loaded.row.encryption_owner_user_id).toBe(historical.id);
    await save({ ...input(), credentials: {} });
    expect((await loadBackupDestination(db, key)).row.encryption_owner_user_id).toBe(historical.id);
  });

  it('migrates a legacy pair together, with rollback on a failed reference replacement', async () => {
    const old = await save(); await db.query('delete from vault_items');
    await db.query('update backup_destination set credentials_enc=$1,encryption_key_ref=$2,credentials_owner_user_id=null,encryption_owner_user_id=null', [seal(key, input().credentials), seal(key, { key: old.recoveryKey })]);
    await db.exec("create function reject_backup_ref() returns trigger as $$ begin raise exception 'synthetic reference failure'; end; $$ language plpgsql; create trigger reject_backup_ref before update on backup_destination for each row execute function reject_backup_ref();");
    await expect(loadBackupDestination(db, key)).rejects.toThrow('synthetic reference failure'); expect(await items()).toHaveLength(0);
    await db.exec('drop trigger reject_backup_ref on backup_destination');
    const migrated = await loadBackupDestination(db, key);
    expect(migrated.credentials).toEqual(input().credentials); expect(await items()).toHaveLength(2);
    expect(migrated.row.configuration_revision).toBe(old.row.configuration_revision);
  });

  it('rejects a substituted slot, stale reads and old connection-test results', async () => {
    const first = await save(); await save({ ...input(), bucket: 'new-destination' });
    await expect(loadBackupDestination(db, key, first.row.configuration_revision)).rejects.toThrow(/changed/);
    await expect(recordBackupDestinationCheck(db, first.row.configuration_revision, { ok: true, detail: 'old result' })).rejects.toThrow(/changed/);
    expect((await db.query('select last_check_ok from backup_destination'))[0].last_check_ok).toBeNull();
    await db.query('update backup_destination set credentials_enc=encryption_key_ref');
    await expect(loadBackupDestination(db, key)).rejects.toThrow(/context/);
  });

  it('allows only one prepared edit to commit and rechecks the Vault at commit', async () => {
    const a = await prepareBackupDestinationSave(db, key, input(), owner);
    const b = await prepareBackupDestinationSave(db, key, { ...input(), bucket: 'other' }, owner);
    await commitBackupDestinationSave(db, key, a);
    await expect(commitBackupDestinationSave(db, key, b)).rejects.toThrow(/changed/);
    const c = await prepareBackupDestinationSave(db, key, input(), owner);
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    await expect(commitBackupDestinationSave(db, key, c)).rejects.toBeInstanceOf(VaultLockedError);
    await removeBackupDestination(db, null, owner);
    expect(await items()).toHaveLength(0); expect(await db.query('select * from backup_destination')).toHaveLength(0);
  });

  it('requires explicit clearing when changing a credentialed NAS to guest access', async () => {
    const nas: BackupDestinationInput = { ...input(), kind: 'nas', bucket: '/mnt/josi-nas/daily', region: 'local', shareProtocol: 'smb', shareHost: 'nas.fixture.test', shareName: 'backup', credentials: { username: 'fixture', password: 'fixture-password' } };
    await save(nas);
    await expect(save({ ...nas, shareHost: 'other.fixture.test', credentials: {} })).rejects.toThrow(/explicitly clear/);
    await save({ ...nas, shareHost: 'other.fixture.test', credentials: {}, clearCredentials: true });
    expect((await loadBackupDestination(db, key)).credentials).toEqual({});
    expect(await items()).toHaveLength(1);
  });
});
