import { isDeepStrictEqual } from 'node:util';
import { appendEvent, deleteVaultSlot, isVaultCredentialReference, json, openCredentialEnvelope, openCredentialPayload, storeVaultCredentialPayload,
  unwrapSecrets, VaultError, VaultLockedError, type Db, type MasterKey } from '@josi-ce/core';
import { credentialFields, describeProvider } from './catalog.js';
import type { StoredProvider } from './registry.js';
import type { ProviderKind } from './types.js';

export class ModelConfigurationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type Role = 'primary' | 'fallback';
async function transaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new VaultError('Model configuration requires transactions');
  return db.transaction(async tx => {
    await tx.query("select pg_advisory_xact_lock(hashtext('josi_llm_configuration'))");
    await tx.query('select id from vault_state where id=true for share');
    return work(tx);
  });
}
async function requireVault(tx: Db, key: MasterKey | null): Promise<MasterKey> {
  const [state] = await tx.query<{ initialized_at: string | null; locked: boolean }>('select initialized_at,locked from vault_state where id=true');
  if (!key || !state?.initialized_at || state.locked) throw new VaultLockedError('Initialize and unlock the Vault to use model credentials.');
  return key;
}
async function ownerFor(tx: Db, row: StoredProvider | null, actorUserId?: string, key: MasterKey | null = null): Promise<string> {
  if (row?.vault_owner_user_id) return row.vault_owner_user_id;
  if (row?.api_key_enc) {
    const available = await requireVault(tx, key);
    const envelope = await openCredentialEnvelope(tx, available, row.api_key_enc);
    if (envelope.vaultItemId) {
      // Recover historical ownership only from the authenticated pointer, never
      // from arbitrary items somebody created with the same service name.
      const [item] = await tx.query<{ owner_user_id: string; service: string; slot: string }>('select owner_user_id,service,slot from vault_items where id=$1', [envelope.vaultItemId]);
      if (!item || item.service !== 'llm' || item.slot !== row.role) throw new VaultError('The model credential context did not match');
      return item.owner_user_id;
    }
  }
  // Old releases stored model keys in the then-current super administrator's
  // box. Persist that owner on the first migration rather than every call.
  const [admin] = await tx.query<{ id: string }>("select id from users where role='super_admin' order by created_at limit 1");
  const owner = admin?.id ?? actorUserId;
  if (!owner) throw new VaultError('The model credential has no Vault owner');
  return owner;
}
async function current(tx: Db, role: Role): Promise<StoredProvider | null> {
  return (await tx.query<StoredProvider>('select *,updated_at::text as updated_at from llm_providers where role=$1 for update', [role]))[0] ?? null;
}
async function payload(tx: Db, key: MasterKey, row: StoredProvider, owner: string): Promise<Record<string, string>> {
  const value = await openCredentialPayload<Record<string, unknown>>(tx, key, { ownerUserId: owner, service: 'llm', slot: row.role, stored: row.api_key_enc! });
  const allowed = new Set(credentialFields(row.provider).secret.map(field => field.key));
  if (Object.entries(value).some(([name, value]) => !allowed.has(name) || typeof value !== 'string'))
    throw new VaultError('The stored model credentials are invalid');
  return value as Record<string, string>;
}

/** Resolve only the current configured destination, never a detached key or a
 * snapshot that was replaced or removed. No network request occurs in this TX. */
export async function resolveModelCredentials(db: Db, key: MasterKey | null, observed: StoredProvider): Promise<{ secrets: Record<string, string>; version: string }> {
  return transaction(db, async tx => {
    const row = await current(tx, observed.role);
    if (!row || ['provider', 'model', 'base_url', 'api_key_enc', 'external_acknowledged'].some(name => row[name as keyof StoredProvider] !== observed[name as keyof StoredProvider])
      || (row.subscription_command ?? null) !== (observed.subscription_command ?? null)
      || !isDeepStrictEqual(row.provider_config ?? {}, observed.provider_config ?? {})
      || (observed.updated_at !== undefined && row.updated_at !== observed.updated_at))
      throw new VaultError('The model configuration changed. Load the current selection again.');
    if (!row.api_key_enc) return { secrets: {}, version: row.updated_at! };
    const available = await requireVault(tx, key), owner = await ownerFor(tx, row, undefined, available);
    const secrets = await payload(tx, available, row, owner);
    let version = row.updated_at!;
    if (!isVaultCredentialReference(row.api_key_enc) || !row.vault_owner_user_id) {
      const reference = isVaultCredentialReference(row.api_key_enc) ? row.api_key_enc : await storeVaultCredentialPayload(tx, available, {
        ownerUserId: owner, kind: 'api_key', service: 'llm', slot: row.role, label: `${row.role} model credentials`, payload: secrets,
      });
      const [updated] = await tx.query<{ updated_at: string }>('update llm_providers set api_key_enc=$2,vault_owner_user_id=$3 where role=$1 returning updated_at::text as updated_at', [row.role, reference, owner]);
      version = updated.updated_at;
      await appendEvent(tx, { actorUserId: owner, actor: 'system', kind: 'llm.credentials_migrated', payload: { role: row.role } });
    }
    return { secrets, version };
  });
}

export async function saveModelConfiguration(db: Db, key: MasterKey | null, args: {
  role: Role; provider: ProviderKind; model: string; baseUrl: string | null; acknowledged: boolean;
  subscriptionCommand?: string | null; secrets: Record<string, unknown>; settings: Record<string, string>;
  actorUserId: string; preserveMissingSecrets?: boolean;
}): Promise<void> {
  await transaction(db, async tx => {
    const row = await current(tx, args.role), owner = await ownerFor(tx, row, args.actorUserId, key);
    const descriptor = describeProvider(args.provider);
    if (!descriptor) throw new ModelConfigurationError(400, 'Choose a model provider.');
    const fields = credentialFields(args.provider), allowed = new Set(fields.secret.map(field => field.key));
    const supplied = unwrapSecrets(args.secrets) as Record<string, unknown>;
    if (Object.entries(supplied).some(([name, value]) => !allowed.has(name) || typeof value !== 'string'))
      throw new ModelConfigurationError(400, 'Unexpected model credential field.');
    if (Object.keys(args.settings).some(name => !fields.config.some(field => field.key === name)))
      throw new ModelConfigurationError(400, 'Unexpected model setting.');
    const values = Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== '')) as Record<string, string>;
    const keep = args.preserveMissingSecrets !== false && row?.provider === args.provider && !!row.api_key_enc;
    let merged: Record<string, string> = { ...values };
    let available: MasterKey | null = null;
    if (keep || Object.keys(values).length) available = await requireVault(tx, key);
    if (keep) merged = { ...await payload(tx, available!, row!, owner), ...values };
    const missing = [...fields.secret.filter(field => field.required && !merged[field.key]), ...fields.config.filter(field => field.required && !args.settings[field.key])];
    if (missing.length) throw new ModelConfigurationError(400, `this provider needs ${missing.map(field => field.label.toLowerCase()).join(' and ')}`);
    let reference: string | null = null;
    if (Object.keys(merged).length) {
      // Leaving every field blank preserves the current reference, while still
      // checking the Vault and validating the actual required fields.
      reference = keep && !Object.keys(values).length && isVaultCredentialReference(row!.api_key_enc)
        ? row!.api_key_enc : await storeVaultCredentialPayload(tx, available!, {
          ownerUserId: owner, kind: 'api_key', service: 'llm', slot: args.role, label: `${args.role} model credentials`, payload: merged, actorUserId: args.actorUserId,
        });
    } else {
      // Switching to a keyless provider/removing a key is allowed while locked.
      await deleteVaultSlot(tx, { ownerUserId: owner, service: 'llm', slot: args.role, actorUserId: args.actorUserId });
    }
    await tx.query(`insert into llm_providers
      (role,provider,model,base_url,api_key_enc,vault_owner_user_id,external_acknowledged,external_acknowledged_at,subscription_command,provider_config)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict(role) do update set provider=excluded.provider,model=excluded.model,base_url=excluded.base_url,
      api_key_enc=excluded.api_key_enc,vault_owner_user_id=excluded.vault_owner_user_id,external_acknowledged=excluded.external_acknowledged,
      external_acknowledged_at=excluded.external_acknowledged_at,subscription_command=excluded.subscription_command,provider_config=excluded.provider_config,
      activated_at=null,probed_at=null,probe_steps='[]',cap_chat=null,cap_structured_output=null,cap_tool_calling=null,cap_vision=null,cap_context_tokens=null`,
    [args.role, args.provider, args.model, args.baseUrl, reference, owner, args.acknowledged, args.acknowledged ? new Date().toISOString() : null,
      args.subscriptionCommand ?? null, json(args.settings)]);
    if (args.role === 'primary') await tx.query("delete from setup_verifications where item='llm'");
    await appendEvent(tx, { actorUserId: args.actorUserId, actor: 'super_admin', kind: 'llm.configured', payload: { role: args.role, provider: args.provider, model: args.model, external: args.provider !== 'openai_compatible' } });
  });
}

export async function removeModelConfiguration(db: Db, role: Role, actorUserId: string, key: MasterKey | null = null): Promise<void> {
  await transaction(db, async tx => {
    const row = await current(tx, role);
    if (row) await deleteVaultSlot(tx, { ownerUserId: await ownerFor(tx, row, actorUserId, key), service: 'llm', slot: role, actorUserId });
    await tx.query('delete from llm_providers where role=$1', [role]);
    if (role === 'primary') await tx.query("delete from setup_verifications where item='llm'");
    await appendEvent(tx, { actorUserId, actor: 'super_admin', kind: role === 'fallback' ? 'llm.fallback_removed' : 'llm.primary_removed' });
  });
}
