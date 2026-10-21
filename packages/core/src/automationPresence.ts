import type { AutomationIdentity } from '@josi-ce/protocol';
import type { Db } from './db.js';
import type { AutomationWorkspaceSummary } from './automationRuntime.js';
import { refuseMemorySecret } from './memorySafety.js';

export interface AutomationPresenceReport {
  machineState: 'starting' | 'running' | 'paused' | 'stopped';
  companionConnected: boolean;
}
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const refusal = () => new Error('The separate desktop presence could not be updated.');
function label(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120
    && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) && !refuseMemorySecret(value)
    ? value.trim() : 'Separate desktop';
}
export function parseAutomationPresence(value: unknown): AutomationPresenceReport {
  if (value === undefined) return { machineState: 'starting', companionConnected: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refusal();
  const report = value as Record<string, unknown>;
  if (Object.keys(report).sort().join(',') !== 'companionConnected,machineState'
    || !['starting', 'running', 'paused', 'stopped'].includes(String(report.machineState))
    || typeof report.companionConnected !== 'boolean') throw refusal();
  return { machineState: report.machineState as AutomationPresenceReport['machineState'],
    companionConnected: report.companionConnected };
}
/** Trusted WorkspaceStorage calls this only after its hardware proof and
 * current canonical workspace checks. No generic HTTP registration endpoint. */
export async function openAutomationPresence(db: Db, args: {
  identity: AutomationIdentity; storageSessionId: string; authSessionId: string;
  authorityEpoch: number; label: string; leaseUntilMs: number; isolated?: boolean;
}): Promise<void> {
  if (![args.identity.userId, args.identity.serverId, args.identity.deviceId, args.identity.workspaceId,
    args.storageSessionId, args.authSessionId].every(uuid) || !Number.isSafeInteger(args.authorityEpoch) || args.authorityEpoch <= 0
    || !Number.isSafeInteger(args.leaseUntilMs) || args.leaseUntilMs <= Date.now() || args.leaseUntilMs > Date.now() + 10_000) throw refusal();
  const rows = await db.query(`insert into automation_workspace_presence
    (workspace_id,owner_user_id,server_id,device_id,storage_session_id,auth_session_id,authority_epoch,
      label,machine_state,companion_connected,lease_until,observed_at,closed_at,isolated)
    values($1,$2,$3,$4,$5,$6,$7,$8,'starting',false,to_timestamp($9/1000.0),clock_timestamp(),null,$10)
    on conflict(workspace_id) do update set storage_session_id=excluded.storage_session_id,
      auth_session_id=excluded.auth_session_id,authority_epoch=excluded.authority_epoch,label=excluded.label,
      machine_state='starting',companion_connected=false,lease_until=excluded.lease_until,
      observed_at=excluded.observed_at,closed_at=null,isolated=excluded.isolated
    where automation_workspace_presence.owner_user_id=excluded.owner_user_id
      and automation_workspace_presence.server_id=excluded.server_id and automation_workspace_presence.device_id=excluded.device_id
      and (automation_workspace_presence.lease_until<=clock_timestamp()
        or automation_workspace_presence.closed_at is not null
        or automation_workspace_presence.storage_session_id=excluded.storage_session_id)
    returning workspace_id`, [args.identity.workspaceId, args.identity.userId, args.identity.serverId, args.identity.deviceId,
    args.storageSessionId, args.authSessionId, args.authorityEpoch, label(args.label), args.leaseUntilMs, args.isolated ?? true]);
  if (rows.length !== 1) throw refusal();
}
export async function renewAutomationPresence(db: Db, args: {
  ownerUserId: string; authSessionId: string; storageSessionId: string; leaseUntilMs: number; report: AutomationPresenceReport;
}): Promise<void> {
  if (![args.ownerUserId, args.authSessionId, args.storageSessionId].every(uuid)
    || !Number.isSafeInteger(args.leaseUntilMs) || args.leaseUntilMs <= Date.now() || args.leaseUntilMs > Date.now() + 10_000) throw refusal();
  const report = parseAutomationPresence(args.report);
  const rows = await db.query(`update automation_workspace_presence set
    machine_state=$4,companion_connected=$5,lease_until=to_timestamp($6/1000.0),observed_at=clock_timestamp()
    where owner_user_id=$1 and auth_session_id=$2 and storage_session_id=$3
      and closed_at is null and lease_until>clock_timestamp()
    returning workspace_id`, [args.ownerUserId, args.authSessionId, args.storageSessionId,
    report.machineState, report.companionConnected, args.leaseUntilMs]);
  if (rows.length !== 1) throw refusal();
}
export async function closeAutomationPresence(db: Db, ownerUserId: string, authSessionId: string, storageSessionId: string): Promise<void> {
  if (![ownerUserId, authSessionId, storageSessionId].every(uuid)) throw refusal();
  await db.query(`update automation_workspace_presence set closed_at=coalesce(closed_at,clock_timestamp()),
    machine_state='stopped',companion_connected=false,lease_until=least(lease_until,clock_timestamp())
    where owner_user_id=$1 and auth_session_id=$2 and storage_session_id=$3`, [ownerUserId, authSessionId, storageSessionId]);
}
/** Presence is not executable authority. This reader never returns "ready",
 * computerUse=true or a browser adapter. Raw SQL metadata cannot enable an
 * action tool, supply consent, bypass the Vault or assert task completion. */
export async function listAutomationPresence(db: Db, ownerUserId: string): Promise<AutomationWorkspaceSummary[]> {
  if (!uuid(ownerUserId)) return [];
  const rows = await db.query<{ workspace_id: string; owner_user_id: string; server_id: string; device_id: string;
    label: string; machine_state: string; companion_connected: boolean; is_current: boolean; isolated: boolean }>(`
    select p.workspace_id,p.owner_user_id,p.server_id,p.device_id,p.label,p.machine_state,p.companion_connected,p.isolated,
      (p.closed_at is null and p.lease_until>clock_timestamp() and p.observed_at<=clock_timestamp()
        and p.lease_until<=p.observed_at+interval '10 seconds'
        and s.revoked_at is null and s.expires_at>clock_timestamp() and u.role='super_admin'
        and v.locked=false and v.authority_reconciliation_required=false and v.authority_epoch=p.authority_epoch
        and coalesce(b.locked,false)=false) as is_current
    from automation_workspace_presence p join users u on u.id=p.owner_user_id
      join sessions s on s.id=p.auth_session_id and s.user_id=p.owner_user_id
      join install_identity installation on installation.id=true and installation.install_id=p.server_id
      join vault_state v on v.id=true left join vault_boxes b on b.owner_user_id=p.owner_user_id
    where p.owner_user_id=$1 and u.status='active'
    order by p.observed_at desc,p.workspace_id limit 32`, [ownerUserId]);
  return rows.filter(row => [row.workspace_id, row.owner_user_id, row.server_id, row.device_id].every(uuid)).map(row => ({
    identity: { workspaceId: row.workspace_id, userId: row.owner_user_id, serverId: row.server_id, deviceId: row.device_id },
    label: label(row.label), isolated: row.isolated !== false, browserFamilies: [], computerUse: false,
    state: !row.is_current ? 'offline' : row.machine_state === 'paused' ? 'paused'
      : row.machine_state === 'running' && row.companion_connected ? 'needs_local_consent' : 'offline',
  }));
}
