// Permanent policy changes are separate from drafts/model advice. The storage
// bridge below is supplied by the existing Vault; no second key/store exists.
import type { Db } from './db.js';
import { parseProtectedControlPresentation, type ProtectedControlPresentation } from '@josi-ce/protocol';
import { isCardinalMeaningAssessment, type CardinalDraftDocument } from './cardinalDrafts.js';
import { cardinalContentDigest, CARDINAL_SEMANTICS_VERSION, CARDINAL_TEST_VERSION, testCardinalRule,
  validateCardinalRule, evaluateCardinalRules, explainCardinalRule, type CardinalRule, type CardinalActionFacts, type CardinalDecision } from './cardinalRules.js';
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
export interface CardinalProtectedReview { command: CardinalPolicyCommand; presentation: ProtectedControlPresentation }
export interface CardinalActivationRequest { actorUserId: string; draft: VaultRecordReference; policy: VaultRecordReference | null }
export interface CardinalRetirementRequest { actorUserId: string; ruleId: string; policy: VaultRecordReference }
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
  verifyProtectedHuman(tx: Db, actorUserId: string, command: CardinalPolicyCommand, presentation: ProtectedControlPresentation): Promise<void>;
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

async function activationContents(tx: CardinalPolicyTransaction, snapshot: CardinalActivationRequest) {
  if (tx.reconciliationRequired) throw new VaultRecordError('Vault authority requires recovery reconciliation.');
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
  return { current, entry, rules };
}

function checkedPresentation(wording: string, meaning: string, advisory: string[]): ProtectedControlPresentation {
  const presentation = parseProtectedControlPresentation({ wording, meaning, advisory });
  if (!presentation) throw new VaultRecordError('The complete rule review cannot be safely displayed. Correct unsupported text or oversized content before confirmation.');
  return presentation;
}
function ruleAdvisory(entry: CardinalActiveRule): string[] {
  const review = entry.tested.review;
  if (review.status !== 'available' || !isCardinalMeaningAssessment(review.assessment)) throw new VaultRecordError('The saved rule review is unavailable.');
  const advice = review.assessment;
  return [`Model clarity assessment: ${advice.clarity}. Advice only; administrator confirmation is required.`,
    advice.summary, ...advice.concerns.map(text => `Concern: ${text}`), ...advice.suggestions.map(text => `Suggestion: ${text}`)];
}
function activationPresentation(current: CardinalPolicyView | null, entry: CardinalActiveRule): ProtectedControlPresentation {
  const previous = current?.document.rules.find(r => r.ruleId === entry.ruleId);
  const meaning = [`${previous ? 'Replace' : 'Make permanent'} rule ${entry.ruleId}. Label: ${entry.definition.label}.`,
    `New enforcement:\n${explainCardinalRule(entry.definition)}`,
    ...(previous ? [`Previous wording:\n${previous.definition.wording}`, `Previous enforcement:\n${explainCardinalRule(previous.definition)}`] : []),
    'All other active Cardinal Rules remain in force. Ordinary permissions and device consent are still required.',
    'The deterministic rule simulation passed. Runtime adapter acceptance is checked separately.'].join('\n\n');
  return checkedPresentation(entry.definition.wording, meaning, ruleAdvisory(entry));
}
function retirementPresentation(entry: CardinalActiveRule): ProtectedControlPresentation {
  const meaning = `Retire rule ${entry.ruleId}. Label: ${entry.definition.label}.\n\nRemove this restriction:\n${explainCardinalRule(entry.definition)}\n\nThis rule will no longer restrict future actions. All other active Cardinal Rules remain in force. Ordinary permissions and device consent are still required.`;
  return checkedPresentation(entry.definition.wording, meaning, ruleAdvisory(entry));
}
async function retirementContents(tx: CardinalPolicyTransaction, snapshot: CardinalRetirementRequest) {
  if (tx.reconciliationRequired) throw new VaultRecordError('Vault authority requires recovery reconciliation.');
  const root = await tx.readPolicy(), current = root ? decode(root, false) : null;
  requirePolicyReference(current, snapshot.policy);
  const entry = current?.document.rules.find(r => r.ruleId === snapshot.ruleId);
  if (!current || !entry) throw new VaultRecordError('The active Cardinal Rule was not found.');
  if (!current.enforcementCurrent) throw new VaultRecordError('Active rules require enforcement revalidation.');
  return { current, entry };
}

export class CardinalPolicyStore {
  constructor(private readonly backend: CardinalPolicyBackend, private readonly authority: CardinalPolicyAuthority) {}

  private async authorize(tx: Db, actorUserId: string, command: CardinalPolicyCommand, presentation: ProtectedControlPresentation): Promise<void> {
    // A function is a trusted server integration, not a JSON "human: true"
    // field. No implementation is installed in production in this checkpoint.
    if (typeof this.authority?.verifyFreshAdministrator !== 'function' || typeof this.authority?.verifyProtectedHuman !== 'function') {
      throw new VaultRecordError('Protected human confirmation is unavailable.');
    }
    const bound = Object.freeze({ ...command });
    await this.authority.verifyFreshAdministrator(tx, actorUserId, bound);
    await this.authority.verifyProtectedHuman(tx, actorUserId, bound, presentation);
  }

  async read(actorUserId: string): Promise<CardinalPolicyView | null> {
    return this.backend(actorUserId, false, async tx => { const value = await tx.readPolicy(); return value ? decode(value, tx.reconciliationRequired) : null; });
  }

  /** Read-only command preparation from exact current Vault records. The same
   * validation runs again on mutation. No model/renderer supplies this meaning,
   * and preparing a review neither changes authority nor consumes a proof. */
  async prepareActivation(args: CardinalActivationRequest): Promise<CardinalProtectedReview> {
    const snapshot = structuredClone(args);
    return this.backend(snapshot.actorUserId, false, async tx => {
      const { current, entry } = await activationContents(tx, snapshot);
      return { command: cardinalActivationBinding(snapshot), presentation: activationPresentation(current, entry) };
    });
  }
  async prepareRetirement(args: CardinalRetirementRequest): Promise<CardinalProtectedReview> {
    const snapshot = structuredClone(args);
    return this.backend(snapshot.actorUserId, false, async tx => {
      const { entry } = await retirementContents(tx, snapshot);
      return { command: cardinalRetirementBinding(snapshot), presentation: retirementPresentation(entry) };
    });
  }

  async activate(args: CardinalActivationRequest): Promise<CardinalPolicyView> {
    const snapshot = structuredClone(args), command = cardinalActivationBinding(snapshot);
    return this.backend(snapshot.actorUserId, true, async tx => {
      const { current, entry, rules } = await activationContents(tx, snapshot);
      await this.authorize(tx.tx, snapshot.actorUserId, command, activationPresentation(current, entry));
      const document: CardinalPolicyDocument = { schemaVersion: 1, enforcementVersion: CARDINAL_ENFORCEMENT_VERSION, rules,
        lastChange: { operation: 'activate', ruleId: entry.ruleId, actorUserId: snapshot.actorUserId, at: new Date().toISOString() } };
      const reference = await tx.writePolicy(new Secret(JSON.stringify(document)));
      return { reference, document, reconciliationRequired: false, enforcementCurrent: true };
    });
  }

  async retire(args: CardinalRetirementRequest): Promise<CardinalPolicyView> {
    const snapshot = structuredClone(args), command = cardinalRetirementBinding(snapshot);
    return this.backend(snapshot.actorUserId, true, async tx => {
      const { current, entry } = await retirementContents(tx, snapshot);
      await this.authorize(tx.tx, snapshot.actorUserId, command, retirementPresentation(entry));
      const document: CardinalPolicyDocument = { ...current.document, rules: current.document.rules.filter(r => r.ruleId !== snapshot.ruleId),
        lastChange: { operation: 'retire', ruleId: snapshot.ruleId, actorUserId: snapshot.actorUserId, at: new Date().toISOString() } };
      const reference = await tx.writePolicy(new Secret(JSON.stringify(document)));
      return { reference, document, reconciliationRequired: false, enforcementCurrent: currentEnforcement(document) };
    });
  }
}
