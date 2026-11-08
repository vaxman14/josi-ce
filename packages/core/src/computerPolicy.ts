import { createHash } from 'node:crypto';
import type { AutomationEffect, AutomationPermissionEvaluation, ComputerDevice, ComputerRequest } from '@josi-ce/protocol';
import { evaluateAutomationPermissions, type AutomationPermissionFacts } from './automationPermissions.js';
import { readAutomationPolicyRecord, type AutomationPolicyView } from './automationPolicy.js';
import { readCardinalPolicyRecord, type CardinalPolicyView } from './cardinalPolicy.js';
import { evaluateCardinalRules } from './cardinalRules.js';
import { readAutomationTargetDocument, sameAutomationIdentity } from './automationTargets.js';
import { computerProtectedDevices } from './protectedDevices.js';
import { computerDesktopWorkspaces } from './workspaceStorage.js';
import type { VaultRecordReference, VaultRecordValue } from './vaultRecords.js';

export interface ComputerPolicySnapshot {
  required: boolean; available: boolean; reason: string; epoch: number; digest: string;
  permissions: AutomationPolicyView | null; cardinal: CardinalPolicyView | null;
  devices: ReturnType<typeof computerProtectedDevices>;
  workspaces: ReturnType<typeof computerDesktopWorkspaces>;
  targets: ReturnType<typeof readAutomationTargetDocument>;
  deviceReference: VaultRecordReference | null;
}
export function unavailableComputerPolicy(reason: string, required = true): ComputerPolicySnapshot {
  return { required, available: !required, reason, epoch: 0, digest: '', permissions: null, cardinal: null,
    devices: [], workspaces: [], targets: { applications: [], models: [], browsers: [] }, deviceReference: null };
}
/** Inputs are authenticated current Vault records from one locked transaction. */
export function readComputerPolicy(records: VaultRecordValue[], owner: string, epoch: number): ComputerPolicySnapshot {
  const get = (kind: VaultRecordValue['kind']) => records.find(r => r.kind === kind) ?? null;
  const p = get('automation_policy'), c = get('cardinal_policy'), d = get('protected_devices');
  const permissions = p ? readAutomationPolicyRecord(p, false) : null;
  const cardinal = c ? readCardinalPolicyRecord(c, false) : null;
  if (permissions && !permissions.enforcementCurrent || cardinal && !cardinal.enforcementCurrent) {
    return unavailableComputerPolicy('Saved permissions need enforcement revalidation.');
  }
  return { required: !!(p || c), available: true, reason: '', epoch,
    digest: createHash('sha256').update(JSON.stringify(records.map(r => r.reference).sort((a,b) => a.recordId.localeCompare(b.recordId)))).digest('hex'),
    permissions, cardinal, deviceReference: d?.reference ?? null,
    devices: computerProtectedDevices(d, owner), workspaces: computerDesktopWorkspaces(get('workspace_storage'), owner),
    targets: readAutomationTargetDocument(get('automation_targets')) };
}
export interface ComputerPolicyUsage { requestId: string; taskId: string; charges: AutomationPermissionEvaluation['charges'] }
export interface ComputerPolicyDecision {
  verdict: 'allow' | 'ask' | 'deny'; reason: string; expiresAt: number;
  digest: string; charges: AutomationPermissionEvaluation['charges']; applicationPin?: NonNullable<ComputerRequest['applicationPin']>;
}
export function evaluateComputerPolicy(context: ComputerPolicySnapshot, device: ComputerDevice, request: ComputerRequest,
  now: number, task: { active: boolean; startedAtMs: number } | undefined, usage: ComputerPolicyUsage[],
  transmission?: { configurationId: string; configurationRevision: number; bytes: number }): ComputerPolicyDecision {
  const result: ComputerPolicyDecision = { verdict: 'allow', reason: '', expiresAt: request.expiresAt, digest: context.digest, charges: [] };
  const refuse = (reason: string): ComputerPolicyDecision => ({ ...result, verdict: 'deny', reason, charges: [] });
  if (!context.available) return refuse(context.reason);
  if (!context.required) return result;
  const binding = device.savedPermissions;
  const enrolled = binding && context.devices.find(d => d.enrollmentId === binding.enrollmentId && !d.revokedAt
    && d.wrappingFingerprint === binding.wrappingFingerprint && d.identity.deviceId === binding.identity.deviceId
    && d.identity.serverId === binding.identity.serverId && d.identity.userId === request.ownerId);
  if (!enrolled || !binding || !context.workspaces.some(w => w.workspaceId === binding.identity.workspaceId
    && w.identity.deviceId === enrolled.identity.deviceId && w.identity.serverId === enrolled.identity.serverId)) {
    return refuse('Connect this Mac’s saved enrollment and current-desktop permissions.');
  }
  const identity = binding.identity, op = request.operation;
  const action: AutomationEffect = transmission ? 'model.transmit' : op.action === 'app.launch' ? 'application.launch'
    : op.action === 'window.close' ? 'application.close'
    : ['window.read','window.capture','environment','app.list'].includes(op.action) ? 'computer.observe'
    : op.action === 'file.write' ? op.args.expectedDigest === '' ? 'file.create' : 'file.edit'
    : op.action.startsWith('file.') ? 'file.read' : op.action.startsWith('terminal.') ? 'execution.shell' : 'computer.interact';
  const broad = action === 'computer.interact' || action === 'application.launch' || action === 'execution.shell';
  // Generic input/launch can trigger business effects beyond an AX action.
  // It cannot use a broad grant to sidestep a narrower saved exclusion.
  const policies = context.permissions?.document.policies.filter(p => sameAutomationIdentity(p.identity, identity)) ?? [];
  const policy = policies[0];
  if (context.permissions && !policy) return refuse('No saved permission policy covers this exact Mac workspace.');
  if (policy && !policy.enabled) return refuse('Automation is disabled in this Mac’s saved permissions.');
  const cardinalFacts = { identities: { ...identity, taskId: request.taskId }, effects: [action],
    effectCoverage: 'verified' as const, ...(task ? { taskElapsedMs: now - task.startedAtMs } : {}) };
  if (context.cardinal) {
    const rules = context.cardinal.document.rules.map(r => r.definition);
    const cardinal = evaluateCardinalRules(rules, cardinalFacts);
    if (cardinal.verdict !== 'no_restriction') return refuse('A saved Cardinal Rule denies or pauses this operation.');
    if (broad && evaluateCardinalRules(rules, { ...cardinalFacts, effectCoverage: 'incomplete' }).reasons.some(r => r.ruleIndex !== null)) {
      return refuse('This generic action cannot prove compliance with the saved Cardinal restrictions.');
    }
    for (const rule of rules) if (rule.restriction.kind === 'maximum_task_duration') {
      // A conservative local bound is safe even when another scope would exclude this rule.
      if (!task) return refuse('A durable work task is required to enforce the saved time limit.');
      result.expiresAt = Math.min(result.expiresAt, task.startedAtMs + rule.restriction.seconds * 1000);
    }
  }
  if (!policy) return result; // Cardinal-only installations still need the v2 local grant.
  const activeRules = policy.rules.filter(r => (r.mode.kind !== 'task' || r.mode.taskId === request.taskId)
    && (r.mode.kind !== 'until' || Date.parse(r.mode.expiresAt) > now));
  if (broad && activeRules.some(r => r.mode.kind === 'deny' || r.mode.kind === 'ask')) {
    return refuse('Saved narrower restrictions prevent this generic desktop or shell action.');
  }
  let target: AutomationPermissionFacts['effects'][number]['target'];
  if (transmission) {
    target = { kind: 'model', configurationId: transmission.configurationId, configurationRevision: transmission.configurationRevision };
  } else if (op.scope.kind === 'application') {
    const app = context.targets.applications.find(a => sameAutomationIdentity(a.identity, identity)
      && `${a.candidate.bundleId}|${a.candidate.teamId || 'apple'}|${a.candidate.bundlePath}` === op.scope.target);
    if (!app) return refuse('Register this exact signed app in the existing Mac permission settings.');
    result.applicationPin = { signingId: app.candidate.signingId, codeHash: app.candidate.codeHash };
    target = { kind: 'application', applicationId: app.applicationId, installationRevision: app.installationRevision };
  } else if (op.scope.kind === 'device') target = { kind: 'workspace' };
  else return refuse('This saved policy uses registered file/runtime identities. A raw path cannot replace that identity.');
  if (activeRules.some(r => r.limits && Object.values(r.limits).some(v => v !== null)) && !task) {
    return refuse('A durable work task is required to enforce the saved limits.');
  }
  const totals = new Map(activeRules.map(r => [r.id, { ruleId: r.id, taskId: request.taskId, actions: 0, bytes: 0 as number | null }]));
  for (const entry of usage.filter(u => u.taskId === request.taskId && u.requestId !== request.id)) for (const charge of entry.charges) {
    const previous = totals.get(charge.ruleId);
    if (previous) { previous.actions += charge.actions; previous.bytes = previous.bytes === null || charge.bytes === null ? null : previous.bytes + charge.bytes; }
  }
  const bytes = transmission?.bytes ?? (op.action === 'window.capture' ? 256000 : op.action === 'window.read' ? 65536
    : typeof op.args.text === 'string' ? Buffer.byteLength(op.args.text) : 1);
  const facts: AutomationPermissionFacts = { identity, nowMs: now,
    task: { id: request.taskId, active: task?.active ?? true, startedAtMs: task?.startedAtMs ?? request.createdAt },
    effectCoverage: 'verified', effects: [{ action, target, bytes }], usage: [...totals.values()] };
  let evaluated = evaluateAutomationPermissions(policy, facts);
  if (evaluated.verdict === 'deny' || evaluated.verdict === 'pause') return refuse('The saved permissions or task limits do not allow this operation.');
  // Ask is a per-operation review. A standing v2 rule cannot erase it.
  if (evaluated.verdict === 'ask') {
    if (transmission || request.savedPolicyReview !== context.digest) return { ...result, verdict: 'ask', reason: 'Review this exact operation under the saved Ask rule.' };
    // The protected approval satisfies only this exact Ask. Re-run all
    // overlapping budgets; the evaluator deliberately drops partial charges.
    const reviewed = structuredClone(policy);
    for (const rule of reviewed.rules) if (rule.mode.kind === 'ask') {
      rule.mode = { kind: 'standing' };
      rule.limits = { maxActionsPerTask: null, maxBytesPerTask: null, maxTaskDurationMs: null };
    }
    if (reviewed.unmatched === 'ask') reviewed.rules.push({ id: request.id, action, scope: target,
      mode: { kind: 'standing' }, limits: { maxActionsPerTask: null, maxBytesPerTask: null, maxTaskDurationMs: null } });
    evaluated = evaluateAutomationPermissions(reviewed, facts);
    if (evaluated.verdict !== 'covered') return refuse('The saved permission limits still prevent this operation.');
  }
  result.charges = evaluated.charges;
  for (const rule of activeRules.filter(r => evaluated.charges.some(c => c.ruleId === r.id))) {
    if (rule.mode.kind === 'until') result.expiresAt = Math.min(result.expiresAt, Date.parse(rule.mode.expiresAt));
    if (rule.limits?.maxTaskDurationMs !== null && rule.limits?.maxTaskDurationMs !== undefined && task) {
      result.expiresAt = Math.min(result.expiresAt, task.startedAtMs + rule.limits.maxTaskDurationMs);
    }
  }
  return result;
}
