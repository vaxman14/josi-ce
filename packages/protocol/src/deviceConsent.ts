import { isProtectedControlOrigin, parseProtectedControlPresentation, type ProtectedControlPresentation } from './protectedControl.js';

/** A local, independently reviewed enrollment request. This public projection
 * contains no signing material and is never itself an authorization token. */
export interface DeviceConsentChallenge {
  schemaVersion: 1; id: string; nonce: string;
  serverOrigin: string; serverId: string; userId: string; deviceId: string;
  enrollmentId: string; requestDigest: string; authorityEpoch: number;
  issuedAtMs: number; expiresAtMs: number; presentation: ProtectedControlPresentation;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const prefix = 'josi-device-consent.1\n';
export function parseDeviceConsentChallenge(value: unknown): DeviceConsentChallenge | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'id', 'nonce', 'serverOrigin', 'serverId', 'userId', 'deviceId', 'enrollmentId',
    'requestDigest', 'authorityEpoch', 'issuedAtMs', 'expiresAtMs', 'presentation'];
  if (Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k)) || v.schemaVersion !== 1
    || ![v.id, v.serverId, v.userId, v.deviceId, v.enrollmentId].every(uuid) || !isProtectedControlOrigin(v.serverOrigin)
    || typeof v.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.nonce)
    || typeof v.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.requestDigest)
    || !integer(v.authorityEpoch) || !integer(v.issuedAtMs) || !integer(v.expiresAtMs)
    || v.expiresAtMs <= v.issuedAtMs || v.expiresAtMs - v.issuedAtMs > 120_000
    || !parseProtectedControlPresentation(v.presentation)) return null;
  return structuredClone(v) as unknown as DeviceConsentChallenge;
}
export function deviceConsentMessage(value: DeviceConsentChallenge): string {
  const c = parseDeviceConsentChallenge(value);
  if (!c) throw new Error('Invalid local device consent challenge.');
  const message = prefix + JSON.stringify([c.schemaVersion, c.id, c.nonce, c.serverOrigin, c.serverId, c.userId,
    c.deviceId, c.enrollmentId, c.requestDigest, c.authorityEpoch, c.issuedAtMs, c.expiresAtMs,
    [c.presentation.wording, c.presentation.meaning, c.presentation.advisory]]);
  if (new TextEncoder().encode(message).byteLength > 64 * 1024) throw new Error('Enrollment review is too large to display completely.');
  return message;
}
export function parseDeviceConsentMessage(message: unknown): DeviceConsentChallenge | null {
  if (typeof message !== 'string' || message.length > 64 * 1024 || !message.startsWith(prefix)) return null;
  try {
    const a: unknown = JSON.parse(message.slice(prefix.length));
    if (!Array.isArray(a) || a.length !== 13 || !Array.isArray(a[12]) || a[12].length !== 3) return null;
    const c = parseDeviceConsentChallenge({ schemaVersion: a[0], id: a[1], nonce: a[2], serverOrigin: a[3],
      serverId: a[4], userId: a[5], deviceId: a[6], enrollmentId: a[7], requestDigest: a[8], authorityEpoch: a[9],
      issuedAtMs: a[10], expiresAtMs: a[11], presentation: { wording: a[12][0], meaning: a[12][1], advisory: a[12][2] } });
    return c && deviceConsentMessage(c) === message ? c : null;
  } catch { return null; }
}
