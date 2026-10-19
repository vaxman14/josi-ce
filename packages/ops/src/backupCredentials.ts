import { randomBytes, randomUUID } from 'node:crypto';
import { appendEvent, deleteVaultSlot, isVaultCredentialReference, openCredentialEnvelope, openCredentialPayload,
  storeVaultCredentialPayload, unwrapSecrets, VaultError, VaultLockedError, type Db, type MasterKey } from '@josi-ce/core';
import { describeDestination, endpointHost, type DestinationKind } from './destination.js';

export interface BackupDestinationRow {
  kind: DestinationKind; label: string; bucket: string; region: string; account_id: string | null; endpoint: string | null;
  object_prefix: string; credentials_enc: string | null; encryption_key_ref: string | null; encryption_enabled: boolean;
  credentials_owner_user_id: string | null; encryption_owner_user_id: string | null; configuration_revision: string;
  share_protocol: 'smb' | 'nfs' | null; share_host: string | null; share_name: string | null;
  last_check_at: string | null; last_check_ok: boolean | null; last_check_error: string | null; api_key_present?: boolean;
}
export interface BackupDestinationInput {
  kind: DestinationKind; label: string; bucket: string; region: string; accountId: string | null; endpoint: string | null;
  objectPrefix: string; shareProtocol: 'smb' | 'nfs' | null; shareHost: string | null; shareName: string | null;
  encryptionEnabled: boolean; credentials: Record<string, unknown>; clearCredentials?: boolean; clearSessionToken?: boolean;
}
export class BackupConfigurationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type Slot = 'destination' | 'encryption';
function transaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new VaultError('Backup credential operations require transactions');
  return db.transaction(async tx => {
    await tx.query("select pg_advisory_xact_lock(hashtext('josi_backup_destination'))");
    await tx.query('select id from vault_state where id=true for share');
    return work(tx);
  });
}
async function requireVault(tx: Db, key: MasterKey | null): Promise<MasterKey> {
  const [state] = await tx.query<{ initialized_at: string | null; locked: boolean }>('select initialized_at,locked from vault_state where id=true');
  if (!key || !state?.initialized_at || state.locked) throw new VaultLockedError('Initialize and unlock the Vault to use backup credentials.');
  return key;
}
const current = async (tx: Db) => (await tx.query<BackupDestinationRow>('select * from backup_destination where id=true for update'))[0] ?? null;
const reference = (row: BackupDestinationRow, slot: Slot) => slot === 'destination' ? row.credentials_enc : row.encryption_key_ref;
async function ownerFor(tx: Db, key: MasterKey | null, row: BackupDestinationRow | null, slot: Slot, actorUserId?: string): Promise<string> {
  const bound = slot === 'destination' ? row?.credentials_owner_user_id : row?.encryption_owner_user_id;
  if (bound) return bound;
  const stored = row && reference(row, slot);
  if (stored) {
    const envelope = await openCredentialEnvelope(tx, await requireVault(tx, key), stored);
    if (envelope.vaultItemId) {
      const [item] = await tx.query<{ owner_user_id: string; service: string; slot: string }>('select owner_user_id,service,slot from vault_items where id=$1', [envelope.vaultItemId]);
      if (!item || item.service !== 'backup' || item.slot !== slot) throw new VaultError('The backup credential context did not match');
      return item.owner_user_id;
    }
  }
  const [admin] = await tx.query<{ id: string }>("select id from users where role='super_admin' order by created_at limit 1");
  const owner = admin?.id ?? actorUserId;
  if (!owner) throw new VaultError('The backup credential has no Vault owner');
  return owner;
}
async function checkBox(tx: Db, owner: string) {
  const [box] = await tx.query<{ locked: boolean }>('select locked from vault_boxes where owner_user_id=$1', [owner]);
  if (box?.locked) throw new VaultLockedError('Unlock the backup credential owner’s Vault box.');
}
async function read(tx: Db, key: MasterKey, row: BackupDestinationRow, slot: Slot, owner: string): Promise<Record<string, string>> {
  await checkBox(tx, owner);
  const value = await openCredentialPayload<Record<string, unknown>>(tx, key, { ownerUserId: owner, service: 'backup', slot, stored: reference(row, slot)! });
  const allowed = slot === 'encryption' ? ['key'] : row.kind === 'nas' ? ['username', 'password'] : ['accessKeyId', 'secretAccessKey', 'sessionToken'];
  if (Object.entries(value).some(([name, entry]) => !allowed.includes(name) || typeof entry !== 'string')) throw new VaultError('The stored backup credential is invalid');
  if (slot === 'encryption' && (typeof value.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.key) || Buffer.from(value.key, 'base64url').byteLength !== 32))
    throw new VaultError('The backup encryption key is invalid');
  if (slot === 'destination' && row.kind !== 'nas' && (!value.accessKeyId || !value.secretAccessKey)) throw new VaultError('The stored backup credential is incomplete');
  return value as Record<string, string>;
}
function sameDestination(old: BackupDestinationRow | null, input: BackupDestinationInput): boolean {
  if (!old || old.kind !== input.kind) return false;
  if (input.kind === 'nas') return old.share_protocol === input.shareProtocol && old.share_host === input.shareHost && old.share_name === input.shareName;
  return old.region === input.region && endpointHost({ kind: old.kind, bucket: old.bucket, region: old.region, accountId: old.account_id, endpoint: old.endpoint })
    === endpointHost({ kind: input.kind, bucket: input.bucket, region: input.region, accountId: input.accountId, endpoint: input.endpoint });
}

/** Internal, short-lived preparation. A controller may consume the resulting
 * NAS credential projection; only commit makes configuration authoritative. */
export async function prepareBackupDestinationSave(db: Db, key: MasterKey, input: BackupDestinationInput, actorUserId: string) {
  return transaction(db, async tx => {
    await requireVault(tx, key);
    const old = await current(tx), owner = await ownerFor(tx, key, old, 'destination', actorUserId);
    const encryptionOwner = await ownerFor(tx, key, old, 'encryption', actorUserId);
    await checkBox(tx, owner); await checkBox(tx, encryptionOwner);
    const allowed = input.kind === 'nas' ? ['username', 'password'] : ['accessKeyId', 'secretAccessKey', 'sessionToken'];
    const supplied = unwrapSecrets(input.credentials) as Record<string, unknown>;
    if (Object.entries(supplied).some(([name, value]) => !allowed.includes(name) || typeof value !== 'string')) throw new BackupConfigurationError(400, 'Unexpected backup credential field.');
    const values = Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== '')) as Record<string, string>;
    if (input.clearCredentials && Object.keys(values).length) throw new BackupConfigurationError(400, 'Choose either replacement credentials or clear credentials.');
    let credentials: Record<string, string> = {};
    if (!input.clearCredentials) {
      const keep = sameDestination(old, input) && !!old?.credentials_enc;
      const previous = keep ? await read(tx, key, old!, 'destination', owner) : {};
      const accountField = input.kind === 'nas' ? 'username' : 'accessKeyId';
      const passwordField = input.kind === 'nas' ? 'password' : 'secretAccessKey';
      if (values[accountField] && values[accountField] !== previous[accountField] && previous[passwordField] && !values[passwordField])
        throw new BackupConfigurationError(400, 'Enter the secret again when changing the backup account.');
      credentials = { ...previous, ...values };
      if (values.accessKeyId && values.accessKeyId !== previous.accessKeyId && !values.sessionToken) delete credentials.sessionToken;
      if (input.clearSessionToken) {
        if (values.sessionToken) throw new BackupConfigurationError(400, 'Choose either a replacement session token or clear session token.');
        delete credentials.sessionToken;
      }
      // Never silently drop a saved NAS credential when changing its destination.
      if (input.kind === 'nas' && old?.credentials_enc && !keep && !Object.keys(values).length)
        throw new BackupConfigurationError(400, 'Enter credentials for the changed NAS address/share, or explicitly clear them for guest access.');
    }
    if (input.kind !== 'nas' && (!credentials.accessKeyId || !credentials.secretAccessKey))
      throw new BackupConfigurationError(400, `this destination needs ${describeDestination(input.kind)?.fields.filter(field => field.secret && field.required).map(field => field.label).join(' and ')}`);
    let encryption: Record<string, string> | null = null, recoveryKey: string | null = null;
    // Retain the archive key while encryption is off: older encrypted backups
    // still need it. Turning encryption back on must not silently rotate it.
    if (old?.encryption_key_ref) encryption = await read(tx, key, old, 'encryption', encryptionOwner);
    else if (input.encryptionEnabled) encryption = { key: recoveryKey = randomBytes(32).toString('base64url') };
    return { input, previous: old, revision: randomUUID(), owner, encryptionOwner, credentials, encryption, recoveryKey, actorUserId };
  });
}
export type PreparedBackupDestination = Awaited<ReturnType<typeof prepareBackupDestinationSave>>;
export async function commitBackupDestinationSave(db: Db, key: MasterKey, plan: PreparedBackupDestination): Promise<BackupDestinationRow> {
  return transaction(db, async tx => {
    await requireVault(tx, key);
    const old = await current(tx);
    if ((old?.configuration_revision ?? null) !== (plan.previous?.configuration_revision ?? null)) throw new BackupConfigurationError(409, 'Backup settings changed while saving. Load the current settings and try again.');
    const input = plan.input;
    let credential: string | null = null, encryption: string | null = null;
    if (Object.keys(plan.credentials).length) credential = await storeVaultCredentialPayload(tx, key, { ownerUserId: plan.owner,
      kind: input.kind === 'nas' ? 'password' : 'api_key', service: 'backup', slot: 'destination', label: 'Backup destination credentials', payload: plan.credentials, actorUserId: plan.actorUserId });
    else await deleteVaultSlot(tx, { ownerUserId: plan.owner, service: 'backup', slot: 'destination', actorUserId: plan.actorUserId });
    if (plan.encryption) encryption = await storeVaultCredentialPayload(tx, key, { ownerUserId: plan.encryptionOwner, kind: 'api_key', service: 'backup', slot: 'encryption', label: 'Backup encryption key', payload: plan.encryption, actorUserId: plan.actorUserId });
    const [saved] = await tx.query<BackupDestinationRow>(`insert into backup_destination(id,kind,label,bucket,region,account_id,endpoint,object_prefix,credentials_enc,
      share_protocol,share_host,share_name,encryption_enabled,encryption_key_ref,credentials_owner_user_id,encryption_owner_user_id,configuration_revision)
      values(true,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict(id) do update set kind=excluded.kind,label=excluded.label,
      bucket=excluded.bucket,region=excluded.region,account_id=excluded.account_id,endpoint=excluded.endpoint,object_prefix=excluded.object_prefix,
      credentials_enc=excluded.credentials_enc,share_protocol=excluded.share_protocol,share_host=excluded.share_host,share_name=excluded.share_name,
      encryption_enabled=excluded.encryption_enabled,encryption_key_ref=excluded.encryption_key_ref,credentials_owner_user_id=excluded.credentials_owner_user_id,
      encryption_owner_user_id=excluded.encryption_owner_user_id,configuration_revision=excluded.configuration_revision,
      last_check_at=null,last_check_ok=null,last_check_error=null,updated_at=now() returning *`,
    [input.kind,input.label,input.bucket,input.region,input.accountId,input.endpoint,input.objectPrefix,credential,input.shareProtocol,input.shareHost,input.shareName,
      input.encryptionEnabled,encryption,plan.owner,plan.encryptionOwner,plan.revision]);
    await appendEvent(tx, { actorUserId: plan.actorUserId, actor: 'super_admin', kind: 'backup.destination_configured', payload: { kind: input.kind, bucket: input.bucket, region: input.region } });
    return saved;
  });
}

/** Resolve current authority; neither another administrator nor a caller's
 * stale snapshot may choose the owner, destination or archive key. */
export async function loadBackupDestination(db: Db, key: MasterKey, expectedRevision?: string) {
  return transaction(db, async tx => {
    await requireVault(tx, key);
    const row = await current(tx);
    if (!row) throw new BackupConfigurationError(400, 'no backup destination has been configured yet');
    if (expectedRevision !== undefined && row.configuration_revision !== expectedRevision) throw new BackupConfigurationError(409, 'The backup destination changed. Try again with the current settings.');
    let credentials: Record<string, string> = {}, encryptionKey: Buffer | undefined, migrated = false;
    for (const slot of ['destination', 'encryption'] as const) {
      const stored = reference(row, slot);
      if (!stored) {
        if (slot === 'destination' && row.kind !== 'nas') throw new VaultError('The backup destination credential is missing');
        if (slot === 'encryption' && row.encryption_enabled) throw new VaultError('The backup encryption key is missing');
        continue;
      }
      const owner = await ownerFor(tx, key, row, slot), payload = await read(tx, key, row, slot, owner);
      if (slot === 'destination') credentials = payload;
      else if (row.encryption_enabled) encryptionKey = Buffer.from(payload.key, 'base64url');
      const ownerColumn = slot === 'destination' ? 'credentials_owner_user_id' : 'encryption_owner_user_id';
      if (!isVaultCredentialReference(stored) || !row[ownerColumn]) {
        const ref = isVaultCredentialReference(stored) ? stored : await storeVaultCredentialPayload(tx, key, { ownerUserId: owner,
          kind: slot === 'destination' && row.kind === 'nas' ? 'password' : 'api_key', service: 'backup', slot, label: `Backup ${slot}`, payload });
        if (slot === 'destination') row.credentials_enc = ref; else row.encryption_key_ref = ref;
        row[ownerColumn] = owner; migrated = true;
      }
    }
    if (migrated) {
      await tx.query('update backup_destination set credentials_enc=$1,encryption_key_ref=$2,credentials_owner_user_id=$3,encryption_owner_user_id=$4 where id=true', [row.credentials_enc,row.encryption_key_ref,row.credentials_owner_user_id,row.encryption_owner_user_id]);
      await appendEvent(tx, { actor: 'system', kind: 'backup.credentials_migrated' });
    }
    return { row, credentials, encryptionKey };
  });
}
export async function recordBackupDestinationCheck(db: Db, revision: string, result: { ok: boolean; detail: string }): Promise<void> {
  await transaction(db, async tx => {
    const rows = await tx.query('update backup_destination set last_check_at=now(),last_check_ok=$2,last_check_error=$3 where id=true and configuration_revision=$1 returning id', [revision,result.ok,result.ok ? null : result.detail]);
    if (!rows.length) throw new BackupConfigurationError(409, 'Backup settings changed during the test. Test the current settings again.');
  });
}
export async function removeBackupDestination(db: Db, key: MasterKey | null, actorUserId: string, expectedRevision?: string): Promise<void> {
  await transaction(db, async tx => {
    const row = await current(tx);
    if (row && expectedRevision !== undefined && row.configuration_revision !== expectedRevision) throw new BackupConfigurationError(409, 'Backup settings changed during removal. Load the current settings again.');
    if (row) for (const slot of ['destination', 'encryption'] as const) {
      const owner = await ownerFor(tx, key, row, slot, actorUserId);
      await deleteVaultSlot(tx, { ownerUserId: owner, service: 'backup', slot, actorUserId });
    }
    await tx.query('delete from backup_destination where id=true');
    await appendEvent(tx, { actorUserId, actor: 'super_admin', kind: 'backup.destination_removed' });
  });
}
