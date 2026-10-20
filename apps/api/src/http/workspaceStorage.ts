import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { vaultRecords, type Db, type MasterKey, type ProtectedConfirmationIdentity } from '@josi-ce/core';
import { isProtectedControlOrigin, parseWorkspaceStorageChallenge, workspaceStorageMessage, type WorkspaceStorageChallenge } from '@josi-ce/protocol';
import { ProtectedChangeError } from './protectedChanges.js';

interface Pending {
  actor: string; session: string; challenge: WorkspaceStorageChallenge;
  deadline: number; previousWall: number; busy: boolean; timer: ReturnType<typeof setTimeout>;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const denied = async () => { throw new ProtectedChangeError(403, 'Use the separate protected administration flow.'); };
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Transient, one-use hardware challenges. Canonical configuration and
 * image passwords belong exclusively to the encrypted Vault. No model route. */
export class WorkspaceStorage {
  private pending = new Map<string, Pending>();
  private preparing = new Set<string>();
  constructor(private db: Db, private master: () => MasterKey, private origin: string) {}
  private async account(tx: Db, actor: string, session: string) {
    if (!uuid(actor) || !uuid(session)) throw new ProtectedChangeError(403, 'Sign in as the administrator again.');
    const rows = await tx.query(`select s.id from sessions s join users u on u.id=s.user_id
      where s.id=$1 and s.user_id=$2 and s.revoked_at is null and s.expires_at>now()
      and u.role='super_admin' and u.status='active' for share of s,u`, [session, actor]);
    if (rows.length !== 1) throw new ProtectedChangeError(403, 'Sign in as the administrator again.');
  }
  private async server(tx: Db, identity: Readonly<ProtectedConfirmationIdentity>) {
    const rows = await tx.query<{ installation_id: string }>('select installation_id from workspace limit 2 for share');
    if (!isProtectedControlOrigin(this.origin) || identity.serverOrigin !== this.origin || rows.length !== 1
      || rows[0].installation_id !== identity.serverId) throw new ProtectedChangeError(409, 'The enrolled Mac does not match this server.');
  }
  private records(actor: string, session: string) {
    return vaultRecords(this.db, this.master(), async (tx, owner) => {
      if (owner !== actor) throw new ProtectedChangeError(403, 'Workspace owner changed.');
      await this.account(tx, actor, session);
    });
  }
  private devices(records: ReturnType<typeof vaultRecords>) {
    return records.protectedDevices({ requireServerIdentity: (tx, identity) => this.server(tx, identity),
      verifyFreshAdministrator: denied, verifyEnrollmentConsent: denied, verifyProtectedRevocation: denied, verifyHostProjection: denied });
  }
  inventory(actor: string, session: string) {
    return this.records(actor, session).workspaceStorage({ verifyProvision: denied }).inventory(actor);
  }
  private forget(id: string) {
    const p = this.pending.get(id);
    if (p) clearTimeout(p.timer);
    this.pending.delete(id);
  }
  private live(p: Pending) {
    const wall = Date.now();
    if (this.pending.get(p.challenge.id) !== p || wall < p.previousWall || wall >= p.challenge.expiresAtMs || performance.now() >= p.deadline) {
      this.forget(p.challenge.id);
      throw new ProtectedChangeError(409, 'This storage request expired. Review it again in the native app.');
    }
    p.previousWall = wall;
  }
  async prepare(actor: string, session: string, input: unknown) {
    for (const p of this.pending.values()) { try { this.live(p); } catch { /* Pruned. */ } }
    if (!exact(input, ['deviceId', 'workspaceId', 'label', 'capacityGiB']) || !uuid(input.deviceId)) {
      throw new ProtectedChangeError(400, 'Choose an enrolled Mac, workspace name and capacity.');
    }
    if (this.preparing.has(actor) || [...this.pending.values()].some(p => p.actor === actor)) throw new ProtectedChangeError(409, 'Finish or cancel the current storage request first.');
    if (this.pending.size + this.preparing.size >= 32) throw new ProtectedChangeError(429, 'Workspace setup is busy. Try again shortly.');
    this.preparing.add(actor);
    try {
      const inventory = await this.devices(this.records(actor, session)).inventory(actor);
      const device = inventory.devices.find(d => d.identity.deviceId === input.deviceId && !d.revokedAt);
      if (!device || !inventory.reference || inventory.reconciliationRequired || device.identity.serverOrigin !== this.origin) {
        throw new ProtectedChangeError(409, 'Choose an active enrolled Mac with an unlocked, reconciled Vault.');
      }
      const now = Date.now();
      const challenge = parseWorkspaceStorageChallenge({ schemaVersion: 1, id: randomUUID(), nonce: randomBytes(32).toString('base64url'),
        ...device.identity, keyReference: inventory.reference, wrappingFingerprint: device.wrappingFingerprint,
        issuedAtMs: now, expiresAtMs: now + 60_000, operation: 'provision',
        workspaceId: input.workspaceId, label: input.label, capacityGiB: input.capacityGiB });
      if (!challenge) throw new ProtectedChangeError(400, 'Use a clear name of up to 120 characters and capacity from 64 to 512 GiB.');
      const timer = setTimeout(() => this.forget(challenge.id), 60_000); timer.unref();
      this.pending.set(challenge.id, { actor, session, challenge, deadline: performance.now() + 60_000, previousWall: now, busy: false, timer });
      return { challenge };
    } finally { this.preparing.delete(actor); }
  }
  private owned(actor: string, session: string, id: string) {
    const p = this.pending.get(id);
    if (!uuid(id) || !p || p.actor !== actor || p.session !== session || p.busy) throw new ProtectedChangeError(409, 'This storage request is unavailable for this sign-in.');
    this.live(p); return p;
  }
  cancel(actor: string, session: string, id: string) {
    this.owned(actor, session, id); this.forget(id); return { cancelled: true };
  }
  async provision(actor: string, session: string, id: string, proof: unknown) {
    const p = this.owned(actor, session, id); p.busy = true;
    try {
      const records = this.records(actor, session), devices = this.devices(records);
      const result = await records.workspaceStorage({ verifyProvision: async (tx, c, receipt) => {
        this.live(p);
        if (workspaceStorageMessage(c) !== workspaceStorageMessage(p.challenge) || !exact(receipt, ['challengeDigest', 'signature'])
          || receipt.challengeDigest !== hash(workspaceStorageMessage(c)) || typeof receipt.signature !== 'string'
          || !/^[A-Za-z0-9_-]{11,96}$/.test(receipt.signature)) throw new ProtectedChangeError(403, 'The native storage proof did not match.');
        const identity = { serverOrigin: c.serverOrigin, serverId: c.serverId, userId: c.userId, deviceId: c.deviceId };
        const current = await devices.resolveDeviceKey(tx, identity), ref = current.reference, expected = c.keyReference;
        const raw = Buffer.from(current.wrappingPublicKey, 'base64'), signature = Buffer.from(receipt.signature, 'base64url');
        if (ref.recordId !== expected.recordId || ref.version !== expected.version || ref.digest !== expected.digest || ref.epoch !== expected.epoch
          || raw.length !== 65 || raw[0] !== 4 || hash(raw) !== c.wrappingFingerprint
          || signature.length < 8 || signature.length > 72 || signature.toString('base64url') !== receipt.signature) {
          throw new ProtectedChangeError(409, 'The enrolled Mac or Vault changed. Review storage setup again.');
        }
        const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
          x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
        if (!verify('sha256', Buffer.from(workspaceStorageMessage(c)), key, signature)) throw new ProtectedChangeError(403, 'Authenticate with the enrolled Mac’s hardware key.');
        this.live(p);
      } }).provision(actor, p.challenge, proof);
      this.live(p);
      // This deliberate native-only projection must never reach logs/chat.
      // The typed Secret still redacts accidental serialization elsewhere.
      return { schemaVersion: 1, challengeId: id, workspace: result.workspace, expiresAtMs: p.challenge.expiresAtMs,
        imagePassword: result.imagePassword.reveal(), executionEnabled: false };
    } finally { this.forget(id); }
  }
}
