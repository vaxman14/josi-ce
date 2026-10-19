import { createHash, randomBytes } from 'node:crypto';
import { deleteVaultSlot, isVaultCredentialReference, openCredentialPayload, storeVaultCredentialPayload,
  VaultError, VaultLockedError, type Db, type MasterKey } from '@josi-ce/core';

const service = 'auth.google.pkce';
export const GOOGLE_NATIVE_RETURN_URI = 'josi://auth/callback';
interface LoginState {
  state_hash: string; verifier: string; native_return_uri: string | null;
  vault_owner_user_id: string | null; expires_at: string; used_at: string | null;
}
const digest = (state: string) => createHash('sha256').update(state).digest('hex');
function transaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new VaultError('Login credential handling requires transactions');
  return db.transaction(work);
}
async function requireVault(tx: Db): Promise<void> {
  const [state] = await tx.query<{ initialized_at: string | null; locked: boolean }>('select initialized_at,locked from vault_state where id=true for share');
  if (!state?.initialized_at || state.locked) throw new VaultLockedError('Unlock the Master Vault to use Google sign-in.');
}
async function appOwner(tx: Db): Promise<string> {
  const [row] = await tx.query<{ vault_owner_user_id: string | null; configured_by: string | null }>("select vault_owner_user_id,configured_by from oauth_clients where provider='google'");
  if (!row) throw new VaultError('Google sign-in is unavailable.');
  if (row.vault_owner_user_id || row.configured_by) return (row.vault_owner_user_id ?? row.configured_by)!;
  const [admin] = await tx.query<{ id: string }>("select id from users where role='super_admin' order by created_at limit 1");
  if (!admin) throw new VaultError('Google sign-in is unavailable.');
  return admin.id;
}
async function removeVerifier(tx: Db, row: LoginState): Promise<void> {
  if (row.vault_owner_user_id) await deleteVaultSlot(tx, { ownerUserId: row.vault_owner_user_id, service, slot: row.state_hash, actorUserId: row.vault_owner_user_id });
}

export async function startGoogleLogin(db: Db, key: MasterKey, nativeReturnUri: string | null): Promise<{ state: string; challenge: string }> {
  if (nativeReturnUri !== null && nativeReturnUri !== GOOGLE_NATIVE_RETURN_URI) throw new VaultError('Unsupported native return URI.');
  return transaction(db, async tx => {
    await requireVault(tx);
    const owner = await appOwner(tx), state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const stateHash = digest(state);
    const reference = await storeVaultCredentialPayload(tx, key, { ownerUserId: owner, kind: 'oauth_token', service, slot: stateHash,
      label: 'Temporary Google login verifier', payload: { verifier } });
    await tx.query(`insert into auth_oauth_states(state_hash,verifier,return_path,native_return_uri,vault_owner_user_id,expires_at)
      values($1,$2,'/app',$3,$4,now()+interval '10 minutes')`, [stateHash, reference, nativeReturnUri, owner]);
    return { state, challenge: createHash('sha256').update(verifier).digest('base64url') };
  });
}

/** A cancelled login still consumes its state and erases its verifier, without
 * opening the Vault. Successful callbacks require a valid verifier; never
 * downgrade PKCE because a key is missing or a box is locked. */
export async function consumeGoogleLogin(db: Db, key: MasterKey, state: string, needsVerifier = true): Promise<{ verifier: string | null; nativeReturnUri: string | null } | null> {
  if (!state || state.length > 512) return null;
  return transaction(db, async tx => {
    await tx.query('select id from vault_state where id=true for share');
    const [row] = await tx.query<LoginState>('select * from auth_oauth_states where state_hash=$1 for update', [digest(state)]);
    if (!row || row.used_at) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await removeVerifier(tx, row);
      await tx.query("update auth_oauth_states set verifier='' where state_hash=$1", [row.state_hash]);
      return null;
    }
    if (row.native_return_uri !== null && row.native_return_uri !== GOOGLE_NATIVE_RETURN_URI) throw new VaultError('Unsupported native return URI.');
    let verifier: string | null = null;
    if (needsVerifier) {
      await requireVault(tx);
      const owner = row.vault_owner_user_id ?? await appOwner(tx);
      const payload = await openCredentialPayload<{ verifier: string }>(tx, key, { ownerUserId: owner, service, slot: row.state_hash, stored: row.verifier });
      if (typeof payload.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(payload.verifier)) throw new VaultError('The login verifier is unavailable. Start signing in again.');
      if (!isVaultCredentialReference(row.verifier)) await storeVaultCredentialPayload(tx, key, { ownerUserId: owner, kind: 'oauth_token', service, slot: row.state_hash,
        label: 'Temporary Google login verifier', payload });
      row.vault_owner_user_id = owner;
      verifier = payload.verifier;
    }
    const claimed = await tx.query(`update auth_oauth_states set used_at=now(),verifier='' where state_hash=$1 and used_at is null and expires_at>now() returning state_hash`, [row.state_hash]);
    if (!claimed.length) return null;
    await removeVerifier(tx, row);
    return { verifier, nativeReturnUri: row.native_return_uri };
  });
}

export async function purgeGoogleLoginStates(db: Db): Promise<number> {
  return transaction(db, async tx => {
    await tx.query('select id from vault_state where id=true for share');
    const spent = await tx.query<LoginState>("update auth_oauth_states set verifier='' where verifier<>'' and (used_at is not null or expires_at<=now()) returning *");
    for (const row of spent) await removeVerifier(tx, row);
    const removed = await tx.query("delete from auth_oauth_states where expires_at<now()-interval '1 hour' or used_at<now()-interval '1 hour' returning state_hash");
    return removed.length;
  });
}
