import { beforeEach, describe, expect, it } from 'vitest';
import { MasterKey, initializeVault, recoverVault, setVaultLock, seal, isVaultCredentialReference, VaultLockedError } from '@josi-ce/core';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { checkDeveloperCredentialAccess, saveDeveloperConnection, loadDeveloperCredentials, recordDeveloperCheck, deleteDeveloperConnection } from '../src/developerCredentials.js';

const key = new MasterKey(Buffer.alloc(32, 70));
let db: TestDb, owner: string, other: string, recovery: string;
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role) values('dev@fixture.test','dev','super_admin') returning id");
  [{ id: other }] = await db.query<{ id: string }>("insert into users(email,username,role) values('other@fixture.test','other','member') returning id");
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
  await db.query("update developer_service_policy set mode='everyone' where service in ('github','netlify')");
});
const args = () => ({ ownerUserId: owner, service: 'github' as const });
const save = (token = 'synthetic-developer-token') => saveDeveloperConnection(db, key, { ...args(), credentials: { token }, accountLabel: 'Fixture' });
const load = () => loadDeveloperCredentials(db, key, args());
const items = () => db.query("select id from vault_items where service='developer.github'");

describe('developer connection Vault authority', () => {
  it('stores only a bound reference and survives replacement-key recovery', async () => {
    await save();
    const prepared = await load();
    expect(isVaultCredentialReference(prepared.reference)).toBe(true);
    const replacement = new MasterKey(Buffer.alloc(32, 71));
    await recoverVault(db, replacement, recovery, owner);
    expect((await loadDeveloperCredentials(db, replacement, args())).credentials.token).toBe('synthetic-developer-token');
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain('synthetic-developer-token');
  });

  it.each(['master', 'box'])('enforces the %s lock before reading, testing or storing and still permits disconnection', async kind => {
    await save();
    await setVaultLock(db, { ...(kind === 'master' ? { master: true } : { ownerUserId: owner }), locked: true, actorUserId: owner });
    await expect(load()).rejects.toBeInstanceOf(VaultLockedError);
    await expect(checkDeveloperCredentialAccess(db, owner, 'github')).rejects.toBeInstanceOf(VaultLockedError);
    await expect(save()).rejects.toBeInstanceOf(VaultLockedError);
    await deleteDeveloperConnection(db, owner, 'github');
    expect(await items()).toHaveLength(0);
  });

  it('rechecks policy after a credential test and refuses late evidence after revocation', async () => {
    await save(); const prepared = await load();
    await checkDeveloperCredentialAccess(db, owner, 'github');
    await db.query("update developer_service_policy set mode='not_allowed' where service='github'");
    await expect(save('replacement')).rejects.toThrow('not permitted');
    await expect(load()).rejects.toThrow('not permitted');
    expect(await recordDeveloperCheck(db, { ...args(), reference: prepared.reference, check: { ok: false, detail: 'old failure' } })).toBe(false);
    expect((await db.query('select last_check_ok from developer_connections'))[0].last_check_ok).toBe(true);
  });

  it('does not let a stale provider result overwrite a rotated or deleted connection', async () => {
    await save(); const old = await load();
    await save('replacement');
    expect(await recordDeveloperCheck(db, { ...args(), reference: old.reference, check: { ok: false, detail: 'old failure' } })).toBe(false);
    const current = await load();
    expect(current.credentials.token).toBe('replacement');
    await deleteDeveloperConnection(db, owner, 'github');
    expect(await recordDeveloperCheck(db, { ...args(), reference: current.reference, check: { ok: true, detail: 'old success' } })).toBe(false);
  });

  it('migrates old ciphertext and rejects cross-owner and cross-service references', async () => {
    await db.query("insert into developer_connections(owner_user_id,service,credentials_enc) values($1,'github',$2)", [owner, seal(key, { token: 'synthetic-legacy-token' })]);
    const prepared = await load(); expect(isVaultCredentialReference(prepared.reference)).toBe(true);
    await db.query("insert into developer_connections(owner_user_id,service,credentials_enc) values($1,'github',$2),($3,'netlify',$2)", [other, prepared.reference, owner]);
    await expect(loadDeveloperCredentials(db, key, { ownerUserId: other, service: 'github' })).rejects.toThrow(/context/);
    await expect(loadDeveloperCredentials(db, key, { ownerUserId: owner, service: 'netlify' })).rejects.toThrow(/context/);
  });

  it.each(['insert', 'update'])('rolls back canonical creation or rotation when connection %s fails', async operation => {
    if (operation === 'update') await save();
    await db.exec(`create function reject_developer() returns trigger as $$ begin raise exception 'synthetic developer failure'; end; $$ language plpgsql;
      create trigger reject_developer before ${operation} on developer_connections for each row execute function reject_developer();`);
    await expect(save('replacement')).rejects.toThrow('synthetic developer failure');
    expect(await items()).toHaveLength(operation === 'update' ? 1 : 0);
    if (operation === 'update') expect((await load()).credentials.token).toBe('synthetic-developer-token');
  });

  it('rolls back a failed import and a failed deletion audit', async () => {
    const legacy = seal(key, { token: 'synthetic-legacy-token' });
    await db.query("insert into developer_connections(owner_user_id,service,credentials_enc) values($1,'github',$2)", [owner, legacy]);
    await db.exec("create function reject_developer() returns trigger as $$ begin raise exception 'synthetic developer failure'; end; $$ language plpgsql; create trigger reject_developer before insert on events for each row execute function reject_developer();");
    await expect(load()).rejects.toThrow('synthetic developer failure');
    expect(await items()).toHaveLength(0);
    expect((await db.query('select credentials_enc from developer_connections'))[0].credentials_enc).toBe(legacy);
    await expect(deleteDeveloperConnection(db, owner, 'github')).rejects.toThrow('synthetic developer failure');
    expect(await db.query('select id from developer_connections')).toHaveLength(1);
  });

  it('allows explicit rechecking of an unhealthy connection, but not resource use or revoked access', async () => {
    await save(); const prepared = await load();
    await recordDeveloperCheck(db, { ...args(), reference: prepared.reference, check: { ok: false, detail: 'Authentication failed.' } });
    await expect(load()).rejects.toThrow('not connected');
    expect((await loadDeveloperCredentials(db, key, { ...args(), requireActive: false })).credentials.token).toBe('synthetic-developer-token');
    await db.query("update developer_connections set status='revoked'");
    await expect(loadDeveloperCredentials(db, key, { ...args(), requireActive: false })).rejects.toThrow('not connected');
  });

  it('denies uninitialized Vault and disabled accounts without a legacy fallback', async () => {
    await db.query('update vault_state set initialized_at=null');
    await expect(save()).rejects.toBeInstanceOf(VaultLockedError);
    expect(await items()).toHaveLength(0);
    await db.query("update users set status='disabled' where id=$1", [owner]);
    await expect(checkDeveloperCredentialAccess(db, owner, 'github')).rejects.toThrow('not permitted');
  });
});
