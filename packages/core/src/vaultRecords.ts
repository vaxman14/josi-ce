// Internal storage for protected records. Generic writes are drafts/reviews/
// tests only. Permanent policy uses the separate guarded P3 lifecycle.
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { appendEvent } from './events.js';
import type { MasterKey } from './masterKey.js';
import { openSealed, seal, Secret } from './sealing.js';
import { CardinalPolicyStore, CARDINAL_POLICY_RECORD_ID, evaluateCardinalPolicyRecord, type CardinalPolicyAuthority, type CardinalPolicyDecision } from './cardinalPolicy.js';
import type { CardinalActionFacts } from './cardinalRules.js';
import { AutomationPolicyStore, AUTOMATION_POLICY_RECORD_ID, evaluateAutomationPolicyRecord, type AutomationPolicyAuthority, type AutomationPolicyDecision } from './automationPolicy.js';
import type { AutomationPermissionFacts } from './automationPermissions.js';
import { AutomationReservationStore, type AutomationReservationProofPort } from './automationReservations.js';
import { ProtectedConfirmationStore, type ProtectedConfirmationAuthority } from './protectedConfirmations.js';
import { ProtectedDeviceStore, PROTECTED_DEVICES_RECORD_ID, type ProtectedDeviceAuthority } from './protectedDevices.js';
import { WorkspaceStorageStore, WORKSPACE_STORAGE_RECORD_ID, type WorkspaceStorageAuthority } from './workspaceStorage.js';

export type VaultRecordKind = 'cardinal_draft' | 'cardinal_review' | 'cardinal_test' | 'cardinal_policy' | 'automation_policy' | 'protected_devices' | 'workspace_storage';
export interface VaultRecordReference { recordId: string; version: number; digest: string; epoch: number }
export interface VaultRecordValue { reference: VaultRecordReference; kind: VaultRecordKind; value: Secret }
export interface VaultAutomationPreview {
  verdict: 'covered' | 'ask' | 'deny' | 'pause';
  code: 'evaluated' | 'vault_unavailable' | 'identity_unavailable' | 'requires_reconciliation' | 'policy_missing' | 'stale_policy';
  permissions: AutomationPolicyDecision | null;
  cardinal: CardinalPolicyDecision | null;
  executionEnabled: false;
}
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

  private async requireOwnerAutomationVault(tx: Db, actorUserId: string): Promise<void> {
    // The Master Vault may be open while this owner's private box is locked.
    // A newly refreshed global epoch must not undo that owner's pause.
    const [box] = await tx.query<{ locked: boolean }>('select locked from vault_boxes where owner_user_id=$1 for share', [actorUserId]);
    if (box?.locked) throw new VaultRecordError('The action owner’s Vault box is locked.');
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
      return this.persist(tx, key, args.actorUserId, args.kind, args.value, previous);
    });
  }

  private async persist(tx: Db, key: MasterKey, actorUserId: string, kind: VaultRecordKind, value: Secret, previous?: Head, newId?: string): Promise<VaultRecordReference> {
      if (value.isEmpty || Buffer.byteLength(value.reveal(), 'utf8') > 256 * 1024) throw new VaultRecordError('Protected Vault record is too large.');
      const id = previous?.id ?? newId ?? randomUUID();
      const version = (previous?.version ?? 0) + 1;
      const [next] = await tx.query<State>(`update vault_state set authority_epoch=authority_epoch+1,updated_at=now()
        where id=true returning authority_epoch,authority_reconciliation_required`);
      const envelope: Envelope = { purpose: 'josi-vault-record', schemaVersion: 1, recordId: id,
        kind, version, epoch: Number(next.authority_epoch), previousDigest: previous?.digest ?? null,
        createdBy: actorUserId, value: value.reveal() };
      const ciphertext = seal(key, envelope), checksum = digest(ciphertext);
      // Digest ciphertext, not low-entropy rule text. Plain SQL indexes contain
      // no rule wording, labels, test cases, LLM output, or secret previews.
      await tx.query(`insert into vault_record_heads(id,kind,version,digest) values($1,$2,$3,$4)
        on conflict(id) do update set version=excluded.version,digest=excluded.digest,updated_at=now()`,
      [id, kind, version, checksum]);
      await tx.query(`insert into vault_record_versions(record_id,version,schema_version,authority_epoch,digest,previous_digest,value_enc,created_by)
        values($1,$2,1,$3,$4,$5,$6,$7)`, [id, version, envelope.epoch, checksum, envelope.previousDigest, ciphertext, actorUserId]);
      await appendEvent(tx, { actorUserId, actor: 'super_admin', kind: 'vault.record_written',
        subjectType: 'vault_record', subjectId: id, payload: { recordKind: kind, version, epoch: envelope.epoch, digest: checksum } });
      return { recordId: id, version, digest: checksum, epoch: envelope.epoch };
  }

  /** Internal server assembly. The authority port must verify fresh account
   * credentials AND an enrolled protected human control, with no network wait.
   * The generic write API cannot write or replace this singleton. */
  cardinalPolicy(authority: CardinalPolicyAuthority): CardinalPolicyStore {
    return new CardinalPolicyStore((actorUserId, writing, work) => this.transaction(async tx => {
      const state = await this.state(tx, actorUserId, writing), key = await this.key(tx);
      if (writing && state.authority_reconciliation_required) throw new VaultRecordError('Vault authority requires recovery reconciliation');
      let previous: Head | undefined;
      const [root] = await tx.query<Head>('select id,kind,version,digest from vault_record_heads where id=$1', [CARDINAL_POLICY_RECORD_ID]);
      if (root && root.kind !== 'cardinal_policy') throw new VaultRecordError('The Cardinal Rule policy context did not match.');
      previous = root;
      let written = false;
      return work({
        tx,
        reconciliationRequired: state.authority_reconciliation_required,
        readPolicy: () => previous ? this.open(tx, key, previous, state) : Promise.resolve(null),
        readDraft: async expected => {
          if (!expected || !uuid.test(expected.recordId)) throw new VaultRecordConflictError('The tested draft changed.');
          const [head] = await tx.query<Head>('select id,kind,version,digest from vault_record_heads where id=$1', [expected.recordId]);
          if (!head || head.kind !== 'cardinal_draft' || !this.matches(expected, head, state)) throw new VaultRecordConflictError('The tested draft changed.');
          return this.open(tx, key, head, state);
        },
        writePolicy: async value => {
          if (!writing || written) throw new VaultRecordError('Only one protected policy change is permitted.');
          written = true;
          return this.persist(tx, key, actorUserId, 'cardinal_policy', value, previous, CARDINAL_POLICY_RECORD_ID);
        },
      });
    }), authority);
  }

  /** Trusted server assembly only. Saving settings does not establish owner
   * consent, pairing, a control session or an execution lease. */
  automationPolicy(authority: AutomationPolicyAuthority): AutomationPolicyStore {
    return new AutomationPolicyStore((actorUserId, writing, work) => this.transaction(async tx => {
      const state = await this.state(tx, actorUserId, writing), key = await this.key(tx);
      if (writing && state.authority_reconciliation_required) throw new VaultRecordError('Vault authority requires recovery reconciliation');
      const [previous] = await tx.query<Head>('select id,kind,version,digest from vault_record_heads where id=$1', [AUTOMATION_POLICY_RECORD_ID]);
      if (previous && previous.kind !== 'automation_policy') throw new VaultRecordError('The automation policy context did not match.');
      let written = false;
      return work({ tx, reconciliationRequired: state.authority_reconciliation_required,
        readPolicy: () => previous ? this.open(tx, key, previous, state) : Promise.resolve(null),
        writePolicy: async value => {
          if (!writing || written) throw new VaultRecordError('Only one protected policy change is permitted.');
          written = true;
          return this.persist(tx, key, actorUserId, 'automation_policy', value, previous, AUTOMATION_POLICY_RECORD_ID);
        },
      });
    }), authority);
  }

  /** Canonical protected signing enrollments use the existing encrypted
   * history. Generic draft writes and generic reads cannot export material.
   * An existing TX is used only by protected-confirmation key resolution. */
  protectedDevices(authority: ProtectedDeviceAuthority): ProtectedDeviceStore {
    return new ProtectedDeviceStore((actorUserId, writing, work, existingTransaction) => {
      const run = async (tx: Db) => {
        const state = await this.state(tx, actorUserId, writing), key = await this.key(tx);
        await this.requireOwnerAutomationVault(tx, actorUserId);
        if (writing && state.authority_reconciliation_required) throw new VaultRecordError('Vault authority requires recovery reconciliation.');
        const [previous] = await tx.query<Head>('select id,kind,version,digest from vault_record_heads where id=$1', [PROTECTED_DEVICES_RECORD_ID]);
        if (previous && previous.kind !== 'protected_devices') throw new VaultRecordError('Protected-device record context did not match.');
        let written = false;
        return work({ tx, epoch: Number(state.authority_epoch), reconciliationRequired: state.authority_reconciliation_required,
          read: () => previous ? this.open(tx, key, previous, state) : Promise.resolve(null),
          write: async value => {
            if (!writing || written) throw new VaultRecordError('Only one protected enrollment change is permitted.');
            written = true;
            return this.persist(tx, key, actorUserId, 'protected_devices', value, previous, PROTECTED_DEVICES_RECORD_ID);
          },
        });
      };
      if (existingTransaction && writing) throw new VaultRecordError('Enrollment writes require their own guarded Vault transaction.');
      return existingTransaction ? run(existingTransaction) : this.transaction(run);
    }, authority);
  }

  /** Workspace image credentials remain canonical encrypted Vault material.
   * Generic reads/writes cannot export or replace this registry. */
  workspaceStorage(authority: WorkspaceStorageAuthority): WorkspaceStorageStore {
    return new WorkspaceStorageStore((actor, writing, work) => this.transaction(async tx => {
      const state = await this.state(tx, actor, writing), key = await this.key(tx);
      await this.requireOwnerAutomationVault(tx, actor);
      const [previous] = await tx.query<Head>('select id,kind,version,digest from vault_record_heads where id=$1', [WORKSPACE_STORAGE_RECORD_ID]);
      if (previous && previous.kind !== 'workspace_storage') throw new VaultRecordError('Workspace storage context did not match.');
      let written = false;
      return work({ tx, epoch: Number(state.authority_epoch), reconciliationRequired: state.authority_reconciliation_required,
        read: () => previous ? this.open(tx, key, previous, state) : Promise.resolve(null),
        write: async value => {
          if (!writing || written || state.authority_reconciliation_required) throw new VaultRecordError('Workspace storage authority is unavailable.');
          written = true;
          return this.persist(tx, key, actor, 'workspace_storage', value, previous, WORKSPACE_STORAGE_RECORD_ID);
        },
      });
    }), authority);
  }

  /** Encrypted short-lived protected presentations. The optional existing TX
   * is used only by the policy mutation's human-proof callback so consumption,
   * fresh administrator proof, audit and policy all commit or roll back together. */
  protectedConfirmations(authority: ProtectedConfirmationAuthority): ProtectedConfirmationStore {
    return new ProtectedConfirmationStore((actorUserId, writing, work, existingTransaction) => {
      const run = async (tx: Db) => {
        const state = await this.state(tx, actorUserId, writing), key = await this.key(tx);
        if (state.authority_reconciliation_required) throw new VaultRecordError('Vault authority requires recovery reconciliation.');
        await this.requireOwnerAutomationVault(tx, actorUserId);
        return work({ tx, key, epoch: Number(state.authority_epoch) });
      };
      return existingTransaction ? run(existingTransaction) : this.transaction(run);
    }, authority);
  }

  /** Concrete hardware-proof wiring for an already enrolled native device.
   * Installation identity, fresh account checks and first-device consent are
   * still supplied by the trusted application assembly, never request JSON. */
  protectedNativeControl(deviceAuthority: Omit<ProtectedDeviceAuthority, 'verifyHostProjection'>,
    confirmationAuthority: Pick<ProtectedConfirmationAuthority, 'verifyFreshAdministrator'>) {
    let confirmations: ProtectedConfirmationStore;
    const devices = this.protectedDevices({ ...deviceAuthority,
      verifyHostProjection: (tx, actor, device, reference, proof) => confirmations.verifyHostProjection(tx, actor, device, reference, proof) });
    confirmations = this.protectedConfirmations({
      resolveDeviceKey: (tx, identity) => devices.resolveDeviceKey(tx, identity),
      verifyFreshAdministrator: (tx, actor, command) => confirmationAuthority.verifyFreshAdministrator(tx, actor, command),
      verifyDelivery: (tx, challenge, proof) => confirmations.verifyHostDelivery(tx, challenge, proof),
    });
    return Object.freeze({ devices, confirmations });
  }

  /** Read both kinds of authority under the SAME Vault state lock/epoch.
   * Server-owned facts only; this is not a request-body authorization endpoint.
   * It cannot reserve usage or substitute for the final device dispatch gate. */
  async previewAutomation(args: { actorUserId: string; facts: AutomationPermissionFacts;
    expected?: { permissions: VaultRecordReference; cardinal: VaultRecordReference } }): Promise<VaultAutomationPreview> {
    const snapshot = structuredClone(args);
    const pause = (code: VaultAutomationPreview['code']): VaultAutomationPreview => ({ verdict: 'pause', code, permissions: null, cardinal: null, executionEnabled: false });
    if (!uuid.test(snapshot.actorUserId) || snapshot.facts?.identity?.userId !== snapshot.actorUserId) return pause('identity_unavailable');
    try {
      return await this.transaction(async tx => {
        const [state] = await tx.query<State>('select authority_epoch,authority_reconciliation_required from vault_state where id=true for share');
        const [actor] = await tx.query("select id from users where id=$1 and status='active' for share", [snapshot.actorUserId]);
        if (!actor) return pause('identity_unavailable');
        const key = await this.key(tx);
        if (!state || !Number.isSafeInteger(Number(state.authority_epoch))) return pause('vault_unavailable');
        if (state.authority_reconciliation_required) return pause('requires_reconciliation');
        await this.requireOwnerAutomationVault(tx, snapshot.actorUserId);
        return this.automationPreview(tx, key, state, snapshot.facts, snapshot.expected);
      });
    } catch { return pause('vault_unavailable'); }
  }

  private async automationPreview(tx: Db, key: MasterKey, state: State, input: AutomationPermissionFacts,
    expected?: { permissions: VaultRecordReference; cardinal: VaultRecordReference }): Promise<VaultAutomationPreview> {
    const pause = (code: VaultAutomationPreview['code']): VaultAutomationPreview => ({ verdict: 'pause', code, permissions: null, cardinal: null, executionEnabled: false });
    const [permissions] = await tx.query<Head>('select id,kind,version,digest from vault_record_heads where id=$1', [AUTOMATION_POLICY_RECORD_ID]);
    const [cardinal] = await tx.query<Head>('select id,kind,version,digest from vault_record_heads where id=$1', [CARDINAL_POLICY_RECORD_ID]);
    if (!permissions || !cardinal) return pause('policy_missing');
    if (permissions.kind !== 'automation_policy' || cardinal.kind !== 'cardinal_policy') return pause('vault_unavailable');
    if (expected && (!this.matches(expected.permissions, permissions, state) || !this.matches(expected.cardinal, cardinal, state))) return pause('stale_policy');
    const ordinary = evaluateAutomationPolicyRecord(await this.open(tx, key, permissions, state), input);
    const facts: CardinalActionFacts = { identities: { ...input.identity, taskId: input.task?.id },
      effects: [...new Set(input.effects.map(e => e.action))], effectCoverage: input.effectCoverage,
      taskElapsedMs: input.nowMs - input.task.startedAtMs };
    const restrictive = evaluateCardinalPolicyRecord(await this.open(tx, key, cardinal, state), facts);
    const verdict = ordinary.verdict === 'deny' || restrictive.verdict === 'deny' ? 'deny'
      : ordinary.verdict === 'pause' || restrictive.verdict === 'pause' ? 'pause' : ordinary.verdict;
    if (verdict !== 'covered' && ordinary.evaluation) ordinary.evaluation.charges = [];
    return { verdict, code: 'evaluated', permissions: ordinary, cardinal: restrictive, executionEnabled: false };
  }

  /** Reservations extend durable turn effects atomically with policy analysis.
   * No production device verifier/transport is installed by this factory. */
  automationReservations(proofs: AutomationReservationProofPort): AutomationReservationStore {
    return new AutomationReservationStore((actorUserId, requiresAuthority, work) => this.transaction(async tx => {
      const [state] = await tx.query<State>('select authority_epoch,authority_reconciliation_required from vault_state where id=true for share');
      const [actor] = await tx.query("select id from users where id=$1 and status='active' for share", [actorUserId]);
      if (!actor) throw new VaultRecordError('The action owner is unavailable.');
      const key = await this.key(tx);
      if (!state || !Number.isSafeInteger(Number(state.authority_epoch))) throw new VaultRecordError('Vault authority unavailable.');
      if (requiresAuthority && state.authority_reconciliation_required) throw new VaultRecordError('Vault authority requires recovery reconciliation.');
      await this.requireOwnerAutomationVault(tx, actorUserId);
      return work({ tx, key, preview: (facts, expected) => {
        if (facts.identity.userId !== actorUserId || state.authority_reconciliation_required) throw new VaultRecordError('Action authority unavailable.');
        return this.automationPreview(tx, key, state, facts, expected);
      } });
    }), proofs);
  }

  /** Restrictive engine check, not admin inspection and never a grant. The
   * caller supplies authenticated adapter facts; P4 must bind this snapshot to
   * current grants, observation, device consent and the final dispatch lease. */
  async checkCardinalPolicy(args: { actorUserId: string; facts: CardinalActionFacts; expected?: VaultRecordReference }): Promise<CardinalPolicyDecision> {
    const snapshot = structuredClone(args);
    const pause = (code: CardinalPolicyDecision['code']): CardinalPolicyDecision => ({ verdict: 'pause', code, policy: null, rules: [] });
    if (!uuid.test(snapshot.actorUserId) || snapshot.facts?.identities?.userId !== snapshot.actorUserId) return pause('identity_unavailable');
    try {
      return await this.transaction(async tx => {
        const [state] = await tx.query<State>('select authority_epoch,authority_reconciliation_required from vault_state where id=true for share');
        const [actor] = await tx.query("select id from users where id=$1 and status='active' for share", [snapshot.actorUserId]);
        if (!actor) return pause('identity_unavailable');
        const key = await this.key(tx);
        if (!state || !Number.isSafeInteger(Number(state.authority_epoch))) return pause('vault_unavailable');
        if (state.authority_reconciliation_required) return pause('requires_reconciliation');
        await this.requireOwnerAutomationVault(tx, snapshot.actorUserId);
        const [head] = await tx.query<Head>('select id,kind,version,digest from vault_record_heads where id=$1', [CARDINAL_POLICY_RECORD_ID]);
        if (!head) return pause('policy_missing');
        if (head.kind !== 'cardinal_policy') return pause('vault_unavailable');
        if (snapshot.expected && !this.matches(snapshot.expected, head, state)) return pause('stale_policy');
        return evaluateCardinalPolicyRecord(await this.open(tx, key, head, state), snapshot.facts);
      });
    } catch {
      // Keys, DB/provider errors and corrupt encrypted contents never reach an
      // automation response or become an implicit empty policy.
      return pause('vault_unavailable');
    }
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
      if (head.kind === 'protected_devices') throw new VaultRecordError('Protected-device material requires the authenticated host projection path.');
      if (head.kind === 'workspace_storage') throw new VaultRecordError('Workspace credentials require the authenticated native storage path.');
      if (args.expected && (state.authority_reconciliation_required || !this.matches(args.expected, head, state))) {
        throw new VaultRecordConflictError('Protected Vault record changed or requires reconciliation');
      }
      return this.open(tx, key, head, state);
    });
  }

  /** Bounded administrator display from canonical encrypted records. No
   * plaintext label/index mirror is created for the settings UI. */
  async listDrafts(actorUserId: string): Promise<VaultRecordValue[]> {
    return this.transaction(async tx => {
      const state = await this.state(tx, actorUserId, false), key = await this.key(tx);
      const heads = await tx.query<Head>(`select id,kind,version,digest from vault_record_heads
        where kind='cardinal_draft' order by updated_at desc,id desc limit 100`);
      const records: VaultRecordValue[] = [];
      for (const head of heads) records.push(await this.open(tx, key, head, state));
      return records;
    });
  }
}
