// Short-lived encrypted projections of protected change requests. The Vault
// remains canonical; these receipts do not enroll a key or grant device access.
import { createHash, createHmac, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { parseProtectedControlChallenge, protectedControlMessage, isProtectedControlOrigin,
  PROTECTED_CONTROL_PURPOSES, type ProtectedControlChallenge, type ProtectedControlPurpose, type ProtectedControlReceipt } from '@josi-ce/protocol';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { openSealed, seal } from './sealing.js';
import { appendEvent } from './events.js';
import type { VaultRecordReference } from './vaultRecords.js';

export interface ProtectedConfirmationCommand { purpose: ProtectedControlPurpose; requestDigest: string }
export interface ProtectedConfirmationIdentity { serverOrigin: string; serverId: string; userId: string; deviceId: string }
export interface ProtectedConfirmationAuthority {
  /** Trusted local verifier of current active enrollment/owner consent and the
   * canonical Vault public key. No supplied key, network wait or default trust.
   * The actual enrollment/key projection implementation remains a release gate. */
  resolveDeviceKey(tx: Db, identity: ProtectedConfirmationIdentity): Promise<{ reference: VaultRecordReference; publicKeySpki: string }>;
  /** Existing fresh administrator proof; check without consuming at issue.
   * Permanent mutation consumes that independent proof in its own TX. */
  verifyFreshAdministrator(tx: Db, actorUserId: string, command: ProtectedConfirmationCommand): Promise<void>;
  /** Authenticated protected host only, bound to this exact challenge/identity.
   * A CE session, renderer boolean or loopback address alone is insufficient. */
  verifyDelivery(tx: Db, challenge: Readonly<ProtectedControlChallenge>, proof: unknown): Promise<void>;
}
export interface ProtectedConfirmationTransaction { tx: Db; key: MasterKey; epoch: number }
export type ProtectedConfirmationBackend = <T>(actorUserId: string, writing: boolean,
  work: (tx: ProtectedConfirmationTransaction) => Promise<T>, existingTransaction?: Db) => Promise<T>;
export class ProtectedConfirmationError extends Error {}
interface Row {
  id: string; owner_user_id: string; server_id: string; device_id: string;
  challenge_enc: string; challenge_mac: string; state_mac: string;
  state: 'pending' | 'consumed' | 'cancelled'; expires_at: string;
}
interface Envelope { purpose: 'josi-protected-challenge'; schemaVersion: 1; challenge: ProtectedControlChallenge; publicKeySpki: string }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const commandValid = (v: ProtectedConfirmationCommand) => exact(v, ['purpose', 'requestDigest'])
  && PROTECTED_CONTROL_PURPOSES.includes(v.purpose) && digest(v.requestDigest);
const identityValid = (v: ProtectedConfirmationIdentity) => exact(v, ['serverOrigin', 'serverId', 'userId', 'deviceId'])
  && isProtectedControlOrigin(v.serverOrigin) && [v.serverId, v.userId, v.deviceId].every(uuid);
function publicKey(value: string) {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ProtectedConfirmationError('Protected device key unavailable.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new ProtectedConfirmationError('Protected device key unavailable.');
  const key = createPublicKey({ key: bytes, type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({ type: 'spki', format: 'der' }).equals(bytes)) throw new ProtectedConfirmationError('Protected device key unavailable.');
  return key;
}
function sameReference(a: VaultRecordReference, b: VaultRecordReference) {
  return a.recordId === b.recordId && a.version === b.version && a.digest === b.digest && a.epoch === b.epoch;
}
function envelopeMac(key: MasterKey, envelope: Envelope): string {
  return createHmac('sha256', key.reveal()).update('josi-protected-challenge.1\0')
    .update(protectedControlMessage(envelope.challenge)).update('\0').update(envelope.publicKeySpki).digest('hex');
}
function stateMac(key: MasterKey, row: Pick<Row, 'id' | 'challenge_mac' | 'state'>): string {
  return createHmac('sha256', key.reveal()).update('josi-protected-challenge-state.1\0')
    .update(JSON.stringify([row.id, row.challenge_mac, row.state])).digest('hex');
}
async function now(tx: Db): Promise<number> {
  const [{ now_ms }] = await tx.query<{ now_ms: string }>('select floor(extract(epoch from clock_timestamp())*1000)::text as now_ms');
  return Number(now_ms);
}
function open(key: MasterKey, row: Row): Envelope {
  try {
    const envelope = openSealed<Envelope>(key, row.challenge_enc), c = parseProtectedControlChallenge(envelope?.challenge);
    if (!exact(envelope, ['purpose', 'schemaVersion', 'challenge', 'publicKeySpki']) || envelope.purpose !== 'josi-protected-challenge'
      || envelope.schemaVersion !== 1 || !c || c.id !== row.id || c.userId !== row.owner_user_id || c.serverId !== row.server_id
      || c.deviceId !== row.device_id || c.expiresAtMs !== new Date(row.expires_at).getTime()
      || !['pending', 'consumed', 'cancelled'].includes(row.state) || envelopeMac(key, envelope) !== row.challenge_mac
      || stateMac(key, row) !== row.state_mac) throw new Error('context');
    publicKey(envelope.publicKeySpki);
    return { ...envelope, challenge: c };
  } catch { throw new ProtectedConfirmationError('The protected confirmation is unreadable or changed.'); }
}

export class ProtectedConfirmationStore {
  constructor(private readonly backend: ProtectedConfirmationBackend, private readonly authority: ProtectedConfirmationAuthority) {}
  private async current(context: ProtectedConfirmationTransaction, identity: ProtectedConfirmationIdentity) {
    if (typeof this.authority?.resolveDeviceKey !== 'function') throw new ProtectedConfirmationError('Protected device enrollment is unavailable.');
    const value = await this.authority.resolveDeviceKey(context.tx, Object.freeze({ ...identity }));
    const ref = value?.reference;
    if (!ref || !exact(ref, ['recordId', 'version', 'digest', 'epoch']) || !uuid(ref.recordId) || !digest(ref.digest)
      || !Number.isSafeInteger(ref.version) || ref.version < 1 || ref.epoch !== context.epoch) throw new ProtectedConfirmationError('Protected device authority changed.');
    try { publicKey(value.publicKeySpki); } catch { throw new ProtectedConfirmationError('Protected device key unavailable.'); }
    return { reference: { ...ref }, publicKeySpki: value.publicKeySpki };
  }
  /** Only the trusted server command builder supplies presentation. It must
   * derive meaning from the exact tested Vault definition, never model prose
   * or a renderer-supplied label. No HTTP issue route is installed here. */
  async issue(args: { actorUserId: string; identity: ProtectedConfirmationIdentity; command: ProtectedConfirmationCommand;
    presentation: ProtectedControlChallenge['presentation'] }): Promise<{ challengeId: string; expiresAtMs: number }> {
    const input = structuredClone(args);
    if (!identityValid(input.identity) || input.identity.userId !== input.actorUserId || !commandValid(input.command)) throw new ProtectedConfirmationError('Exact protected change identity required.');
    return this.backend(input.actorUserId, true, async context => {
      if (typeof this.authority?.verifyFreshAdministrator !== 'function') throw new ProtectedConfirmationError('Fresh administrator verification required.');
      await this.authority.verifyFreshAdministrator(context.tx, input.actorUserId, Object.freeze(input.command));
      const key = await this.current(context, input.identity), issuedAtMs = await now(context.tx);
      const challenge = parseProtectedControlChallenge({ schemaVersion: 1, id: randomUUID(), nonce: randomBytes(32).toString('base64url'),
        ...input.identity, ...input.command, keyReference: key.reference, issuedAtMs, expiresAtMs: issuedAtMs + 120_000, presentation: input.presentation });
      if (!challenge) throw new ProtectedConfirmationError('Use a bounded exact protected presentation.');
      // Expired projections are not canonical policy/history. Keep a bounded
      // retention window; durable audit references outlive the presentation.
      // Deleting an old challenge cannot make its receipt valid again.
      await context.tx.query("delete from protected_control_challenges where owner_user_id=$1 and expires_at<clock_timestamp()-interval '1 day'", [input.actorUserId]);
      // The Vault writer lock serializes issuance; no caller-selected quota.
      const [{ count }] = await context.tx.query<{ count: string }>(`select count(*)::text as count from protected_control_challenges
        where owner_user_id=$1 and state='pending' and expires_at>clock_timestamp()`, [input.actorUserId]);
      if (Number(count) >= 16) throw new ProtectedConfirmationError('Too many pending confirmations. Cancel one or wait for expiry.');
      const envelope: Envelope = { purpose: 'josi-protected-challenge', schemaVersion: 1, challenge, publicKeySpki: key.publicKeySpki };
      const mac = envelopeMac(context.key, envelope);
      await context.tx.query(`insert into protected_control_challenges(id,owner_user_id,server_id,device_id,challenge_enc,challenge_mac,state_mac,expires_at)
        values($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000))`, [challenge.id, input.actorUserId, challenge.serverId, challenge.deviceId,
        seal(context.key, envelope), mac, stateMac(context.key, { id: challenge.id, challenge_mac: mac, state: 'pending' }), challenge.expiresAtMs]);
      await appendEvent(context.tx, { actorUserId: input.actorUserId, actor: 'super_admin', kind: 'auth.protected_challenge_issued',
        subjectType: 'protected_confirmation', subjectId: challenge.id, payload: { deviceId: challenge.deviceId, epoch: context.epoch } });
      return { challengeId: challenge.id, expiresAtMs: challenge.expiresAtMs };
    });
  }
  private async load(context: ProtectedConfirmationTransaction, actorUserId: string, id: string) {
    const [row] = await context.tx.query<Row>('select * from protected_control_challenges where id=$1 and owner_user_id=$2 for update', [id, actorUserId]);
    if (!row) throw new ProtectedConfirmationError('Protected confirmation unavailable.');
    const envelope = open(context.key, row), c = envelope.challenge, at = await now(context.tx);
    if (row.state !== 'pending' || c.issuedAtMs > at || c.expiresAtMs <= at || c.keyReference.epoch !== context.epoch) throw new ProtectedConfirmationError('Protected confirmation expired, consumed or stale.');
    const current = await this.current(context, { serverOrigin: c.serverOrigin, serverId: c.serverId, userId: c.userId, deviceId: c.deviceId });
    if (!sameReference(current.reference, c.keyReference) || current.publicKeySpki !== envelope.publicKeySpki) throw new ProtectedConfirmationError('Protected device authority changed.');
    return { row, envelope };
  }
  /** Delivery is to an authenticated protected host, not ordinary chat content. */
  async deliver(args: { actorUserId: string; challengeId: string; proof: unknown }): Promise<ProtectedControlChallenge> {
    const { actorUserId, challengeId, proof } = args;
    if (!uuid(actorUserId) || !uuid(challengeId)) throw new ProtectedConfirmationError('Protected confirmation unavailable.');
    return this.backend(actorUserId, false, async context => {
      const { envelope } = await this.load(context, actorUserId, challengeId);
      if (typeof this.authority?.verifyDelivery !== 'function') throw new ProtectedConfirmationError('Protected host authentication unavailable.');
      await this.authority.verifyDelivery(context.tx, structuredClone(envelope.challenge), proof);
      if (envelope.challenge.expiresAtMs <= await now(context.tx)) throw new ProtectedConfirmationError('Protected confirmation expired.');
      return structuredClone(envelope.challenge);
    });
  }
  /** Pass to verifyProtectedHuman in the Cardinal/automation-policy store. tx
   * MUST be that mutation's transaction; fresh account proof is independently
   * consumed there. No network/dialog/private-key export occurs here. */
  verifier(receipt: ProtectedControlReceipt) {
    const snapshot = structuredClone(receipt);
    return async (tx: Db, actorUserId: string, command: ProtectedConfirmationCommand): Promise<void> => {
      if (!uuid(actorUserId) || !commandValid(command) || !exact(snapshot, ['schemaVersion', 'challengeId', 'challengeDigest', 'signature'])
        || snapshot.schemaVersion !== 1 || !uuid(snapshot.challengeId) || !digest(snapshot.challengeDigest)
        || typeof snapshot.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(snapshot.signature)) throw new ProtectedConfirmationError('Protected confirmation proof required.');
      const binding = { ...command };
      await this.backend(actorUserId, false, async context => {
        const { row, envelope } = await this.load(context, actorUserId, snapshot.challengeId), c = envelope.challenge;
        if (c.purpose !== binding.purpose || c.requestDigest !== binding.requestDigest) throw new ProtectedConfirmationError('Confirm this exact protected change again.');
        const message = Buffer.from(protectedControlMessage(c), 'utf8'), signature = Buffer.from(snapshot.signature, 'base64url');
        if (signature.length !== 64 || signature.toString('base64url') !== snapshot.signature
          || createHash('sha256').update(message).digest('hex') !== snapshot.challengeDigest
          || !verify(null, message, publicKey(envelope.publicKeySpki), signature)) throw new ProtectedConfirmationError('Protected confirmation proof did not match.');
        if (c.expiresAtMs <= await now(context.tx)) throw new ProtectedConfirmationError('Protected confirmation expired.');
        await context.tx.query("update protected_control_challenges set state='consumed',state_mac=$2,settled_at=clock_timestamp() where id=$1",
          [row.id, stateMac(context.key, { ...row, state: 'consumed' })]);
        await appendEvent(context.tx, { actorUserId, actor: 'super_admin', kind: 'auth.protected_challenge_consumed',
          subjectType: 'protected_confirmation', subjectId: row.id, payload: { deviceId: row.device_id, epoch: context.epoch } });
      }, tx);
    };
  }
  async cancel(actorUserId: string, challengeId: string): Promise<void> {
    if (!uuid(actorUserId) || !uuid(challengeId)) throw new ProtectedConfirmationError('Protected confirmation unavailable.');
    return this.backend(actorUserId, false, async context => {
      const [row] = await context.tx.query<Row>('select * from protected_control_challenges where id=$1 and owner_user_id=$2 for update', [challengeId, actorUserId]);
      if (!row) throw new ProtectedConfirmationError('Protected confirmation unavailable.');
      open(context.key, row);
      if (row.state === 'cancelled') return;
      if (row.state !== 'pending') throw new ProtectedConfirmationError('This confirmation was already consumed.');
      await context.tx.query("update protected_control_challenges set state='cancelled',state_mac=$2,settled_at=clock_timestamp() where id=$1",
        [row.id, stateMac(context.key, { ...row, state: 'cancelled' })]);
      await appendEvent(context.tx, { actorUserId, actor: 'super_admin', kind: 'auth.protected_challenge_cancelled',
        subjectType: 'protected_confirmation', subjectId: row.id });
    });
  }
}
