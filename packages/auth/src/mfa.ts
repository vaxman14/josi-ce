import { createHash, randomBytes } from 'node:crypto';
import { generateSecret, verify } from 'otplib';
import { appendEvent, deleteVaultSlot, isVaultCredentialReference, openCredentialPayload, storeVaultCredentialPayload,
  VaultError, VaultLockedError, type Db, type MasterKey } from '@josi-ce/core';
import { verifyPassword } from './passwords.js';
import { createSession, SESSION_TTL_SECONDS } from './sessions.js';

export const MFA_VAULT_SERVICE = 'auth.totp';
const slot = 'authenticator';
export class MfaError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
interface Account {
  id: string; email: string; username: string; role: string; display_name: string | null; status: string;
  password_hash: string | null; totp_secret_enc: string | null; mfa_enabled_at: string | null;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const cleanCode = (code: string) => code.replace(/\s/g, '').toUpperCase().slice(0, 200);
function transaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new VaultError('Authenticator operations require transactions');
  return db.transaction(async tx => {
    // The same order as Vault locking/recovery: state, account, challenge.
    await tx.query('select id from vault_state where id=true for share');
    return work(tx);
  });
}
async function account(tx: Db, userId: string): Promise<Account> {
  const [row] = await tx.query<Account>("select * from users where id=$1 and status='active' for update", [userId]);
  if (!row) throw new MfaError(401, 'This account is unavailable.');
  return row;
}
async function requireVault(tx: Db, key: MasterKey | null): Promise<MasterKey> {
  const [state] = await tx.query<{ initialized_at: string | null; locked: boolean }>('select initialized_at,locked from vault_state where id=true');
  if (!key || !state?.initialized_at || state.locked) throw new VaultLockedError('The Vault is unavailable. Use an MFA recovery code, or unlock it from an existing signed-in session.');
  return key;
}
async function secretFor(tx: Db, key: MasterKey | null, row: Account): Promise<string> {
  const availableKey = await requireVault(tx, key);
  if (!row.totp_secret_enc) throw new MfaError(409, 'The authenticator is unavailable. Use an MFA recovery code.');
  const payload = await openCredentialPayload<{ secret: string }>(tx, availableKey, { ownerUserId: row.id, service: MFA_VAULT_SERVICE, slot, stored: row.totp_secret_enc });
  if (typeof payload.secret !== 'string' || !payload.secret || payload.secret.length > 1024) throw new MfaError(409, 'The stored authenticator is invalid. Use an MFA recovery code.');
  if (!isVaultCredentialReference(row.totp_secret_enc)) {
    const reference = await storeVaultCredentialPayload(tx, availableKey, { ownerUserId: row.id, kind: 'other', service: MFA_VAULT_SERVICE, slot,
      label: 'Account authenticator — managed in Security', payload });
    await tx.query('update users set totp_secret_enc=$2 where id=$1', [row.id, reference]);
  }
  return payload.secret;
}
async function checkFactor(tx: Db, key: MasterKey | null, row: Account, supplied: string): Promise<boolean> {
  if (!row.mfa_enabled_at) return false;
  const code = cleanCode(supplied);
  // These are one-way verification hashes, not an alternate secret store.
  // A recovery code remains a required second factor when the Vault is locked.
  if (/^[0-9A-F]{6}-[0-9A-F]{6}$/.test(code)) {
    const used = await tx.query('update mfa_recovery_codes set used_at=now() where user_id=$1 and code_hash=$2 and used_at is null returning id', [row.id, digest(code)]);
    return used.length === 1;
  }
  if (!/^\d{6}$/.test(code)) return false;
  const secret = await secretFor(tx, key, row);
  return (await verify({ secret, token: code, epochTolerance: 30 })).valid;
}

export async function beginMfaSetup(db: Db, key: MasterKey, userId: string): Promise<string> {
  return transaction(db, async tx => {
    await requireVault(tx, key);
    const row = await account(tx, userId);
    if (row.mfa_enabled_at) throw new MfaError(409, 'MFA is already enabled. Disable it before setting up a new authenticator.');
    const secret = generateSecret();
    const reference = await storeVaultCredentialPayload(tx, key, { ownerUserId: userId, kind: 'other', service: MFA_VAULT_SERVICE, slot,
      label: 'Account authenticator — managed in Security', payload: { secret } });
    await tx.query('update users set totp_secret_enc=$2,mfa_enabled_at=null where id=$1', [userId, reference]);
    return secret;
  });
}

export async function enableMfa(db: Db, key: MasterKey, userId: string, supplied: string): Promise<string[]> {
  return transaction(db, async tx => {
    const row = await account(tx, userId);
    if (row.mfa_enabled_at) throw new MfaError(409, 'MFA is already enabled.');
    if (!row.totp_secret_enc) throw new MfaError(409, 'Start MFA setup first.');
    const code = cleanCode(supplied), secret = await secretFor(tx, key, row);
    if (!/^\d{6}$/.test(code) || !(await verify({ secret, token: code, epochTolerance: 30 })).valid) throw new MfaError(400, 'That code did not match.');
    const codes = Array.from({ length: 10 }, () => `${randomBytes(3).toString('hex')}-${randomBytes(3).toString('hex')}`.toUpperCase());
    await tx.query('delete from mfa_recovery_codes where user_id=$1', [userId]);
    for (const recovery of codes) await tx.query('insert into mfa_recovery_codes(user_id,code_hash) values($1,$2)', [userId, digest(recovery)]);
    await tx.query('update users set mfa_enabled_at=now() where id=$1', [userId]);
    await appendEvent(tx, { actorUserId: userId, actor: 'user', kind: 'auth.mfa_enabled', subjectType: 'user', subjectId: userId });
    return codes;
  });
}

export async function disableMfa(db: Db, userId: string, password: string): Promise<void> {
  await transaction(db, async tx => {
    const row = await account(tx, userId);
    if (!(await verifyPassword(row.password_hash, password))) throw new MfaError(401, 'That password did not match.');
    await tx.query('update users set totp_secret_enc=null,mfa_enabled_at=null where id=$1', [userId]);
    await tx.query('delete from mfa_recovery_codes where user_id=$1', [userId]);
    await tx.query('delete from auth_mfa_challenges where user_id=$1', [userId]);
    await deleteVaultSlot(tx, { ownerUserId: userId, service: MFA_VAULT_SERVICE, slot, actorUserId: userId });
    await appendEvent(tx, { actorUserId: userId, actor: 'user', kind: 'auth.mfa_disabled', subjectType: 'user', subjectId: userId });
  });
}

/** Caller must independently prove the first factor / existing session. */
export async function verifyMfaFactor(db: Db, key: MasterKey | null, userId: string, code: string): Promise<boolean> {
  return transaction(db, async tx => checkFactor(tx, key, await account(tx, userId), code));
}

/** Internal auth-package composition only. Caller holds a transaction and the
 * Vault-state lock; factor consumption must commit with the protected receipt. */
export async function verifyMfaFactorInTransaction(tx: Db, key: MasterKey | null, userId: string, code: string): Promise<boolean> {
  return checkFactor(tx, key, await account(tx, userId), code);
}

/** Challenge consumption, recovery-code consumption and session issuance are
 * one commit, so replay or failed session insertion cannot split them apart. */
export async function completeMfaLogin(db: Db, key: MasterKey | null, args: {
  challenge: string; code: string; ip?: string | null; userAgent?: string | null;
}): Promise<{ user: Pick<Account, 'id' | 'email' | 'username' | 'role' | 'display_name'>; token: string; ttlSeconds: number } | null> {
  if (!args.challenge || args.challenge.length > 512 || !args.code) return null;
  return transaction(db, async tx => {
    const hash = digest(args.challenge);
    const [hint] = await tx.query<{ user_id: string }>('select user_id from auth_mfa_challenges where token_hash=$1', [hash]);
    if (!hint) return null;
    const row = await account(tx, hint.user_id);
    const [challenge] = await tx.query<{ id: string; remember_me: boolean }>(`select id,remember_me from auth_mfa_challenges
      where token_hash=$1 and used_at is null and expires_at>now() and attempts<5 for update`, [hash]);
    if (!challenge || !row.mfa_enabled_at) return null;
    if (!(await checkFactor(tx, key, row, args.code))) {
      await tx.query('update auth_mfa_challenges set attempts=least(attempts+1,5) where id=$1', [challenge.id]);
      return null;
    }
    const claimed = await tx.query('update auth_mfa_challenges set used_at=now() where id=$1 and used_at is null and expires_at>now() and attempts<5 returning id', [challenge.id]);
    if (!claimed.length) throw new MfaError(401, 'That verification code did not work.');
    const ttlSeconds = challenge.remember_me ? SESSION_TTL_SECONDS : 60 * 60 * 12;
    const { token } = await createSession(tx, { userId: row.id, ip: args.ip, userAgent: args.userAgent, ttlSeconds });
    await appendEvent(tx, { actorUserId: row.id, actor: 'user', kind: 'auth.mfa_login', subjectType: 'user', subjectId: row.id });
    return { user: { id: row.id, email: row.email, username: row.username, role: row.role, display_name: row.display_name }, token, ttlSeconds };
  });
}
