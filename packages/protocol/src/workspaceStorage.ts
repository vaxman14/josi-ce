import { parseProtectedHostChallenge, type ProtectedHostChallenge } from './protectedHost.js';

/** This authorizes storage provisioning only, never desktop/browser execution.
 * A separate signature domain prevents reuse as a protected-rule approval. */
export interface WorkspaceStorageChallenge extends ProtectedHostChallenge {
  operation: 'provision' | 'open' | 'connect';
  workspaceId: string;
  label: string;
  capacityGiB: number;
}
export function parseWorkspaceStorageChallenge(value: unknown): WorkspaceStorageChallenge | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { operation, workspaceId, label, capacityGiB, ...host } = value as Record<string, unknown>;
  const parsed = parseProtectedHostChallenge(host);
  if (!parsed || !['provision', 'open', 'connect'].includes(String(operation)) || typeof workspaceId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(workspaceId)
    || typeof label !== 'string' || !label || label.trim() !== label || label.length > 120
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(label)
    || !Number.isSafeInteger(capacityGiB)
    || (operation === 'connect' ? capacityGiB !== 0 : Number(capacityGiB) < 64 || Number(capacityGiB) > 512)) return null;
  return { ...parsed, operation: operation as WorkspaceStorageChallenge['operation'], workspaceId, label, capacityGiB: Number(capacityGiB) };
}
export function workspaceStorageMessage(value: WorkspaceStorageChallenge): string {
  const c = parseWorkspaceStorageChallenge(value);
  if (!c) throw new Error('Invalid workspace storage challenge.');
  // Existing VM approvals cannot be replayed to authorize the real desktop.
  return (c.operation === 'connect' ? 'josi-current-desktop.1\n' : 'josi-workspace-storage.1\n') + JSON.stringify([
    c.schemaVersion, c.id, c.nonce, c.serverOrigin, c.serverId, c.userId, c.deviceId,
    [c.keyReference.recordId, c.keyReference.version, c.keyReference.digest, c.keyReference.epoch],
    c.wrappingFingerprint, c.issuedAtMs, c.expiresAtMs, c.operation, c.workspaceId, c.label, c.capacityGiB,
  ]);
}
