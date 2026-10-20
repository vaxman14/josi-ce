// Internal storage for protected records. P3 supplies rule semantics and
// human-only activation. This module cannot activate a rule or grant access.
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { appendEvent } from './events.js';
import type { MasterKey } from './masterKey.js';
import { openSealed, seal, Secret } from './sealing.js';

export type VaultRecordKind = 'cardinal_draft' | 'cardinal_review' | 'cardinal_test';
export interface VaultRecordReference { recordId: string; version: number; digest: string; epoch: number }
export interface VaultRecordValue { reference: VaultRecordReference; kind: VaultRecordKind; value: Secret }
/** Optional server-owned authorization, never a callback supplied over HTTP.
 * Runs inside the record transaction after the state and live actor locks. */
export type VaultRecordAccessCheck = (tx: Db, actorUserId: string, writing: boolean) => Promise<void>;
export class VaultRecordError extends Error {}
export class VaultRecordConflictError extends VaultRecordError {}
const kinds = new Set<VaultRecordKind>(['cardinal_draft', 'cardinal_review', 'cardinal_test']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface State { authority_epoch: string | number; authority_reconciliation_required: boolean }
interface Head { id: string; kind: VaultRecordKind; version: number; digest: string }
interface Envelope {
  purpose: 'josi-vault-record'; schemaVersion: 1; recordId: string; kind: VaultRecordKind;
  version: number; epoch: number; previousDigest: string | null; createdBy: string; value: string;
}

/** Constructed by vault.ts, which keeps the existing vault master key private.
 * A transaction holds the vault-state lock until a read/write commits. This
 * establishes an ordering with lock/recovery; it is not a dispatch lease. */
export class VaultRecordStore {
  constructor(private readonly db: Db, private readonly key: (tx: Db) => Promise<MasterKey>, private readonly access?: VaultRecordAccessCheck) {}

  private transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    if (!this.db.transaction) throw new VaultRecordError('Protected Vault records require database transactions');
    return this.db.transaction(work);
  }

  private async state(tx: Db, actorUserId: string, writing: boolean): Promise<State> {
    if (!uuid.test(actorUserId)) throw new VaultRecordError('Active super admin required');
    // All paths use this lock ordering. The live user row is checked as well as
    // the caller identity, so a stale cached role cannot authorize a write.
    const [state] = await tx.query<State>(`select authority_epoch,authority_reconciliation_required
      from vault_state where id=true ${writing ? 'for update' : 'for share'}`);
    const [actor] = await tx.query(`select id from users where id=$1 and role='super_admin' and status='active' for share`, [actorUserId]);
    if (!actor) throw new VaultRecordError('Active super admin required');
    if (!state || !Number.isSafeInteger(Number(state.authority_epoch))) throw new VaultRecordError('Vault authority unavailable');
    await this.access?.(tx, actorUserId, writing);
    return state;
  }

  private reference(head: Head, state: State): VaultRecordReference {
    return { recordId: head.id, version: head.version, digest: head.digest, epoch: Number(state.authority_epoch) };
  }

  private matches(reference: VaultRecordReference, head: Head, state: State): boolean {
    return reference?.recordId === head.id && reference.version === head.version
      && reference.digest === head.digest && reference.epoch === Number(state.authority_epoch);
  }

  async write(args: { actorUserId: string; kind: VaultRecordKind; value: Secret; expected?: VaultRecordReference }): Promise<VaultRecordReference> {
    if (!kinds.has(args.kind) || !(args.value instanceof Secret) || args.value.isEmpty
      || Buffer.byteLength(args.value.reveal(), 'utf8') > 256 * 1024) {
      throw new VaultRecordError('Unsupported or oversized protected Vault record');
    }
    if (args.expected && !uuid.test(args.expected.recordId)) throw new VaultRecordConflictError('Protected Vault record changed');
    return this.transaction(async tx => {
      const state = await this.state(tx, args.actorUserId, true);
      const key = await this.key(tx); // always consult current lock/key state
      if (state.authority_reconciliation_required) throw new VaultRecordError('Vault authority requires recovery reconciliation');
      let previous: Head | undefined;
      if (args.expected) {
        [previous] = await tx.query<Head>(`select id,kind,version,digest from vault_record_heads where id=$1`, [args.expected.recordId]);
        if (!previous || !this.matches(args.expected, previous, state) || previous.kind !== args.kind) {
          throw new VaultRecordConflictError('Protected Vault record changed');
        }
        // Do not extend a corrupted history merely because its index matches.
        await this.open(tx, key, previous, state);
      }
      const id = previous?.id ?? randomUUID();
      const version = (previous?.version ?? 0) + 1;
      const [next] = await tx.query<State>(`update vault_state set authority_epoch=authority_epoch+1,updated_at=now()
        where id=true returning authority_epoch,authority_reconciliation_required`);
      const envelope: Envelope = { purpose: 'josi-vault-record', schemaVersion: 1, recordId: id,
        kind: args.kind, version, epoch: Number(next.authority_epoch), previousDigest: previous?.digest ?? null,
        createdBy: args.actorUserId, value: args.value.reveal() };
      const ciphertext = seal(key, envelope), checksum = digest(ciphertext);
      // Digest ciphertext, not low-entropy rule text. Plain SQL indexes contain
      // no rule wording, labels, test cases, LLM output, or secret previews.
      await tx.query(`insert into vault_record_heads(id,kind,version,digest) values($1,$2,$3,$4)
        on conflict(id) do update set version=excluded.version,digest=excluded.digest,updated_at=now()`,
      [id, args.kind, version, checksum]);
      await tx.query(`insert into vault_record_versions(record_id,version,schema_version,authority_epoch,digest,previous_digest,value_enc,created_by)
        values($1,$2,1,$3,$4,$5,$6,$7)`, [id, version, envelope.epoch, checksum, envelope.previousDigest, ciphertext, args.actorUserId]);
      await appendEvent(tx, { actorUserId: args.actorUserId, actor: 'super_admin', kind: 'vault.record_written',
        subjectType: 'vault_record', subjectId: id, payload: { recordKind: args.kind, version, epoch: envelope.epoch, digest: checksum } });
      return { recordId: id, version, digest: checksum, epoch: envelope.epoch };
    });
  }

  private async open(tx: Db, key: MasterKey, head: Head, state: State): Promise<VaultRecordValue> {
    const [row] = await tx.query<{ value_enc: string; digest: string; previous_digest: string | null; authority_epoch: string | number; created_by: string; schema_version: number }>(
      `select value_enc,digest,previous_digest,authority_epoch,created_by,schema_version from vault_record_versions where record_id=$1 and version=$2`, [head.id, head.version]);
    if (!row || row.schema_version !== 1 || row.digest !== head.digest || digest(row.value_enc) !== head.digest) {
      throw new VaultRecordError('Protected Vault record integrity check failed');
    }
    let opened: Envelope;
    try { opened = openSealed<Envelope>(key, row.value_enc); }
    catch { throw new VaultRecordError('Protected Vault record integrity check failed'); }
    if (opened.purpose !== 'josi-vault-record' || opened.schemaVersion !== 1 || opened.recordId !== head.id
      || opened.kind !== head.kind || opened.version !== head.version || opened.epoch !== Number(row.authority_epoch)
      || opened.epoch > Number(state.authority_epoch) || opened.createdBy !== row.created_by
      || opened.previousDigest !== row.previous_digest || typeof opened.value !== 'string') {
      throw new VaultRecordError('Protected Vault record context did not match');
    }
    return { reference: this.reference(head, state), kind: head.kind, value: new Secret(opened.value) };
  }

  /** Historical display and post-recovery inspection may read the current
   * record. An exact reference check additionally requires reconciliation and
   * current epoch. Neither return value is an authorization to execute. */
  async read(args: { actorUserId: string; recordId: string; expected?: VaultRecordReference }): Promise<VaultRecordValue> {
    if (!uuid.test(args.recordId)) throw new VaultRecordError('Protected Vault record not found');
    return this.transaction(async tx => {
      const state = await this.state(tx, args.actorUserId, false);
      const key = await this.key(tx);
      const [head] = await tx.query<Head>(`select id,kind,version,digest from vault_record_heads where id=$1`, [args.recordId]);
      if (!head) throw new VaultRecordError('Protected Vault record not found');
      if (args.expected && (state.authority_reconciliation_required || !this.matches(args.expected, head, state))) {
        throw new VaultRecordConflictError('Protected Vault record changed or requires reconciliation');
      }
      return this.open(tx, key, head, state);
    });
  }
}
