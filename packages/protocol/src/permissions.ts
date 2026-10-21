import type { AutomationIdentity } from './automation.js';

/** Shared vocabulary, not a list of installed executors. Adding a new effect
 * requires new semantics/tests; unknown effects must stop existing engines. */
export const AUTOMATION_EFFECTS = [
  'browser.navigate', 'browser.observe', 'browser.fill', 'browser.click', 'browser.submit', 'browser.download', 'browser.upload',
  'computer.observe', 'computer.interact', 'application.launch', 'application.close',
  'file.read', 'file.create', 'file.edit', 'file.rename', 'file.move', 'file.delete', 'file.import', 'file.export',
  'network.connect', 'execution.shell', 'execution.script', 'system.modify',
  'clipboard.read', 'clipboard.write', 'credential.use', 'model.transmit',
  'authority.modify', 'vault.manage',
] as const;
export type AutomationEffect = typeof AUTOMATION_EFFECTS[number];
export type GrantableEffect = Exclude<AutomationEffect, 'authority.modify' | 'vault.manage'>;
export const AUTOMATION_PERMISSION_SEMANTICS = 'automation-permissions.1';

export interface BrowserPermissionScope {
  kind: 'browser'; browser: 'chrome' | 'firefox' | 'safari' | 'brave'; profileId: string; origin: string;
}
export interface FilePermissionScope {
  kind: 'file'; rootId: string; rootRevision: number; segments: string[]; descendants: boolean;
}
export interface NetworkPermissionScope {
  kind: 'network'; origin: string; networkClass: 'public' | 'private' | 'loopback';
}
export interface ModelPermissionScope { kind: 'model'; configurationId: string; configurationRevision: number }
export type PermissionScope = BrowserPermissionScope | FilePermissionScope | NetworkPermissionScope | ModelPermissionScope
  | { kind: 'application'; applicationId: string; installationRevision: number }
  | { kind: 'runtime'; runtimeId: string; runtimeRevision: number; sandboxId: string; sandboxRevision: number }
  | { kind: 'workspace' }
  | { kind: 'credential'; itemId: string; itemVersion: number;
      destination: BrowserPermissionScope | NetworkPermissionScope | ModelPermissionScope };
export type PermissionMode = { kind: 'deny' } | { kind: 'ask' } | { kind: 'standing' }
  | { kind: 'task'; taskId: string } | { kind: 'until'; expiresAt: string };
/** Null means explicitly unlimited for this dimension, never an implicit
 * default. Limits apply to the original durable task, including retries. */
export interface AutomationPermissionLimits {
  maxTaskDurationMs: number | null;
  maxActionsPerTask: number | null;
  maxBytesPerTask: number | null;
}
export interface AutomationPermissionRule {
  id: string; action: GrantableEffect; scope: PermissionScope; mode: PermissionMode;
  limits: AutomationPermissionLimits | null;
}
export interface AutomationPermissionPolicy {
  schemaVersion: 1; semanticsVersion: typeof AUTOMATION_PERMISSION_SEMANTICS;
  identity: AutomationIdentity; enabled: boolean; unmatched: 'ask' | 'deny'; rules: AutomationPermissionRule[];
}
/** Evaluation/preview only. Even `covered` is not a signed dispatch permit. */
export interface AutomationPermissionEvaluation {
  verdict: 'covered' | 'ask' | 'deny' | 'pause';
  reasons: Array<{ effectIndex: number | null; ruleId: string | null; code:
    'invalid_policy' | 'invalid_facts' | 'identity_mismatch' | 'automation_disabled' | 'inactive_task'
    | 'human_only' | 'unverified_effects' | 'explicit_denial' | 'explicit_ask' | 'unmatched'
    | 'duration_limit' | 'action_limit' | 'byte_limit' | 'usage_unavailable' }>;
  /** Every applicable grant is charged; overlapping grants cannot hide usage.
   * The dispatcher must reserve these charges atomically before execution. */
  charges: Array<{ ruleId: string; actions: 1; bytes: number | null }>;
  executionEnabled: false;
}
