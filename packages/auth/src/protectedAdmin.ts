import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendEvent, consume, LIMITS, VaultLockedError, type Db, type MasterKey } from '@josi-ce/core';
import { verifyPassword } from './passwords.js';
import { verifyMfaFactorInTransaction } from './mfa.js';

export class ProtectedAdminError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type ProtectedAdminPurpose = 'cardinal.draft.save' | 'cardinal.draft.test' | 'cardinal.activate' | 'cardinal.retire' | 'automation.policy.replace' | 'device.enroll' | 'device.revoke';
export interface ProtectedAdminBinding { purpose: ProtectedAdminPurpose; requestDigest: string }
const purposes = new Set<ProtectedAdminPurpose>(['cardinal.draft.save', 'cardinal.draft.test', 'cardinal.activate', 'cardinal.retire', 'automation.policy.replace', 'device.enroll', 'device.revoke']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface AccountSecurity { password_hash: string | null; totp_secret_enc: string | null; mfa_enabled_at: string | null }

function validBinding(binding: ProtectedAdminBinding): boolean {
  return !!binding && purposes.has(binding.purpose) && /^[a-f0-9]{64}$/.test(binding.requestDigest);
}
function refuse(): ProtectedAdminError { return new ProtectedAdminError(401, 'Confirm this exact change again with your current administrator credentials.'); }
async function currentAccount(tx: Db, userId: string, sessionId: string): Promise<AccountSecurity> {
  const [user] = await tx.query<AccountSecurity>(`select password_hash,totp_secret_enc,mfa_enabled_at::text as mfa_enabled_at
    from users where id=$1 and role='super_admin' and status='active' for share`, [userId]);
  if (!user) throw new ProtectedAdminError(403, 'An active super administrator is required.');
  const [session] = await tx.query(`select id from sessions where id=$1 and user_id=$2 and revoked_at is null and expires_at>now() for share`, [sessionId, userId]);
  if (!session) throw refuse();
  return user;
}

export interface ProtectedAdminProof {
  /** Called in the same database transaction as the exact mutation. `consume`
   * must be true for a write; a failed write rolls consumption back as well.
   * Lock order: Vault state, user, session, receipt. Never persist this object. */
  check(tx: Db, args: ProtectedAdminBinding & { actorUserId: string; consume: boolean }): Promise<void>;
  toJSON(): string;
}

/** Fresh account verification is necessary, but is NOT proof of human presence
 * or a protected client. Activation must additionally require the P4/P5 human
 * control boundary. Neither this function nor its return value activates a rule.
 * A normal fifteen-minute step-up unlock cannot substitute for this receipt. */
export async function reauthenticateProtectedAdmin(db: Db, key: MasterKey | null, args: ProtectedAdminBinding & {
  userId: string; sessionId: string; password: string; mfaCode?: string;
}): Promise<ProtectedAdminProof> {
  if (!db.transaction) throw new ProtectedAdminError(503, 'Protected changes require database transactions.');
  if (!uuid.test(args.userId) || !uuid.test(args.sessionId) || !validBinding(args)) throw refuse();
  const userId = args.userId, sessionId = args.sessionId;
  const binding: ProtectedAdminBinding = { purpose: args.purpose, requestDigest: args.requestDigest };
  const password = typeof args.password === 'string' && args.password.length <= 4096 ? args.password : '';
  const code = typeof args.mfaCode === 'string' && args.mfaCode.length <= 200 ? args.mfaCode : '';
  // Account-scoped to prevent parallel sessions from multiplying guesses. This
  // counts attempts, including successes; no caller-chosen bucket or TTL.
  const allowance = await consume(db, { subject: userId, limit: LIMITS.protected_admin_reauth });
  if (!allowance.ok) throw new ProtectedAdminError(429, 'Too many administrator verification attempts. Wait a few minutes and try again.');
  const token = randomBytes(32).toString('base64url');
  const mac = (purpose: string, data: unknown) => createHmac('sha256', token).update(JSON.stringify([purpose, data])).digest('hex');
  const tokenHash = hash(token);
  const bindingHash = mac('binding', { userId, sessionId, ...binding });
  const issued = await db.transaction(async tx => {
    const [vault] = await tx.query<{ initialized_at: string | null; locked: boolean; authority_epoch: string | number }>('select initialized_at,locked,authority_epoch from vault_state where id=true for share');
    if (!vault?.initialized_at || vault.locked || !key) throw new VaultLockedError('Initialize and unlock the Vault before changing protected rules or permissions.');
    // Upgrade to the account lock before MFA validation so recovery-code use
    // and an authenticator migration share this exact transaction.
    await tx.query('select id from users where id=$1 for update', [userId]);
    const before = await currentAccount(tx, userId, sessionId);
    const passwordOk = await verifyPassword(before.password_hash, password);
    const factorOk = passwordOk && (!before.mfa_enabled_at || await verifyMfaFactorInTransaction(tx, key, userId, code));
    if (!factorOk) {
      await appendEvent(tx, { actorUserId: userId, actor: 'super_admin', kind: 'auth.protected_admin_failed', subjectType: 'session', subjectId: sessionId });
      return false;
    }
    // MFA may have upgraded an old authenticator reference in this transaction.
    const current = await currentAccount(tx, userId, sessionId);
    await tx.query("delete from protected_admin_reauth where expires_at<now()-interval '1 day'");
    await tx.query(`insert into protected_admin_reauth(user_id,session_id,token_hash,binding_hash,security_hash,authority_epoch)
      values($1,$2,$3,$4,$5,$6)`, [userId, sessionId, tokenHash, bindingHash, mac('account-security', current), vault.authority_epoch]);
    await appendEvent(tx, { actorUserId: userId, actor: 'super_admin', kind: 'auth.protected_admin_verified', subjectType: 'session', subjectId: sessionId });
    return true;
  });
  if (!issued) throw refuse();

  // The token and verifier key stay in a closure. Object inspection/JSON never
  // exposes them. Restart loses this short-lived proof, not canonical authority.
  return Object.freeze({
    toJSON: () => '[protected administrator verification redacted]',
    async check(tx: Db, check: ProtectedAdminBinding & { actorUserId: string; consume: boolean }): Promise<void> {
      if (check.actorUserId !== userId || !validBinding(check) || check.purpose !== binding.purpose || check.requestDigest !== binding.requestDigest) throw refuse();
      const [vault] = await tx.query<{ initialized_at: string | null; locked: boolean; authority_epoch: string | number }>('select initialized_at,locked,authority_epoch from vault_state where id=true for share');
      if (!vault?.initialized_at || vault.locked) throw new VaultLockedError('Initialize and unlock the Vault before changing protected rules or permissions.');
      const current = await currentAccount(tx, userId, sessionId);
      const [receipt] = await tx.query<{ id: string }>(`select id from protected_admin_reauth
        where token_hash=$1 and binding_hash=$2 and security_hash=$3 and user_id=$4 and session_id=$5
          and authority_epoch=$6 and used_at is null and expires_at>now() for update`,
      [tokenHash, bindingHash, mac('account-security', current), userId, sessionId, vault.authority_epoch]);
      if (!receipt) throw refuse();
      if (check.consume) {
        await tx.query('update protected_admin_reauth set used_at=now() where id=$1', [receipt.id]);
        await appendEvent(tx, { actorUserId: userId, actor: 'super_admin', kind: 'auth.protected_admin_consumed', subjectType: 'verification', subjectId: receipt.id });
      }
    },
  });
}
