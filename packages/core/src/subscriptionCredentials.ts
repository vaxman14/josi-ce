import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { Secret } from './sealing.js';
import { getVaultSecret, putVaultItem, VaultError, VaultLockedError } from './vault.js';

const SERVICE = 'subscription_cli', SLOT = 'codex';
const MAX_CACHE_BYTES = 64 * 1024;
const MAX_LEASE_MS = 16 * 60_000;
export class SubscriptionCredentialError extends Error {}
/** Refused before any consumer starts. A bounded scheduler retry is safe. */
export class SubscriptionCredentialBusyError extends SubscriptionCredentialError {}
type State = 'ready' | 'leased' | 'reconnect_required' | 'signed_out';
type Operation = 'login' | 'chat' | 'status';
interface Document {
  schemaVersion: 1;
  consumer: 'codex';
  revision: number;
  state: State;
  auth: string | null;
  lease: { id: string; operation: Operation; expiresAtMs: number; epoch: number } | null;
}
export interface SubscriptionCredentialLease {
  ownerUserId: string;
  itemId: string;
  revision: number;
  id: string;
  operation: Operation;
  expiresAtMs: number;
  epoch: number;
}
export interface SubscriptionCredentialStatus {
  itemId: string | null;
  revision: number;
  state: State | 'not_configured';
  operation: Operation | null;
  /** Expiry is never permission to replay a possibly stale refresh token. */
  expiredLease: boolean;
}
export interface SubscriptionCredentialReview {
  purpose: 'subscription.login' | 'subscription.logout' | 'subscription.reconcile';
  ownerUserId: string;
  expected: { itemId: string | null; revision: number };
  leaseId: string | null;
}
/** Trusted application verifiers, not booleans from a renderer or a tool.
 * No dialog, process wait or network call may run inside the transaction. */
export interface SubscriptionCredentialAdministration {
  requireAdministrator(tx: Db, review: Readonly<SubscriptionCredentialReview>): Promise<void>;
  /** Required when reconciling a lost consumer. Expiry alone cannot prove
   * that its process and private projection have stopped. */
  requireConsumerStopped(tx: Db, review: Readonly<SubscriptionCredentialReview>): Promise<void>;
}
const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, names: string[]): v is Record<string, unknown> => object(v)
  && Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const failure = () => new SubscriptionCredentialError('The saved subscription login could not be verified. Reconnect through Josi’s model settings.');

/** File format from the bundled first-party Codex 0.152.0 source.
 * This validates shape only. The vendor CLI still authenticates and refreshes.
 * Never admits an API key, alternate vendor or caller-selected auth endpoint. */
export function validateCodexAuthCache(value: Secret): Secret {
  if (!(value instanceof Secret) || Buffer.byteLength(value.reveal(), 'utf8') > MAX_CACHE_BYTES) throw failure();
  let parsed: unknown;
  try { parsed = JSON.parse(value.reveal()); } catch { throw failure(); }
  if (!object(parsed) || Object.keys(parsed).some(key => !['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(key))
    || parsed.auth_mode !== undefined && parsed.auth_mode !== null && parsed.auth_mode !== 'chatgpt'
    || parsed.OPENAI_API_KEY !== undefined && parsed.OPENAI_API_KEY !== null
    || !object(parsed.tokens)) throw failure();
  const tokens = parsed.tokens;
  if (Object.keys(tokens).some(key => !['id_token', 'access_token', 'refresh_token', 'account_id'].includes(key))
    || ['id_token', 'access_token', 'refresh_token'].some(key => typeof tokens[key] !== 'string'
      || !tokens[key].length || Buffer.byteLength(tokens[key], 'utf8') > 32 * 1024)
    || tokens.account_id !== undefined && tokens.account_id !== null
      && (typeof tokens.account_id !== 'string' || !tokens.account_id || tokens.account_id.length > 256)
    || parsed.last_refresh !== undefined && parsed.last_refresh !== null
      && (typeof parsed.last_refresh !== 'string' || parsed.last_refresh.length > 64 || !Number.isFinite(Date.parse(parsed.last_refresh)))) throw failure();
  return new Secret(JSON.stringify(parsed));
}
/** Compatibility screening, not JWT authentication. The first-party CLI
 * authenticates the credential. The bundled CLI can load cloud-managed
 * storage requirements for workspace plans, so this initial consumer only
 * accepts the known personal plans that do not load those requirements.
 * Unknown plans refuse instead of silently weakening managed policy. */
function requireUnmanagedCodexAccount(value: Secret): void {
  try {
    const cache = JSON.parse(value.reveal()) as { tokens: { id_token: string } };
    const pieces = cache.tokens.id_token.split('.');
    if (pieces.length !== 3 || !/^[a-zA-Z0-9_-]+$/.test(pieces[1])) throw new Error();
    const claims: unknown = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
    if (!object(claims) || !object(claims['https://api.openai.com/auth'])
      || !['free', 'plus', 'pro'].includes(String(claims['https://api.openai.com/auth'].chatgpt_plan_type))) throw new Error();
  } catch {
    throw new SubscriptionCredentialError('This subscription workspace is not supported by Vault-managed execution yet. Use a personal Free, Plus or Pro ChatGPT workspace, or an API provider.');
  }
}
function decode(value: Secret): Document {
  let doc: unknown;
  try { doc = JSON.parse(value.reveal()); } catch { throw failure(); }
  if (!exact(doc, ['schemaVersion', 'consumer', 'revision', 'state', 'auth', 'lease'])
    || doc.schemaVersion !== 1 || doc.consumer !== 'codex' || !integer(doc.revision)
    || !['ready', 'leased', 'reconnect_required', 'signed_out'].includes(String(doc.state))
    || doc.auth !== null && typeof doc.auth !== 'string') throw failure();
  if (doc.state === 'leased') {
    if (!exact(doc.lease, ['id', 'operation', 'expiresAtMs', 'epoch']) || !uuid(doc.lease.id)
      || !['login', 'chat', 'status'].includes(String(doc.lease.operation))
      || !integer(doc.lease.expiresAtMs) || !integer(doc.lease.epoch)
      || doc.lease.operation !== 'login' && doc.auth === null) throw failure();
  } else if (doc.lease !== null) throw failure();
  if (doc.state === 'ready' && doc.auth === null
    || ['signed_out', 'reconnect_required'].includes(String(doc.state)) && doc.auth !== null) throw failure();
  if (typeof doc.auth === 'string') validateCodexAuthCache(new Secret(doc.auth));
  return doc as unknown as Document;
}
interface Current {
  itemId: string | null; doc: Document | null; epoch: number; now: number;
}
function status(current: Current): SubscriptionCredentialStatus {
  return { itemId: current.itemId, revision: current.doc?.revision ?? 0, state: current.doc?.state ?? 'not_configured',
    operation: current.doc?.lease?.operation ?? null,
    expiredLease: current.doc?.state === 'leased' && current.doc.lease!.expiresAtMs <= current.now };
}

/** Resolve the installation's canonical owner without reading a filesystem
 * cache. Only the first administrator-driven sign-in may nominate an owner. */
export async function codexCredentialStoreForInstallation(
  db: Db, key: MasterKey, initialOwnerUserId?: string,
): Promise<CodexCredentialStore> {
  const rows = await db.query<{ owner_user_id: string }>(
    'select owner_user_id from vault_items where service=$1 and slot=$2', [SERVICE, SLOT]);
  if (rows.length > 1) throw failure();
  const owner = rows[0]?.owner_user_id ?? initialOwnerUserId;
  if (!owner) throw new SubscriptionCredentialError('Sign in to ChatGPT through Josi’s model settings first.');
  return new CodexCredentialStore(db, key, owner);
}
function expected(current: Current, value: { itemId: string | null; revision: number }) {
  if (!exact(value, ['itemId', 'revision']) || value.itemId !== current.itemId || value.revision !== (current.doc?.revision ?? 0)) {
    throw new SubscriptionCredentialError('The subscription login changed. Reload its status before continuing.');
  }
}

/** Exclusive refresh/write-back state belongs to the same canonical Vault
 * item as the vendor cache. A crash leaves "leased", never reusable "ready".
 * No filesystem import, projection, provider request or automatic recovery
 * happens in this store. Those require the supervised consumer adapter. */
export class CodexCredentialStore {
  constructor(private db: Db, private key: MasterKey, private ownerUserId: string) {
    if (!uuid(ownerUserId)) throw failure();
  }
  private async transaction<T>(work: (tx: Db, current: Current) => Promise<T>): Promise<T> {
    if (!this.db.transaction) throw new SubscriptionCredentialError('Subscription credentials require transactional Vault storage.');
    return this.db.transaction(async tx => {
      // One shared installation login, across API and worker processes.
      await tx.query("select pg_advisory_xact_lock(hashtext('josi_codex_credentials'))");
      const [vault] = await tx.query<{ authority_epoch: string | number; authority_reconciliation_required: boolean;
        initialized_at: string | null; locked: boolean }>(
        'select authority_epoch,authority_reconciliation_required,initialized_at,locked from vault_state where id=true for share');
      if (!vault?.initialized_at || vault.locked) throw new VaultLockedError('Unlock the Vault before using the subscription login.');
      if (!integer(Number(vault.authority_epoch)) || vault.authority_reconciliation_required) {
        throw new SubscriptionCredentialError('Reconcile recovered Vault authority before using the subscription login.');
      }
      const [owner] = await tx.query("select id from users where id=$1 and role='super_admin' and status='active' for share", [this.ownerUserId]);
      if (!owner) throw new SubscriptionCredentialError('The subscription login administrator is unavailable.');
      const [box] = await tx.query<{ locked: boolean }>('select locked from vault_boxes where owner_user_id=$1 for share', [this.ownerUserId]);
      if (box?.locked) throw new VaultLockedError('Unlock the subscription administrator’s Vault box before continuing.');
      // Reject an ambiguous second canonical owner rather than picking one.
      const rows = await tx.query<{ id: string; owner_user_id: string; status: string }>(
        'select id,owner_user_id,status from vault_items where service=$1 and slot=$2 order by id for update', [SERVICE, SLOT]);
      if (rows.length > 1 || rows[0] && (rows[0].owner_user_id !== this.ownerUserId || rows[0].status !== 'active')) throw failure();
      const item = rows[0];
      const doc = item ? decode(await getVaultSecret(tx, this.key, {
        ownerUserId: this.ownerUserId, service: SERVICE, slot: SLOT, itemId: item.id,
      })) : null;
      const [{ now_ms }] = await tx.query<{ now_ms: string }>('select floor(extract(epoch from clock_timestamp())*1000)::text as now_ms');
      return work(tx, { itemId: item?.id ?? null, doc, epoch: Number(vault.authority_epoch), now: Number(now_ms) });
    });
  }
  private async write(tx: Db, current: Current, change: Pick<Document, 'state' | 'auth' | 'lease'>) {
    const revision = (current.doc?.revision ?? 0) + 1;
    if (!integer(revision)) throw failure();
    const doc: Document = { schemaVersion: 1, consumer: 'codex', revision, ...change };
    const saved = await putVaultItem(tx, this.key, { ownerUserId: this.ownerUserId, kind: 'oauth_token',
      service: SERVICE, slot: SLOT, label: 'ChatGPT subscription login', value: new Secret(JSON.stringify(doc)),
      metadata: { consumer: 'codex', schemaVersion: 1 } });
    return { ...current, itemId: saved.id, doc };
  }
  private match(current: Current, lease: Readonly<SubscriptionCredentialLease>, requireLive: boolean) {
    if (!exact(lease, ['ownerUserId', 'itemId', 'revision', 'id', 'operation', 'expiresAtMs', 'epoch'])
      || lease.ownerUserId !== this.ownerUserId || lease.itemId !== current.itemId
      || lease.revision !== current.doc?.revision || current.doc.state !== 'leased'
      || lease.id !== current.doc.lease?.id || lease.operation !== current.doc.lease.operation
      || lease.expiresAtMs !== current.doc.lease.expiresAtMs || lease.epoch !== current.epoch
      || current.doc.lease.epoch !== current.epoch || requireLive && lease.expiresAtMs <= current.now) {
      throw new SubscriptionCredentialError('This subscription run lost its current Vault claim. Stop it and reconcile the login.');
    }
  }
  inspect(): Promise<SubscriptionCredentialStatus> {
    return this.transaction(async (_tx, current) => status(current));
  }
  /** The application must supervise the CLI, continuously enforce this lease,
   * wait for process closure, then either finish or abandon. */
  async begin(operation: Operation, durationMs: number, administration?: {
    expected: SubscriptionCredentialReview['expected']; authority: SubscriptionCredentialAdministration;
  }): Promise<{ lease: SubscriptionCredentialLease; projection: Secret | null }> {
    if (!['login', 'chat', 'status'].includes(operation) || !integer(durationMs) || durationMs > MAX_LEASE_MS) throw failure();
    return this.transaction(async (tx, current) => {
      if (current.doc?.state === 'leased') {
        if (current.doc.lease!.expiresAtMs > current.now) {
          throw new SubscriptionCredentialBusyError('Another subscription run is using this login. Wait for it to finish.');
        }
        throw new SubscriptionCredentialError('Another subscription run owns this login, or ended without a confirmed write-back. Do not reuse its earlier cache.');
      }
      if (operation === 'login') {
        if (!administration || typeof administration.authority?.requireAdministrator !== 'function') throw failure();
        expected(current, administration.expected);
        await administration.authority.requireAdministrator(tx, {
          purpose: 'subscription.login', ownerUserId: this.ownerUserId, expected: administration.expected, leaseId: null,
        });
      } else if (current.doc?.state !== 'ready') throw failure();
      if (operation !== 'login') requireUnmanagedCodexAccount(new Secret(current.doc!.auth!));
      const id = randomUUID(), expiresAtMs = current.now + durationMs;
      // A new sign-in never receives the prior account's refresh material.
      const auth = operation === 'login' ? null : current.doc!.auth;
      const saved = await this.write(tx, current, { state: 'leased', auth, lease: { id, operation, expiresAtMs, epoch: current.epoch } });
      return { lease: { ownerUserId: this.ownerUserId, itemId: saved.itemId!, revision: saved.doc.revision,
        id, operation, expiresAtMs, epoch: current.epoch }, projection: auth === null ? null : new Secret(auth) };
    });
  }
  requireCurrent(lease: Readonly<SubscriptionCredentialLease>): Promise<void> {
    return this.transaction(async (_tx, current) => { this.match(current, lease, true); });
  }
  /** Caller has confirmed its supervised child stopped. Expired exact leases
   * may retain refreshed credentials, but cannot resume execution. */
  async finish(lease: Readonly<SubscriptionCredentialLease>, refreshed: Secret): Promise<SubscriptionCredentialStatus> {
    const cache = validateCodexAuthCache(refreshed);
    return this.transaction(async (tx, current) => {
      this.match(current, lease, false);
      return status(await this.write(tx, current, { state: 'ready', auth: cache.reveal(), lease: null }));
    });
  }
  /** Caller has stopped its consumer. Unknown refresh results discard the old
   * usable cache instead of rolling back to a potentially rotated token. */
  abandon(lease: Readonly<SubscriptionCredentialLease>): Promise<SubscriptionCredentialStatus> {
    return this.transaction(async (tx, current) => {
      this.match(current, lease, false);
      return status(await this.write(tx, current, { state: 'reconnect_required', auth: null, lease: null }));
    });
  }
  async disconnect(reviewed: SubscriptionCredentialReview['expected'], authority: SubscriptionCredentialAdministration,
    recoverLostConsumer = false): Promise<SubscriptionCredentialStatus> {
    return this.transaction(async (tx, current) => {
      expected(current, reviewed);
      if (typeof authority?.requireAdministrator !== 'function') throw new VaultError('Administrator verification is unavailable.');
      const review: SubscriptionCredentialReview = { purpose: recoverLostConsumer ? 'subscription.reconcile' : 'subscription.logout',
        ownerUserId: this.ownerUserId, expected: reviewed, leaseId: current.doc?.lease?.id ?? null };
      await authority.requireAdministrator(tx, review);
      if (current.doc?.state === 'leased') {
        if (!recoverLostConsumer || typeof authority.requireConsumerStopped !== 'function') {
          throw new SubscriptionCredentialError('Stop and reconcile the active subscription consumer before removing its login.');
        }
        await authority.requireConsumerStopped(tx, review);
      }
      return status(await this.write(tx, current, { state: recoverLostConsumer ? 'reconnect_required' : 'signed_out', auth: null, lease: null }));
    });
  }
}
