import type { VaultAuthorityReference } from './automation.js';
import { isProtectedControlOrigin } from './protectedControl.js';

/** Public authentication challenge, derived from one pending protected change.
 * Contains neither the rule presentation nor wrapped signing material. */
export interface ProtectedHostChallenge {
  schemaVersion: 1; id: string; nonce: string;
  serverOrigin: string; serverId: string; userId: string; deviceId: string;
  keyReference: VaultAuthorityReference; wrappingFingerprint: string;
  issuedAtMs: number; expiresAtMs: number;
}
export interface ProtectedHostReceipt {
  schemaVersion: 1; challengeId: string; challengeDigest: string; signature: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function parseProtectedHostChallenge(value: unknown): ProtectedHostChallenge | null {
  if (!object(value) || !exact(value, ['schemaVersion', 'id', 'nonce', 'serverOrigin', 'serverId', 'userId', 'deviceId',
    'keyReference', 'wrappingFingerprint', 'issuedAtMs', 'expiresAtMs']) || value.schemaVersion !== 1
    || ![value.id, value.serverId, value.userId, value.deviceId].every(uuid) || !isProtectedControlOrigin(value.serverOrigin)
    || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce) || !digest(value.wrappingFingerprint)
    || !integer(value.issuedAtMs) || !integer(value.expiresAtMs) || value.expiresAtMs <= value.issuedAtMs
    || value.expiresAtMs - value.issuedAtMs > 60_000) return null;
  const ref = value.keyReference;
  if (!object(ref) || !exact(ref, ['recordId', 'version', 'digest', 'epoch'])
    || !uuid(ref.recordId) || !digest(ref.digest) || !integer(ref.version) || ref.version < 1 || !integer(ref.epoch) || ref.epoch < 1) return null;
  return structuredClone(value) as unknown as ProtectedHostChallenge;
}
export function protectedHostMessage(value: ProtectedHostChallenge): string {
  const c = parseProtectedHostChallenge(value);
  if (!c) throw new Error('Invalid protected-host challenge.');
  return 'josi-protected-host-auth.1\n' + JSON.stringify([c.schemaVersion, c.id, c.nonce, c.serverOrigin, c.serverId, c.userId, c.deviceId,
    [c.keyReference.recordId, c.keyReference.version, c.keyReference.digest, c.keyReference.epoch], c.wrappingFingerprint, c.issuedAtMs, c.expiresAtMs]);
}
