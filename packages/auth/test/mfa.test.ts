import { beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { generate, generateSecret } from 'otplib';
import { MasterKey, initializeVault, recoverVault, setVaultLock, seal, isVaultCredentialReference, VaultLockedError } from '@josi-ce/core';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { beginMfaSetup, enableMfa, disableMfa, completeMfaLogin, verifyMfaFactor } from '../src/mfa.js';
import { hashPassword } from '../src/passwords.js';

const key = new MasterKey(Buffer.alloc(32, 63));
const password = 'synthetic-mfa-password';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let db: TestDb, owner: string, other: string, recovery: string;
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role,password_hash) values('mfa@fixture.test','mfa','super_admin',$1) returning id", [await hashPassword(password)]);
  [{ id: other }] = await db.query<{ id: string }>("insert into users(email,username,role) values('other@fixture.test','other','member') returning id");
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
});
const items = () => db.query("select id from vault_items where service='auth.totp'");
async function enrolled() {
  const secret = await beginMfaSetup(db, key, owner);
  const codes = await enableMfa(db, key, owner, await generate({ secret }));
  return { secret, codes };
}
async function challenge() {
  const value = randomBytes(32).toString('base64url');
  await db.query("insert into auth_mfa_challenges(user_id,token_hash,expires_at) values($1,$2,now()+interval '5 minutes')", [owner, digest(value)]);
  return value;
}

describe('Vault authenticator authority', () => {
  it('keeps setup secret in the Vault and recovery codes only as verification hashes', async () => {
    const { secret, codes } = await enrolled();
    expect(codes).toHaveLength(10);
    const [user] = await db.query<{ totp_secret_enc: string }>('select totp_secret_enc from users where id=$1', [owner]);
    expect(isVaultCredentialReference(user.totp_secret_enc)).toBe(true);
    const stored = JSON.stringify(await db.query('select * from mfa_recovery_codes'));
    for (const code of codes) expect(stored).not.toContain(code);
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(secret);
    expect(await verifyMfaFactor(db, key, owner, await generate({ secret }))).toBe(true);
  });

  it('does not replace an enabled authenticator or regenerate recovery codes', async () => {
    const { codes } = await enrolled();
    const before = await db.query('select totp_secret_enc from users where id=$1', [owner]);
    await expect(beginMfaSetup(db, key, owner)).rejects.toThrow('already enabled');
    await expect(enableMfa(db, key, owner, codes[0])).rejects.toThrow('already enabled');
    expect(await db.query('select totp_secret_enc from users where id=$1', [owner])).toEqual(before);
    expect(await verifyMfaFactor(db, key, owner, codes[0])).toBe(true);
  });

  it('survives replacement of the installation wrapping key', async () => {
    const { secret } = await enrolled();
    const replacement = new MasterKey(Buffer.alloc(32, 64));
    await recoverVault(db, replacement, recovery, owner);
    const result = await completeMfaLogin(db, replacement, { challenge: await challenge(), code: await generate({ secret }) });
    expect(result?.user.id).toBe(owner);
    expect(result?.user).not.toHaveProperty('password_hash');
    expect(result?.user).not.toHaveProperty('totp_secret_enc');
  });

  it.each(['master', 'box'])('keeps a %s lock enforced and lets a recovery code complete a pending login', async kind => {
    const { secret, codes } = await enrolled();
    const pending = await challenge();
    await setVaultLock(db, { ...(kind === 'master' ? { master: true } : { ownerUserId: owner }), locked: true, actorUserId: owner });
    await expect(completeMfaLogin(db, key, { challenge: pending, code: await generate({ secret }) })).rejects.toBeInstanceOf(VaultLockedError);
    const [state] = await db.query('select used_at,attempts from auth_mfa_challenges');
    expect(state).toMatchObject({ used_at: null, attempts: 0 });
    const accepted = await completeMfaLogin(db, null, { challenge: pending, code: codes[0] });
    expect(accepted?.user.id).toBe(owner);
    expect(await verifyMfaFactor(db, key, owner, codes[0])).toBe(false);
    expect(await completeMfaLogin(db, key, { challenge: pending, code: codes[1] })).toBeNull();
  });

  it('consumes a login challenge and recovery code once under competing requests', async () => {
    const { codes } = await enrolled(), pending = await challenge();
    const results = await Promise.all([1, 2].map(() => completeMfaLogin(db, key, { challenge: pending, code: codes[0] })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.query('select id from sessions')).toHaveLength(1);
    expect(await verifyMfaFactor(db, key, owner, codes[0])).toBe(false);
  });

  it('locks out repeated failed codes and refuses expired or disabled-account challenges', async () => {
    const { codes } = await enrolled(), pending = await challenge();
    for (let i = 0; i < 5; i++) expect(await completeMfaLogin(db, key, { challenge: pending, code: 'not-a-code' })).toBeNull();
    expect(await completeMfaLogin(db, key, { challenge: pending, code: codes[0] })).toBeNull();
    const expired = await challenge();
    await db.query("update auth_mfa_challenges set expires_at=now()-interval '1 second' where token_hash=$1", [digest(expired)]);
    expect(await completeMfaLogin(db, key, { challenge: expired, code: codes[0] })).toBeNull();
    const disabled = await challenge();
    await db.query("update users set status='disabled' where id=$1", [owner]);
    await expect(completeMfaLogin(db, key, { challenge: disabled, code: codes[0] })).rejects.toThrow('unavailable');
    expect(await db.query('select id from sessions')).toHaveLength(0);
  });

  it.each(['sessions', 'events'])('rolls back challenge and recovery-code use if %s insertion fails', async table => {
    const { codes } = await enrolled(), pending = await challenge();
    await db.exec(`create function reject_mfa() returns trigger as $$ begin raise exception 'synthetic mfa failure'; end; $$ language plpgsql;
      create trigger reject_mfa before insert on ${table} for each row execute function reject_mfa();`);
    await expect(completeMfaLogin(db, key, { challenge: pending, code: codes[0] })).rejects.toThrow('synthetic mfa failure');
    expect((await db.query('select used_at from auth_mfa_challenges'))[0].used_at).toBeNull();
    expect(await db.query('select id from mfa_recovery_codes where used_at is not null')).toHaveLength(0);
    expect(await db.query('select id from sessions')).toHaveLength(0);
  });

  it('imports a legacy secret atomically and rejects another account’s reference', async () => {
    const secret = generateSecret(), legacy = seal(key, { secret });
    await db.query('update users set totp_secret_enc=$2,mfa_enabled_at=now() where id=$1', [owner, legacy]);
    expect(await verifyMfaFactor(db, key, owner, await generate({ secret }))).toBe(true);
    const [row] = await db.query<{ totp_secret_enc: string }>('select totp_secret_enc from users where id=$1', [owner]);
    expect(isVaultCredentialReference(row.totp_secret_enc)).toBe(true);
    await db.query('update users set totp_secret_enc=$2,mfa_enabled_at=now() where id=$1', [other, row.totp_secret_enc]);
    await expect(verifyMfaFactor(db, key, other, await generate({ secret }))).rejects.toThrow(/context/);
  });

  it('rolls back Vault setup if updating the account fails', async () => {
    await db.exec("create function reject_mfa() returns trigger as $$ begin raise exception 'synthetic mfa failure'; end; $$ language plpgsql; create trigger reject_mfa before update on users for each row execute function reject_mfa();");
    await expect(beginMfaSetup(db, key, owner)).rejects.toThrow('synthetic mfa failure');
    expect(await items()).toHaveLength(0);
  });

  it('requires the existing password to disable MFA and clears its Vault slot while locked', async () => {
    await enrolled(); await challenge();
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    await expect(disableMfa(db, owner, 'wrong')).rejects.toThrow('password');
    expect(await items()).toHaveLength(1);
    await disableMfa(db, owner, password);
    expect(await items()).toHaveLength(0);
    expect(await db.query('select id from mfa_recovery_codes')).toHaveLength(0);
    expect(await db.query('select id from auth_mfa_challenges')).toHaveLength(0);
    expect((await db.query('select mfa_enabled_at,totp_secret_enc from users where id=$1', [owner]))[0]).toEqual({ mfa_enabled_at: null, totp_secret_enc: null });
  });

  it('requires a usable Vault to enroll and fails closed on a corrupt secret', async () => {
    const { secret, codes } = await enrolled();
    await db.query("update users set totp_secret_enc='corrupt' where id=$1", [owner]);
    await expect(verifyMfaFactor(db, key, owner, await generate({ secret }))).rejects.toThrow();
    expect(await verifyMfaFactor(db, null, owner, codes[0])).toBe(true);
    await db.query('update vault_state set initialized_at=null');
    await expect(beginMfaSetup(db, key, other)).rejects.toBeInstanceOf(VaultLockedError);
  });
});
