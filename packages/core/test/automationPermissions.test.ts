import { describe, expect, it } from 'vitest';
import { AUTOMATION_PERMISSION_SEMANTICS, type AutomationPermissionPolicy, type AutomationPermissionRule,
  type AutomationEffect, type PermissionScope } from '@josi-ce/protocol';
import { evaluateAutomationPermissions as evaluate, validateAutomationPermissionPolicy as validate,
  type AutomationPermissionFacts } from '../src/automationPermissions.js';
import { evaluateCardinalRules } from '../src/cardinalRules.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { userId: id(1), serverId: id(2), deviceId: id(3), workspaceId: id(4) };
const file = (segments = ['reports', 'result.txt'], descendants = false): PermissionScope =>
  ({ kind: 'file', rootId: id(5), rootRevision: 1, segments, descendants });
const browser = (): PermissionScope => ({ kind: 'browser', browser: 'safari', profileId: id(6), origin: 'https://example.test' });
const now = Date.parse('2026-10-19T22:00:00.000Z');
const unlimited = () => ({ maxTaskDurationMs: null, maxActionsPerTask: null, maxBytesPerTask: null });
function rule(patch: Partial<AutomationPermissionRule> = {}): AutomationPermissionRule {
  return { id: id(7), action: 'file.read', scope: file(), mode: { kind: 'standing' }, limits: unlimited(), ...patch };
}
function policy(rules = [rule()]): AutomationPermissionPolicy {
  return { schemaVersion: 1, semanticsVersion: AUTOMATION_PERMISSION_SEMANTICS, identity, enabled: true, unmatched: 'ask', rules };
}
function facts(patch: Partial<AutomationPermissionFacts> = {}): AutomationPermissionFacts {
  return { identity, nowMs: now, task: { id: id(8), active: true, startedAtMs: now - 1000 }, effectCoverage: 'verified',
    effects: [{ action: 'file.read', target: file(), bytes: 10 }], usage: [], ...patch };
}
const verdict = (p: unknown, f: unknown = facts()) => evaluate(p, f).verdict;

describe('exact automation permission analysis', () => {
  it('supports autonomous standing, original-task and unexpired grants without making a dispatch permit', () => {
    for (const mode of [{ kind: 'standing' }, { kind: 'task', taskId: id(8) }, { kind: 'until', expiresAt: new Date(now + 1).toISOString() }] as const) {
      expect(evaluate(policy([rule({ mode })]), facts())).toEqual({ verdict: 'covered', reasons: [],
        charges: [{ ruleId: id(7), actions: 1, bytes: 10 }], executionEnabled: false });
    }
  });
  it('the master switch alone grants no access; explicit unmatched Deny stays Deny', () => {
    expect(verdict(policy([]))).toBe('ask');
    expect(verdict({ ...policy([]), unmatched: 'deny' })).toBe('deny');
    expect(verdict({ ...policy(), enabled: false })).toBe('deny');
    expect(verdict(policy(), facts({ task: { ...facts().task, active: false } }))).toBe('deny');
  });
  it.each(['userId', 'serverId', 'deviceId', 'workspaceId'] as const)('does not transfer a grant across %s', name => {
    expect(evaluate(policy(), facts({ identity: { ...identity, [name]: id(99) } }))).toMatchObject({ verdict: 'deny', charges: [],
      reasons: [{ code: 'identity_mismatch' }] });
  });
  it('does not revive an expired grant or let a new task inherit one', () => {
    expect(verdict(policy([rule({ mode: { kind: 'until', expiresAt: new Date(now).toISOString() } })]))).toBe('ask');
    expect(verdict(policy([rule({ mode: { kind: 'task', taskId: id(99) } })]))).toBe('ask');
  });
  it('Deny wins over Ask and Allow, and Ask wins over Allow regardless of order', () => {
    const ask = rule({ id: id(10), mode: { kind: 'ask' }, limits: null });
    const deny = rule({ id: id(11), mode: { kind: 'deny' }, limits: null });
    for (const rules of [[rule(), ask, deny], [deny, ask, rule()], [ask, deny, rule()]]) expect(verdict(policy(rules))).toBe('deny');
    for (const rules of [[rule(), ask], [ask, rule()]]) expect(verdict(policy(rules))).toBe('ask');
  });
  it('requires coverage of every effect and target; a read grant cannot authorize a transfer', () => {
    const f = facts(); f.effects.push({ action: 'file.export', target: file(), bytes: 10 });
    expect(evaluate(policy(), f)).toMatchObject({ verdict: 'ask', charges: [], reasons: [{ code: 'unmatched', effectIndex: 1 }] });
    expect(verdict(policy([rule(), rule({ id: id(10), action: 'file.export' })]), f)).toBe('covered');
    f.effects.push({ action: 'file.read', target: file(['private', 'result.txt']), bytes: 10 });
    expect(verdict(policy([rule(), rule({ id: id(10), action: 'file.export' })]), f)).toBe('ask');
  });
  it('a generic click or shell route cannot avoid known effects or declare unknown effects harmless', () => {
    const app: PermissionScope = { kind: 'application', applicationId: id(10), installationRevision: 1 };
    const allowed = rule({ action: 'computer.interact', scope: app });
    const denied = rule({ id: id(11), action: 'file.delete', mode: { kind: 'deny' }, limits: null });
    const f = facts({ effects: [{ action: 'computer.interact', target: app, bytes: 0 }], effectCoverage: 'incomplete' });
    expect(verdict(policy([allowed]), f)).toBe('pause');
    f.effectCoverage = 'verified'; f.effects.push({ action: 'file.delete', target: file(), bytes: 10 });
    expect(verdict(policy([allowed, denied]), f)).toBe('deny');
    expect(verdict(policy(), facts({ effects: [] }))).toBe('pause');
    expect(verdict(policy(), facts({ effects: [{ action: 'purchase.any' as AutomationEffect, target: browser(), bytes: 0 }] }))).toBe('pause');
  });
  it.each(['authority.modify', 'vault.manage'] as const)('never grants protected %s through automation', action => {
    expect(verdict(policy(), facts({ effects: [{ action, target: { kind: 'workspace' }, bytes: 0 }] }))).toBe('deny');
    expect(validate(policy([rule({ action: action as never, scope: { kind: 'workspace' } })])).valid).toBe(false);
  });
  it('matches file components, explicit descendant choice and root revision without broad prefix matching', () => {
    expect(verdict(policy([rule({ scope: file(['reports'], true) })]))).toBe('covered');
    expect(verdict(policy([rule({ scope: file(['reports'], false) })]))).toBe('ask');
    expect(verdict(policy([rule({ scope: file(['report'], true) })]))).toBe('ask');
    expect(verdict(policy([rule({ scope: { ...file(), rootRevision: 2 } as PermissionScope })]))).toBe('ask');
    expect(verdict(policy([rule({ scope: { ...file(), rootId: id(99) } as PermissionScope })]))).toBe('ask');
    expect(verdict(policy(), facts({ effects: [{ action: 'file.read', target: file(['reports'], true), bytes: 10 }] }))).toBe('pause');
  });
  it('does not normalize ambiguous file paths, case or Unicode', () => {
    for (const segment of ['..', '.', '', '../secret', 'a/b', 'a\\b', 'a\u0000b']) expect(validate(policy([rule({ scope: file([segment]) })])).valid).toBe(false);
    const p = policy([rule({ scope: file(['Résumé']) })]);
    expect(verdict(p, facts({ effects: [{ action: 'file.read', target: file(['Re\u0301sume\u0301']), bytes: 10 }] }))).toBe('ask');
    expect(verdict(policy([rule({ scope: file(['Reports'], true) })]))).toBe('ask');
  });
  it.each(['chrome', 'firefox', 'safari', 'brave'] as const)('pins %s to its exact origin and isolated profile', family => {
    const target = { ...browser(), browser: family } as PermissionScope;
    const p = policy([rule({ action: 'browser.navigate', scope: target })]);
    const f = facts({ effects: [{ action: 'browser.navigate', target, bytes: 0 }] });
    expect(verdict(p, f)).toBe('covered');
    for (const patch of [{ profileId: id(99) }, { origin: 'https://sub.example.test' }, { origin: 'http://example.test' }, { origin: 'https://example.test:8443' }, { browser: family === 'brave' ? 'chrome' : 'brave' }]) {
      expect(verdict(p, facts({ effects: [{ action: 'browser.navigate', target: { ...target, ...patch } as PermissionScope, bytes: 0 }] }))).toBe('ask');
    }
  });
  it.each(['https://*.example.test', 'https://user:pass@example.test', 'https://example.test/', 'https://example.test/path',
    'https://example.test?q=1', 'https://example.test#x', 'HTTPS://example.test', 'https://EXAMPLE.test',
    'https://example.test:443', 'file:///tmp', 'javascript:alert(1)', ' https://example.test', 'https://example.test\\evil'])('refuses noncanonical origin %s', origin => {
    expect(validate(policy([rule({ action: 'browser.navigate', scope: { ...browser(), origin } as PermissionScope })])).valid).toBe(false);
  });
  it('network locality and model/app/runtime revision changes need new grants', () => {
    const pairs: Array<[AutomationEffect, PermissionScope, PermissionScope]> = [
      ['network.connect', { kind: 'network', origin: 'https://example.test', networkClass: 'public' }, { kind: 'network', origin: 'https://example.test', networkClass: 'private' }],
      ['model.transmit', { kind: 'model', configurationId: id(20), configurationRevision: 1 }, { kind: 'model', configurationId: id(20), configurationRevision: 2 }],
      ['application.launch', { kind: 'application', applicationId: id(20), installationRevision: 1 }, { kind: 'application', applicationId: id(20), installationRevision: 2 }],
      ['execution.script', { kind: 'runtime', runtimeId: id(20), runtimeRevision: 1, sandboxId: id(21), sandboxRevision: 1 }, { kind: 'runtime', runtimeId: id(20), runtimeRevision: 1, sandboxId: id(22), sandboxRevision: 1 }],
    ];
    for (const [action, scope, target] of pairs) {
      const p = policy([rule({ action: action as never, scope })]);
      expect(verdict(p, facts({ effects: [{ action, target: scope, bytes: 0 }] }))).toBe('covered');
      expect(verdict(p, facts({ effects: [{ action, target, bytes: 0 }] }))).toBe('ask');
    }
  });
  it('a credential-use grant is pinned to its item/version AND destination; it does not grant transmission', () => {
    const scope: PermissionScope = { kind: 'credential', itemId: id(12), itemVersion: 1, destination: browser() as never };
    const p = policy([rule({ action: 'credential.use', scope })]);
    expect(verdict(p, facts({ effects: [{ action: 'credential.use', target: scope, bytes: 0 }] }))).toBe('covered');
    for (const target of [{ ...scope, itemVersion: 2 }, { ...scope, itemId: id(99) }, { ...scope, destination: { ...scope.destination, origin: 'https://evil.test' } }]) {
      expect(verdict(p, facts({ effects: [{ action: 'credential.use', target: target as PermissionScope, bytes: 0 }] }))).toBe('ask');
    }
    expect(verdict(p, facts({ effects: [{ action: 'model.transmit', target: { kind: 'model', configurationId: id(12), configurationRevision: 1 }, bytes: 1 }] }))).toBe('ask');
  });
  it('Cardinal Rule restriction remains independent from ordinary grant coverage', () => {
    expect(verdict(policy())).toBe('covered');
    expect(evaluateCardinalRules([{ schemaVersion: 1, label: 'No reads', wording: 'Deny every file read.', actions: ['file.read'],
      scope: { userId: '*', serverId: '*', deviceId: '*', workspaceId: '*', taskId: '*' }, restriction: { kind: 'deny' }, onUnavailable: 'pause' }],
    { effects: ['file.read'], effectCoverage: 'verified', identities: { ...identity, taskId: id(8) } }).verdict).toBe('deny');
  });
});

describe('original-task limits and uncertain usage', () => {
  const limited = (patch = {}) => policy([rule({ limits: { ...unlimited(), maxActionsPerTask: 2, maxBytesPerTask: 100, ...patch } })]);
  const used = (actions = 1, bytes: number | null = 90) => facts({ usage: [{ ruleId: id(7), taskId: id(8), actions, bytes }] });
  it('permits the exact byte ceiling and last action; denies the next attempt', () => {
    expect(verdict(limited(), used())).toBe('covered');
    expect(verdict(limited(), used(2))).toBe('deny');
    expect(verdict(limited(), used(1, 91))).toBe('deny');
    expect(verdict(limited({ maxActionsPerTask: 0 }), used(0, 0))).toBe('deny');
    expect(verdict(limited({ maxBytesPerTask: 0 }), used(0, 0))).toBe('deny');
  });
  it('unknown usage/bytes stop; a stale or duplicate counter is never treated as zero', () => {
    expect(verdict(limited())).toBe('pause');
    expect(verdict(limited(), used(0, null))).toBe('pause');
    const f = used(0, 0); f.effects[0].bytes = null;
    expect(verdict(limited(), f)).toBe('pause');
    f.usage[0].taskId = id(99); expect(verdict(limited(), f)).toBe('pause');
    const duplicate = used(); duplicate.usage.push(duplicate.usage[0]); expect(verdict(limited(), duplicate)).toBe('pause');
  });
  it('measures original-task duration, including retries, and stops at the exact boundary', () => {
    expect(verdict(limited({ maxTaskDurationMs: 1001 }), used())).toBe('covered');
    expect(verdict(limited({ maxTaskDurationMs: 1000 }), used())).toBe('deny');
    expect(verdict(limited(), facts({ task: { ...facts().task, startedAtMs: now + 1 } }))).toBe('pause');
  });
  it('charges all overlapping active grants once per proposal, sums their bytes and applies every limit', () => {
    const p = limited(); p.rules.push(rule({ id: id(10), scope: file(['reports'], true) }));
    const f = used(0, 0); f.effects.push({ action: 'file.read', target: file(), bytes: 20 });
    expect(evaluate(p, f).charges).toEqual([{ ruleId: id(7), actions: 1, bytes: 30 }, { ruleId: id(10), actions: 1, bytes: 30 }]);
    f.usage[0].actions = 2; expect(verdict(p, f)).toBe('deny');
    f.usage[0].actions = 0; f.usage[0].bytes = 75; expect(verdict(p, f)).toBe('deny');
  });
  it('does not overflow counters or byte sums into apparent spare budget', () => {
    expect(verdict(limited(), used(Number.MAX_SAFE_INTEGER, 0))).toBe('deny');
    const f = used(0, 0); f.effects[0].bytes = Number.MAX_SAFE_INTEGER;
    f.effects.push({ action: 'file.read', target: file(), bytes: 1 });
    expect(verdict(limited(), f)).toBe('pause');
  });
});

describe('strict parsing without silent repair or widening', () => {
  it.each([null, {}, 'allow everything', { ...policy(), enabled: 'true' }, { ...policy(), unmatched: ['ask'] },
    { ...policy(), semanticsVersion: 'automation-permissions.2' }, { ...policy(), ruleDefaults: 'always' },
    { ...policy(), identity: { ...identity, deviceId: '*' } }, policy([rule(), rule()]),
    policy([rule({ scope: { kind: 'workspace' } })]), policy([rule({ mode: { kind: 'standing' }, limits: null })]),
    policy([rule({ mode: { kind: 'ask' } })]), policy([rule({ mode: { kind: 'task' } as never })]),
    policy([rule({ mode: { kind: ['standing'] } as never })]), policy([rule({ limits: { ...unlimited(), maxBytesPerTask: -1 } })]),
    policy([rule({ limits: { ...unlimited(), maxActionsPerTask: 1.5 } })]), policy([rule({ limits: { ...unlimited(), maxTaskDurationMs: Infinity } })]),
    policy([rule({ scope: { ...browser(), browser: ['safari'] } as never, action: 'browser.observe' })]),
    policy([rule({ mode: { kind: 'until', expiresAt: '2026-02-30T00:00:00.000Z' } })]),
  ])('rejects malformed or unsupported policy %#', value => {
    expect(validate(value).valid).toBe(false); expect(verdict(value)).toBe('pause');
  });
  it.each([null, {}, { ...facts(), effects: [] }, { ...facts(), nowMs: NaN }, { ...facts(), nowMs: Infinity },
    { ...facts(), modelSaysSafe: true }, { ...facts(), effectCoverage: ['verified'] },
    facts({ effects: [{ action: 'file.read', target: file(), bytes: -1 }] }),
    facts({ effects: [{ action: 'file.read', target: file(), bytes: Number.MAX_SAFE_INTEGER + 1 }] }),
    facts({ task: { ...facts().task, active: 'true' as never } }),
  ])('refuses malformed facts %#', value => expect(verdict(policy(), value)).toBe('pause'));
  it('returns an independent policy snapshot and never changes caller input', () => {
    const p = policy(), before = JSON.stringify(p); const parsed = validate(p);
    if (!parsed.valid) throw new Error('fixture');
    parsed.policy.rules[0].limits!.maxActionsPerTask = 1;
    evaluate(p, facts()); expect(JSON.stringify(p)).toBe(before);
  });
});
