import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { MasterKey, initializeVault, isVaultCredentialReference, recoverVault, seal, setVaultLock,
  deleteVaultSlot, openCredentialEnvelope, VaultLockedError } from '@josi-ce/core';
import { createCustomApi, customApiById, deleteCustomApi, openCustomApiCredentials, updateCustomApi, type CustomApiConnectionRow } from '../src/customApi.js';

let db: TestDb, admin: string, recovery: string;
const key = new MasterKey(Buffer.alloc(32, 43));
const secret = 'synthetic-custom-api-vault-value';
beforeEach(async () => {
  db = await testDb();
  [{ id: admin }] = await db.query<{ id: string }>(`insert into users(email,username,role) values('custom-vault@example.test','custom-vault','super_admin') returning id`);
  recovery = (await initializeVault(db, key, admin)).recoveryKey.reveal();
});
function create(slug = 'fixture') {
  return createCustomApi(db, key, { actorUserId: admin, name: 'Fixture', slug, baseUrl: 'https://example.test/v1', host: 'example.test',
    authKind: 'bearer', authHeader: null, credentials: { secret }, testPath: '/health' });
}
async function legacy(row: CustomApiConnectionRow) {
  await db.query('update custom_api_connections set credentials_enc=$2,vault_owner_user_id=null where id=$1', [row.id, seal(key, { secret })]);
  await deleteVaultSlot(db, { ownerUserId: admin, actorUserId: admin, service: 'custom_api', slot: row.id });
  return (await customApiById(db, row.id))!;
}

describe('canonical Custom API credentials', () => {
  it('imports a legacy payload with owner binding and preserves it across installation-key recovery', async () => {
    const old = await legacy(await create());
    expect(await openCustomApiCredentials(db, key, old)).toEqual({ secret });
    const current = (await customApiById(db, old.id))!;
    expect(current.vault_owner_user_id).toBe(admin);
    expect(isVaultCredentialReference(current.credentials_enc)).toBe(true);
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(secret);
    const replacement = new MasterKey(Buffer.alloc(32, 44));
    await recoverVault(db, replacement, recovery, admin);
    expect(await openCustomApiCredentials(db, replacement, current)).toEqual({ secret });
  });

  it('upgrades an old opaque reference without accepting another connection slot', async () => {
    const one = await create(), two = await create('second');
    const pointer = await openCredentialEnvelope(db, key, one.credentials_enc);
    await db.query('update custom_api_connections set credentials_enc=$2 where id=$1', [one.id, seal(key, { vaultItemId: pointer.vaultItemId })]);
    expect(await openCustomApiCredentials(db, key, (await customApiById(db, one.id))!)).toEqual({ secret });
    expect(isVaultCredentialReference((await customApiById(db, one.id))!.credentials_enc)).toBe(true);
    await db.query('update custom_api_connections set credentials_enc=$2 where id=$1', [one.id, two.credentials_enc]);
    await expect(openCustomApiCredentials(db, key, (await customApiById(db, one.id))!)).rejects.toThrow(/context/);
  });

  it('blocks legacy import and reads while locked, and can still delete canonical credentials', async () => {
    const old = await legacy(await create()), current = await create('current');
    await setVaultLock(db, { master: true, locked: true, actorUserId: admin });
    await expect(openCustomApiCredentials(db, key, old)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(openCustomApiCredentials(db, key, current)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(create('locked')).rejects.toBeInstanceOf(VaultLockedError);
    expect((await customApiById(db, old.id))!.credentials_enc).toBe(old.credentials_enc);
    await deleteCustomApi(db, { actorUserId: admin, connection: current });
    expect(await customApiById(db, current.id)).toBeNull();
    expect(await db.query("select id from vault_items where service='custom_api'")).toHaveLength(0);
  });

  it('rolls back a failed import and leaves the original credential intact', async () => {
    const old = await legacy(await create());
    await db.exec(`create function reject_custom_import() returns trigger as $$ begin raise exception 'synthetic import failure'; end; $$ language plpgsql;
      create trigger reject_custom_import before update on custom_api_connections for each row execute function reject_custom_import();`);
    await expect(openCustomApiCredentials(db, key, old)).rejects.toThrow('synthetic import failure');
    expect((await customApiById(db, old.id))!.credentials_enc).toBe(old.credentials_enc);
    expect(await db.query("select id from vault_items where service='custom_api'")).toHaveLength(0);
  });

  it('rolls back a credential rotation when the configuration cannot commit', async () => {
    const current = await create();
    await db.exec(`create function reject_custom_rotation() returns trigger as $$ begin raise exception 'synthetic rotation failure'; end; $$ language plpgsql;
      create trigger reject_custom_rotation before update on custom_api_connections for each row execute function reject_custom_rotation();`);
    await expect(updateCustomApi(db, key, { actorUserId: admin, connection: current, credentials: { secret: 'synthetic-rotated-value' } })).rejects.toThrow('synthetic rotation failure');
    expect(await openCustomApiCredentials(db, key, current)).toEqual({ secret });
  });

  it('refuses an earlier snapshot after credential rotation or destination changes', async () => {
    const old = await create();
    const current = await updateCustomApi(db, key, { actorUserId: admin, connection: old, credentials: { secret: 'synthetic-rotated-value' } });
    await expect(openCustomApiCredentials(db, key, old)).rejects.toThrow(/changed/);
    expect(await openCustomApiCredentials(db, key, current)).toEqual({ secret: 'synthetic-rotated-value' });
    await updateCustomApi(db, key, { actorUserId: admin, connection: current, baseUrl: 'https://other.test', host: 'other.test' });
    await expect(openCustomApiCredentials(db, key, current)).rejects.toThrow(/changed/);
  });

  it('requires an initialized Vault for new credentials', async () => {
    await db.query('update vault_state set initialized_at=null');
    await expect(create()).rejects.toBeInstanceOf(VaultLockedError);
    expect(await db.query('select id from custom_api_connections')).toHaveLength(0);
  });

  it('does not leave an orphan credential when creation hits a configuration constraint', async () => {
    const current = await create();
    await expect(create()).rejects.toThrow(); // The slug must be unique.
    expect(await db.query("select id from vault_items where service='custom_api'")).toHaveLength(1);
    expect(await openCustomApiCredentials(db, key, current)).toEqual({ secret });
  });
});
