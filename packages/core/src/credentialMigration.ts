// Internal upgrade seam. It moves encrypted material without using a provider,
// enabling a connection, granting permission, or returning secret values.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { appendEvent } from './events.js';
import { getVaultSecret, isVaultCredentialReference, openCredentialEnvelope, openCredentialPayload, referenceExistingVaultCredential, storeVaultCredentialPayload,
  VaultError, VaultLockedError, type VaultKind } from './vault.js';

type Row = Record<string, any>;
type Value = string | ((row: Row) => string);
interface Field {
  column: string; service: Value; slot: Value; kind?: VaultKind | ((row: Row) => VaultKind);
  owner?: string; binding?: string; fallback?: string;
}
interface Source {
  table: string; key: string; fields: Field[];
  before?: (tx: Db, row: Row) => Promise<unknown>;
  after?: (tx: Db, row: Row) => Promise<unknown>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const value = (definition: Value, row: Row) => typeof definition === 'string' ? definition : definition(row);
const fence = (name: string) => (tx: Db) => tx.query('select pg_advisory_xact_lock(hashtext($1))', [name]);
// All identifiers and SQL fragments below are source constants, never API input.
// Fences deliberately match each existing consumer's lock ordering.
const sources: Source[] = [
  { table: 'telegram_config', key: 'id', fields: [
    { column: 'bot_token_enc', service: 'channel.telegram', slot: 'bot', binding: 'vault_owner_user_id' },
    { column: 'webhook_secret_enc', service: 'channel.telegram', slot: 'webhook', binding: 'vault_owner_user_id' },
  ] },
  { table: 'external_channel_configs', key: 'provider', fields: [
    { column: 'credentials_enc', service: row => `channel.${row.provider}`, slot: 'credentials', binding: 'vault_owner_user_id' },
    { column: 'webhook_secret_enc', service: row => `channel.${row.provider}`, slot: 'webhook', binding: 'vault_owner_user_id' },
  ] },
  { table: 'custom_api_connections', key: 'id', fields: [
    { column: 'credentials_enc', service: 'custom_api', slot: row => row.id, binding: 'vault_owner_user_id', fallback: 'created_by_user_id' },
  ] },
  { table: 'oauth_clients', key: 'provider', after: fence('josi_oauth_clients'), fields: [
    { column: 'client_secret_enc', service: 'oauth_client', slot: row => row.provider, binding: 'vault_owner_user_id', fallback: 'configured_by', kind: 'oauth_token' },
  ] },
  { table: 'connector_configs', key: 'id', fields: [
    { column: 'client_secret_enc', service: 'legacy.connector_config', slot: row => row.id, binding: 'vault_owner_user_id', kind: 'oauth_token' },
  ] },
  { table: 'connections', key: 'id', before: (tx, row) => tx.query("select pg_advisory_xact_lock(hashtext('josi_connection_owner'),hashtext($1))", [JSON.stringify([row.owner_user_id, row.provider])]), fields: [
    { column: 'secrets_enc', service: row => `connector.${row.provider}`, slot: row => row.id, owner: 'owner_user_id', kind: row => row.provider === 'nextcloud' ? 'password' : 'oauth_token' },
  ] },
  { table: 'oauth_states', key: 'id', fields: [
    { column: 'verifier_enc', service: 'oauth.pkce', slot: row => hash(row.id), owner: 'user_id', kind: 'oauth_token' },
  ] },
  { table: 'auth_oauth_states', key: 'state_hash', fields: [
    { column: 'verifier', service: 'auth.google.pkce', slot: row => row.state_hash, binding: 'vault_owner_user_id', kind: 'oauth_token' },
  ] },
  { table: 'users', key: 'id', fields: [
    { column: 'totp_secret_enc', service: 'auth.totp', slot: 'authenticator', owner: 'id', kind: 'other' },
  ] },
  { table: 'llm_providers', key: 'role', before: fence('josi_llm_configuration'), fields: [
    { column: 'api_key_enc', service: 'llm', slot: row => row.role, binding: 'vault_owner_user_id' },
  ] },
  { table: 'smtp_profiles', key: 'kind', before: fence('josi_smtp_configuration'), fields: [
    { column: 'password_enc', service: 'smtp', slot: row => row.kind, binding: 'vault_owner_user_id', kind: 'password' },
  ] },
  { table: 'developer_connections', key: 'id', before: (tx, row) => tx.query("select pg_advisory_xact_lock(hashtext('josi_developer_service'),hashtext($1))", [row.service]), fields: [
    { column: 'credentials_enc', service: row => `developer.${row.service}`, slot: 'token', owner: 'owner_user_id' },
  ] },
  { table: 'workflow_integrations', key: 'id', before: fence('josi_workflow_credentials'), fields: [
    { column: 'credentials_enc', service: row => `workflow.${row.provider}`, slot: row => row.id, owner: 'created_by' },
    { column: 'callback_secret_enc', service: row => `workflow.${row.provider}`, slot: row => `${row.id}.callback`, owner: 'created_by' },
  ] },
  { table: 'backup_destination', key: 'id', before: fence('josi_backup_destination'), fields: [
    { column: 'credentials_enc', service: 'backup', slot: 'destination', binding: 'credentials_owner_user_id', kind: row => row.kind === 'nas' ? 'password' : 'api_key' },
    { column: 'encryption_key_ref', service: 'backup', slot: 'encryption', binding: 'encryption_owner_user_id' },
  ] },
  { table: 'mobile_devices', key: 'id', before: fence('josi_mobile_device_registration'), fields: [
    { column: 'expo_token_enc', service: 'mobile.push', slot: row => row.device_identity, owner: 'owner_user_id' },
  ] },
];
const present = (source: Source) => source.fields.map(field => `(${field.column} is not null and ${field.column}<>'')`).join(' or ');
export interface CredentialMigrationCount { source: string; rows: number; legacyFields: number; unboundFields: number }
export interface CredentialMigrationReport {
  checked: number; migrated: number; skipped: number; failed: number;
  issues: Array<{ source: string; record: string; category: 'locked' | 'credential_conflict' | 'unavailable_or_misbound' | 'storage_failure' }>;
  issuesTruncated: boolean; remaining: CredentialMigrationCount[]; legacyMigrationComplete: boolean;
}
class CredentialConflict extends VaultError {}
async function administrator(db: Db, actorUserId: string) {
  const [actor] = await db.query("select id from users where id=$1 and role='super_admin' and status='active'", [actorUserId]);
  if (!actor) throw new VaultError('Active super admin required for credential migration.');
}

/** Counts formats and missing bindings only. It does not vouch for decryption,
 * live provider access, runtime projections, or recovery reconciliation. */
export async function inspectCredentialMigration(db: Db, actorUserId: string): Promise<CredentialMigrationCount[]> {
  await administrator(db, actorUserId);
  const result: CredentialMigrationCount[] = [];
  for (const source of sources) {
    const legacy = source.fields.map(field => `case when ${field.column} is not null and ${field.column}<>'' and ${field.column} not like 'vaultref.v1.%' then 1 else 0 end`).join('+');
    const unbound = source.fields.filter(field => field.binding).map(field => `case when ${field.column} is not null and ${field.column}<>'' and ${field.binding} is null then 1 else 0 end`).join('+') || '0';
    const [count] = await db.query<{ rows: string | number; legacy: string | number; unbound: string | number }>(`select count(*) as rows,coalesce(sum(${legacy}),0) as legacy,coalesce(sum(${unbound}),0) as unbound from ${source.table} where ${present(source)}`);
    result.push({ source: source.table, rows: Number(count.rows), legacyFields: Number(count.legacy), unboundFields: Number(count.unbound) });
  }
  return result;
}

async function ownerFor(tx: Db, key: MasterKey, row: Row, field: Field, stored: string): Promise<string> {
  const bound = field.owner ? row[field.owner] : field.binding ? row[field.binding] : null;
  if (bound) return bound;
  // A missing intrinsic owner is not permission to reassign somebody's account.
  if (field.owner) throw new VaultError('The credential owner is unavailable.');
  const envelope = await openCredentialEnvelope(tx, key, stored);
  if (envelope.vaultItemId) {
    const [item] = await tx.query<{ owner_user_id: string; service: string; slot: string }>('select owner_user_id,service,slot from vault_items where id=$1', [envelope.vaultItemId]);
    if (!item || item.service !== value(field.service, row) || item.slot !== value(field.slot, row)) throw new VaultError('The credential context did not match.');
    return item.owner_user_id;
  }
  if (field.fallback && row[field.fallback]) return row[field.fallback];
  if (field.service === 'auth.google.pkce') {
    const [app] = await tx.query<{ owner: string | null }>("select coalesce(vault_owner_user_id,configured_by) as owner from oauth_clients where provider='google'");
    if (app?.owner) return app.owner;
  }
  const [admin] = await tx.query<{ id: string }>("select id from users where role='super_admin' order by created_at limit 1");
  if (!admin) throw new VaultError('The credential owner is unavailable.');
  return admin.id;
}

async function migrateRow(db: Db, key: MasterKey, actorUserId: string, source: Source, observed: Row): Promise<'migrated' | 'checked' | 'skipped'> {
  if (!db.transaction) throw new VaultError('Credential migration requires transactions.');
  return db.transaction(async tx => {
    await source.before?.(tx, observed);
    const [state] = await tx.query<{ initialized_at: string | null; locked: boolean }>('select initialized_at,locked from vault_state where id=true for share');
    if (!state?.initialized_at || state.locked) throw new VaultLockedError('Unlock the Vault before migrating credentials.');
    await administrator(tx, actorUserId);
    await source.after?.(tx, observed);
    const [row] = await tx.query<Row>(`select * from ${source.table} where ${source.key}=$1 for update`, [observed[source.key]]);
    if (!row) return 'skipped';
    // The fence owner must still be the one selected before entering the TX.
    if (['owner_user_id', 'provider', 'service'].some(name => row[name] !== observed[name])) throw new CredentialConflict('The connection changed during migration.');
    const changes = new Map<string, string>();
    for (const field of source.fields) {
      const stored = row[field.column];
      if (!stored) continue;
      const owner = await ownerFor(tx, key, row, field, stored), service = value(field.service, row), slot = value(field.slot, row);
      const [box] = await tx.query<{ locked: boolean }>('select locked from vault_boxes where owner_user_id=$1', [owner]);
      if (box?.locked) throw new VaultLockedError('The credential owner’s Vault box is locked.');
      const payload = await openCredentialPayload<Record<string, unknown>>(tx, key, { ownerUserId: owner, service, slot, stored });
      if (!isVaultCredentialReference(stored)) {
        // Never overwrite a different canonical credential just because an old
        // configuration column still contains a decryptable legacy payload.
        const [item] = await tx.query<{ id: string; status: string }>('select id,status from vault_items where owner_user_id=$1 and service=$2 and slot=$3', [owner,service,slot]);
        if (item) {
          if (item.status !== 'active') throw new CredentialConflict('An existing canonical credential is withdrawn.');
          const existing = JSON.parse((await getVaultSecret(tx, key, { ownerUserId: owner, service, slot, itemId: item.id })).reveal());
          if (!isDeepStrictEqual(existing, payload)) throw new CredentialConflict('The existing canonical credential differs.');
        }
        const kind = typeof field.kind === 'function' ? field.kind(row) : field.kind ?? 'api_key';
        const reference = item
          ? await referenceExistingVaultCredential(tx, key, { ownerUserId: owner, service, slot, itemId: item.id })
          : await storeVaultCredentialPayload(tx, key, { ownerUserId: owner, service, slot, kind,
            label: `Migrated ${service} credential`, payload, actorUserId });
        changes.set(field.column, reference);
      }
      if (field.binding && !row[field.binding]) {
        if (changes.has(field.binding) && changes.get(field.binding) !== owner) throw new CredentialConflict('The paired credentials have different owners.');
        changes.set(field.binding, owner);
      }
    }
    if (!changes.size) return 'checked';
    await tx.query(`update ${source.table} set ${[...changes.keys()].map((column, i) => `${column}=$${i + 2}`).join(',')} where ${source.key}=$1`, [row[source.key], ...changes.values()]);
    await appendEvent(tx, { actorUserId, actor: 'super_admin', kind: 'vault.credentials_migrated', payload: { source: source.table, record: hash(`${source.table}:${row[source.key]}`), fields: source.fields.filter(field => changes.has(field.column)).length } });
    return 'migrated';
  });
}

/** Scans inactive as well as active consumers. Each record commits separately,
 * so rerunning resumes safely; a failed pair rolls back without stopping other
 * records. Only bounded, redacted issues leave this seam. No secret is exposed
 * to the administrator or a model. No key is replaced by this operation. */
export async function migrateStoredCredentials(db: Db, key: MasterKey, actorUserId: string): Promise<CredentialMigrationReport> {
  await administrator(db, actorUserId);
  const [state] = await db.query<{ initialized_at: string | null; locked: boolean }>('select initialized_at,locked from vault_state where id=true');
  if (!state?.initialized_at || state.locked) throw new VaultLockedError('Initialize and unlock the Vault before migrating credentials.');
  const report: CredentialMigrationReport = { checked: 0, migrated: 0, skipped: 0, failed: 0, issues: [], issuesTruncated: false, remaining: [], legacyMigrationComplete: false };
  for (const source of sources) {
    let after: string | null = null;
    for (;;) {
      const rows: Row[] = await db.query(`select * from ${source.table} where (${present(source)}) and ($1::text is null or ${source.key}::text>$1) order by ${source.key}::text limit 100`, [after]);
      if (!rows.length) break;
      for (const row of rows) {
        try { report[await migrateRow(db, key, actorUserId, source, row)]++; }
        catch (error) {
          report.failed++;
          const category = error instanceof VaultLockedError ? 'locked' : error instanceof CredentialConflict ? 'credential_conflict' : error instanceof VaultError ? 'unavailable_or_misbound' : 'storage_failure';
          if (report.issues.length < 100) report.issues.push({ source: source.table, record: hash(`${source.table}:${row[source.key]}`), category });
          else report.issuesTruncated = true;
        }
        after = String(row[source.key]);
      }
    }
  }
  report.remaining = await inspectCredentialMigration(db, actorUserId);
  report.legacyMigrationComplete = report.failed === 0 && report.remaining.every(item => item.legacyFields === 0 && item.unboundFields === 0);
  return report;
}
