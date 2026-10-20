import { parseProtectedControlPresentation, type AutomationPermissionPolicy, type AutomationPermissionRule, type ProtectedControlPresentation } from '@josi-ce/protocol';
import { cardinalContentDigest } from './cardinalRules.js';
import { VaultRecordError } from './vaultRecords.js';

const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => [k, canonical(value)])) : v;
function describe(rule: AutomationPermissionRule): string {
  const mode = rule.mode;
  const permission = mode.kind === 'deny' ? 'Deny this action.' : mode.kind === 'ask' ? 'Ask before this action; no standing allowance.'
    : mode.kind === 'standing' ? 'Standing allowance within this exact scope and the limits below.'
    : mode.kind === 'task' ? `Allow only for original task ${mode.taskId}, within the limits below.`
    : `Allow strictly before ${mode.expiresAt} (UTC), within the limits below.`;
  const limits = rule.limits;
  return [`Rule ID: ${rule.id}`, `Action: ${rule.action}`, `Exact scope:\n${JSON.stringify(canonical(rule.scope), null, 2)}`, permission,
    ...(limits ? [`Original-task duration: ${limits.maxTaskDurationMs === null ? 'unlimited' : `stop when elapsed time reaches ${limits.maxTaskDurationMs} milliseconds`}.`,
      `Maximum actions per original task: ${limits.maxActionsPerTask === null ? 'unlimited' : limits.maxActionsPerTask}.`,
      `Maximum bytes per original task: ${limits.maxBytesPerTask === null ? 'unlimited' : limits.maxBytesPerTask}.`] : [])].join('\n');
}

/** Inputs have already passed the strict permission schema and current Vault
 * checks. Full before/after values are shown for every changed rule. Enabling
 * automation also lists every unchanged rule that becomes effective. */
export function automationReplacementPresentation(previous: AutomationPermissionPolicy | null, next: AutomationPermissionPolicy): ProtectedControlPresentation {
  const before = new Map(previous?.rules.map(rule => [rule.id, rule]) ?? []), after = new Map(next.rules.map(rule => [rule.id, rule]));
  const changes: string[] = [];
  let unchanged = 0;
  for (const rule of next.rules) {
    const prior = before.get(rule.id);
    if (!prior) changes.push(`Add rule:\n${describe(rule)}`);
    else if (cardinalContentDigest(prior) !== cardinalContentDigest(rule)) changes.push(`Change rule — before:\n${describe(prior)}\n\nAfter:\n${describe(rule)}`);
    else { unchanged++; if (!previous?.enabled && next.enabled) changes.push(`Existing rule becomes effective when enabled:\n${describe(rule)}`); }
  }
  for (const rule of previous?.rules ?? []) if (!after.has(rule.id)) changes.push(`Remove rule:\n${describe(rule)}`);
  const { userId, serverId, deviceId, workspaceId } = next.identity;
  const meaning = [`User: ${userId}\nServer: ${serverId}\nDevice: ${deviceId}\nAutomation workspace: ${workspaceId}`,
    `Automation: ${previous ? previous.enabled ? 'enabled' : 'disabled' : 'no policy'} → ${next.enabled ? 'enabled' : 'disabled'}.`,
    `Unmatched actions: ${previous?.unmatched ?? 'no policy'} → ${next.unmatched}.`,
    next.enabled ? 'Enabling these settings alone does not establish device-owner consent or authorize unsupported operations.'
      : 'Automation is disabled for this identity. Stored rules cannot grant execution while disabled.',
    `Rules after this change: ${next.rules.length}. Unchanged rules: ${unchanged}.`,
    changes.length ? changes.join('\n\n') : 'No rule scope, mode or limit changes.',
    'Deny takes precedence over Ask and allowances. Every overlapping allowance must satisfy its own limits. Reordering rules does not change precedence.',
    'Limits apply to the original task, including retries. Zero allows no use of that resource. Usage is counted by rule ID across saved attempts; retaining or reusing an ID does not reset it. A never-used rule ID starts its own budget.',
    'Cardinal Rules, current Vault authority, verified effects and independent device-owner consent still apply. These settings cannot authorize protected administration. Other identities are unchanged.'].join('\n\n');
  const presentation = parseProtectedControlPresentation({ wording: 'Replace the automation permissions for this exact user, server, device and workspace.', meaning, advisory: [] });
  if (!presentation) throw new VaultRecordError('This permission change cannot be completely displayed. Use smaller explicit changes or correct unsupported text; no permissions were changed.');
  return presentation;
}
