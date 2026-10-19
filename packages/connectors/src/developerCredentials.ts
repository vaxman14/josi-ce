import { appendEvent, deleteVaultSlot, isVaultCredentialReference, openCredentialPayload, storeVaultCredentialPayload,
  VaultError, VaultLockedError, type Db, type MasterKey } from '@josi-ce/core';
import { requireConnectorVault } from './credentialVault.js';
import { describeDeveloperService, type DeveloperCheck, type DeveloperService } from './developerServices.js';

export interface DeveloperCredentials { token: string; username?: string; email?: string; baseUrl?: string }
export class DeveloperCredentialError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Policy changes and connection lifecycle share a short per-service fence.
 * No provider request is made while this transaction is held. */
export function withDeveloperServiceTransaction<T>(db: Db, service: DeveloperService, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new VaultError('Developer connections require transactions');
  return db.transaction(async tx => {
    await tx.query("select pg_advisory_xact_lock(hashtext('josi_developer_service'),hashtext($1))", [service]);
    await tx.query('select id from vault_state where id=true for share');
    return work(tx);
  });
}
async function permitted(tx: Db, owner: string, service: DeveloperService): Promise<boolean> {
  return (await tx.query(`select 1 from developer_service_policy p where p.service=$2
    and exists(select 1 from users where id=$1 and status='active')
    and (p.mode='everyone' or (p.mode='specific_users' and exists(select 1 from developer_service_allowed_users a where a.service=p.service and a.user_id=$1)))`, [owner, service])).length === 1;
}
async function requirePermission(tx: Db, owner: string, service: DeveloperService): Promise<void> {
  if (!(await permitted(tx, owner, service))) throw new DeveloperCredentialError(403, 'This service is not permitted for this account.');
}
async function requireVault(tx: Db, owner: string): Promise<void> {
  await requireConnectorVault(tx);
  const [box] = await tx.query<{ locked: boolean }>('select locked from vault_boxes where owner_user_id=$1', [owner]);
  if (box?.locked) throw new VaultLockedError('Unlock your Vault box to use this connection.');
}
function valid(value: DeveloperCredentials): void {
  if (!value || typeof value.token !== 'string' || !value.token || Object.entries(value).some(([name, entry]) =>
    !['token', 'username', 'email', 'baseUrl'].includes(name) || typeof entry !== 'string')) throw new VaultError('The developer credential is invalid');
}

/** Check before testing a newly submitted credential; save checks again after
 * that bounded request so a policy revocation cannot race the commit. */
export async function checkDeveloperCredentialAccess(db: Db, owner: string, service: DeveloperService): Promise<void> {
  await withDeveloperServiceTransaction(db, service, async tx => { await requirePermission(tx, owner, service); await requireVault(tx, owner); });
}

export async function saveDeveloperConnection(db: Db, key: MasterKey, args: {
  ownerUserId: string; service: DeveloperService; credentials: DeveloperCredentials; accountLabel: string | null;
}): Promise<void> {
  valid(args.credentials);
  await withDeveloperServiceTransaction(db, args.service, async tx => {
    await requirePermission(tx, args.ownerUserId, args.service); await requireVault(tx, args.ownerUserId);
    const reference = await storeVaultCredentialPayload(tx, key, { ownerUserId: args.ownerUserId, kind: 'api_key', service: `developer.${args.service}`, slot: 'token',
      label: `${describeDeveloperService(args.service)!.label} credential`, payload: { ...args.credentials }, actorUserId: args.ownerUserId });
    await tx.query(`insert into developer_connections(owner_user_id,service,credentials_enc,account_label,status,last_check_at,last_check_ok,last_error)
      values($1,$2,$3,$4,'active',now(),true,null) on conflict(owner_user_id,service) do update set credentials_enc=excluded.credentials_enc,
      account_label=excluded.account_label,status='active',last_check_at=now(),last_check_ok=true,last_error=null`,
    [args.ownerUserId, args.service, reference, args.accountLabel]);
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'member', kind: 'developer_service.connected', payload: { service: args.service } });
  });
}

export async function loadDeveloperCredentials(db: Db, key: MasterKey, args: {
  ownerUserId: string; service: DeveloperService; requireActive?: boolean;
}): Promise<{ credentials: DeveloperCredentials; reference: string }> {
  return withDeveloperServiceTransaction(db, args.service, async tx => {
    await requirePermission(tx, args.ownerUserId, args.service); await requireVault(tx, args.ownerUserId);
    const [row] = await tx.query<{ credentials_enc: string | null; status: string }>('select credentials_enc,status from developer_connections where owner_user_id=$1 and service=$2 for update', [args.ownerUserId, args.service]);
    if (!row?.credentials_enc || row.status === 'revoked' || (args.requireActive !== false && row.status !== 'active'))
      throw new DeveloperCredentialError(404, 'That provider is not connected and active for this account.');
    const credentials = await openCredentialPayload<DeveloperCredentials>(tx, key, { ownerUserId: args.ownerUserId, service: `developer.${args.service}`, slot: 'token', stored: row.credentials_enc });
    valid(credentials);
    let reference = row.credentials_enc;
    if (!isVaultCredentialReference(reference)) {
      reference = await storeVaultCredentialPayload(tx, key, { ownerUserId: args.ownerUserId, kind: 'api_key', service: `developer.${args.service}`, slot: 'token',
        label: `${describeDeveloperService(args.service)!.label} credential`, payload: { ...credentials }, actorUserId: args.ownerUserId });
      await tx.query('update developer_connections set credentials_enc=$3 where owner_user_id=$1 and service=$2', [args.ownerUserId, args.service, reference]);
      await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'system', kind: 'developer_service.credentials_migrated', payload: { service: args.service } });
    }
    return { credentials, reference };
  });
}

/** A provider reply is evidence about the credential that was actually sent.
 * Rotation, removal or policy revocation discards a late reply. */
export async function recordDeveloperCheck(db: Db, args: {
  ownerUserId: string; service: DeveloperService; reference: string; check: DeveloperCheck; used?: boolean; preserveStatus?: boolean;
}): Promise<boolean> {
  return withDeveloperServiceTransaction(db, args.service, async tx => {
    if (!(await permitted(tx, args.ownerUserId, args.service))) return false;
    const updated = await tx.query(`update developer_connections set last_check_at=now(),last_check_ok=$4,last_error=$5,
      status=case when $8 then status when $4 then 'active' else 'needs_reconnect' end,account_label=coalesce($6,account_label),
      last_used_at=case when $7 then now() else last_used_at end
      where owner_user_id=$1 and service=$2 and credentials_enc=$3 and status<>'revoked' returning id`,
    [args.ownerUserId, args.service, args.reference, args.check.ok, args.check.ok ? null : args.check.detail, args.check.accountLabel ?? null, args.used === true, args.preserveStatus === true]);
    return updated.length === 1;
  });
}

export async function deleteDeveloperConnection(db: Db, ownerUserId: string, service: DeveloperService): Promise<void> {
  await withDeveloperServiceTransaction(db, service, async tx => {
    await tx.query('delete from developer_connections where owner_user_id=$1 and service=$2', [ownerUserId, service]);
    await deleteVaultSlot(tx, { ownerUserId, service: `developer.${service}`, slot: 'token', actorUserId: ownerUserId });
    await appendEvent(tx, { actorUserId: ownerUserId, actor: 'member', kind: 'developer_service.disconnected', payload: { service } });
  });
}
