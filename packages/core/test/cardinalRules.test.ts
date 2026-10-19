import { describe, expect, it } from 'vitest';
import { CARDINAL_ACTIONS, CARDINAL_SCOPE_KEYS, cardinalContentDigest, evaluateCardinalRules, explainCardinalRule,
  testCardinalRule, validateCardinalRule, type CardinalActionFacts, type CardinalRule } from '../src/cardinalRules.js';

export const identity = '11111111-1111-4111-8111-111111111111';
export const elsewhere = '22222222-2222-4222-8222-222222222222';
export const rule = (): CardinalRule => ({ schemaVersion: 1, label: 'No terminal', wording: 'Do not run shell commands.',
  actions: ['execution.shell'], scope: { userId: '*', serverId: '*', deviceId: '*', workspaceId: '*', taskId: '*' },
  restriction: { kind: 'deny' }, onUnavailable: 'pause' });
const facts = (extra: Partial<CardinalActionFacts> = {}): CardinalActionFacts => ({ effects: ['execution.shell'],
  effectCoverage: 'verified', identities: { userId: identity, serverId: identity, deviceId: identity, workspaceId: identity, taskId: identity }, ...extra });

describe('explicit Cardinal Rule semantics', () => {
  it('accepts only complete supported structure, never prose alone or guessed meaning', () => {
    expect(validateCardinalRule('do no harm').valid).toBe(false);
    expect(validateCardinalRule({ wording: 'make good decisions' }).valid).toBe(false);
    expect(validateCardinalRule(rule()).valid).toBe(true);
    const withBudget = { ...rule(), spendingLimit: 10 };
    expect(validateCardinalRule(withBudget)).toMatchObject({ valid: false, issues: [{ field: 'rule', code: 'unsupported' }] });
    expect(validateCardinalRule({ ...rule(), restriction: { kind: 'spend_limit', dollars: 5 } }).valid).toBe(false);
    expect(validateCardinalRule({ ...rule(), onUnavailable: 'allow' }).valid).toBe(false);
  });

  it.each([
    { schemaVersion: 2 }, { actions: [] }, { actions: ['execution.*'] }, { actions: ['file.delete', 'file.delete'] },
    { scope: {} }, { label: '' }, { wording: 'x'.repeat(4001) }, { wording: 'bad\u0000text' },
    { restriction: { kind: 'deny', exceptAdmins: true } }, { restriction: { kind: 'maximum_task_duration', seconds: 0 } },
    { restriction: { kind: 'maximum_task_duration', seconds: 0.5 } }, { restriction: { kind: 'maximum_task_duration', seconds: Infinity } },
    { restriction: { kind: 'maximum_task_duration', seconds: '60' } },
  ])('refuses unsupported or ambiguous input %j', patch => {
    expect(validateCardinalRule({ ...rule(), ...patch }).valid).toBe(false);
  });

  it('does not normalize identity names, prefixes, case, empty lists or duplicated IDs', () => {
    for (const selector of [{ ids: [] }, { ids: [identity, identity] }, { ids: ['my-mac'] }, { ids: ['ABCDEFAB-1111-4111-8111-111111111111'] }, { ids: [identity], descendants: true }]) {
      const candidate = rule(); candidate.scope.deviceId = selector;
      expect(validateCardinalRule(candidate).valid).toBe(false);
    }
  });

  it('never grants permission, even when no Cardinal Rule restricts the action', () => {
    expect(evaluateCardinalRules([], facts()).verdict).toBe('no_restriction');
    expect(evaluateCardinalRules([rule()], facts({ effects: ['file.read'] })).verdict).toBe('no_restriction');
    expect(evaluateCardinalRules([rule()], facts()).verdict).toBe('deny');
    expect(evaluateCardinalRules([{ ...rule(), enabled: false }], facts()).verdict).toBe('pause');
  });

  it('checks every possible effect, including an alternate route and unknown effects', () => {
    expect(evaluateCardinalRules([rule()], facts({ effects: ['computer.interact', 'execution.shell'] })).verdict).toBe('deny');
    expect(evaluateCardinalRules([rule()], facts({ effects: ['computer.interact'], effectCoverage: 'incomplete' })).verdict).toBe('pause');
    expect(evaluateCardinalRules([rule()], facts({ effects: ['new.provider.publish'] })).verdict).toBe('pause');
    expect(evaluateCardinalRules([], facts({ effects: [], effectCoverage: 'verified' })).verdict).toBe('pause');
    expect(evaluateCardinalRules([], facts({ effects: ['file.read', 'file.read'] })).verdict).toBe('pause');
    expect(evaluateCardinalRules([], null as never).verdict).toBe('pause');
    expect(evaluateCardinalRules([rule()], facts({ identities: null as never })).verdict).toBe('pause');
  });

  it('applies exact scope and fails closed if a potentially matching identity is missing', () => {
    const specific = rule(); specific.scope.deviceId = { ids: [identity] }; specific.scope.userId = { ids: [identity] };
    expect(evaluateCardinalRules([specific], facts()).verdict).toBe('deny');
    expect(evaluateCardinalRules([specific], facts({ identities: { userId: identity } })).verdict).toBe('pause');
    expect(evaluateCardinalRules([{ ...specific, onUnavailable: 'deny' }], facts({ identities: {} })).verdict).toBe('deny');
    // Known mismatch proves this rule is out of scope even if another ID is absent.
    expect(evaluateCardinalRules([specific], facts({ identities: { deviceId: elsewhere } })).verdict).toBe('no_restriction');
    expect(evaluateCardinalRules([specific], facts({ identities: { deviceId: `${identity}-child` } })).verdict).toBe('pause');
  });

  it('uses an inclusive duration boundary and refuses missing, fractional, negative and unsafe clock facts', () => {
    const duration: CardinalRule = { ...rule(), restriction: { kind: 'maximum_task_duration', seconds: 60 } };
    expect(evaluateCardinalRules([duration], facts({ taskElapsedMs: 59_999 })).verdict).toBe('no_restriction');
    for (const elapsed of [60_000, 60_001, Number.MAX_SAFE_INTEGER]) expect(evaluateCardinalRules([duration], facts({ taskElapsedMs: elapsed })).verdict).toBe('deny');
    for (const elapsed of [undefined, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(evaluateCardinalRules([duration], facts({ taskElapsedMs: elapsed })).verdict).toBe('pause');
    expect(explainCardinalRule(duration)).toContain('greater than or equal to 60 seconds');
    expect(explainCardinalRule(duration)).toContain('original task');
  });

  it('makes denial win over incomplete facts, invalid peers and less restrictive rules', () => {
    const duration: CardinalRule = { ...rule(), restriction: { kind: 'maximum_task_duration', seconds: 60 } };
    for (const list of [[duration, rule()], [rule(), duration], [{ unsupported: true }, rule()]]) {
      expect(evaluateCardinalRules(list, facts({ effectCoverage: 'incomplete' })).verdict).toBe('deny');
    }
  });

  it('keeps protected administration human-only even with zero configured rules', () => {
    for (const effect of ['authority.modify', 'vault.manage']) expect(evaluateCardinalRules([], facts({ effects: [effect] })).verdict).toBe('deny');
  });

  it('pins all wording and fields while making object-key order immaterial', () => {
    expect(cardinalContentDigest(rule())).toBe(cardinalContentDigest({ restriction: rule().restriction, ...rule() }));
    expect(cardinalContentDigest(rule())).not.toBe(cardinalContentDigest({ ...rule(), wording: 'Something else.' }));
    expect(cardinalContentDigest(rule())).not.toBe(cardinalContentDigest({ ...rule(), onUnavailable: 'deny' }));
  });
});

describe('side-effect-free Cardinal Rule simulation', () => {
  it('tests every supported action, both unavailable modes and both restrictions', () => {
    for (const action of CARDINAL_ACTIONS) for (const unavailable of ['deny', 'pause'] as const) for (const duration of [false, true]) {
      const candidate: CardinalRule = { ...rule(), actions: [action], onUnavailable: unavailable,
        restriction: duration ? { kind: 'maximum_task_duration', seconds: 30 } : { kind: 'deny' } };
      for (const scope of CARDINAL_SCOPE_KEYS) candidate.scope[scope] = { ids: [identity] };
      const report = testCardinalRule(candidate);
      expect(report.status, JSON.stringify({ action, unavailable, duration, failed: report.cases.filter(c => !c.passed) })).toBe('passed');
      expect(report.cases.some(c => c.id === 'denial_wins')).toBe(true);
      expect(report.cases.some(c => c.id === 'outside_deviceId')).toBe(true);
      expect(report.executionEnabled).toBe(false);
    }
  });
  it('covers global rules, unsupported rules and clarification separately', () => {
    expect(testCardinalRule({ ...rule(), actions: '*' }).status).toBe('passed');
    expect(testCardinalRule({ ...rule(), actions: '*', restriction: { kind: 'maximum_task_duration', seconds: 1 } }).status).toBe('passed');
    expect(testCardinalRule('do no harm').status).toBe('needs_clarification');
    expect(testCardinalRule({ ...rule(), restriction: { kind: 'safe_purchase' } }).status).toBe('unsupported');
    expect(testCardinalRule({ ...rule(), label: '' }).cases).toEqual([]);
  });
});
