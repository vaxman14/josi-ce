import { beforeEach, describe, expect, it } from 'vitest';
import { MasterKey, initializeVault, recoverVault, setVaultLock, seal, isVaultCredentialReference, VaultLockedError } from '@josi-ce/core';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { loadProfile, saveSmtpProfiles, removeSmtpProfile } from '../src/profiles.js';

const key = new MasterKey(Buffer.alloc(32, 68));
let db: TestDb, owner: string, recovery: string;
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role) values('smtp@fixture.test','smtp','super_admin') returning id");
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
});
const system = () => ({ host: 'smtp.fixture.test', port: 587, security: 'starttls', username: 'fixture-user', password: 'synthetic-mail-password', fromName: 'Security', fromAddress: 'security@fixture.test' });
const communications = () => ({ copyFromSystem: true, fromName: 'Work', fromAddress: 'work@fixture.test' });
const save = () => saveSmtpProfiles(db, key, { system: system(), communications: communications(), actorUserId: owner });
const items = () => db.query("select id from vault_items where service='smtp'");

describe('SMTP Vault authority', () => {
  it('borrows one canonical credential while preserving the communications sender identity', async () => {
    await save();
    const rows = await db.query<{ kind: string; password_enc: string | null }>('select kind,password_enc from smtp_profiles order by kind');
    expect(rows[0].password_enc).toBeNull();
    expect(isVaultCredentialReference(rows[1].password_enc)).toBe(true);
    expect(await items()).toHaveLength(1);
    expect(await loadProfile(db, key, 'communications')).toMatchObject({ host: 'smtp.fixture.test', username: 'fixture-user', password: 'synthetic-mail-password', fromName: 'Work', fromAddress: 'work@fixture.test' });
    expect(await loadProfile(db, key, 'system')).toMatchObject({ fromName: 'Security', fromAddress: 'security@fixture.test' });
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain('synthetic-mail-password');
  });

  it('survives recovery and preserves an older reference’s historical owner', async () => {
    await save();
    await db.query("update smtp_profiles set vault_owner_user_id=null where kind='system'");
    await db.query("update users set role='member' where id=$1", [owner]);
    const [{ id: successor }] = await db.query<{ id: string }>("insert into users(email,username,role) values('next@fixture.test','next','super_admin') returning id");
    const replacement = new MasterKey(Buffer.alloc(32, 69));
    await recoverVault(db, replacement, recovery, successor);
    expect((await loadProfile(db, replacement, 'communications')).password).toBe('synthetic-mail-password');
    expect((await db.query("select vault_owner_user_id from smtp_profiles where kind='system'"))[0].vault_owner_user_id).toBe(owner);
  });

  it('preserves a blank password only for the same server/account and explicitly clears it', async () => {
    await save();
    await saveSmtpProfiles(db, key, { system: { ...system(), password: '', fromName: 'Updated Security' }, communications: communications(), actorUserId: owner });
    expect((await loadProfile(db, key, 'system')).password).toBe('synthetic-mail-password');
    await expect(saveSmtpProfiles(db, key, { system: { ...system(), password: '', host: 'different.fixture.test' }, communications: communications(), actorUserId: owner })).rejects.toThrow('password again');
    expect((await loadProfile(db, key, 'system')).host).toBe('smtp.fixture.test');
    await saveSmtpProfiles(db, key, { system: { ...system(), password: '', clearPassword: true }, communications: communications(), actorUserId: owner });
    expect((await loadProfile(db, key, 'system')).password).toBeNull(); expect(await items()).toHaveLength(0);
  });

  it('removes the independent communications credential when switching to shared SMTP', async () => {
    await saveSmtpProfiles(db, key, { system: system(), communications: { ...system(), ...communications(), copyFromSystem: false, password: 'separate-fixture-password' }, actorUserId: owner });
    expect(await items()).toHaveLength(2);
    await save();
    expect(await items()).toHaveLength(1);
    expect((await loadProfile(db, key, 'communications')).password).toBe('synthetic-mail-password');
  });

  it.each(['master', 'box'])('blocks reading through a %s lock and permits removal of migrated profiles', async kind => {
    await save();
    await setVaultLock(db, { ...(kind === 'master' ? { master: true } : { ownerUserId: owner }), locked: true, actorUserId: owner });
    await expect(loadProfile(db, key, 'communications')).rejects.toBeInstanceOf(VaultLockedError);
    await removeSmtpProfile(db, null, 'system', owner);
    expect(await items()).toHaveLength(0);
    expect(await db.query('select kind from smtp_profiles')).toHaveLength(0);
  });

  it('migrates legacy ciphertext atomically and refuses cross-profile substitution', async () => {
    await db.query("insert into smtp_profiles(kind,host,port,security,password_enc,from_address) values('system','smtp.fixture.test',587,'starttls',$1,'security@fixture.test')", [seal(key, { password: 'synthetic-legacy-password' })]);
    expect((await loadProfile(db, key, 'system')).password).toBe('synthetic-legacy-password');
    const [row] = await db.query<{ password_enc: string }>("select password_enc from smtp_profiles where kind='system'");
    expect(isVaultCredentialReference(row.password_enc)).toBe(true);
    await db.query("insert into smtp_profiles(kind,host,port,security,password_enc,from_address) values('communications','smtp.fixture.test',587,'starttls',$1,'work@fixture.test')", [row.password_enc]);
    await expect(loadProfile(db, key, 'communications')).rejects.toThrow(/context/);
  });

  it('rolls back both profiles and both canonical secrets when the second profile fails', async () => {
    await save();
    await db.exec("create function reject_mail() returns trigger as $$ begin if new.kind='communications' then raise exception 'synthetic mail failure'; end if; return new; end; $$ language plpgsql; create trigger reject_mail before update on smtp_profiles for each row execute function reject_mail();");
    await expect(saveSmtpProfiles(db, key, { system: { ...system(), password: 'replacement-fixture-password' }, communications: communications(), actorUserId: owner })).rejects.toThrow('synthetic mail failure');
    expect((await loadProfile(db, key, 'system')).password).toBe('synthetic-mail-password');
  });

  it('leaves no partial profile or Vault item when the communications input is invalid', async () => {
    await expect(saveSmtpProfiles(db, key, { system: system(), communications: { ...communications(), fromAddress: 'invalid' }, actorUserId: owner })).rejects.toThrow('From address');
    expect(await db.query('select kind from smtp_profiles')).toHaveLength(0);
    expect(await items()).toHaveLength(0);
  });

  it('rolls back canonical deletion when audit insertion fails', async () => {
    await save();
    await db.exec("create function reject_mail() returns trigger as $$ begin raise exception 'synthetic mail failure'; end; $$ language plpgsql; create trigger reject_mail before insert on events for each row execute function reject_mail();");
    await expect(removeSmtpProfile(db, null, 'system', owner)).rejects.toThrow('synthetic mail failure');
    expect((await loadProfile(db, key, 'system')).password).toBe('synthetic-mail-password');
  });

  it('normalizes Gmail app passwords for both independent profiles and has no pre-init fallback', async () => {
    await saveSmtpProfiles(db, key, { system: { ...system(), host: 'smtp.gmail.com', password: 'abcd efgh ijkl mnop' },
      communications: { ...system(), host: 'smtp.gmail.com', password: 'qrst uvwx yzab cdef' }, actorUserId: owner });
    expect((await loadProfile(db, key, 'system')).password).toBe('abcdefghijklmnop');
    expect((await loadProfile(db, key, 'communications')).password).toBe('qrstuvwxyzabcdef');
    await db.query('update vault_state set initialized_at=null');
    await expect(save()).rejects.toBeInstanceOf(VaultLockedError);
  });
});
