import { randomBytes } from 'node:crypto';
import { appendEvent, deleteVaultSlot, isVaultCredentialReference, openCredentialPayload, storeVaultCredentialPayload,
  VaultError, VaultLockedError, type Db, type MasterKey } from '@josi-ce/core';
import { requireConnectorVault } from './credentialVault.js';
import { describeDeveloperService, type DeveloperCheck, type DeveloperFieldValues, type DeveloperService } from './developerServices.js';

/** Everything a connection needs, by field key, sealed as ONE Vault payload.
 * A token service carries `token` (and its optional username/email/base URL);
 * a store carries the parts of its signing key. No part is ever a column. */
export type DeveloperCredentials = DeveloperFieldValues;
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
  // Rule 2 of docs/JOSI_IS_THE_INTERFACE.md: the owner (super-admin) may always
  // connect; the policy is the ceiling for members.
  const [self] = await tx.query(`select 1 from users where id=$1 and status='active' and role='super_admin'`, [owner]);
  if (self) return true;
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
const TOKEN_KEYS = ['token', 'username', 'email', 'baseUrl'];
function valid(service: DeveloperService, value: DeveloperCredentials): void {
  const declared = describeDeveloperService(service)?.fields;
  // A token service must have its token; a store must have every part of its
  // key. Either way nothing outside the service's own fields may ride along.
  const allowed = declared ? declared.map(f => f.key as string) : TOKEN_KEYS;
  const required = declared ? declared.filter(f => !f.optional).map(f => f.key as string) : ['token'];
  const entries = value && typeof value === 'object' ? Object.entries(value) : [];
  if (!entries.length || entries.some(([name, entry]) => !allowed.includes(name) || typeof entry !== 'string')
    || required.some(name => !(value as Record<string, unknown>)[name])) throw new VaultError('The developer credential is invalid');
}

/** Check before testing a newly submitted credential; save checks again after
 * that bounded request so a policy revocation cannot race the commit. */
export async function checkDeveloperCredentialAccess(db: Db, owner: string, service: DeveloperService): Promise<void> {
  await withDeveloperServiceTransaction(db, service, async tx => { await requirePermission(tx, owner, service); await requireVault(tx, owner); });
}

// ------------------------------------------------------------------ accounts
//
// A person may connect several accounts of one service. Each has a short key:
// 'default' for the first, random for the rest. The key names the row and the
// Vault slot, and is what a caller passes to say which account it means.

export const DEFAULT_DEVELOPER_ACCOUNT = 'default';
/** A ceiling, not a plan limit: enough for anybody, and a bound on a loop. */
export const MAX_DEVELOPER_ACCOUNTS_PER_SERVICE = 25;
const ACCOUNT_KEY = /^[a-z0-9]{1,24}$/;
export function isDeveloperAccountKey(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_KEY.test(value);
}
const slotFor = (account: string): string => (account === DEFAULT_DEVELOPER_ACCOUNT ? 'token' : `token.${account}`);

export interface DeveloperAccount {
  account: string; name: string | null; accountLabel: string | null; status: string;
  lastCheckAt: string | null; lastCheckOk: boolean | null; lastError: string | null; lastUsedAt: string | null;
}

/** A person's own name for an account: one short line, or nothing. */
export function normalizeAccountName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name || null;
}

/** This person's accounts of one service, the first connected first. */
export async function listDeveloperAccounts(db: Db, ownerUserId: string, service: DeveloperService): Promise<DeveloperAccount[]> {
  const rows = await db.query<{
    account_key: string; nickname: string | null; account_label: string | null; status: string;
    last_check_at: string | null; last_check_ok: boolean | null; last_error: string | null; last_used_at: string | null;
  }>(`select account_key, nickname, account_label, status, last_check_at, last_check_ok, last_error, last_used_at
      from developer_connections where owner_user_id=$1 and service=$2
      order by (account_key='default') desc, created_at, account_key`, [ownerUserId, service]);
  return rows.map(r => ({ account: r.account_key, name: r.nickname, accountLabel: r.account_label, status: r.status,
    lastCheckAt: r.last_check_at, lastCheckOk: r.last_check_ok, lastError: r.last_error, lastUsedAt: r.last_used_at }));
}

/** How an account is shown to a person or a model: their own name for it when
 * they gave one, otherwise what the service called it. */
export function developerAccountTitle(account: Pick<DeveloperAccount, 'account' | 'name' | 'accountLabel'>): string {
  return account.name ?? account.accountLabel ?? (account.account === DEFAULT_DEVELOPER_ACCOUNT ? 'First account' : `Account ${account.account}`);
}

/** Which account a caller means. `undefined` means "the only one": with
 * several connected it is refused, with their names, rather than guessed. A
 * key, a person's name for the account or the service's label all select it. */
async function resolveAccount(tx: Db, ownerUserId: string, service: DeveloperService, wanted: string | undefined, first = false): Promise<string> {
  const accounts = await listDeveloperAccounts(tx, ownerUserId, service);
  const label = describeDeveloperService(service)?.label ?? service;
  if (!accounts.length) throw new DeveloperCredentialError(404, 'That provider is not connected and active for this account.');
  const asked = (wanted ?? '').trim();
  if (!asked) {
    const usable = accounts.filter(a => a.status !== 'revoked');
    if (usable.length === 1) return usable[0].account;
    if (accounts.length === 1) return accounts[0].account;
    if (first) return (accounts.find(a => a.status === 'active') ?? accounts[0]).account;
    throw new DeveloperCredentialError(409, `More than one ${label} account is connected: ${
      accounts.map(a => `"${developerAccountTitle(a)}" (${a.account})`).join(', ')}. Say which one.`);
  }
  const lower = asked.toLowerCase();
  const match = accounts.find(a => a.account === asked)
    ?? accounts.find(a => a.name?.toLowerCase() === lower)
    ?? accounts.find(a => a.accountLabel?.toLowerCase() === lower);
  if (!match) throw new DeveloperCredentialError(404, `There is no ${label} account called "${asked.slice(0, 60)}". Connected: ${
    accounts.map(a => `"${developerAccountTitle(a)}" (${a.account})`).join(', ')}.`);
  return match.account;
}

/** Save a verified credential.
 *
 * `account` says where: undefined is the first account (what every caller did
 * before there could be more than one), a key replaces that account's
 * credential, and 'new' adds an account. Adding the SAME account again (the
 * service gave it the same label) replaces that account's credential rather
 * than making a twin nobody could tell apart. */
export async function saveDeveloperConnection(db: Db, key: MasterKey, args: {
  ownerUserId: string; service: DeveloperService; credentials: DeveloperCredentials; accountLabel: string | null;
  account?: string; name?: string | null;
}): Promise<{ account: string; created: boolean }> {
  valid(args.service, args.credentials);
  const name = args.name === undefined ? undefined : normalizeAccountName(args.name);
  return withDeveloperServiceTransaction(db, args.service, async tx => {
    await requirePermission(tx, args.ownerUserId, args.service); await requireVault(tx, args.ownerUserId);
    const existing = await listDeveloperAccounts(tx, args.ownerUserId, args.service);
    let account = args.account ?? DEFAULT_DEVELOPER_ACCOUNT;
    if (account === 'new') {
      const same = args.accountLabel ? existing.find(a => a.accountLabel === args.accountLabel) : undefined;
      if (same) account = same.account;
      else if (!existing.some(a => a.account === DEFAULT_DEVELOPER_ACCOUNT)) account = DEFAULT_DEVELOPER_ACCOUNT;
      else {
        if (existing.length >= MAX_DEVELOPER_ACCOUNTS_PER_SERVICE) {
          throw new DeveloperCredentialError(409, `At most ${MAX_DEVELOPER_ACCOUNTS_PER_SERVICE} accounts of one service can be connected.`);
        }
        do { account = randomBytes(4).toString('hex'); } while (existing.some(a => a.account === account));
      }
    } else if (!isDeveloperAccountKey(account) || (account !== DEFAULT_DEVELOPER_ACCOUNT && !existing.some(a => a.account === account))) {
      throw new DeveloperCredentialError(404, 'There is no such account to replace.');
    }
    const created = !existing.some(a => a.account === account);
    const title = name ?? args.accountLabel;
    const reference = await storeVaultCredentialPayload(tx, key, { ownerUserId: args.ownerUserId, kind: 'api_key', service: `developer.${args.service}`, slot: slotFor(account),
      label: `${describeDeveloperService(args.service)!.label} credential${account === DEFAULT_DEVELOPER_ACCOUNT || !title ? '' : ` (${title})`}`,
      payload: { ...args.credentials }, actorUserId: args.ownerUserId });
    await tx.query(`insert into developer_connections(owner_user_id,service,account_key,credentials_enc,account_label,nickname,status,last_check_at,last_check_ok,last_error)
      values($1,$2,$3,$4,$5,$6,'active',now(),true,null) on conflict(owner_user_id,service,account_key) do update set credentials_enc=excluded.credentials_enc,
      account_label=excluded.account_label,nickname=case when $7 then excluded.nickname else developer_connections.nickname end,
      status='active',last_check_at=now(),last_check_ok=true,last_error=null`,
    [args.ownerUserId, args.service, account, reference, args.accountLabel, name ?? null, name !== undefined]);
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'member', kind: 'developer_service.connected', payload: { service: args.service, account } });
    return { account, created };
  });
}

export async function loadDeveloperCredentials(db: Db, key: MasterKey, args: {
  ownerUserId: string; service: DeveloperService; requireActive?: boolean; account?: string;
  /** With several accounts and none named, use the first active one instead of refusing. */
  first?: boolean;
}): Promise<{ credentials: DeveloperCredentials; reference: string; account: string }> {
  return withDeveloperServiceTransaction(db, args.service, async tx => {
    await requirePermission(tx, args.ownerUserId, args.service); await requireVault(tx, args.ownerUserId);
    const account = await resolveAccount(tx, args.ownerUserId, args.service, args.account, args.first === true);
    const [row] = await tx.query<{ credentials_enc: string | null; status: string }>('select credentials_enc,status from developer_connections where owner_user_id=$1 and service=$2 and account_key=$3 for update', [args.ownerUserId, args.service, account]);
    if (!row?.credentials_enc || row.status === 'revoked' || (args.requireActive !== false && row.status !== 'active'))
      throw new DeveloperCredentialError(404, 'That provider is not connected and active for this account.');
    const credentials = await openCredentialPayload<DeveloperCredentials>(tx, key, { ownerUserId: args.ownerUserId, service: `developer.${args.service}`, slot: slotFor(account), stored: row.credentials_enc });
    valid(args.service, credentials);
    let reference = row.credentials_enc;
    if (!isVaultCredentialReference(reference)) {
      reference = await storeVaultCredentialPayload(tx, key, { ownerUserId: args.ownerUserId, kind: 'api_key', service: `developer.${args.service}`, slot: slotFor(account),
        label: `${describeDeveloperService(args.service)!.label} credential`, payload: { ...credentials }, actorUserId: args.ownerUserId });
      await tx.query('update developer_connections set credentials_enc=$3 where owner_user_id=$1 and service=$2 and account_key=$4', [args.ownerUserId, args.service, reference, account]);
      await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'system', kind: 'developer_service.credentials_migrated', payload: { service: args.service } });
    }
    return { credentials, reference, account };
  });
}

/** A provider reply is evidence about the credential that was actually sent.
 * Rotation, removal or policy revocation discards a late reply. The sealed
 * reference names one account's credential, so no account key is needed. */
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

/** Give an account a name of the person's own, or take it away. */
export async function renameDeveloperAccount(db: Db, args: {
  ownerUserId: string; service: DeveloperService; account: string; name: unknown;
}): Promise<boolean> {
  if (!isDeveloperAccountKey(args.account)) return false;
  const rows = await db.query('update developer_connections set nickname=$4 where owner_user_id=$1 and service=$2 and account_key=$3 returning id',
    [args.ownerUserId, args.service, args.account, normalizeAccountName(args.name)]);
  return rows.length === 1;
}

/** Disconnect. With an account key, that account; without one, every account
 * of the service, which is what "disconnect" meant when there was only one. */
export async function deleteDeveloperConnection(db: Db, ownerUserId: string, service: DeveloperService, account?: string): Promise<number> {
  if (account !== undefined && !isDeveloperAccountKey(account)) return 0;
  return withDeveloperServiceTransaction(db, service, async tx => {
    const rows = await tx.query<{ account_key: string }>(
      `delete from developer_connections where owner_user_id=$1 and service=$2 and ($3::text is null or account_key=$3) returning account_key`,
      [ownerUserId, service, account ?? null]);
    // The first account's slot is cleared even when no row was found, as before:
    // a sealed credential with no row would be one nobody could find to remove.
    const keys = new Set(rows.map(r => r.account_key));
    if (account === undefined || account === DEFAULT_DEVELOPER_ACCOUNT) keys.add(DEFAULT_DEVELOPER_ACCOUNT);
    for (const k of keys) await deleteVaultSlot(tx, { ownerUserId, service: `developer.${service}`, slot: slotFor(k), actorUserId: ownerUserId });
    await appendEvent(tx, { actorUserId: ownerUserId, actor: 'member', kind: 'developer_service.disconnected', payload: { service, accounts: rows.length } });
    return rows.length;
  });
}
