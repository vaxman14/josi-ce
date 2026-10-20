// Pure permission analysis. The Vault/device bridge must authenticate the
// policy, effects, task clock and counters. Nothing here dispatches or approves
// an operation. Request-body/LLM assertions are not verified effects.
import { AUTOMATION_EFFECTS, AUTOMATION_PERMISSION_SEMANTICS, type AutomationIdentity,
  type AutomationEffect, type PermissionScope, type AutomationPermissionPolicy,
  type AutomationPermissionRule, type AutomationPermissionEvaluation } from '@josi-ce/protocol';

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const revision = (v: unknown): v is number => integer(v) && v > 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const keys = (v: Record<string, unknown>, names: readonly string[]) => Object.keys(v).length === names.length
  && names.every(k => Object.hasOwn(v, k));
const identityKeys = ['userId', 'serverId', 'deviceId', 'workspaceId'] as const;
export function isAutomationIdentity(v: unknown): v is AutomationIdentity {
  return object(v) && keys(v, identityKeys) && identityKeys.every(k => uuid(v[k]));
}
function origin(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 2048 || /[\s*\\]/u.test(v)) return false;
  try {
    const url = new URL(v);
    // Exact canonical origin only: no credentials, path, query, fragment,
    // wildcard, implicit default-port rewrite or case normalization.
    return ['http:', 'https:'].includes(url.protocol) && url.origin === v && !!url.hostname;
  } catch { return false; }
}
function timestamp(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
function isScope(v: unknown, destination = false): v is PermissionScope {
  if (!object(v)) return false;
  switch (v.kind) {
    case 'browser': return keys(v, ['kind', 'browser', 'profileId', 'origin'])
      && typeof v.browser === 'string' && ['chrome', 'firefox', 'safari', 'brave'].includes(v.browser) && uuid(v.profileId) && origin(v.origin);
    case 'network': return keys(v, ['kind', 'origin', 'networkClass']) && origin(v.origin)
      && typeof v.networkClass === 'string' && ['public', 'private', 'loopback'].includes(v.networkClass);
    case 'model': return keys(v, ['kind', 'configurationId', 'configurationRevision'])
      && uuid(v.configurationId) && revision(v.configurationRevision);
    default: if (destination) return false;
  }
  switch (v.kind) {
    case 'file': return keys(v, ['kind', 'rootId', 'rootRevision', 'segments', 'descendants']) && uuid(v.rootId)
      && revision(v.rootRevision) && typeof v.descendants === 'boolean' && Array.isArray(v.segments) && v.segments.length <= 64
      && v.segments.every(s => typeof s === 'string' && s.length > 0 && s.length <= 255 && s !== '.' && s !== '..'
        && !/[\u0000-\u001f\u007f/\\]/u.test(s));
    case 'application': return keys(v, ['kind', 'applicationId', 'installationRevision'])
      && uuid(v.applicationId) && revision(v.installationRevision);
    case 'runtime': return keys(v, ['kind', 'runtimeId', 'runtimeRevision', 'sandboxId', 'sandboxRevision'])
      && uuid(v.runtimeId) && revision(v.runtimeRevision) && uuid(v.sandboxId) && revision(v.sandboxRevision);
    case 'workspace': return keys(v, ['kind']);
    case 'credential': return keys(v, ['kind', 'itemId', 'itemVersion', 'destination']) && uuid(v.itemId)
      && revision(v.itemVersion) && isScope(v.destination, true);
    default: return false;
  }
}
function scopeKindFor(effect: AutomationEffect): PermissionScope['kind'][] {
  if (effect.startsWith('browser.')) return ['browser'];
  if (effect.startsWith('file.')) return ['file'];
  if (effect.startsWith('application.') || effect === 'computer.interact' || effect === 'system.modify') return ['application'];
  if (effect === 'computer.observe') return ['application', 'workspace'];
  if (effect.startsWith('execution.')) return ['runtime'];
  if (effect.startsWith('clipboard.')) return ['workspace'];
  if (effect === 'network.connect') return ['network'];
  if (effect === 'model.transmit') return ['model'];
  if (effect === 'credential.use') return ['credential'];
  return [];
}
function validMode(v: unknown): boolean {
  if (!object(v) || typeof v.kind !== 'string') return false;
  if (['deny', 'ask', 'standing'].includes(v.kind)) return keys(v, ['kind']);
  if (v.kind === 'task') return keys(v, ['kind', 'taskId']) && uuid(v.taskId);
  return v.kind === 'until' && keys(v, ['kind', 'expiresAt']) && timestamp(v.expiresAt);
}
function isRule(v: unknown): v is AutomationPermissionRule {
  if (!object(v) || !keys(v, ['id', 'action', 'scope', 'mode', 'limits']) || !uuid(v.id)
    || !AUTOMATION_EFFECTS.includes(v.action as AutomationEffect) || !isScope(v.scope)
    || !scopeKindFor(v.action as AutomationEffect).includes(v.scope.kind) || !validMode(v.mode)) return false;
  const mode = v.mode as AutomationPermissionRule['mode'];
  if (mode.kind === 'deny' || mode.kind === 'ask') return v.limits === null;
  const limits = v.limits;
  return object(limits) && keys(limits, ['maxTaskDurationMs', 'maxActionsPerTask', 'maxBytesPerTask'])
    && Object.values(limits).every(l => l === null || integer(l));
}
export type PermissionValidation = { valid: true; policy: AutomationPermissionPolicy } | { valid: false; code: 'invalid_policy' };
export function validateAutomationPermissionPolicy(value: unknown): PermissionValidation {
  if (!object(value) || !keys(value, ['schemaVersion', 'semanticsVersion', 'identity', 'enabled', 'unmatched', 'rules'])
    || value.schemaVersion !== 1 || value.semanticsVersion !== AUTOMATION_PERMISSION_SEMANTICS
    || !isAutomationIdentity(value.identity) || typeof value.enabled !== 'boolean' || typeof value.unmatched !== 'string' || !['ask', 'deny'].includes(value.unmatched)
    || !Array.isArray(value.rules) || value.rules.length > 100 || !value.rules.every(isRule)
    || new Set(value.rules.map(r => r.id)).size !== value.rules.length) return { valid: false, code: 'invalid_policy' };
  return { valid: true, policy: structuredClone(value) as unknown as AutomationPermissionPolicy };
}

export interface AutomationPermissionEffect { action: AutomationEffect; target: PermissionScope; bytes: number | null }
export interface AutomationPermissionFacts {
  identity: AutomationIdentity;
  /** Clock and original task state are read by the server, not proposed by the model. */
  nowMs: number;
  task: { id: string; active: boolean; startedAtMs: number };
  effectCoverage: 'verified' | 'incomplete';
  effects: AutomationPermissionEffect[];
  /** Atomic dispatcher counters include reserved and uncertain attempts. A
   * missing counter is unknown, never zero. A budget change keeps prior use. */
  usage: Array<{ ruleId: string; taskId: string; actions: number; bytes: number | null }>;
}
function validFacts(v: unknown): v is AutomationPermissionFacts {
  if (!object(v) || !keys(v, ['identity', 'nowMs', 'task', 'effectCoverage', 'effects', 'usage'])
    || !isAutomationIdentity(v.identity) || !integer(v.nowMs) || !object(v.task)
    || !keys(v.task, ['id', 'active', 'startedAtMs']) || !uuid(v.task.id) || typeof v.task.active !== 'boolean'
    || !integer(v.task.startedAtMs) || v.task.startedAtMs > v.nowMs || typeof v.effectCoverage !== 'string' || !['verified', 'incomplete'].includes(v.effectCoverage)
    || !Array.isArray(v.effects) || !v.effects.length || v.effects.length > 64 || !Array.isArray(v.usage) || v.usage.length > 100) return false;
  const effectsValid = v.effects.every(e => object(e) && keys(e, ['action', 'target', 'bytes'])
    && AUTOMATION_EFFECTS.includes(e.action as AutomationEffect) && isScope(e.target)
    && (e.bytes === null || integer(e.bytes))
    && (e.action === 'authority.modify' || e.action === 'vault.manage' || scopeKindFor(e.action as AutomationEffect).includes(e.target.kind))
    // An operation addresses concrete objects, not a directory wildcard.
    && (e.target.kind !== 'file' || e.target.descendants === false));
  const taskId = v.task.id;
  const usageValid = v.usage.every(u => object(u) && keys(u, ['ruleId', 'taskId', 'actions', 'bytes'])
    && uuid(u.ruleId) && u.taskId === taskId && integer(u.actions) && (u.bytes === null || integer(u.bytes)));
  return effectsValid && usageValid && new Set(v.usage.map(u => u.ruleId)).size === v.usage.length;
}
/** String scope matching is not an OS containment proof. Adapters must pin
 * file handles, resolve aliases/links, verify app identity, and pin network
 * destinations before supplying these canonical targets. */
function matches(scope: PermissionScope, target: PermissionScope): boolean {
  if (scope.kind !== target.kind) return false;
  switch (scope.kind) {
    case 'file': return target.kind === 'file' && scope.rootId === target.rootId && scope.rootRevision === target.rootRevision
      && scope.segments.every((s, i) => target.segments[i] === s)
      && (scope.descendants || scope.segments.length === target.segments.length);
    case 'browser': return target.kind === 'browser' && scope.browser === target.browser
      && scope.profileId === target.profileId && scope.origin === target.origin;
    case 'network': return target.kind === 'network' && scope.origin === target.origin && scope.networkClass === target.networkClass;
    case 'model': return target.kind === 'model' && scope.configurationId === target.configurationId && scope.configurationRevision === target.configurationRevision;
    case 'application': return target.kind === 'application' && scope.applicationId === target.applicationId && scope.installationRevision === target.installationRevision;
    case 'runtime': return target.kind === 'runtime' && scope.runtimeId === target.runtimeId && scope.runtimeRevision === target.runtimeRevision
      && scope.sandboxId === target.sandboxId && scope.sandboxRevision === target.sandboxRevision;
    case 'credential': return target.kind === 'credential' && scope.itemId === target.itemId && scope.itemVersion === target.itemVersion
      && matches(scope.destination, target.destination);
    case 'workspace': return true; // exact device/workspace identity is checked first
  }
}
export function evaluateAutomationPermissions(value: unknown, input: unknown): AutomationPermissionEvaluation {
  const result: AutomationPermissionEvaluation = { verdict: 'covered', reasons: [], charges: [], executionEnabled: false };
  const severity = { covered: 0, ask: 1, pause: 2, deny: 3 } as const;
  const stop = (verdict: 'deny' | 'ask' | 'pause', code: AutomationPermissionEvaluation['reasons'][number]['code'], effectIndex: number | null = null, ruleId: string | null = null) => {
    if (severity[verdict] > severity[result.verdict]) result.verdict = verdict;
    result.reasons.push({ effectIndex, ruleId, code });
  };
  const parsed = validateAutomationPermissionPolicy(value);
  if (!parsed.valid) { stop('pause', 'invalid_policy'); return result; }
  if (!validFacts(input)) { stop('pause', 'invalid_facts'); return result; }
  const policy = parsed.policy, facts = input;
  if (identityKeys.some(k => policy.identity[k] !== facts.identity[k])) { stop('deny', 'identity_mismatch'); return result; }
  if (!policy.enabled) { stop('deny', 'automation_disabled'); return result; }
  if (!facts.task.active) { stop('deny', 'inactive_task'); return result; }
  if (facts.effectCoverage !== 'verified') stop('pause', 'unverified_effects');
  const charges = new Map<string, { rule: AutomationPermissionRule; indices: number[]; bytes: number | null }>();
  facts.effects.forEach((effect, index) => {
    if (effect.action === 'authority.modify' || effect.action === 'vault.manage') { stop('deny', 'human_only', index); return; }
    const applicable = policy.rules.filter(rule => rule.action === effect.action && matches(rule.scope, effect.target)
      && (rule.mode.kind !== 'task' || rule.mode.taskId === facts.task.id)
      && (rule.mode.kind !== 'until' || Date.parse(rule.mode.expiresAt) > facts.nowMs));
    if (!applicable.length) stop(policy.unmatched, 'unmatched', index);
    for (const rule of applicable) {
      if (rule.mode.kind === 'deny') { stop('deny', 'explicit_denial', index, rule.id); continue; }
      if (rule.mode.kind === 'ask') { stop('ask', 'explicit_ask', index, rule.id); continue; }
      const previous = charges.get(rule.id);
      const sum = (previous?.bytes ?? 0) + (effect.bytes ?? 0);
      charges.set(rule.id, { rule, indices: [...previous?.indices ?? [], index],
        bytes: previous?.bytes === null || effect.bytes === null || !Number.isSafeInteger(sum) ? null : sum });
    }
  });
  for (const { rule, indices, bytes } of charges.values()) {
    const limits = rule.limits!, usage = facts.usage.find(u => u.ruleId === rule.id);
    const index = indices[0];
    if (limits.maxTaskDurationMs !== null && facts.nowMs - facts.task.startedAtMs >= limits.maxTaskDurationMs) stop('deny', 'duration_limit', index, rule.id);
    if (limits.maxActionsPerTask !== null) {
      if (!usage) stop('pause', 'usage_unavailable', index, rule.id);
      else if (usage.actions >= limits.maxActionsPerTask) stop('deny', 'action_limit', index, rule.id);
    }
    if (limits.maxBytesPerTask !== null) {
      if (!usage || usage.bytes === null || bytes === null) stop('pause', 'usage_unavailable', index, rule.id);
      else if (usage.bytes > limits.maxBytesPerTask || bytes > limits.maxBytesPerTask - usage.bytes) stop('deny', 'byte_limit', index, rule.id);
    }
    result.charges.push({ ruleId: rule.id, actions: 1, bytes });
  }
  // Never reserve partial coverage or spend counters on a refused proposal.
  if (result.verdict !== 'covered') result.charges = [];
  return result;
}
