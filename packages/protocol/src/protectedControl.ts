import type { VaultAuthorityReference } from './automation.js';

export const PROTECTED_CONTROL_PURPOSES = ['cardinal.activate', 'cardinal.retire', 'automation.policy.replace', 'device.revoke'] as const;
export type ProtectedControlPurpose = typeof PROTECTED_CONTROL_PURPOSES[number];
export interface ProtectedControlPresentation { wording: string; meaning: string; advisory: string[] }
export interface ProtectedControlChallenge {
  schemaVersion: 1; id: string; nonce: string;
  serverOrigin: string; serverId: string; userId: string; deviceId: string;
  purpose: ProtectedControlPurpose; requestDigest: string; keyReference: VaultAuthorityReference;
  issuedAtMs: number; expiresAtMs: number;
  presentation: ProtectedControlPresentation;
}
export interface ProtectedControlReceipt {
  schemaVersion: 1; challengeId: string; challengeDigest: string; signature: string;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
/** Protected control requires HTTPS off-device. Legacy private-HTTP clients
 * may still chat; they do not gain privileged key-projection transport. */
export function isProtectedControlOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\*]/u.test(value)) return false;
  try {
    const u = new URL(value);
    return u.origin === value && !u.username && !u.password && (u.protocol === 'https:'
      || u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname));
  } catch { return false; }
}
/** Bounded full presentation, including old/new maximum-size rule scopes and
 * the complete stored advisory. No truncation is permitted for confirmation. */
export function parseProtectedControlPresentation(value: unknown): ProtectedControlPresentation | null {
  if (!object(value) || !keys(value, ['wording', 'meaning', 'advisory']) || !text(value.wording, 4000)
    || !text(value.meaning, 64_000) || !Array.isArray(value.advisory) || value.advisory.length > 20
    || value.advisory.some(v => !text(v, 2600))) return null;
  return structuredClone(value) as unknown as ProtectedControlPresentation;
}
export function parseProtectedControlChallenge(value: unknown): ProtectedControlChallenge | null {
  if (!object(value) || !keys(value, ['schemaVersion', 'id', 'nonce', 'serverOrigin', 'serverId', 'userId', 'deviceId',
    'purpose', 'requestDigest', 'keyReference', 'issuedAtMs', 'expiresAtMs', 'presentation']) || value.schemaVersion !== 1
    || ![value.id, value.serverId, value.userId, value.deviceId].every(uuid) || !isProtectedControlOrigin(value.serverOrigin)
    || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce)
    || typeof value.purpose !== 'string' || !PROTECTED_CONTROL_PURPOSES.includes(value.purpose as ProtectedControlPurpose)
    || !digest(value.requestDigest) || !integer(value.issuedAtMs) || !integer(value.expiresAtMs)
    || value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > 120_000) return null;
  const key = value.keyReference, p = value.presentation;
  if (!object(key) || !keys(key, ['recordId', 'version', 'digest', 'epoch']) || !uuid(key.recordId) || !digest(key.digest)
    || !integer(key.version) || key.version < 1 || !integer(key.epoch) || key.epoch < 1
    || !parseProtectedControlPresentation(p)) return null;
  return structuredClone(value) as unknown as ProtectedControlChallenge;
}
/** Canonical bytes bind the complete host presentation as well as the exact
 * mutation, nonce, identity, expiry and Vault signing-key reference. */
export function protectedControlMessage(challenge: ProtectedControlChallenge): string {
  const c = parseProtectedControlChallenge(challenge);
  if (!c) throw new Error('Invalid protected confirmation challenge.');
  return 'josi-protected-control.1\n' + JSON.stringify([c.schemaVersion, c.id, c.nonce, c.serverOrigin, c.serverId, c.userId, c.deviceId,
    c.purpose, c.requestDigest, [c.keyReference.recordId, c.keyReference.version, c.keyReference.digest, c.keyReference.epoch],
    c.issuedAtMs, c.expiresAtMs, [c.presentation.wording, c.presentation.meaning, c.presentation.advisory]]);
}
