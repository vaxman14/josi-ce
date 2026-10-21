export interface AutomationIdentity {
  serverId: string;
  userId: string;
  deviceId: string;
  workspaceId: string;
}
/** A reference never contains secret values or authoritative copied rules. */
export interface VaultAuthorityReference {
  recordId: string;
  version: number;
  digest: string;
  epoch: number;
}
export interface ControlLease extends AutomationIdentity {
  sessionId: string;
  goalId: string;
  generation: number;
  expiresAt: string;
  holder: 'agent' | 'human';
}
export interface ObservationReference extends AutomationIdentity {
  id: string;
  controlGeneration: number;
  targetId: string;
  targetRevision: number;
  capturedAt: string;
}
export type AutomationAction =
  | { kind: 'browser.photo'; browserProfileId: string; tabId: string; elementId: string; sourceReservationId: string }
  | { kind: 'browser.draft'; browserProfileId: string; tabId: string; elementId: string;
      sourceReservationId: string; text: string }
  // Initial inspection resolves the current window/tab locally. It cannot
  // carry an input action or pretend that a prior observation already exists.
  | { kind: 'browser.inspect'; browserProfileId: string }
  | { kind: 'desktop.inspect'; appId: string }
  | { kind: 'browser.observe'; browserProfileId: string; tabId: string }
  | { kind: 'browser.navigate'; browserProfileId: string; tabId: string; url: string }
  | { kind: 'browser.element'; browserProfileId: string; tabId: string; elementId: string;
      action: 'click' | 'fill'; sourceReservationId: string; text?: string; valueReference?: string }
  | { kind: 'desktop.observe'; appId: string; windowId: string }
  | { kind: 'desktop.element'; appId: string; windowId: string; elementId: string; sourceReservationId: string; action: 'press' | 'focus' }
  | { kind: 'desktop.pointer'; appId: string; windowId: string; x: number; y: number; sourceReservationId: string; action: 'click' }
  | { kind: 'desktop.text'; appId: string; windowId: string; sourceReservationId: string; text: string }
  | { kind: 'desktop.key'; appId: string; windowId: string; sourceReservationId: string; key: string }
  | { kind: 'desktop.scroll'; appId: string; windowId: string; sourceReservationId: string; deltaY: number }
  | { kind: 'browser.scroll'; browserProfileId: string; tabId: string; sourceReservationId: string; deltaY: number };
export interface ActionProposal extends AutomationIdentity {
  version: 1;
  id: string;
  goalId: string;
  attemptId: string;
  controlSessionId: string;
  controlGeneration: number;
  sequence: number;
  observation: ObservationReference;
  authority: VaultAuthorityReference;
  action: AutomationAction;
  expiresAt: string;
}
export type PermissionVerdict =
  | { decision: 'deny'; code: string; ruleReferences: VaultAuthorityReference[] }
  | { decision: 'ask'; requestId: string; proposalDigest: string; expiresAt: string }
  | { decision: 'allow'; grantId: string; proposalDigest: string; authority: VaultAuthorityReference; expiresAt: string };
export interface ActionReceipt {
  proposalId: string;
  proposalDigest: string;
  outcome: 'denied' | 'succeeded' | 'failed' | 'uncertain';
  evidenceIds: string[];
  completedAt: string;
}

/** Defense-in-depth consistency check, not authentication or authorization.
 * P4 must verify vault freshness, policy, owner consent, replay state, and the
 * signed channel before dispatch. These contracts do not expose an executor. */
export function matchesControlTarget(proposal: ActionProposal, lease: ControlLease): boolean {
  const same = (identity: AutomationIdentity) => identity.serverId === lease.serverId
    && identity.userId === lease.userId && identity.deviceId === lease.deviceId && identity.workspaceId === lease.workspaceId;
  return lease.holder === 'agent' && same(proposal) && same(proposal.observation)
    && proposal.goalId === lease.goalId && proposal.controlSessionId === lease.sessionId
    && proposal.controlGeneration === lease.generation
    && proposal.observation.controlGeneration === lease.generation;
}
