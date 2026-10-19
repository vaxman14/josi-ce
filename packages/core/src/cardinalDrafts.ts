// P3 draft/review/simulation storage. There is deliberately no activation API
// in this checkpoint: a future protected human confirmation boundary must
// consume the exact reviewed version, never this model's opinion.
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { Secret } from './sealing.js';
import { vaultRecords, VaultRecordError, type VaultRecordReference } from './vault.js';
import { CARDINAL_RULE_GUIDANCE, explainCardinalRule, testCardinalRule, validateCardinalRule,
  cardinalContentDigest, type CardinalRule, type CardinalTestReport } from './cardinalRules.js';

export interface CardinalMeaningAssessment {
  clarity: 'clear' | 'needs_clarification';
  summary: string;
  concerns: string[];
  suggestions: string[];
}
export type CardinalMeaningReview = { status: 'available'; assessment: CardinalMeaningAssessment }
  | { status: 'unavailable' | 'invalid_response'; message: string };
export interface CardinalReviewInput { wording: string; structuredMeaning: string; guidance: string }
export type CardinalReviewer = (input: CardinalReviewInput) => Promise<CardinalMeaningReview>;
export interface CardinalDraftDocument {
  schemaVersion: 1;
  draft: unknown;
  tested: null | { report: CardinalTestReport; review: CardinalMeaningReview; testedAt: string;
    /** Provider identity only, never configuration or credentials. */
    reviewer: { providerId: string; model: string; configurationVersion: string } };
}
export interface CardinalDraftView { reference: VaultRecordReference; document: CardinalDraftDocument }

function encoded(value: unknown): string {
  let raw: string | undefined;
  try { raw = JSON.stringify(value); } catch { throw new VaultRecordError('The rule draft is not valid JSON.'); }
  if (!raw || Buffer.byteLength(raw) > 64 * 1024) throw new VaultRecordError('The rule draft is empty or too large.');
  return raw;
}
function documentFrom(value: Secret): CardinalDraftDocument {
  let doc: CardinalDraftDocument;
  try { doc = JSON.parse(value.reveal()) as CardinalDraftDocument; }
  catch { throw new VaultRecordError('Unsupported Cardinal Rule draft.'); }
  if (!doc || doc.schemaVersion !== 1 || !Object.hasOwn(doc, 'draft') || !Object.hasOwn(doc, 'tested')) {
    throw new VaultRecordError('Unsupported Cardinal Rule draft.');
  }
  return doc;
}

/** Only structured scope IDs are minimized. The UI must show and authorize
 * sending the wording itself: arbitrary prose cannot reliably be scrubbed of
 * secrets. No other Vault records, conversation, tools or task context go to
 * the review model. Cardinal Rules do not become model instructions. */
export function cardinalReviewInput(rule: CardinalRule): CardinalReviewInput {
  const minimized = structuredClone(rule);
  let sequence = 0;
  for (const key of Object.keys(minimized.scope) as Array<keyof CardinalRule['scope']>) {
    const selector = minimized.scope[key];
    if (selector !== '*') selector.ids = selector.ids.map(() => `selected-${key}-${++sequence}`);
  }
  return { wording: rule.wording, structuredMeaning: explainCardinalRule(minimized), guidance: CARDINAL_RULE_GUIDANCE };
}

export function isCardinalMeaningAssessment(value: unknown): value is CardinalMeaningAssessment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = ['clarity', 'summary', 'concerns', 'suggestions'];
  const text = (s: unknown) => typeof s === 'string' && s.trim().length > 0 && s.length <= 2400
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
  return Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
    && (v.clarity === 'clear' || v.clarity === 'needs_clarification') && text(v.summary)
    && Array.isArray(v.concerns) && v.concerns.length <= 8 && v.concerns.every(text)
    && Array.isArray(v.suggestions) && v.suggestions.length <= 8 && v.suggestions.every(text);
}

export class CardinalDraftStore {
  private readonly records;
  constructor(db: Db, key: MasterKey) { this.records = vaultRecords(db, key); }

  async read(args: { actorUserId: string; recordId: string; expected?: VaultRecordReference }): Promise<CardinalDraftView> {
    const value = await this.records.read(args);
    if (value.kind !== 'cardinal_draft') throw new VaultRecordError('Cardinal Rule draft not found.');
    return { reference: value.reference, document: documentFrom(value.value) };
  }

  async save(args: { actorUserId: string; draft: unknown; expected?: VaultRecordReference }): Promise<CardinalDraftView> {
    // Round-trip to sever caller aliases before any async work. Invalid or
    // unfinished JSON drafts can be saved, but can never pass deterministic tests.
    const draft: unknown = JSON.parse(encoded(args.draft));
    const actorUserId = args.actorUserId, expected = args.expected ? { ...args.expected } : undefined;
    if (expected) await this.read({ actorUserId, recordId: expected.recordId, expected });
    const document: CardinalDraftDocument = { schemaVersion: 1, draft, tested: null };
    const reference = await this.records.write({ actorUserId, kind: 'cardinal_draft',
      value: new Secret(encoded(document)), expected });
    return { reference, document };
  }

  async test(args: { actorUserId: string; expected: VaultRecordReference; reviewer: CardinalReviewer;
    reviewerIdentity: { providerId: string; model: string; configurationVersion: string };
    /** Exact preview approved through the protected UI. This is not authority
     * to activate anything, and must not be populated from an automation body. */
    approvedReviewInputDigest: string;
  }): Promise<CardinalDraftView> {
    const actorUserId = args.actorUserId, expected = { ...args.expected }, reviewer = args.reviewer;
    const identity = { ...args.reviewerIdentity }, approvedDigest = args.approvedReviewInputDigest;
    if (![identity.providerId, identity.model, identity.configurationVersion].every(v => typeof v === 'string' && v.length > 0 && v.length <= 300)) {
      throw new VaultRecordError('The selected review model is unavailable.');
    }
    const { document } = await this.read({ actorUserId, recordId: expected.recordId, expected });
    const report = testCardinalRule(document.draft);
    const parsed = validateCardinalRule(document.draft);
    let review: CardinalMeaningReview = { status: 'unavailable', message: 'Complete the supported structured rule before requesting a meaning review.' };
    if (parsed.valid) {
      const input = cardinalReviewInput(parsed.rule);
      if (cardinalContentDigest(input) !== approvedDigest) throw new VaultRecordError('Confirm the exact model review preview again.');
      try {
        const result = await reviewer(input);
        review = result?.status === 'available' && isCardinalMeaningAssessment(result.assessment)
          ? { status: 'available', assessment: structuredClone(result.assessment) }
          : result?.status === 'invalid_response' || result?.status === 'available'
            ? { status: 'invalid_response', message: 'The model returned an unusable meaning review. No approval was recorded.' }
            : { status: 'unavailable', message: 'The selected model could not provide a meaning review.' };
      } catch {
        // Provider errors can contain request contents or keys. They are neither
        // audit payloads nor user-facing review text.
        review = { status: 'unavailable', message: 'The selected model could not provide a meaning review.' };
      }
    }
    const next: CardinalDraftDocument = { ...document, tested: { report, review, testedAt: new Date().toISOString(), reviewer: {
      providerId: identity.providerId, model: identity.model, configurationVersion: identity.configurationVersion,
    } } };
    // Live role, lock, epoch, recovery and exact version are checked again after
    // the external call. A late review cannot attach to a newer draft.
    const reference = await this.records.write({ actorUserId, kind: 'cardinal_draft', expected,
      value: new Secret(encoded(next)) });
    return { reference, document: next };
  }
}
