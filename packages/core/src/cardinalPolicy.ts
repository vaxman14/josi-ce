// Permanent policy changes are separate from drafts/model advice. The storage
// bridge below is supplied by the existing Vault; no second key/store exists.
import type { Db } from './db.js';
import { isCardinalMeaningAssessment, type CardinalDraftDocument } from './cardinalDrafts.js';
import { cardinalContentDigest, CARDINAL_SEMANTICS_VERSION, CARDINAL_TEST_VERSION, testCardinalRule,
  validateCardinalRule, evaluateCardinalRules, type CardinalRule, type CardinalActionFacts, type CardinalDecision } from './cardinalRules.js';
import type { VaultRecordReference, VaultRecordValue } from './vaultRecords.js';
import { VaultRecordError, VaultRecordConflictError } from './vaultRecords.js';
import { Secret } from './sealing.js';

export const CARDINAL_POLICY_RECORD_ID = 'ea230e88-65fc-4c35-b05d-1792c00471cf';
export const CARDINAL_ENFORCEMENT_VERSION = 'cardinal-enforcement.1';
export interface CardinalActiveRule {
  ruleId: string;
  source: Pick<VaultRecordReference, 'recordId' | 'version' | 'digest'>;
  definition: CardinalRule;
  tested: NonNullable<CardinalDraftDocument['tested']>;
}
export interface CardinalPolicyDocument {
  schemaVersion: 1;
  enforcementVersion: string;
  rules: CardinalActiveRule[];
  lastChange: { operation: 'activate' | 'retire'; ruleId: string; actorUserId: string; at: string };
}
/** Administrator inspection, never an execution permit. */
export interface CardinalPolicyView { reference: VaultRecordReference; document: CardinalPolicyDocument;
  reconciliationRequired: boolean; enforcementCurrent: boolean }
export type CardinalPolicyCommand = { purpose: 'cardinal.activate' | 'cardinal.retire'; requestDigest: string };
export interface CardinalPolicyDecision {
  verdict: CardinalDecision['verdict'];
  code: 'evaluated' | 'vault_unavailable' | 'policy_missing' | 'requires_reconciliation' | 'requires_revalidation' | 'identity_unavailable' | 'stale_policy';
  policy: VaultRecordReference | null;
  rules: Array<Pick<VaultRecordReference, 'recordId' | 'version' | 'digest'>>;
}
export interface CardinalPolicyAuthority {
  /** Local checks/receipt consumption only. No dialog or external call inside
   * the transaction. Account reauth AND protected human control are required. */
  verifyFreshAdministrator(tx: Db, actorUserId: string, command: CardinalPolicyCommand): Promise<void>;
  verifyProtectedHuman(tx: Db, actorUserId: string, command: CardinalPolicyCommand): Promise<void>;
}
export interface CardinalPolicyTransaction {
  tx: Db;
  reconciliationRequired: boolean;
  readPolicy(): Promise<VaultRecordValue | null>;
  readDraft(expected: VaultRecordReference): Promise<VaultRecordValue>;
  writePolicy(value: Secret): Promise<VaultRecordReference>;
}
export type CardinalPolicyBackend = <T>(actorUserId: string, writing: boolean, work: (tx: CardinalPolicyTransaction) => Promise<T>) => Promise<T>;

function currentEnforcement(document: CardinalPolicyDocument): boolean {
  return document.enforcementVersion === CARDINAL_ENFORCEMENT_VERSION && document.rules.every(entry =>
    entry.tested?.report?.status === 'passed' && entry.tested.report.semanticsVersion === CARDINAL_SEMANTICS_VERSION
      && entry.tested.report.suiteVersion === CARDINAL_TEST_VERSION && entry.tested.report.contentDigest === cardinalContentDigest(entry.definition));
}

function decode(record: VaultRecordValue, reconciliationRequired: boolean): CardinalPolicyView {
  let doc: CardinalPolicyDocument;
  try { doc = JSON.parse(record.value.reveal()) as CardinalPolicyDocument; } catch { throw new VaultRecordError('The Cardinal Rule policy is unreadable.'); }
  if (record.kind !== 'cardinal_policy' || record.reference.recordId !== CARDINAL_POLICY_RECORD_ID
    || doc?.schemaVersion !== 1 || typeof doc.enforcementVersion !== 'string' || !Array.isArray(doc.rules) || doc.rules.length > 100
    || !doc.lastChange || new Set(doc.rules.map(r => r?.ruleId)).size !== doc.rules.length
    || doc.rules.some(r => !r || r.ruleId !== r.source?.recordId || !/^[a-f0-9-]{36}$/.test(r.ruleId)
      || !Number.isSafeInteger(r.source.version) || r.source.version < 1 || !/^[a-f0-9]{64}$/.test(r.source.digest)
      || !validateCardinalRule(r.definition).valid)) {
    throw new VaultRecordError('The Cardinal Rule policy is invalid.');
  }
  return { reference: record.reference, document: doc, reconciliationRequired,
    enforcementCurrent: currentEnforcement(doc) };
}
function sameReference(a: VaultRecordReference, b: VaultRecordReference): boolean {
  return a.recordId === b.recordId && a.version === b.version && a.digest === b.digest && a.epoch === b.epoch;
}
function requirePolicyReference(current: CardinalPolicyView | null, expected: VaultRecordReference | null): void {
  if (!(current === null && expected === null || current && expected && sameReference(current.reference, expected))) {
    throw new VaultRecordConflictError('The active Cardinal Rule policy changed. Review the current policy again.');
  }
}

/** Internal evaluation of an authenticated current snapshot. Emits references,
 * never protected wording/model advice. It still grants no execution authority. */
export function evaluateCardinalPolicyRecord(record: VaultRecordValue, facts: CardinalActionFacts): CardinalPolicyDecision {
  const { document, enforcementCurrent } = decode(record, false);
  if (!enforcementCurrent) {
    return { verdict: 'pause', code: 'requires_revalidation', policy: record.reference, rules: [] };
  }
  const decision = evaluateCardinalRules(document.rules.map(r => r.definition), facts);
  const matches = new Set(decision.reasons.flatMap(r => r.ruleIndex === null ? [] : [r.ruleIndex]));
  return { verdict: decision.verdict, code: 'evaluated', policy: record.reference,
    rules: [...matches].map(index => document.rules[index].source) };
}
export function cardinalActivationBinding(args: { draft: VaultRecordReference; policy: VaultRecordReference | null }): CardinalPolicyCommand {
  return { purpose: 'cardinal.activate', requestDigest: cardinalContentDigest({ draft: args.draft, policy: args.policy }) };
}
export function cardinalRetirementBinding(args: { ruleId: string; policy: VaultRecordReference }): CardinalPolicyCommand {
  return { purpose: 'cardinal.retire', requestDigest: cardinalContentDigest({ ruleId: args.ruleId, policy: args.policy }) };
}

export class CardinalPolicyStore {
  constructor(private readonly backend: CardinalPolicyBackend, private readonly authority: CardinalPolicyAuthority) {}

  private async authorize(tx: Db, actorUserId: string, command: CardinalPolicyCommand): Promise<void> {
    // A function is a trusted server integration, not a JSON "human: true"
    // field. No implementation is installed in production in this checkpoint.
    if (typeof this.authority?.verifyFreshAdministrator !== 'function' || typeof this.authority?.verifyProtectedHuman !== 'function') {
      throw new VaultRecordError('Protected human confirmation is unavailable.');
    }
    const bound = Object.freeze({ ...command });
    await this.authority.verifyFreshAdministrator(tx, actorUserId, bound);
    await this.authority.verifyProtectedHuman(tx, actorUserId, bound);
  }

  async read(actorUserId: string): Promise<CardinalPolicyView | null> {
    return this.backend(actorUserId, false, async tx => { const value = await tx.readPolicy(); return value ? decode(value, tx.reconciliationRequired) : null; });
  }

  async activate(args: { actorUserId: string; draft: VaultRecordReference; policy: VaultRecordReference | null }): Promise<CardinalPolicyView> {
    const snapshot = structuredClone(args), command = cardinalActivationBinding(snapshot);
    return this.backend(snapshot.actorUserId, true, async tx => {
      const root = await tx.readPolicy(), current = root ? decode(root, tx.reconciliationRequired) : null;
      requirePolicyReference(current, snapshot.policy);
      if (current && !current.enforcementCurrent) {
        throw new VaultRecordError('Active rules require enforcement revalidation.');
      }
      const draft = await tx.readDraft(snapshot.draft);
      let saved: CardinalDraftDocument;
      try { saved = JSON.parse(draft.value.reveal()) as CardinalDraftDocument; } catch { throw new VaultRecordError('The tested rule draft is invalid.'); }
      const parsed = validateCardinalRule(saved?.draft), tested = saved?.tested;
      if (draft.kind !== 'cardinal_draft' || saved?.schemaVersion !== 1 || !parsed.valid || !tested
        || tested.report?.status !== 'passed' || tested.report.semanticsVersion !== CARDINAL_SEMANTICS_VERSION
        || tested.report.suiteVersion !== CARDINAL_TEST_VERSION
        || cardinalContentDigest(tested.report) !== cardinalContentDigest(testCardinalRule(saved.draft))
        || tested.review?.status !== 'available' || !isCardinalMeaningAssessment(tested.review.assessment)
        || !tested.reviewer || typeof tested.reviewer.providerId !== 'string' || typeof tested.reviewer.model !== 'string'
        || typeof tested.reviewer.configurationVersion !== 'string') {
        throw new VaultRecordError('Test this exact supported rule again before making it permanent.');
      }
      // Advisory concerns remain visible. Neither favorable nor unfavorable
      // model wording decides activation. The human confirms this exact record.
      const [model] = await tx.tx.query<{ provider: string; model: string; updated_at: string }>(
        `select provider,model,updated_at::text as updated_at from llm_providers where role='primary' and activated_at is not null for share`);
      if (!model || model.provider !== tested.reviewer.providerId || model.model !== tested.reviewer.model || model.updated_at !== tested.reviewer.configurationVersion) {
        throw new VaultRecordError('The selected review model changed. Test this rule again.');
      }
      const rules = current ? [...current.document.rules] : [];
      const entry: CardinalActiveRule = { ruleId: draft.reference.recordId,
        source: { recordId: draft.reference.recordId, version: draft.reference.version, digest: draft.reference.digest },
        definition: parsed.rule, tested };
      const index = rules.findIndex(r => r.ruleId === entry.ruleId);
      if (index === -1) rules.push(entry); else rules[index] = entry;
      if (rules.length > 100) throw new VaultRecordError('This policy has reached the supported rule count.');
      await this.authorize(tx.tx, snapshot.actorUserId, command);
      const document: CardinalPolicyDocument = { schemaVersion: 1, enforcementVersion: CARDINAL_ENFORCEMENT_VERSION, rules,
        lastChange: { operation: 'activate', ruleId: entry.ruleId, actorUserId: snapshot.actorUserId, at: new Date().toISOString() } };
      const reference = await tx.writePolicy(new Secret(JSON.stringify(document)));
      return { reference, document, reconciliationRequired: false, enforcementCurrent: true };
    });
  }

  async retire(args: { actorUserId: string; ruleId: string; policy: VaultRecordReference }): Promise<CardinalPolicyView> {
    const snapshot = structuredClone(args), command = cardinalRetirementBinding(snapshot);
    return this.backend(snapshot.actorUserId, true, async tx => {
      const root = await tx.readPolicy(), current = root ? decode(root, tx.reconciliationRequired) : null;
      requirePolicyReference(current, snapshot.policy);
      if (!current?.document.rules.some(r => r.ruleId === snapshot.ruleId)) throw new VaultRecordError('The active Cardinal Rule was not found.');
      await this.authorize(tx.tx, snapshot.actorUserId, command);
      const document: CardinalPolicyDocument = { ...current.document, rules: current.document.rules.filter(r => r.ruleId !== snapshot.ruleId),
        lastChange: { operation: 'retire', ruleId: snapshot.ruleId, actorUserId: snapshot.actorUserId, at: new Date().toISOString() } };
      const reference = await tx.writePolicy(new Secret(JSON.stringify(document)));
      return { reference, document, reconciliationRequired: false, enforcementCurrent: currentEnforcement(document) };
    });
  }
}
