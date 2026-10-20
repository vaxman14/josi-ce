import { createHash, createPublicKey, ECDH, verify } from 'node:crypto';
import { isProtectedControlOrigin, type ProtectedControlPresentation } from '@josi-ce/protocol';
import type { Db } from './db.js';
import { Secret } from './sealing.js';
import { VaultRecordError, VaultRecordConflictError, type VaultRecordReference, type VaultRecordValue } from './vaultRecords.js';
import type { ProtectedConfirmationIdentity } from './protectedConfirmations.js';
import { cardinalContentDigest } from './cardinalRules.js';

export const PROTECTED_DEVICES_RECORD_ID = '914a736a-94bf-46f2-a602-82ff4180c45d';
/** Native Swift Data fields use canonical padded base64. Public-key output
 * for protectedControl uses base64url, with an explicit conversion below. */
export interface NativeVaultSigningMaterial {
  schemaVersion: 1; identity: ProtectedConfirmationIdentity;
  wrappingPublicKey: string; signingPublicKeySpki: string; wrappedPrivateKey: string;
}
interface DeviceRecord {
  id: string; label: string; material: NativeVaultSigningMaterial;
  enrolledAt: string; revokedAt: string | null;
}
interface DeviceDocument { schemaVersion: 1; devices: DeviceRecord[] }
export interface ProtectedDeviceSummary {
  enrollmentId: string; label: string; identity: ProtectedConfirmationIdentity;
  signingFingerprint: string; wrappingFingerprint: string;
  enrolledAt: string; revokedAt: string | null;
}
export interface ProtectedDeviceInventory {
  reference: VaultRecordReference | null; authorityEpoch: number; devices: ProtectedDeviceSummary[]; reconciliationRequired: boolean;
}
export interface ProtectedDeviceCommand { purpose: 'device.enroll' | 'device.revoke'; requestDigest: string }
export interface ProtectedDeviceAuthority {
  /** Compare against trusted installation identity, never a request body. */
  requireServerIdentity(tx: Db, identity: Readonly<ProtectedConfirmationIdentity>): Promise<void>;
  /** Must consume the exact fresh administrator proof in the mutation TX. */
  verifyFreshAdministrator(tx: Db, actorUserId: string, command: ProtectedDeviceCommand): Promise<void>;
  /** The first-device ceremony is an independent human/native trust boundary.
   * A software-generated key, signature, CE cookie or renderer boolean is NOT
   * local owner consent. No default verifier is supplied here. */
  verifyEnrollmentConsent(tx: Db, actorUserId: string, command: ProtectedDeviceCommand,
    presentation: ProtectedControlPresentation, proof: unknown): Promise<void>;
  verifyProtectedRevocation(tx: Db, actorUserId: string, command: ProtectedDeviceCommand,
    presentation: ProtectedControlPresentation, proof: unknown): Promise<void>;
  /** Current authenticated protected-host session, bound to this identity and
   * exact reference. The proof implementation cannot wait on a network/UI. */
  verifyHostProjection(tx: Db, actorUserId: string, device: ProtectedDeviceSummary,
    reference: VaultRecordReference, proof: unknown): Promise<void>;
}
export interface ProtectedDeviceTransaction {
  tx: Db; epoch: number; reconciliationRequired: boolean;
  read(): Promise<VaultRecordValue | null>;
  write(value: Secret): Promise<VaultRecordReference>;
}
export type ProtectedDeviceBackend = <T>(actorUserId: string, writing: boolean,
  work: (context: ProtectedDeviceTransaction) => Promise<T>, existingTransaction?: Db) => Promise<T>;
export interface ProtectedDeviceEnrollment {
  actorUserId: string; enrollmentId: string; label: string; material: Secret;
  expected: VaultRecordReference | null; epoch: number;
}
export interface ProtectedDeviceRevocation {
  actorUserId: string; enrollmentId: string; expected: VaultRecordReference;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const labelValid = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0
  && value.length <= 120 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const identityValid = (value: unknown): value is ProtectedConfirmationIdentity => exact(value, ['serverOrigin', 'serverId', 'userId', 'deviceId'])
  && isProtectedControlOrigin(value.serverOrigin) && [value.serverId, value.userId, value.deviceId].every(uuid);
const sameIdentity = (a: ProtectedConfirmationIdentity, b: ProtectedConfirmationIdentity) => a.serverOrigin === b.serverOrigin
  && a.serverId === b.serverId && a.userId === b.userId && a.deviceId === b.deviceId;
const referenceValid = (value: unknown): value is VaultRecordReference => exact(value, ['recordId', 'version', 'digest', 'epoch'])
  && value.recordId === PROTECTED_DEVICES_RECORD_ID && Number.isSafeInteger(value.version) && Number(value.version) > 0
  && Number.isSafeInteger(value.epoch) && Number(value.epoch) > 0 && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest);
function bytes(value: unknown, min: number, max = min): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('encoding');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < min || decoded.length > max || decoded.toString('base64') !== value) throw new Error('encoding');
  return decoded;
}
function materialValid(value: unknown): value is NativeVaultSigningMaterial {
  try {
    if (!exact(value, ['schemaVersion', 'identity', 'wrappingPublicKey', 'signingPublicKeySpki', 'wrappedPrivateKey'])
      || value.schemaVersion !== 1 || !identityValid(value.identity)) return false;
    const wrapping = bytes(value.wrappingPublicKey, 65), signing = bytes(value.signingPublicKeySpki, 44);
    bytes(value.wrappedPrivateKey, 33, 4096);
    if (wrapping[0] !== 4 || !Buffer.from(ECDH.convertKey(wrapping, 'prime256v1')).equals(wrapping)) return false;
    const key = createPublicKey({ key: signing, type: 'spki', format: 'der' });
    return key.asymmetricKeyType === 'ed25519' && key.export({ type: 'spki', format: 'der' }).equals(signing);
  } catch { return false; }
}
function materialFrom(secret: Secret): NativeVaultSigningMaterial {
  try {
    if (!(secret instanceof Secret) || secret.length > 16_384) throw new Error('material');
    const material: unknown = JSON.parse(secret.reveal());
    if (!materialValid(material)) throw new Error('material');
    return material;
  } catch { throw new VaultRecordError('The native protected-key material is invalid.'); }
}
function decode(record: VaultRecordValue): DeviceDocument {
  try {
    const value: unknown = JSON.parse(record.value.reveal());
    if (record.kind !== 'protected_devices' || record.reference.recordId !== PROTECTED_DEVICES_RECORD_ID
      || !exact(value, ['schemaVersion', 'devices']) || value.schemaVersion !== 1 || !Array.isArray(value.devices)
      || value.devices.length > 32 || value.devices.some(entry => !exact(entry, ['id', 'label', 'material', 'enrolledAt', 'revokedAt'])
        || !uuid(entry.id) || !labelValid(entry.label) || !materialValid(entry.material) || !timestamp(entry.enrolledAt)
        || entry.revokedAt !== null && (!timestamp(entry.revokedAt) || Date.parse(entry.revokedAt) < Date.parse(String(entry.enrolledAt))))) throw new Error('record');
    const devices = value.devices as DeviceRecord[];
    const unique = (values: string[]) => new Set(values).size === devices.length;
    if (!unique(devices.map(d => d.id)) || !unique(devices.map(d => d.material.identity.deviceId))
      || !unique(devices.map(d => d.material.signingPublicKeySpki)) || !unique(devices.map(d => d.material.wrappingPublicKey))) throw new Error('duplicate');
    return { schemaVersion: 1, devices };
  } catch { throw new VaultRecordError('The protected-device Vault record is unreadable or invalid.'); }
}
function summary(device: DeviceRecord): ProtectedDeviceSummary {
  const fingerprint = (value: string) => createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex');
  return { enrollmentId: device.id, label: device.label, identity: { ...device.material.identity },
    signingFingerprint: fingerprint(device.material.signingPublicKeySpki), wrappingFingerprint: fingerprint(device.material.wrappingPublicKey),
    enrolledAt: device.enrolledAt, revokedAt: device.revokedAt };
}
function sameReference(a: VaultRecordReference | null, b: VaultRecordReference | null) {
  return a === null && b === null || a !== null && b !== null && a.recordId === b.recordId && a.version === b.version
    && a.digest === b.digest && a.epoch === b.epoch;
}
async function current(context: ProtectedDeviceTransaction, expected?: VaultRecordReference | null) {
  const record = await context.read();
  if (expected !== undefined && !sameReference(record?.reference ?? null, expected)) throw new VaultRecordConflictError('The enrolled devices changed. Review the exact current version.');
  return { reference: record?.reference ?? null, document: record ? decode(record) : { schemaVersion: 1 as const, devices: [] } };
}
async function server(authority: ProtectedDeviceAuthority, tx: Db, identity: ProtectedConfirmationIdentity) {
  if (typeof authority?.requireServerIdentity !== 'function') throw new VaultRecordError('Trusted server identity is unavailable.');
  await authority.requireServerIdentity(tx, Object.freeze({ ...identity }));
}
async function date(tx: Db) {
  const [row] = await tx.query<{ at: string }>('select clock_timestamp()::text as at');
  if (!row || !Number.isFinite(Date.parse(row.at))) throw new VaultRecordError('The server clock is unavailable.');
  return new Date(row.at).toISOString();
}
function enrollmentBinding(args: Omit<ProtectedDeviceEnrollment, 'material'>, material: NativeVaultSigningMaterial): ProtectedDeviceCommand {
  return { purpose: 'device.enroll', requestDigest: cardinalContentDigest({ ...args,
    materialDigest: cardinalContentDigest(material) }) };
}
export function protectedDeviceEnrollmentMessage(command: ProtectedDeviceCommand): string {
  if (command.purpose !== 'device.enroll' || !/^[a-f0-9]{64}$/.test(command.requestDigest)) throw new VaultRecordError('Invalid device enrollment command.');
  return 'josi-protected-device-enrollment.1\n' + JSON.stringify([command.purpose, command.requestDigest]);
}

export class ProtectedDeviceStore {
  constructor(private readonly backend: ProtectedDeviceBackend, private readonly authority: ProtectedDeviceAuthority) {}
  async inventory(actorUserId: string): Promise<ProtectedDeviceInventory> {
    return this.backend(actorUserId, false, async context => {
      const value = await current(context);
      return { reference: value.reference, authorityEpoch: context.epoch, reconciliationRequired: context.reconciliationRequired,
        devices: value.document.devices.filter(device => device.material.identity.userId === actorUserId).map(summary) };
    });
  }
  private async enrollment(context: ProtectedDeviceTransaction, args: Omit<ProtectedDeviceEnrollment, 'material'>, material: NativeVaultSigningMaterial) {
    if (!uuid(args.actorUserId) || !uuid(args.enrollmentId) || !labelValid(args.label)
      || !(args.expected === null || referenceValid(args.expected))
      || material.identity.userId !== args.actorUserId || args.epoch !== context.epoch || context.reconciliationRequired) throw new VaultRecordError('Exact current owner and Vault authority are required.');
    await server(this.authority, context.tx, material.identity);
    const value = await current(context, args.expected), devices = value.document.devices;
    if (devices.length >= 32) throw new VaultRecordError('This protected-device registry has reached its retained enrollment limit.');
    if (devices.some(device => device.id === args.enrollmentId || device.material.identity.deviceId === material.identity.deviceId
      || device.material.signingPublicKeySpki === material.signingPublicKeySpki || device.material.wrappingPublicKey === material.wrappingPublicKey)) {
      throw new VaultRecordConflictError('This device or key was already enrolled. Do not silently replace or revive it.');
    }
    const fingerprints = summary({ id: args.enrollmentId, label: args.label, material, enrolledAt: '', revokedAt: null });
    const command = enrollmentBinding(args, material);
    const presentation: ProtectedControlPresentation = { wording: `Enroll ${args.label} for protected administrator confirmations.`,
      meaning: `Server: ${material.identity.serverOrigin}\nServer ID: ${material.identity.serverId}\nAdministrator: ${material.identity.userId}\nDevice: ${material.identity.deviceId}\nSigning key SHA-256: ${fingerprints.signingFingerprint}\nHardware wrapping key SHA-256: ${fingerprints.wrappingFingerprint}\nThis enrolls a protected confirmation key. It does not grant browser, desktop, file, network or task access.`,
      advisory: ['The Vault remains canonical. Local owner consent and fresh administrator verification are both required.',
        'Approve this request in the installed Josi app on the server Mac. For a remote target Mac, compare the complete device identity and both key fingerprints with its enrollment window before approving.'] };
    return { ...value, command, presentation };
  }
  async prepareEnrollment(args: ProtectedDeviceEnrollment) {
    const material = materialFrom(args.material), { material: _secret, ...rest } = args, input = structuredClone(rest);
    return this.backend(input.actorUserId, false, async context => {
      const value = await this.enrollment(context, input, material);
      return { command: value.command, presentation: value.presentation };
    });
  }
  async enroll(args: ProtectedDeviceEnrollment & { possessionSignature: string; consentProof: unknown }): Promise<ProtectedDeviceInventory> {
    const material = materialFrom(args.material);
    const input = structuredClone({ actorUserId: args.actorUserId, enrollmentId: args.enrollmentId, label: args.label, expected: args.expected, epoch: args.epoch });
    const signature = args.possessionSignature, consentProof = args.consentProof;
    return this.backend(input.actorUserId, true, async context => {
      const prepared = await this.enrollment(context, input, material);
      if (typeof this.authority?.verifyFreshAdministrator !== 'function' || typeof this.authority?.verifyEnrollmentConsent !== 'function') throw new VaultRecordError('Protected enrollment is unavailable.');
      const key = createPublicKey({ key: Buffer.from(material.signingPublicKeySpki, 'base64'), type: 'spki', format: 'der' });
      const proof = typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature) ? Buffer.from(signature, 'base64url') : Buffer.alloc(0);
      if (proof.length !== 64 || proof.toString('base64url') !== signature
        || !verify(null, Buffer.from(protectedDeviceEnrollmentMessage(prepared.command)), key, proof)) throw new VaultRecordError('The new device did not prove possession of its signing key.');
      await this.authority.verifyFreshAdministrator(context.tx, input.actorUserId, Object.freeze({ ...prepared.command }));
      await this.authority.verifyEnrollmentConsent(context.tx, input.actorUserId, Object.freeze({ ...prepared.command }), structuredClone(prepared.presentation), consentProof);
      const device: DeviceRecord = { id: input.enrollmentId, label: input.label, material, enrolledAt: await date(context.tx), revokedAt: null };
      const document: DeviceDocument = { schemaVersion: 1, devices: [...prepared.document.devices, device] };
      const reference = await context.write(new Secret(JSON.stringify(document)));
      return { reference, authorityEpoch: reference.epoch, reconciliationRequired: false, devices: document.devices.filter(d => d.material.identity.userId === input.actorUserId).map(summary) };
    });
  }
  private async revocation(context: ProtectedDeviceTransaction, args: ProtectedDeviceRevocation) {
    if (!uuid(args.actorUserId) || !uuid(args.enrollmentId) || !referenceValid(args.expected)
      || context.reconciliationRequired) throw new VaultRecordError('Current protected-device authority is required.');
    const value = await current(context, args.expected);
    const device = value.document.devices.find(d => d.id === args.enrollmentId && d.material.identity.userId === args.actorUserId && !d.revokedAt);
    if (!device) throw new VaultRecordError('The active owned enrollment is unavailable.');
    await server(this.authority, context.tx, device.material.identity);
    const command: ProtectedDeviceCommand = { purpose: 'device.revoke', requestDigest: cardinalContentDigest(args) };
    const presentation: ProtectedControlPresentation = { wording: `Revoke protected confirmations on ${device.label}.`,
      meaning: `Server: ${device.material.identity.serverOrigin}\nAdministrator: ${args.actorUserId}\nDevice: ${device.material.identity.deviceId}\nThis key will no longer verify protected changes. Existing challenges become stale. Vault history remains. This does not log out website accounts or erase the Mac's hardware wrapping root.`,
      advisory: ['A revoked enrollment cannot be silently reactivated. Recovery requires an explicitly approved new enrollment.'] };
    return { ...value, device, command, presentation };
  }
  async prepareRevocation(args: ProtectedDeviceRevocation) {
    const input = structuredClone(args);
    return this.backend(input.actorUserId, false, async context => {
      const value = await this.revocation(context, input); return { command: value.command, presentation: value.presentation };
    });
  }
  async revoke(args: ProtectedDeviceRevocation & { proof: unknown }): Promise<ProtectedDeviceInventory> {
    const input = structuredClone({ actorUserId: args.actorUserId, enrollmentId: args.enrollmentId, expected: args.expected }), proof = args.proof;
    return this.backend(input.actorUserId, true, async context => {
      const prepared = await this.revocation(context, input);
      if (typeof this.authority?.verifyFreshAdministrator !== 'function' || typeof this.authority?.verifyProtectedRevocation !== 'function') throw new VaultRecordError('Protected revocation is unavailable.');
      await this.authority.verifyFreshAdministrator(context.tx, input.actorUserId, Object.freeze({ ...prepared.command }));
      await this.authority.verifyProtectedRevocation(context.tx, input.actorUserId, Object.freeze({ ...prepared.command }), structuredClone(prepared.presentation), proof);
      prepared.device.revokedAt = await date(context.tx);
      if (Date.parse(prepared.device.revokedAt) < Date.parse(prepared.device.enrolledAt)) throw new VaultRecordError('The server clock moved backwards. Reconcile it before revoking this enrollment.');
      const reference = await context.write(new Secret(JSON.stringify(prepared.document)));
      return { reference, authorityEpoch: reference.epoch, reconciliationRequired: false, devices: prepared.document.devices.filter(d => d.material.identity.userId === input.actorUserId).map(summary) };
    });
  }
  private async enrolled(context: ProtectedDeviceTransaction, identity: ProtectedConfirmationIdentity, expected?: VaultRecordReference) {
    if (!identityValid(identity) || context.reconciliationRequired) throw new VaultRecordError('Current protected-device authority is required.');
    await server(this.authority, context.tx, identity);
    const value = await current(context, expected);
    const device = value.document.devices.find(d => sameIdentity(d.material.identity, identity) && !d.revokedAt);
    if (!device || !value.reference) throw new VaultRecordError('The active owned enrollment is unavailable.');
    return { device, reference: value.reference };
  }
  /** Public verifier material only. Use the caller's existing Vault TX so
   * confirmation consumption and current enrollment share one authority view. */
  async resolveDeviceKey(tx: Db, identity: ProtectedConfirmationIdentity) {
    const input = structuredClone(identity);
    return this.backend(input.userId, false, async context => {
      const { device, reference } = await this.enrolled(context, input);
      return { reference, publicKeySpki: Buffer.from(device.material.signingPublicKeySpki, 'base64').toString('base64url'),
        wrappingPublicKey: device.material.wrappingPublicKey };
    }, tx);
  }
  /** Only an authenticated protected-host adapter may receive this short-lived
   * projection. The returned Secret redacts accidental JSON/log serialization. */
  async project(args: { actorUserId: string; identity: ProtectedConfirmationIdentity; expected: VaultRecordReference; proof: unknown }) {
    const identity = structuredClone(args.identity), expected = structuredClone(args.expected), actor = args.actorUserId, proof = args.proof;
    if (!identityValid(identity) || identity.userId !== actor || !referenceValid(expected)) throw new VaultRecordError('Use the enrolled administrator identity and exact current Vault reference.');
    return this.backend(actor, false, async context => {
      const { device, reference } = await this.enrolled(context, identity, expected);
      if (typeof this.authority?.verifyHostProjection !== 'function') throw new VaultRecordError('Protected-host authentication is unavailable.');
      await this.authority.verifyHostProjection(context.tx, actor, summary(device), { ...reference }, proof);
      const issuedAtMs = Date.parse(await date(context.tx));
      return { schemaVersion: 1 as const, reference, issuedAtMs, expiresAtMs: issuedAtMs + 60_000,
        material: new Secret(JSON.stringify(device.material)) };
    });
  }
}
