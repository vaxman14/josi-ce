import { reauthenticateProtectedAdmin, type ProtectedAdminProof } from '@josi-ce/auth';
import { cardinalContentDigest, vaultRecords,
  type Db, type MasterKey, type VaultRecordReference, type CardinalActivationRequest, type CardinalRetirementRequest,
  type AutomationTargetRegistration, type AutomationPolicyReplacement, type ProtectedConfirmationCommand, type ProtectedConfirmationIdentity,
  type ProtectedDeviceAuthority } from '@josi-ce/core';
import { isProtectedControlOrigin, type ProtectedControlReceipt, type ProtectedHostReceipt } from '@josi-ce/protocol';

type Change = { kind: 'cardinal.activate'; draft: VaultRecordReference; policy: VaultRecordReference | null }
  | { kind: 'cardinal.retire'; ruleId: string; policy: VaultRecordReference }
  | { kind: 'automation.policy.replace'; policy: AutomationPolicyReplacement['policy']; expected: VaultRecordReference | null }
  | { kind: 'automation.target.register'; identity: AutomationTargetRegistration['identity']; candidate: AutomationTargetRegistration['candidate']; expected: VaultRecordReference | null }
  | { kind: 'device.revoke'; enrollmentId: string; expected: VaultRecordReference };
type Records = ReturnType<typeof vaultRecords>;
type Native = ReturnType<Records['protectedNativeControl']>;
interface Pending {
  actor: string; session: string; identity: ProtectedConfirmationIdentity; change: Change;
  proof: ProtectedAdminProof; records: Records; native: Native; command: ProtectedConfirmationCommand;
  presentationDigest: string; keyReference: VaultRecordReference; expires: number; deadline: number;
  previousWall: number; previousMono: number; busy: boolean;
  timer: ReturnType<typeof setTimeout>;
}
export class ProtectedChangeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const unavailable = async () => { throw new ProtectedChangeError(503, 'Use the separate protected device-enrollment or recovery flow.'); };
const noMutation = { verifyFreshAdministrator: unavailable, verifyProtectedHuman: unavailable };
const sameReference = (a: VaultRecordReference | null, b: VaultRecordReference) => a && a.recordId === b.recordId
  && a.version === b.version && a.digest === b.digest && a.epoch === b.epoch;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function changeInput(value: unknown): Change {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtectedChangeError(400, 'Choose an exact protected change.');
  const kind = (value as Record<string, unknown>).kind;
  if (!(kind === 'cardinal.activate' && exact(value, ['kind', 'draft', 'policy'])
    || kind === 'cardinal.retire' && exact(value, ['kind', 'ruleId', 'policy'])
    || kind === 'device.revoke' && exact(value, ['kind', 'enrollmentId', 'expected'])
    || kind === 'automation.target.register' && exact(value, ['kind', 'identity', 'candidate', 'expected'])
    || kind === 'automation.policy.replace' && exact(value, ['kind', 'policy', 'expected']))) {
    throw new ProtectedChangeError(400, 'Choose an exact protected change.');
  }
  // The canonical stores validate every reference/definition and build the
  // meaning. This tag check cannot make a raw request authoritative.
  return structuredClone(value) as Change;
}

/** Bounded, transient coordination of a native review. Durable challenge and
 * policy state remain Vault-backed. No password, proof token or policy copy is
 * persisted here; process loss requires fresh review, never replayed approval. */
export class ProtectedChanges {
  private readonly pending = new Map<string, Pending>();
  private readonly preparing = new Set<string>();
  readonly enabled: boolean;
  constructor(private readonly db: Db, private readonly master: () => MasterKey, private readonly origin: string) {
    this.enabled = isProtectedControlOrigin(origin);
  }
  private async server(tx: Db, identity: Readonly<ProtectedConfirmationIdentity>) {
    const rows = await tx.query<{ installation_id: string }>('select installation_id from workspace limit 2 for share');
    if (!this.enabled || identity.serverOrigin !== this.origin || rows.length !== 1 || !uuid(rows[0].installation_id)
      || identity.serverId !== rows[0].installation_id) throw new ProtectedChangeError(409, 'The enrolled device does not match this installation and its configured public origin.');
  }
  private prune() {
    const wall = Date.now(), mono = performance.now();
    for (const [id, entry] of this.pending) {
      if (wall < entry.previousWall || mono < entry.previousMono || wall >= entry.expires || mono >= entry.deadline) this.forget(id);
    }
  }
  private forget(id: string) {
    const entry = this.pending.get(id);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(id);
  }
  private entry(actor: string, session: string, id: string) {
    this.prune();
    const value = this.pending.get(id);
    if (!value || value.actor !== actor || value.session !== session || !uuid(id)) throw new ProtectedChangeError(409, 'This review expired, ended or belongs to another sign-in. Start a new protected review.');
    if (value.busy) throw new ProtectedChangeError(409, 'This protected review already has a request in progress.');
    value.previousWall = Date.now(); value.previousMono = performance.now();
    return value;
  }
  private deviceAuthority(): ProtectedDeviceAuthority {
    return { requireServerIdentity: (tx, identity) => this.server(tx, identity), verifyFreshAdministrator: unavailable,
      verifyEnrollmentConsent: unavailable, verifyProtectedRevocation: unavailable, verifyHostProjection: unavailable };
  }
  private async review(records: Records, actorUserId: string, change: Change) {
    if (change.kind === 'cardinal.activate') return records.cardinalPolicy(noMutation).prepareActivation({
      actorUserId, draft: change.draft, policy: change.policy } satisfies CardinalActivationRequest);
    if (change.kind === 'cardinal.retire') return records.cardinalPolicy(noMutation).prepareRetirement({
      actorUserId, ruleId: change.ruleId, policy: change.policy } satisfies CardinalRetirementRequest);
    if (change.kind === 'automation.target.register') return records.automationTargets(noMutation).prepareRegistration({ actorUserId, ...change });
    if (change.kind === 'device.revoke') {
      const value = await records.protectedDevices(this.deviceAuthority()).prepareRevocation({
        actorUserId, enrollmentId: change.enrollmentId, expected: change.expected });
      if (value.command.purpose !== 'device.revoke') throw new ProtectedChangeError(409, 'The device command is not a revocation.');
      return { command: { purpose: 'device.revoke' as const, requestDigest: value.command.requestDigest }, presentation: value.presentation };
    }
    return records.automationPolicy(noMutation).prepareReplacement({ actorUserId, policy: change.policy, expected: change.expected });
  }
  async prepare(args: { actor: string; session: string; deviceId: string; change: unknown; password: string; mfaCode?: string }) {
    this.prune();
    if (!this.enabled || !uuid(args.actor) || !uuid(args.session) || !uuid(args.deviceId)) throw new ProtectedChangeError(400, 'Use this server’s configured HTTPS or loopback origin and an enrolled device.');
    if (this.preparing.has(args.actor) || [...this.pending.values()].some(entry => entry.actor === args.actor)) {
      throw new ProtectedChangeError(409, 'Finish or cancel your existing protected review first.');
    }
    if (this.preparing.size + this.pending.size >= 64) throw new ProtectedChangeError(429, 'Protected reviews are busy. Try again after a pending review ends.');
    this.preparing.add(args.actor);
    try {
      const change = changeInput(args.change), key = this.master(), records = vaultRecords(this.db, key);
      if (change.kind === 'automation.target.register' && change.identity?.deviceId !== args.deviceId) {
        throw new ProtectedChangeError(409, 'Use the enrolled Mac that owns this workspace to register its automation targets.');
      }
      const review = await this.review(records, args.actor, change);
      const proof = await reauthenticateProtectedAdmin(this.db, key, { ...review.command, userId: args.actor, sessionId: args.session,
        password: args.password, mfaCode: args.mfaCode });
      const native = records.protectedNativeControl({
        requireServerIdentity: (tx, identity) => this.server(tx, identity), verifyFreshAdministrator: unavailable,
        verifyEnrollmentConsent: unavailable, verifyProtectedRevocation: unavailable,
      }, { verifyFreshAdministrator: (tx, actor, command) => proof.check(tx, { ...command, actorUserId: actor, consume: false }) });
      const inventory = await native.devices.inventory(args.actor);
      const device = inventory.devices.find(value => value.identity.deviceId === args.deviceId && value.identity.userId === args.actor && !value.revokedAt);
      if (!device || !inventory.reference || inventory.reconciliationRequired) throw new ProtectedChangeError(409, 'Choose an active enrolled device after reconciling the Vault.');
      const issued = await native.confirmations.issue({ actorUserId: args.actor, identity: device.identity,
        command: review.command, presentation: review.presentation });
      const host = await native.confirmations.prepareHostAuthentication(args.actor, issued.challengeId);
      const wall = Date.now(), mono = performance.now();
      if (issued.expiresAtMs <= wall) throw new ProtectedChangeError(409, 'The protected review expired during preparation.');
      const timer = setTimeout(() => this.forget(issued.challengeId), issued.expiresAtMs - wall); timer.unref();
      this.pending.set(issued.challengeId, { actor: args.actor, session: args.session, identity: { ...device.identity }, change,
        proof, records, native, command: review.command, presentationDigest: cardinalContentDigest(review.presentation),
        keyReference: host.keyReference, expires: issued.expiresAtMs, deadline: mono + issued.expiresAtMs - wall,
        previousWall: wall, previousMono: mono, busy: false, timer });
      return { challengeId: issued.challengeId, expiresAtMs: issued.expiresAtMs, deviceId: device.identity.deviceId };
    } finally { this.preparing.delete(args.actor); }
  }
  private async current(entry: Pending) {
    if (!this.db.transaction) throw new ProtectedChangeError(503, 'Protected reviews require durable transactions.');
    await this.db.transaction(async tx => {
      await this.server(tx, entry.identity);
      await entry.proof.check(tx, { ...entry.command, actorUserId: entry.actor, consume: false });
    });
    const inventory = await entry.native.devices.inventory(entry.actor);
    const device = inventory.devices.find(value => value.identity.deviceId === entry.identity.deviceId && !value.revokedAt);
    if (!device || inventory.reconciliationRequired || !sameReference(inventory.reference, entry.keyReference)) {
      throw new ProtectedChangeError(409, 'The Vault or enrolled device changed. Start a new protected review.');
    }
    const review = await this.review(entry.records, entry.actor, entry.change);
    if (review.command.purpose !== entry.command.purpose || review.command.requestDigest !== entry.command.requestDigest
      || cardinalContentDigest(review.presentation) !== entry.presentationDigest) {
      throw new ProtectedChangeError(409, 'The protected change or its meaning changed. Review the current version again.');
    }
    const wall = Date.now(), mono = performance.now();
    if (wall < entry.previousWall || mono < entry.previousMono || wall >= entry.expires || mono >= entry.deadline) throw new ProtectedChangeError(409, 'The protected review expired.');
    entry.previousWall = wall; entry.previousMono = mono;
  }
  private async request<T>(actor: string, session: string, id: string, work: (entry: Pending) => Promise<T>) {
    const entry = this.entry(actor, session, id); entry.busy = true;
    try { await this.current(entry); return await work(entry); }
    finally { entry.busy = false; }
  }
  hostChallenge(actor: string, session: string, id: string) {
    return this.request(actor, session, id, entry => entry.native.confirmations.prepareHostAuthentication(actor, id));
  }
  isCurrent(actor: string, session: string, id: string) {
    return this.request(actor, session, id, async () => ({ current: true }));
  }
  presentation(actor: string, session: string, id: string, proof: ProtectedHostReceipt) {
    if (proof?.challengeId !== id) throw new ProtectedChangeError(400, 'Use the proof for this protected review.');
    return this.request(actor, session, id, entry => entry.native.confirmations.deliver({ actorUserId: actor, challengeId: id, proof }));
  }
  projection(actor: string, session: string, id: string, proof: ProtectedHostReceipt) {
    if (proof?.challengeId !== id) throw new ProtectedChangeError(400, 'Use the proof for this protected review.');
    return this.request(actor, session, id, async entry => {
      const value = await entry.native.devices.project({ actorUserId: actor, identity: entry.identity, expected: entry.keyReference, proof });
      // Explicit minimized native transport projection. Secret.toJSON remains
      // redacting everywhere else; this result must never enter chat or logs.
      return { ...value, material: JSON.parse(value.material.reveal()) as unknown };
    });
  }
  commit(actor: string, session: string, id: string, receipt: ProtectedControlReceipt) {
    if (receipt?.challengeId !== id) throw new ProtectedChangeError(400, 'Confirm this exact protected review.');
    return this.request(actor, session, id, async entry => {
      // Drop the in-memory fresh-proof capability after any commit attempt.
      // The canonical transaction rolls back all consumption on failure.
      try {
        const authority = {
          verifyFreshAdministrator: (tx: Db, actorUserId: string, command: ProtectedConfirmationCommand) =>
            entry.proof.check(tx, { ...command, actorUserId, consume: true }),
          verifyProtectedHuman: entry.native.confirmations.verifier(receipt),
        };
        const change = entry.change;
        if (change.kind === 'cardinal.activate') return { kind: 'cardinal' as const,
          policy: await entry.records.cardinalPolicy(authority).activate({ actorUserId: actor, draft: change.draft, policy: change.policy }) };
        if (change.kind === 'cardinal.retire') return { kind: 'cardinal' as const,
          policy: await entry.records.cardinalPolicy(authority).retire({ actorUserId: actor, ruleId: change.ruleId, policy: change.policy }) };
        if (change.kind === 'automation.target.register') return { kind: 'targets' as const,
          policy: await entry.records.automationTargets(authority).register({ actorUserId: actor, ...change }) };
        if (change.kind === 'device.revoke') return { kind: 'devices' as const,
          policy: await entry.records.protectedDevices({ ...this.deviceAuthority(),
            verifyFreshAdministrator: (tx, actorUserId, command) => entry.proof.check(tx, { ...command, actorUserId, consume: true }),
            verifyProtectedRevocation: async (tx, actorUserId, command, presentation) => {
              if (command.purpose !== 'device.revoke') throw new ProtectedChangeError(409, 'Confirm the exact device revocation.');
              await authority.verifyProtectedHuman(tx, actorUserId, { purpose: 'device.revoke', requestDigest: command.requestDigest }, presentation);
            },
          }).revoke({ actorUserId: actor, enrollmentId: change.enrollmentId, expected: change.expected, proof: receipt }) };
        return { kind: 'permissions' as const,
          policy: await entry.records.automationPolicy(authority).replace({ actorUserId: actor, policy: change.policy, expected: change.expected }) };
      } finally { this.forget(id); }
    });
  }
  async cancel(actor: string, session: string, id: string) {
    const entry = this.entry(actor, session, id); entry.busy = true;
    try { await entry.native.confirmations.cancel(actor, id); }
    finally { this.forget(id); }
  }
}
