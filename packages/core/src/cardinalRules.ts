// Cardinal Rules only restrict authority. A `no_restriction` result is never
// permission to execute: identity, ordinary grants, current Vault authority and
// the device's verified effect boundary are separate mandatory gates (P4).
import { createHash } from 'node:crypto';
import { AUTOMATION_EFFECTS } from '@josi-ce/protocol';

export const CARDINAL_RULE_GUIDANCE = 'Cardinal Rules must be explicit and enforceable. Specify exactly what is allowed or forbidden, where it applies, and any limits. Statements such as “do no harm” or “make good decisions” cannot be Cardinal Rules.';
export const CARDINAL_SEMANTICS_VERSION = 'cardinal-semantics.1';
export const CARDINAL_TEST_VERSION = 'cardinal-simulator.1';
export const CARDINAL_ACTIONS = AUTOMATION_EFFECTS;
export type CardinalAction = typeof CARDINAL_ACTIONS[number];
export const CARDINAL_SCOPE_KEYS = ['userId', 'serverId', 'deviceId', 'workspaceId', 'taskId'] as const;
export type CardinalScopeKey = typeof CARDINAL_SCOPE_KEYS[number];
export type CardinalSelector = '*' | { ids: string[] };
export interface CardinalRule {
  schemaVersion: 1;
  label: string;
  /** Admin wording is annotation. Only the structured fields have executable meaning. */
  wording: string;
  actions: '*' | CardinalAction[];
  scope: Record<CardinalScopeKey, CardinalSelector>;
  restriction: { kind: 'deny' } | { kind: 'maximum_task_duration'; seconds: number };
  onUnavailable: 'deny' | 'pause';
}
export interface CardinalIssue { field: string; code: 'required' | 'invalid' | 'unsupported'; message: string }
export type CardinalValidation = { valid: true; rule: CardinalRule; issues: [] } | { valid: false; issues: CardinalIssue[] };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const actionSet = new Set<string>(CARDINAL_ACTIONS);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k))
  && keys.every(k => Object.hasOwn(v, k));
const boundedText = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);

/** Do not infer defaults, expand globs, fix spelling or ignore unknown fields.
 * Unsupported constraints remain unsupported, even if an LLM says otherwise. */
export function validateCardinalRule(value: unknown): CardinalValidation {
  const issues: CardinalIssue[] = [];
  const add = (field: string, code: CardinalIssue['code'], message: string) => issues.push({ field, code, message });
  if (!object(value)) return { valid: false, issues: [{ field: 'rule', code: 'required', message: 'An explicit structured rule is required.' }] };
  if (!exactKeys(value, ['schemaVersion', 'label', 'wording', 'actions', 'scope', 'restriction', 'onUnavailable'])) {
    add('rule', 'unsupported', 'Use exactly the supported rule fields; extra conditions cannot be ignored.');
  }
  if (value.schemaVersion !== 1) add('schemaVersion', 'unsupported', 'This rule schema version is not supported.');
  if (!boundedText(value.label, 120)) add('label', 'invalid', 'Provide a label of 1–120 characters.');
  if (!boundedText(value.wording, 4000)) add('wording', 'invalid', 'Provide wording of 1–4,000 characters.');
  if (value.actions !== '*' && (!Array.isArray(value.actions) || !value.actions.length
    || value.actions.length > CARDINAL_ACTIONS.length || value.actions.some(v => typeof v !== 'string' || !actionSet.has(v))
    || new Set(value.actions).size !== value.actions.length)) {
    add('actions', 'unsupported', 'Select exact supported actions, or explicitly select every action.');
  }
  if (!object(value.scope) || !exactKeys(value.scope, CARDINAL_SCOPE_KEYS)) {
    add('scope', 'required', 'Specify user, server, device, workspace and task scope explicitly.');
  } else for (const name of CARDINAL_SCOPE_KEYS) {
    const s = value.scope[name];
    if (s !== '*' && (!object(s) || !exactKeys(s, ['ids']) || !Array.isArray(s.ids) || !s.ids.length || s.ids.length > 100
      || s.ids.some(v => typeof v !== 'string' || !uuid.test(v)) || new Set(s.ids).size !== s.ids.length)) {
      add(`scope.${name}`, 'invalid', 'Use exact lowercase identity IDs, or explicitly select every identity. Names and patterns are not identities.');
    }
  }
  const r = value.restriction;
  if (!object(r) || !(r.kind === 'deny' && exactKeys(r, ['kind'])
    || r.kind === 'maximum_task_duration' && exactKeys(r, ['kind', 'seconds']) && Number.isSafeInteger(r.seconds)
      && Number(r.seconds) >= 1 && Number(r.seconds) <= 31_536_000)) {
    add('restriction', 'unsupported', 'Supported restrictions are denial and an exact task duration of 1–31,536,000 seconds. Other business constraints need a verified adapter.');
  }
  if (value.onUnavailable !== 'deny' && value.onUnavailable !== 'pause') add('onUnavailable', 'required', 'Choose Deny or Pause when required facts cannot be verified.');
  return issues.length ? { valid: false, issues } : { valid: true, rule: structuredClone(value) as unknown as CardinalRule, issues: [] };
}

/** These facts must come from authenticated device/server adapters. This type
 * does not authenticate them. Never pass request-body or LLM assertions here as
 * proof. Unknown business effects of a generic UI action are incomplete. */
export interface CardinalActionFacts {
  effects: readonly string[];
  effectCoverage: 'verified' | 'incomplete';
  identities: Partial<Record<CardinalScopeKey, string>>;
  /** Trusted elapsed time for the original durable task, not this retry. */
  taskElapsedMs?: number;
}
export type CardinalVerdict = 'no_restriction' | 'deny' | 'pause';
export interface CardinalDecision {
  verdict: CardinalVerdict;
  reasons: Array<{ ruleIndex: number | null; code: 'explicit_denial' | 'duration_limit' | 'facts_unavailable' | 'invalid_rule' | 'unverified_effects' | 'human_only' }>;
}

function scopeMatch(rule: CardinalRule, facts: CardinalActionFacts): 'match' | 'outside' | 'unknown' {
  let unknown = false;
  for (const name of CARDINAL_SCOPE_KEYS) {
    const selector = rule.scope[name];
    if (selector === '*') continue;
    const actual = facts.identities[name];
    if (typeof actual !== 'string' || !uuid.test(actual)) unknown = true;
    else if (!selector.ids.includes(actual)) return 'outside';
  }
  return unknown ? 'unknown' : 'match';
}

export function evaluateCardinalRules(rules: readonly unknown[], facts: CardinalActionFacts): CardinalDecision {
  const reasons: CardinalDecision['reasons'] = [];
  let denied = false, paused = false;
  const usable = object(facts) && Array.isArray(facts.effects) && facts.effects.length > 0
    && facts.effects.length <= CARDINAL_ACTIONS.length && facts.effects.every(v => typeof v === 'string' && actionSet.has(v))
    && new Set(facts.effects).size === facts.effects.length && object(facts.identities);
  if (!usable) return { verdict: 'pause', reasons: [{ ruleIndex: null, code: 'unverified_effects' }] };
  if (facts.effectCoverage !== 'verified') { paused = true; reasons.push({ ruleIndex: null, code: 'unverified_effects' }); }
  if (facts.effects.some(e => e === 'authority.modify' || e === 'vault.manage')) {
    denied = true; reasons.push({ ruleIndex: null, code: 'human_only' });
  }
  rules.forEach((value, ruleIndex) => {
    const parsed = validateCardinalRule(value);
    if (!parsed.valid) { paused = true; reasons.push({ ruleIndex, code: 'invalid_rule' }); return; }
    const rule = parsed.rule;
    // An incomplete effect list cannot prove that a restriction is irrelevant.
    const matchesAction = rule.actions === '*' || facts.effects.some(e => rule.actions.includes(e as CardinalAction));
    const scope = scopeMatch(rule, facts);
    if (scope === 'outside' || (!matchesAction && facts.effectCoverage === 'verified')) return;
    const unavailable = () => { if (rule.onUnavailable === 'deny') denied = true; else paused = true; reasons.push({ ruleIndex, code: 'facts_unavailable' }); };
    if (scope === 'unknown' || !matchesAction) { unavailable(); return; }
    if (rule.restriction.kind === 'deny') { denied = true; reasons.push({ ruleIndex, code: 'explicit_denial' }); return; }
    const elapsed = facts.taskElapsedMs;
    if (!Number.isSafeInteger(elapsed) || Number(elapsed) < 0) { unavailable(); return; }
    if (Number(elapsed) >= rule.restriction.seconds * 1000) { denied = true; reasons.push({ ruleIndex, code: 'duration_limit' }); }
  });
  return { verdict: denied ? 'deny' : paused ? 'pause' : 'no_restriction', reasons };
}

// Hashes stay inside encrypted records. They pin the exact text and structure;
// public audit/index rows use the Vault record's ciphertext digest instead.
export function cardinalContentDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Exact machine meaning for the human confirmation view. No model-generated
 * paraphrase can replace these fields or change their unit/boundary. */
export function explainCardinalRule(rule: CardinalRule): string {
  const action = rule.actions === '*' ? 'every supported action' : rule.actions.join(', ');
  const scope = CARDINAL_SCOPE_KEYS.map(k => `${k}: ${rule.scope[k] === '*' ? 'all' : rule.scope[k].ids.join(', ')}`).join('; ');
  const restriction = rule.restriction.kind === 'deny' ? `Deny ${action}`
    : `Deny ${action} when the original task's verified elapsed time is greater than or equal to ${rule.restriction.seconds} seconds`;
  return `${restriction}. Scope: ${scope}. If required facts are unavailable: ${rule.onUnavailable}. This rule grants no permission.`;
}

export interface CardinalTestCase { id: string; expected: CardinalVerdict; actual: CardinalVerdict; passed: boolean }
export interface CardinalTestReport {
  contentDigest: string; semanticsVersion: string; suiteVersion: string;
  status: 'passed' | 'needs_clarification' | 'unsupported' | 'failed';
  issues: CardinalIssue[]; cases: CardinalTestCase[];
  /** Simulation is never proof that a browser/native executor implements it. */
  executionEnabled: false;
}
const fixtureId = '00000000-0000-4000-8000-000000000001';
const otherId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** Pure simulation: no tools, network, files, provider or device calls. */
export function testCardinalRule(value: unknown): CardinalTestReport {
  const parsed = validateCardinalRule(value);
  const report: CardinalTestReport = { contentDigest: cardinalContentDigest(value), semanticsVersion: CARDINAL_SEMANTICS_VERSION,
    suiteVersion: CARDINAL_TEST_VERSION, status: 'passed', issues: parsed.issues, cases: [], executionEnabled: false };
  if (!parsed.valid) {
    report.status = parsed.issues.some(v => v.code === 'unsupported') ? 'unsupported' : 'needs_clarification';
    return report;
  }
  const rule = parsed.rule;
  const effect = rule.actions === '*' ? 'file.read' : rule.actions[0];
  const identities = Object.fromEntries(CARDINAL_SCOPE_KEYS.map(k => [k, rule.scope[k] === '*' ? fixtureId : rule.scope[k].ids[0]]));
  const facts: CardinalActionFacts = { effects: [effect], effectCoverage: 'verified', identities, taskElapsedMs: 0 };
  const humanOnly = effect === 'authority.modify' || effect === 'vault.manage';
  const baseline: CardinalVerdict = humanOnly || rule.restriction.kind === 'deny' ? 'deny' : 'no_restriction';
  const check = (id: string, candidate: CardinalActionFacts, expected: CardinalVerdict, rules: unknown[] = [rule]) => {
    const actual = evaluateCardinalRules(rules, candidate).verdict;
    report.cases.push({ id, expected, actual, passed: expected === actual });
  };
  check('matching_action', facts, baseline);
  for (const selected of rule.actions === '*' ? CARDINAL_ACTIONS : rule.actions) {
    const isHumanOnly = selected === 'authority.modify' || selected === 'vault.manage';
    check(`selected_${selected}`, { ...facts, effects: [selected] }, isHumanOnly || rule.restriction.kind === 'deny' ? 'deny' : 'no_restriction');
    if (rule.restriction.kind === 'maximum_task_duration') {
      check(`boundary_${selected}`, { ...facts, effects: [selected], taskElapsedMs: rule.restriction.seconds * 1000 }, 'deny');
    }
  }
  check('unknown_effect', { ...facts, effects: ['unknown.operation'] }, 'pause');
  check('empty_effects', { ...facts, effects: [] }, 'pause');
  check('incomplete_effects', { ...facts, effectCoverage: 'incomplete' }, baseline === 'deny' ? 'deny' : 'pause');
  // A caller cannot label a generic click as harmless and omit other effects.
  check('alternate_route_unclassified', { ...facts, effects: ['computer.interact'], effectCoverage: 'incomplete' },
    rule.actions === '*' || rule.actions.includes('computer.interact')
      ? rule.restriction.kind === 'deny' ? 'deny' : 'pause'
      : rule.onUnavailable);
  check('denial_wins', facts, 'deny', [rule, { ...rule, restriction: { kind: 'deny' } }]);
  check('human_only_authority', { ...facts, effects: ['authority.modify'] }, 'deny');
  check('human_only_vault', { ...facts, effects: ['vault.manage'] }, 'deny');
  if (rule.restriction.kind === 'maximum_task_duration') {
    const threshold = rule.restriction.seconds * 1000;
    check('below_duration', { ...facts, taskElapsedMs: threshold - 1 }, humanOnly ? 'deny' : 'no_restriction');
    check('exact_duration', { ...facts, taskElapsedMs: threshold }, 'deny');
    check('above_duration', { ...facts, taskElapsedMs: threshold + 1 }, 'deny');
    for (const [id, elapsed] of [['missing_duration', undefined], ['negative_duration', -1], ['invalid_duration', NaN], ['overflow_duration', Number.MAX_SAFE_INTEGER + 1]] as const) {
      check(id, { ...facts, taskElapsedMs: elapsed }, humanOnly ? 'deny' : rule.onUnavailable);
    }
  }
  for (const name of CARDINAL_SCOPE_KEYS) {
    const selector = rule.scope[name];
    if (selector === '*') continue;
    const missing = { ...identities }; delete missing[name];
    check(`missing_${name}`, { ...facts, identities: missing }, humanOnly ? 'deny' : rule.onUnavailable);
    let different = otherId, suffix = 0;
    while (selector.ids.includes(different)) different = `eeeeeeee-eeee-4eee-8eee-${String(++suffix).padStart(12, '0')}`;
    check(`outside_${name}`, { ...facts, identities: { ...identities, [name]: different } }, humanOnly ? 'deny' : 'no_restriction');
  }
  if (rule.actions !== '*') {
    const outside = CARDINAL_ACTIONS.find(a => !rule.actions.includes(a) && a !== 'authority.modify' && a !== 'vault.manage');
    if (outside) check('unaffected_action', { ...facts, effects: [outside] }, 'no_restriction');
  }
  if (report.cases.some(c => !c.passed)) report.status = 'failed';
  return report;
}
