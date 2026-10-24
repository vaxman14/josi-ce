import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { reauthenticateProtectedAdmin, type ProtectedAdminProof } from '@josi-ce/auth';
import {
  vaultRecords, Secret, cardinalContentDigest, type Db, type MasterKey, type ProtectedConfirmationIdentity,
  type ProtectedDeviceEnrollment, type ProtectedDeviceCommand, type ProtectedDeviceAuthority,
} from '@josi-ce/core';
import { isProtectedControlOrigin, type DeviceConsentChallenge } from '@josi-ce/protocol';
import { startNativeDeviceConsent, windowsConsentAvailable, type NativeDeviceConsent } from './nativeDeviceConsent.js';
import { ProtectedChangeError } from './protectedChanges.js';

type Records = ReturnType<typeof vaultRecords>;
interface Pending {
  actor: string; session: string; identity: ProtectedConfirmationIdentity; records: Records;
  enrollment: Omit<ProtectedDeviceEnrollment, 'material'>; material: Secret | null;
  command: ProtectedDeviceCommand | null; challenge: DeviceConsentChallenge | null;
  proof: ProtectedAdminProof | null; consent: NativeDeviceConsent | null;
  controller: AbortController; busy: boolean; expires: number; deadline: number;
  previousWall: number; previousMono: number; timer: ReturnType<typeof setTimeout>;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const unavailable = async () => { throw new ProtectedChangeError(503, 'This operation requires its separate protected approval flow.'); };
const helper = '/Applications/Josi.app/Contents/Helpers/JosiDeviceConsentHost';
const control = '/Library/Application Support/Josi CE Server/control';
const sameIdentity = (a: unknown, b: ProtectedConfirmationIdentity) => a && typeof a === 'object'
  && Object.keys(a).length === 4 && ['serverOrigin', 'serverId', 'userId', 'deviceId']
    .every(k => (a as Record<string, unknown>)[k] === b[k as keyof ProtectedConfirmationIdentity]);

/** Bootstrap coordination, not another key store. Uncommitted wrapped material,
 * fresh-account proof and local consent live only for this attempt in memory.
 * Only the guarded Vault transaction can create a canonical enrollment. */
export class DeviceEnrollments {
  private readonly pending = new Map<string, Pending>();
  private readonly beginning = new Set<string>();
  constructor(private readonly db: Db, private readonly master: () => MasterKey, private readonly origin: string) {}
  async available(): Promise<boolean> {
    if (!isProtectedControlOrigin(this.origin)) return false;
    // Item 29: on Windows the server starts the Josi app in its consent mode
    // on the server's own screen (see nativeDeviceConsent.ts).
    if (process.platform === 'win32') return windowsConsentAvailable();
    if (process.platform !== 'darwin') return false;
    try {
      const [file, directory] = await Promise.all([lstat(helper), lstat(control)]);
      return file.isFile() && !file.isSymbolicLink() && file.uid === 0 && !(file.mode & 0o022)
        && directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid?.()
        && directory.uid > 0 && !(directory.mode & 0o022) && await realpath(helper) === helper && await realpath(control) === control;
    } catch { return false; }
  }
  private async installation(tx: Db) {
    const rows = await tx.query<{ installation_id: string }>('select install_id as installation_id from install_identity where id=true for share');
    if (!isProtectedControlOrigin(this.origin) || rows.length !== 1 || !uuid(rows[0].installation_id)) {
      throw new ProtectedChangeError(409, 'Configure this server’s HTTPS or loopback origin before enrolling a device.');
    }
    return rows[0].installation_id;
  }
  private async server(tx: Db, identity: Readonly<ProtectedConfirmationIdentity>) {
    if (identity.serverOrigin !== this.origin || identity.serverId !== await this.installation(tx)) {
      throw new ProtectedChangeError(409, 'The device does not match this server installation.');
    }
  }
  private async account(actor: string, session: string) {
    if (!uuid(actor) || !uuid(session) || !this.db.transaction) throw new ProtectedChangeError(403, 'An active administrator sign-in is required.');
    return this.db.transaction(async tx => {
      const serverId = await this.installation(tx);
      const rows = await tx.query(`select s.id from sessions s join users u on u.id=s.user_id
        where s.id=$1 and s.user_id=$2 and s.revoked_at is null and s.expires_at>now()
          and u.role='super_admin' and u.status='active' for share of s,u`, [session, actor]);
      if (rows.length !== 1) throw new ProtectedChangeError(403, 'An active administrator sign-in is required.');
      return serverId;
    });
  }
  private authority(): ProtectedDeviceAuthority {
    return { requireServerIdentity: (tx, identity) => this.server(tx, identity), verifyFreshAdministrator: unavailable,
      verifyEnrollmentConsent: unavailable, verifyProtectedRevocation: unavailable, verifyHostProjection: unavailable };
  }
  private forget(id: string) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id); clearTimeout(entry.timer);
    entry.controller.abort(); entry.consent?.close();
    entry.material = null; entry.proof = null; entry.consent = null;
  }
  private live(id: string, entry: Pending) {
    const wall = Date.now(), mono = performance.now();
    if (this.pending.get(id) !== entry || entry.controller.signal.aborted || wall < entry.previousWall || mono < entry.previousMono
      || wall >= entry.expires || mono >= entry.deadline) {
      this.forget(id); throw new ProtectedChangeError(409, 'This enrollment ended or expired. Start again with a new device identity.');
    }
    entry.previousWall = wall; entry.previousMono = mono;
  }
  private prune() {
    for (const [id, entry] of this.pending) { try { this.live(id, entry); } catch { /* Expired attempt removed. */ } }
  }
  private owned(actor: string, session: string, id: string, initiatingSession = true) {
    this.prune();
    const entry = this.pending.get(id);
    if (!entry || entry.actor !== actor || initiatingSession && entry.session !== session || !uuid(id)) {
      throw new ProtectedChangeError(409, 'This enrollment is unavailable for this administrator sign-in.');
    }
    if (entry.busy) throw new ProtectedChangeError(409, 'This enrollment already has a request in progress.');
    this.live(id, entry);
    return entry;
  }
  async begin(actor: string, session: string, label: unknown) {
    this.prune();
    if (typeof label !== 'string' || !label.trim() || label !== label.trim() || label.length > 120
      || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(label)) throw new ProtectedChangeError(400, 'Give this computer a clear name, up to 120 characters.');
    if (this.beginning.has(actor) || [...this.pending.values()].some(p => p.actor === actor)) throw new ProtectedChangeError(409, 'Finish or cancel your existing device enrollment first.');
    if (this.pending.size + this.beginning.size >= 32) throw new ProtectedChangeError(429, 'Device enrollment is busy. Wait for a current request to end.');
    this.beginning.add(actor);
    try {
      if (!await this.available()) throw new ProtectedChangeError(503, 'Device enrollment needs the Josi app installed on the computer that runs this server, where the request is approved.');
      const serverId = await this.account(actor, session), records = vaultRecords(this.db, this.master());
      const inventory = await records.protectedDevices(this.authority()).inventory(actor);
      if (inventory.reconciliationRequired) throw new ProtectedChangeError(409, 'Reconcile the Vault before enrolling a device.');
      const wall = Date.now(), mono = performance.now(), id = randomUUID(), identity = {
        serverOrigin: this.origin, serverId, userId: actor, deviceId: randomUUID(),
      };
      const expires = wall + 120_000, timer = setTimeout(() => this.forget(id), 120_000); timer.unref();
      const entry: Pending = { actor, session, identity, records,
        enrollment: { actorUserId: actor, enrollmentId: randomUUID(), label, expected: inventory.reference, epoch: inventory.authorityEpoch },
        material: null, command: null, challenge: null, proof: null, consent: null, controller: new AbortController(),
        busy: false, expires, deadline: mono + 120_000, previousWall: wall, previousMono: mono, timer };
      this.pending.set(id, entry);
      return { attemptId: id, identity: { ...identity }, enrollmentId: entry.enrollment.enrollmentId, expiresAtMs: expires };
    } finally { this.beginning.delete(actor); }
  }
  async prepare(args: { actor: string; session: string; id: string; material: unknown; password: string; mfaCode?: string }) {
    const entry = this.owned(args.actor, args.session, args.id); entry.busy = true;
    try {
      if (entry.material || entry.challenge || !args.material || typeof args.material !== 'object'
        || !sameIdentity((args.material as Record<string, unknown>).identity, entry.identity)) {
        throw new ProtectedChangeError(400, 'Use the new native material for this exact enrollment attempt.');
      }
      const encoded = JSON.stringify(args.material);
      if (encoded.length > 16_384) throw new ProtectedChangeError(400, 'Invalid native enrollment material.');
      entry.material = new Secret(encoded);
      const store = entry.records.protectedDevices(this.authority());
      const review = await store.prepareEnrollment({ ...entry.enrollment, material: entry.material });
      entry.proof = await reauthenticateProtectedAdmin(this.db, this.master(), { ...review.command,
        userId: args.actor, sessionId: args.session, password: args.password, mfaCode: args.mfaCode });
      this.live(args.id, entry);
      // Reopen after authentication; MFA migration or concurrent Vault changes
      // must not silently rebind the just-reviewed enrollment.
      const current = await store.prepareEnrollment({ ...entry.enrollment, material: entry.material });
      if (cardinalContentDigest(current) !== cardinalContentDigest(review)) throw new ProtectedChangeError(409, 'Enrollment authority changed. Review a new attempt.');
      entry.command = review.command;
      entry.challenge = { schemaVersion: 1, id: args.id, nonce: randomBytes(32).toString('base64url'), ...entry.identity,
        enrollmentId: entry.enrollment.enrollmentId, requestDigest: review.command.requestDigest, authorityEpoch: entry.enrollment.epoch,
        issuedAtMs: Date.now(), expiresAtMs: entry.expires, presentation: review.presentation };
      entry.consent = await startNativeDeviceConsent(entry.challenge, entry.controller.signal);
      this.live(args.id, entry);
      return { challenge: structuredClone(entry.challenge), challengeDigest: entry.consent.challengeDigest };
    } catch (error) { this.forget(args.id); throw error; }
    finally { entry.busy = false; }
  }
  private async current(id: string, entry: Pending) {
    this.live(id, entry);
    if (!entry.material || !entry.proof || !entry.command || !entry.challenge || !entry.consent || !this.db.transaction) {
      throw new ProtectedChangeError(409, 'Finish preparing this exact enrollment first.');
    }
    await this.db.transaction(async tx => {
      await this.server(tx, entry.identity);
      await entry.proof!.check(tx, { ...entry.command!, actorUserId: entry.actor, consume: false });
    });
    const review = await entry.records.protectedDevices(this.authority()).prepareEnrollment({ ...entry.enrollment, material: entry.material });
    if (review.command.requestDigest !== entry.command.requestDigest
      || cardinalContentDigest(review.presentation) !== cardinalContentDigest(entry.challenge.presentation)) {
      throw new ProtectedChangeError(409, 'The enrollment changed. Start a new review.');
    }
    this.live(id, entry);
  }
  async status(actor: string, session: string, id: string) {
    const entry = this.owned(actor, session, id); entry.busy = true;
    try {
      await this.current(id, entry);
      return { state: entry.consent!.status(), expiresAtMs: entry.expires };
    } finally { entry.busy = false; }
  }
  async review(actor: string, session: string, id: string) {
    // A separate sign-in by the same administrator on the server Mac may open
    // the local review. It cannot obtain the initiating session or commit key.
    const entry = this.owned(actor, session, id, false); entry.busy = true;
    try {
      await this.account(actor, session); await this.current(id, entry);
      return { id, identity: { ...entry.identity }, challengeDigest: entry.consent!.challengeDigest, expiresAtMs: entry.expires };
    } finally { entry.busy = false; }
  }
  async list(actor: string, session: string) {
    this.prune();
    if (!this.pending.size) return [];
    await this.account(actor, session);
    return [...this.pending].filter(([, entry]) => entry.actor === actor && entry.challenge && entry.consent && !entry.busy)
      .map(([id, entry]) => ({ id, label: entry.enrollment.label, identity: { ...entry.identity },
        state: entry.consent!.status(), expiresAtMs: entry.expires, canCancel: entry.session === session }));
  }
  async commit(actor: string, session: string, id: string, possessionSignature: unknown) {
    const entry = this.owned(actor, session, id); entry.busy = true;
    try {
      await this.current(id, entry);
      if (typeof possessionSignature !== 'string') throw new ProtectedChangeError(400, 'A native enrollment possession signature is required.');
      const expected = entry.challenge!, command = entry.command!, proof = entry.proof!, consent = entry.consent!;
      const store = entry.records.protectedDevices({ ...this.authority(),
        verifyFreshAdministrator: (tx, actorUserId, binding) => proof.check(tx, { ...binding, actorUserId, consume: true }),
        verifyEnrollmentConsent: async (_tx, actorUserId, binding, presentation) => {
          if (actorUserId !== actor || binding.purpose !== command.purpose || binding.requestDigest !== command.requestDigest
            || cardinalContentDigest(presentation) !== cardinalContentDigest(expected.presentation)) throw new ProtectedChangeError(409, 'Consent does not match this enrollment.');
          this.live(id, entry); consent.consume(expected);
        },
      });
      const inventory = await store.enroll({ ...entry.enrollment, material: entry.material!, possessionSignature, consentProof: undefined });
      // Read through the same canonical inventory used by the device picker
      // after the write transaction commits. Do not acknowledge an enrollment
      // based only on an in-transaction result that the client cannot display.
      const confirmed = await entry.records.protectedDevices(this.authority()).inventory(actor);
      const saved = confirmed.devices.find(device => device.enrollmentId === entry.enrollment.enrollmentId
        && device.identity.deviceId === entry.identity.deviceId && device.revokedAt === null);
      if (!saved || !confirmed.reference || !inventory.reference
        || confirmed.reference.version < inventory.reference.version) {
        throw new ProtectedChangeError(409, 'The enrollment was saved, but the current device list could not confirm it. Refresh Saved Devices before starting another enrollment.');
      }
      return { enrolled: true as const, deviceId: entry.identity.deviceId, enrollmentId: entry.enrollment.enrollmentId,
        reference: confirmed.reference, inventory: confirmed };
    } finally {
      // Even a lost commit result or a rollback discards this transient attempt.
      // Never retry a commit automatically or silently replace a hardware root.
      this.forget(id); entry.busy = false;
    }
  }
  cancel(actor: string, session: string, id: string) {
    this.owned(actor, session, id); this.forget(id); return { cancelled: true };
  }
}
