import { randomBytes } from 'node:crypto';
import { isProtectedControlOrigin, parseWorkspaceStorageChallenge, type WorkspaceStorageChallenge } from '@josi-ce/protocol';
import type { Db } from './db.js';
import { Secret } from './sealing.js';
import { appendEvent } from './events.js';
import { VaultRecordError, type VaultRecordReference, type VaultRecordValue } from './vaultRecords.js';
import type { ProtectedConfirmationIdentity } from './protectedConfirmations.js';

export const WORKSPACE_STORAGE_RECORD_ID = 'bf92b450-03f7-4588-81b9-e23ff24a39e1';
export interface WorkspaceStorageSummary {
  workspaceId: string; identity: ProtectedConfirmationIdentity; label: string; capacityGiB: number; createdAt: string;
}
interface Entry extends WorkspaceStorageSummary { imagePassword: string }
interface Context {
  tx: Db; epoch: number; reconciliationRequired: boolean;
  read(): Promise<VaultRecordValue | null>;
  write(value: Secret): Promise<VaultRecordReference>;
}
type Backend = <T>(actor: string, writing: boolean, work: (context: Context) => Promise<T>) => Promise<T>;
export interface WorkspaceStorageAuthority {
  /** Trusted assembly verifies the live session, current enrolled hardware
   * key, one-use challenge and exact request, inside this Vault transaction. */
  verifyRequest(tx: Db, challenge: WorkspaceStorageChallenge, proof: unknown): Promise<void>;
}
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
function decode(record: VaultRecordValue | null): Entry[] {
  if (!record) return [];
  try {
    const value: unknown = JSON.parse(record.value.reveal());
    if (record.kind !== 'workspace_storage' || record.reference.recordId !== WORKSPACE_STORAGE_RECORD_ID
      || !exact(value, ['schemaVersion', 'workspaces']) || value.schemaVersion !== 1
      || !Array.isArray(value.workspaces) || value.workspaces.length > 64) throw new Error();
    const entries = value.workspaces as Entry[];
    for (const e of entries) {
      if (!exact(e, ['workspaceId', 'identity', 'label', 'capacityGiB', 'createdAt', 'imagePassword'])
        || !uuid(e.workspaceId) || !exact(e.identity, ['serverOrigin', 'serverId', 'userId', 'deviceId'])
        || ![e.identity.serverId, e.identity.userId, e.identity.deviceId].every(uuid)
        || !isProtectedControlOrigin(e.identity.serverOrigin)
        || typeof e.label !== 'string' || !e.label || e.label.trim() !== e.label || e.label.length > 120
        || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(e.label)
        || !Number.isSafeInteger(e.capacityGiB) || e.capacityGiB < 64 || e.capacityGiB > 512
        || typeof e.createdAt !== 'string' || !Number.isFinite(Date.parse(e.createdAt))
        || new Date(e.createdAt).toISOString() !== e.createdAt
        || typeof e.imagePassword !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(e.imagePassword)) throw new Error();
    }
    if (new Set(entries.map(e => e.workspaceId)).size !== entries.length) throw new Error();
    return entries;
  } catch { throw new VaultRecordError('The workspace storage Vault record is invalid.'); }
}
function summary(e: Entry): WorkspaceStorageSummary {
  return { workspaceId: e.workspaceId, identity: { ...e.identity }, label: e.label, capacityGiB: e.capacityGiB, createdAt: e.createdAt };
}
export class WorkspaceStorageStore {
  constructor(private readonly backend: Backend, private readonly authority: WorkspaceStorageAuthority) {}
  inventory(actor: string) {
    return this.backend(actor, false, async context => ({
      workspaces: decode(await context.read()).filter(e => e.identity.userId === actor).map(summary),
      reconciliationRequired: context.reconciliationRequired, executionEnabled: false as const,
    }));
  }
  /** Repeating an exact provision request after a lost response returns the
   * same canonical credential. It cannot replace an existing workspace key. */
  authorize(actor: string, challenge: WorkspaceStorageChallenge, proof: unknown) {
    const c = parseWorkspaceStorageChallenge(challenge);
    if (!c || c.userId !== actor) throw new VaultRecordError('Review this exact workspace in the enrolled native app.');
    return this.backend(actor, c.operation === 'provision', async context => {
      if (context.reconciliationRequired || context.epoch !== c.keyReference.epoch) throw new VaultRecordError('Vault authority changed. Review the workspace again.');
      await this.authority.verifyRequest(context.tx, c, proof);
      const entries = decode(await context.read());
      let entry = entries.find(e => e.workspaceId === c.workspaceId);
      if (entry) {
        if (entry.label !== c.label || entry.capacityGiB !== c.capacityGiB
          || ['serverOrigin', 'serverId', 'userId', 'deviceId'].some(k => entry!.identity[k as keyof ProtectedConfirmationIdentity] !== c[k as keyof ProtectedConfirmationIdentity])) {
          throw new VaultRecordError('This workspace already exists with different ownership or storage settings.');
        }
      } else {
        if (c.operation !== 'provision') throw new VaultRecordError('Prepare this workspace’s storage before opening it.');
        if (entries.length >= 64) throw new VaultRecordError('The workspace registry has reached its retained storage limit.');
        entry = { workspaceId: c.workspaceId, label: c.label, capacityGiB: c.capacityGiB, createdAt: new Date().toISOString(),
          identity: { serverOrigin: c.serverOrigin, serverId: c.serverId, userId: actor, deviceId: c.deviceId },
          imagePassword: randomBytes(32).toString('base64url') };
        entries.push(entry);
        await context.write(new Secret(JSON.stringify({ schemaVersion: 1, workspaces: entries })));
      }
      await appendEvent(context.tx, { actorUserId: actor, actor: 'super_admin', kind: 'automation.workspace_storage_authorized',
        subjectType: 'workspace_storage', subjectId: entry.workspaceId, payload: { operation: c.operation, deviceId: c.deviceId } });
      return { workspace: summary(entry), imagePassword: new Secret(entry.imagePassword) };
    });
  }
}
