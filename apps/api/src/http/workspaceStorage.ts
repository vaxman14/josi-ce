import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { vaultRecords, openAutomationPresence, renewAutomationPresence, closeAutomationPresence, parseAutomationPresence,
  type Db, type MasterKey, type ProtectedConfirmationIdentity, type VaultRecordReference } from '@josi-ce/core';
import { isProtectedControlOrigin, parseWorkspaceStorageChallenge, workspaceStorageMessage, type WorkspaceStorageChallenge,
  parseAutomationConsentChallenge, automationConsentMessage, type AutomationConsentChallenge } from '@josi-ce/protocol';
import { ProtectedChangeError } from './protectedChanges.js';

interface Pending {
  actor: string; session: string; challenge: WorkspaceStorageChallenge;
  deadline: number; previousWall: number; busy: boolean; timer: ReturnType<typeof setTimeout>;
}
interface OpenSession {
  id: string; actor: string; session: string; identity: ProtectedConfirmationIdentity; reference: VaultRecordReference;
  workspaceId: string; deadline: number; expires: number; leaseUntil: number; leaseDeadline: number; previousWall: number;
  label: string; consent: VaultRecordReference | null; consentGeneration: number;
  nativeGeneration: number | null; applicationSelection: { applicationId: string; installationRevision: number } | null;
}
interface PendingConsent {
  owner: OpenSession; challenge: AutomationConsentChallenge; generation: number;
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
  private opened = new Map<string, OpenSession>();
  private consents = new Map<string, PendingConsent>();
  private consentPreparing = new Set<string>();
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
    return this.records(actor, session).workspaceStorage({ verifyRequest: denied }).inventory(actor);
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
    this.pruneOpened();
    if (!exact(input, ['operation', 'deviceId', 'workspaceId', 'label', 'capacityGiB']) || !uuid(input.deviceId)
      || !['provision', 'open'].includes(String(input.operation))) {
      throw new ProtectedChangeError(400, 'Choose an enrolled Mac, workspace name and capacity.');
    }
    if (input.operation === 'open' && [...this.opened.values()].some(s => s.actor === actor && s.identity.deviceId === input.deviceId)) {
      throw new ProtectedChangeError(409, 'Close this Mac’s existing workspace session before opening another.');
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
        issuedAtMs: now, expiresAtMs: now + 60_000, operation: input.operation,
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
  async authorize(actor: string, session: string, id: string, proof: unknown, operation: 'provision' | 'open') {
    const p = this.owned(actor, session, id); p.busy = true;
    try {
      if (p.challenge.operation !== operation) throw new ProtectedChangeError(403, 'Use the exact reviewed storage operation.');
      const records = this.records(actor, session), devices = this.devices(records);
      const result = await records.workspaceStorage({ verifyRequest: async (tx, c, receipt) => {
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
      } }).authorize(actor, p.challenge, proof);
      this.live(p);
      let opened: { sessionId: string; expiresAtMs: number; leaseUntilMs: number } | null = null;
      if (operation === 'open') {
        this.pruneOpened();
        if (this.opened.size >= 32 || [...this.opened.values()].some(s => s.actor === actor && s.identity.deviceId === p.challenge.deviceId)) {
          throw new ProtectedChangeError(409, 'Close the existing workspace session first.');
        }
        const wall = Date.now(), mono = performance.now(), c = p.challenge, sessionId = randomUUID();
        const s: OpenSession = { id: sessionId, actor, session, identity: {
          serverOrigin: c.serverOrigin, serverId: c.serverId, userId: c.userId, deviceId: c.deviceId,
        }, reference: c.keyReference, workspaceId: c.workspaceId, expires: wall + 2 * 60 * 60_000,
          deadline: mono + 2 * 60 * 60_000, leaseUntil: wall + 10_000, leaseDeadline: mono + 10_000, previousWall: wall,
          label: c.label, consent: null, consentGeneration: 0, nativeGeneration: null, applicationSelection: null };
        this.opened.set(sessionId, s);
        try {
          await openAutomationPresence(this.db, { identity: { userId: actor, serverId: c.serverId,
            deviceId: c.deviceId, workspaceId: c.workspaceId }, storageSessionId: sessionId, authSessionId: session,
            authorityEpoch: s.reference.epoch, label: c.label, leaseUntilMs: s.leaseUntil });
          this.openedLive(s);
        } catch (error) { this.opened.delete(sessionId); throw error; }
        opened = { sessionId, expiresAtMs: s.expires, leaseUntilMs: s.leaseUntil };
      }
      // This deliberate native-only projection must never reach logs/chat.
      // The typed Secret still redacts accidental serialization elsewhere.
      return { schemaVersion: 1, challengeId: id, workspace: result.workspace, expiresAtMs: p.challenge.expiresAtMs,
        imagePassword: result.imagePassword.reveal(), executionEnabled: false, ...(opened ? { openSession: opened } : {}) };
    } finally { this.forget(id); }
  }
  private openedLive(s: OpenSession) {
    const wall = Date.now(), mono = performance.now();
    if (this.opened.get(s.id) !== s || wall < s.previousWall || wall >= s.expires || mono >= s.deadline
      || wall >= s.leaseUntil || mono >= s.leaseDeadline) {
      this.opened.delete(s.id);
      throw new ProtectedChangeError(409, 'The desktop connection ended. Close the workspace and authenticate again.');
    }
    s.previousWall = wall;
  }
  private pruneOpened() {
    for (const s of this.opened.values()) { try { this.openedLive(s); } catch { /* No credential retained. */ } }
  }
  private session(actor: string, session: string, id: string) {
    const s = this.opened.get(id);
    if (!uuid(id) || !s || s.actor !== actor || s.session !== session) {
      throw new ProtectedChangeError(409, 'The desktop connection is unavailable.');
    }
    this.openedLive(s); return s;
  }
  private consentIdentity(s: OpenSession) {
    return { userId: s.actor, serverId: s.identity.serverId, deviceId: s.identity.deviceId, workspaceId: s.workspaceId };
  }
  private forgetConsent(id: string) {
    const p = this.consents.get(id);
    if (p) clearTimeout(p.timer);
    this.consents.delete(id);
  }
  private liveConsent(p: PendingConsent) {
    this.openedLive(p.owner);
    const now = Date.now();
    if (this.consents.get(p.challenge.id) !== p || p.generation !== p.owner.consentGeneration
      || now < p.previousWall || now >= p.challenge.expiresAtMs || performance.now() >= p.deadline) {
      this.forgetConsent(p.challenge.id);
      throw new ProtectedChangeError(409, 'Local automation approval expired. Review it again on the enrolled Mac.');
    }
    p.previousWall = now;
  }
  private consentStore(s: OpenSession, pending?: PendingConsent) {
    const records = this.records(s.actor, s.session), devices = this.devices(records);
    return records.automationConsent({
      requireConnection: async (tx, c) => {
        this.openedLive(s);
        if (c.storageSessionId !== s.id || c.workspaceId !== s.workspaceId || c.label !== s.label
          || c.consentUntilMs !== s.expires || ['userId', 'serverId', 'serverOrigin', 'deviceId']
            .some(k => c[k as keyof typeof s.identity] !== s.identity[k as keyof typeof s.identity])) {
          throw new ProtectedChangeError(409, 'The reviewed desktop connection changed.');
        }
        const current = await devices.resolveDeviceKey(tx, s.identity), a = current.reference, b = c.keyReference;
        if ([s.reference, b].some(r => r.recordId !== a.recordId || r.version !== a.version || r.digest !== a.digest || r.epoch !== a.epoch)
          || hash(Buffer.from(current.wrappingPublicKey, 'base64')) !== c.wrappingFingerprint) {
          throw new ProtectedChangeError(409, 'Vault authority changed. Reopen this desktop.');
        }
        this.openedLive(s);
      },
      verifyLocalHuman: async (tx, c, proof) => {
        if (!pending) throw new ProtectedChangeError(403, 'Use a fresh local automation approval.');
        this.liveConsent(pending);
        const message = automationConsentMessage(c);
        if (message !== automationConsentMessage(pending.challenge) || !exact(proof, ['challengeDigest', 'signature'])
          || proof.challengeDigest !== hash(message) || typeof proof.signature !== 'string'
          || !/^[A-Za-z0-9_-]{11,96}$/.test(proof.signature)) throw new ProtectedChangeError(403, 'The local automation proof did not match.');
        const current = await devices.resolveDeviceKey(tx, s.identity);
        const raw = Buffer.from(current.wrappingPublicKey, 'base64'), signature = Buffer.from(proof.signature, 'base64url');
        if (raw.length !== 65 || raw[0] !== 4 || hash(raw) !== c.wrappingFingerprint
          || signature.length < 8 || signature.length > 72 || signature.toString('base64url') !== proof.signature) {
          throw new ProtectedChangeError(403, 'The enrolled hardware key did not match.');
        }
        const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
          x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
        if (!verify('sha256', Buffer.from(message), key, signature)) throw new ProtectedChangeError(403, 'Authenticate on the enrolled Mac.');
        this.liveConsent(pending);
      },
    });
  }
  private nativeTransport(actor: string, session: string) {
    return this.records(actor, session).nativeAutomation({ requireNativeConnection: async (_tx, c) => {
      const s = this.session(actor, session, c.storageSessionId), ref = s.consent;
      if (!ref || c.authSessionId !== session || s.nativeGeneration !== c.generation
        || c.leaseUntilMs > s.leaseUntil || c.identity.userId !== actor || c.identity.workspaceId !== s.workspaceId
        || c.identity.serverId !== s.identity.serverId || c.identity.deviceId !== s.identity.deviceId
        || ref.recordId !== c.consent.recordId || ref.version !== c.consent.version
        || ref.digest !== c.consent.digest || ref.epoch !== c.consent.epoch
        || s.applicationSelection?.applicationId !== c.applicationId
        || s.applicationSelection.installationRevision !== c.installationRevision) {
        throw new ProtectedChangeError(409, 'This native automation connection changed.');
      }
    } });
  }
  async nextNativeCommand(actor: string, session: string, id: string) {
    this.session(actor, session, id);
    const command = await this.nativeTransport(actor, session).take(actor, id);
    this.session(actor, session, id);
    return { command };
  }
  async permitNativeCommand(actor: string, session: string, id: string, query: unknown) {
    this.session(actor, session, id);
    if (!exact(query, ['kind', 'commandId', 'reservationId', 'commandDigest', 'target', 'targetDigest', 'consentDigest'])
      || !uuid(query.reservationId)) throw new ProtectedChangeError(400, 'Use the exact pending native command.');
    const transport = this.nativeTransport(actor, session);
    const records = this.records(actor, session).automationReservations({
      verifyDispatch: async (tx, context, proof) => {
        if (proof !== query) throw new ProtectedChangeError(403, 'Use the native permit route.');
        await transport.permit(tx, context, id, query);
        this.session(actor, session, id);
      },
      verifyOutcome: denied,
    });
    const result = await records.confirmNativeDispatch(actor, query.reservationId, query);
    this.session(actor, session, id);
    return { kind: 'permit', commandId: query.commandId, reservationId: query.reservationId,
      commandDigest: query.commandDigest, targetDigest: query.targetDigest, consentDigest: query.consentDigest,
      expiresAtMs: String(result.expiresAtMs) };
  }
  async reportNativeCommand(actor: string, session: string, id: string, receipt: unknown) {
    this.session(actor, session, id);
    return this.nativeTransport(actor, session).report(actor, id, receipt);
  }
  async prepareConsent(actor: string, session: string, id: string, input: unknown) {
    const s = this.session(actor, session, id);
    if (!exact(input, ['guestBootId', 'guestChannelId']) || !uuid(input.guestBootId) || !uuid(input.guestChannelId)) {
      throw new ProtectedChangeError(400, 'Connect and compare codes with this desktop’s companion first.');
    }
    for (const p of this.consents.values()) { try { this.liveConsent(p); } catch { /* Pruned. */ } }
    if (s.consent || this.consentPreparing.has(id) || [...this.consents.values()].some(p => p.owner === s)) {
      throw new ProtectedChangeError(409, 'Finish or stop this desktop’s current automation approval first.');
    }
    if (this.consents.size + this.consentPreparing.size >= 32) throw new ProtectedChangeError(429, 'Local approval is busy.');
    this.consentPreparing.add(id);
    const generation = s.consentGeneration;
    try {
      const policies = await this.consentStore(s).policies(actor, this.consentIdentity(s), id);
      const inventory = await this.devices(this.records(actor, session)).inventory(actor);
      const device = inventory.devices.find(d => d.identity.deviceId === s.identity.deviceId && !d.revokedAt);
      this.openedLive(s);
      if (!device || !inventory.reference || inventory.reconciliationRequired || generation !== s.consentGeneration) {
        throw new ProtectedChangeError(409, 'The local automation request changed.');
      }
      const now = Date.now();
      const challenge = parseAutomationConsentChallenge({ schemaVersion: 1, id: randomUUID(), nonce: randomBytes(32).toString('base64url'),
        ...s.identity, keyReference: inventory.reference, wrappingFingerprint: device.wrappingFingerprint,
        issuedAtMs: now, expiresAtMs: now + 60_000, workspaceId: s.workspaceId, label: s.label, storageSessionId: s.id,
        guestBootId: input.guestBootId, guestChannelId: input.guestChannelId, consentUntilMs: s.expires, ...policies });
      if (!challenge || challenge.keyReference.epoch !== s.reference.epoch) {
        throw new ProtectedChangeError(409, 'This desktop’s authority changed or its session is ending. Close and reopen it.');
      }
      const timer = setTimeout(() => this.forgetConsent(challenge.id), 60_000); timer.unref();
      this.consents.set(challenge.id, { owner: s, challenge, generation, previousWall: now,
        deadline: performance.now() + 60_000, busy: false, timer });
      return { challenge };
    } finally { this.consentPreparing.delete(id); }
  }
  async authorizeConsent(actor: string, session: string, id: string, input: unknown) {
    const s = this.session(actor, session, id);
    if (!exact(input, ['challengeId', 'proof']) || !uuid(input.challengeId)) throw new ProtectedChangeError(400, 'Review the local approval again.');
    const p = this.consents.get(input.challengeId);
    if (!p || p.owner !== s || p.busy) throw new ProtectedChangeError(409, 'This local approval is unavailable.');
    this.liveConsent(p); p.busy = true;
    try {
      const result = await this.consentStore(s, p).grant(actor, p.challenge, input.proof);
      this.liveConsent(p);
      s.consent = result.reference;
      return { schemaVersion: 1, sessionId: s.id, challengeId: p.challenge.id, identity: this.consentIdentity(s),
        guestBootId: p.challenge.guestBootId, guestChannelId: p.challenge.guestChannelId, ...result,
        leaseUntilMs: s.leaseUntil, executionEnabled: false };
    } finally { this.forgetConsent(p.challenge.id); }
  }
  async stopConsent(actor: string, session: string, id: string) {
    const s = this.session(actor, session, id);
    // Volatile revocation precedes DB work, so lock/failure cannot keep input enabled.
    s.consent = null; s.consentGeneration += 1; s.nativeGeneration = null;
    for (const p of this.consents.values()) if (p.owner === s) this.forgetConsent(p.challenge.id);
    await this.consentStore(s).stop(actor, this.consentIdentity(s), id);
    await this.nativeTransport(actor, session).stop(actor, id);
    return { stopped: true };
  }
  cancelConsent(actor: string, session: string, id: string, challengeId: unknown) {
    const s = this.session(actor, session, id), p = typeof challengeId === 'string' ? this.consents.get(challengeId) : undefined;
    if (p && p.owner !== s) throw new ProtectedChangeError(403, 'This review belongs to another desktop.');
    if (p) this.forgetConsent(p.challenge.id);
    return { cancelled: true };
  }
  /** One canonical app pin for this hardware-authenticated open workspace.
   * Does not renew the lease, authorize observation or grant native input. */
  async application(actor: string, session: string, id: string, input: unknown) {
    if (!exact(input, ['applicationId', 'installationRevision']) || !uuid(input.applicationId)
      || !Number.isSafeInteger(input.installationRevision) || Number(input.installationRevision) < 1) {
      throw new ProtectedChangeError(400, 'Choose the registered application and installation revision.');
    }
    const s = this.opened.get(id);
    if (!uuid(id) || !s || s.actor !== actor || s.session !== session || !this.db.transaction) {
      throw new ProtectedChangeError(409, 'The desktop connection is unavailable.');
    }
    try {
      this.openedLive(s);
      const records = this.records(actor, session);
      const identity = { userId: actor, serverId: s.identity.serverId, deviceId: s.identity.deviceId, workspaceId: s.workspaceId };
      const result = await this.db.transaction(async tx => {
        const current = await this.devices(records).resolveDeviceKey(tx, s.identity), a = current.reference, b = s.reference;
        if (a.recordId !== b.recordId || a.version !== b.version || a.digest !== b.digest || a.epoch !== b.epoch) {
          throw new ProtectedChangeError(409, 'Vault authority changed. Reopen the desktop before resolving an app.');
        }
        const target = await records.automationTargets({ verifyFreshAdministrator: denied, verifyProtectedHuman: denied })
          .resolve(actor, identity, input.applicationId as string, Number(input.installationRevision), tx);
        if (target.reference.epoch !== a.epoch) throw new ProtectedChangeError(409, 'Application authority changed.');
        this.openedLive(s);
        return target;
      });
      this.openedLive(s);
      s.applicationSelection = { applicationId: input.applicationId as string, installationRevision: Number(input.installationRevision) };
      return { schemaVersion: 1, sessionId: s.id, identity, ...result, expiresAtMs: s.leaseUntil, executionEnabled: false };
    } catch (error) { this.opened.delete(id); throw error; }
  }
  async browser(actor: string, session: string, id: string, input: unknown) {
    if (!exact(input, ['profileId', 'family']) || !uuid(input.profileId)
      || !['chrome', 'brave', 'firefox', 'safari'].includes(String(input.family))) {
      throw new ProtectedChangeError(400, 'Choose the registered isolated browser profile.');
    }
    const s = this.opened.get(id);
    if (!uuid(id) || !s || s.actor !== actor || s.session !== session || !this.db.transaction) {
      throw new ProtectedChangeError(409, 'The desktop connection is unavailable.');
    }
    try {
      this.openedLive(s);
      const records = this.records(actor, session);
      const identity = { userId: actor, serverId: s.identity.serverId, deviceId: s.identity.deviceId, workspaceId: s.workspaceId };
      const result = await this.db.transaction(async tx => {
        const current = await this.devices(records).resolveDeviceKey(tx, s.identity), a = current.reference, b = s.reference;
        if (a.recordId !== b.recordId || a.version !== b.version || a.digest !== b.digest || a.epoch !== b.epoch) {
          throw new ProtectedChangeError(409, 'Vault authority changed. Reopen the desktop before resolving a browser.');
        }
        const resolved = await records.automationTargets({ verifyFreshAdministrator: denied, verifyProtectedHuman: denied })
          .resolveBrowser(actor, identity, input.profileId as string, input.family as 'chrome' | 'brave' | 'firefox' | 'safari', tx);
        if (resolved.reference.epoch !== a.epoch || resolved.application.applicationId !== s.applicationSelection?.applicationId
          || resolved.application.installationRevision !== s.applicationSelection.installationRevision) {
          throw new ProtectedChangeError(409, 'Select this browser’s registered application first.');
        }
        this.openedLive(s);
        return { reference: resolved.reference, browser: resolved.target };
      });
      this.openedLive(s);
      // A leased canonical metadata projection, never an action permit.
      return { schemaVersion: 1, sessionId: s.id, identity, ...result, expiresAtMs: s.leaseUntil, executionEnabled: false };
    } catch (error) { this.opened.delete(id); throw error; }
  }
  async renew(actor: string, session: string, id: string, presence?: unknown, controlInput?: unknown) {
    const report = parseAutomationPresence(presence);
    const s = this.opened.get(id);
    if (!uuid(id) || !s || s.actor !== actor || s.session !== session || !this.db.transaction) throw new ProtectedChangeError(409, 'The desktop connection is unavailable.');
    try {
      this.openedLive(s);
      const records = this.records(actor, session);
      await this.db.transaction(async tx => {
        const current = await this.devices(records).resolveDeviceKey(tx, s.identity), a = current.reference, b = s.reference;
        if (a.recordId !== b.recordId || a.version !== b.version || a.digest !== b.digest || a.epoch !== b.epoch) {
          throw new ProtectedChangeError(409, 'Vault authority changed. Close the workspace and authenticate again.');
        }
        this.openedLive(s);
      });
      this.openedLive(s);
      const wall = Date.now(), mono = performance.now();
      s.leaseUntil = Math.min(wall + 10_000, s.expires); s.leaseDeadline = Math.min(mono + 10_000, s.deadline);
      await renewAutomationPresence(this.db, { ownerUserId: actor, authSessionId: session,
        storageSessionId: id, leaseUntilMs: s.leaseUntil, report });
      let consent = null;
      if (s.consent) {
        if (report.machineState !== 'running' || !report.companionConnected) await this.stopConsent(actor, session, id);
        else {
          const reference = s.consent, generation = s.consentGeneration;
          const resolved = await this.consentStore(s).resolve(actor, this.consentIdentity(s), id, reference);
          if (s.consent === reference && generation === s.consentGeneration) consent = resolved;
        }
      }
      let nativeControl = false;
      if (controlInput !== undefined && controlInput !== null) {
        if (!consent || !s.consent || !exact(controlInput, ['generation', 'guestBootId', 'guestChannelId', 'applicationId', 'installationRevision'])
          || !Number.isSafeInteger(controlInput.generation) || Number(controlInput.generation) < 0
          || controlInput.guestBootId !== consent.guestBootId || controlInput.guestChannelId !== consent.guestChannelId
          || !uuid(controlInput.applicationId) || !Number.isSafeInteger(controlInput.installationRevision)
          || Number(controlInput.installationRevision) < 1 || s.nativeGeneration !== null && s.nativeGeneration !== controlInput.generation) {
          throw new ProtectedChangeError(409, 'This local automation connection needs a new approval.');
        }
        s.nativeGeneration = Number(controlInput.generation);
        await this.nativeTransport(actor, session).renew(actor, { identity: this.consentIdentity(s), storageSessionId: id,
          authSessionId: session, consent: s.consent, generation: s.nativeGeneration, leaseUntilMs: s.leaseUntil,
          applicationId: controlInput.applicationId, installationRevision: Number(controlInput.installationRevision) });
        nativeControl = true;
      }
      this.openedLive(s);
      return { sessionId: id, workspaceId: s.workspaceId, leaseUntilMs: s.leaseUntil, expiresAtMs: s.expires, consent, nativeControl, executionEnabled: false };
    } catch (error) { this.opened.delete(id); throw error; }
  }
  async close(actor: string, session: string, id: string) {
    const s = this.opened.get(id);
    if (s && (s.actor !== actor || s.session !== session)) throw new ProtectedChangeError(403, 'This desktop connection belongs to another sign-in.');
    if (s) {
      s.consent = null; s.consentGeneration += 1;
      for (const p of this.consents.values()) if (p.owner === s) this.forgetConsent(p.challenge.id);
    }
    this.opened.delete(id);
    if (s) {
      try { await this.nativeTransport(actor, session).stop(actor, id); } catch { /* Native closure and short expiry remain mandatory. */ }
    }
    await closeAutomationPresence(this.db, actor, session, id);
    return { closed: true };
  }
}
