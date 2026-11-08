/** Versioned native Mac contract. Legacy path and policy semantics are unchanged. */
export const COMPUTER_CONTROL_VERSION = 'computer-control.2' as const;
export type ComputerPlatform = 'macos';
export const COMPUTER_ACTIONS = ['environment', 'file.list', 'file.read', 'file.write', 'app.list', 'app.launch',
  'window.read', 'window.capture', 'window.click', 'window.type', 'window.scroll', 'window.drag', 'window.close',
  'terminal.open', 'terminal.input', 'terminal.read', 'terminal.close'] as const;
export type ComputerAction = typeof COMPUTER_ACTIONS[number];
export type ComputerScope = { kind: 'device' | 'folder' | 'application' | 'host'; target: string };
export type ComputerDuration = { kind: 'saved' } | { kind: 'until'; expiresAt: number }
  | { kind: 'task'; taskId: string; expiresAt: number } | { kind: 'once'; requestId: string };
export interface ComputerRule {
  id: string; action: ComputerAction | '*'; scope: ComputerScope;
  decision: 'allow' | 'ask' | 'deny'; duration: ComputerDuration;
}
export interface ComputerOperation {
  action: ComputerAction; scope: ComputerScope; args: Record<string, unknown>;
}
export interface ComputerRequest {
  id: string; ownerId: string; deviceId: string; taskId: string; revision: number;
  taskBound?: boolean; operation: ComputerOperation; digest: string; createdAt: number; expiresAt: number;
  state: 'pending' | 'approved' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  leaseUntil?: number; result?: unknown;
  savedPolicyDigest?: string; savedPolicyReview?: string;
  applicationPin?: { signingId: string; codeHash: string };
}
export interface ComputerDevice {
  id: string; label: string; platform: ComputerPlatform; publicKey: string;
  revision: number; stopped: boolean; revoked: boolean; lastSeen: number;
  rules: ComputerRule[]; capabilities: ComputerAction[];
  savedPermissions?: { enrollmentId: string; wrappingFingerprint: string;
    identity: { userId: string; serverId: string; deviceId: string; workspaceId: string } };
}
export interface ComputerProof {
  payload: { version: typeof COMPUTER_CONTROL_VERSION; ownerId: string; deviceId: string;
    nonce: string; timestamp: number; method: string; body: Record<string, unknown> };
  signature: string;
}
export interface ComputerProposal {
  id: string; deviceId: string; ownerId: string; revision: number; digest: string;
  taskId: string; instruction: string; createdAt: number; expiresAt: number;
  change: { rule?: ComputerRule; removeRuleId?: string; resume?: boolean; approveRequestId?: string };
  state: 'pending' | 'approved' | 'denied'; summary: string;
  savedPolicyDigest?: string;
}
/** A lease is renewed at most every 3 seconds and expires locally in 10 seconds.
 * A new connection never clears the durable local stopped/takeover latch. */
export const COMPUTER_LEASE_MS = 10_000;
