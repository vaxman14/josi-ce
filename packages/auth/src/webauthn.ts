// WebAuthn, the part that has to be right: reading what a browser sends back
// and deciding whether to believe it.
//
// Written here rather than pulled in for the same reason as the UI primitives:
// CE ships to strangers on small machines, every dependency is surface, and all
// of this is a page of parsing on top of node:crypto. There is no attestation
// verification because Josi asks for none: it has no use for knowing which
// company made a key, only that the same key comes back. So the registration
// check is the browser's ceremony (type, challenge, origin, RP ID, user present,
// user verified) and the public key it hands over.
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const COSE_RS256 = -257;

export class WebAuthnError extends Error {}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED = 0x40;

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Strict: a value that is not exactly base64url is refused rather than half read. */
export function fromBase64url(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new WebAuthnError(`${label} is missing or malformed.`);
  return Buffer.from(value, 'base64url');
}

/** The CBOR that attestation objects and COSE keys actually use. Anything else
 * (floats, tags, indefinite lengths) has no business being here and is refused. */
export function decodeCbor(bytes: Uint8Array, start = 0): { value: unknown; end: number } {
  let at = start;
  const need = (n: number) => { if (at + n > bytes.length) throw new WebAuthnError('The authenticator data was cut short.'); };
  const readLength = (info: number): number => {
    if (info < 24) return info;
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
    if (!width) throw new WebAuthnError('The authenticator data used an unsupported length.');
    need(width);
    let length = 0;
    for (let i = 0; i < width; i++) length = length * 256 + bytes[at + i]!;
    at += width;
    return length;
  };
  const item = (depth: number): unknown => {
    if (depth > 8) throw new WebAuthnError('The authenticator data is nested too deeply.');
    need(1);
    const first = bytes[at++]!, major = first >> 5, info = first & 31;
    if (major === 0) return readLength(info);
    if (major === 1) return -1 - readLength(info);
    if (major === 2 || major === 3) {
      const length = readLength(info);
      need(length);
      const data = bytes.subarray(at, at + length);
      at += length;
      return major === 2 ? Buffer.from(data) : Buffer.from(data).toString('utf8');
    }
    if (major === 4) {
      const length = readLength(info), list: unknown[] = [];
      for (let i = 0; i < length; i++) list.push(item(depth + 1));
      return list;
    }
    if (major === 5) {
      const length = readLength(info), map = new Map<unknown, unknown>();
      for (let i = 0; i < length; i++) { const key = item(depth + 1); map.set(key, item(depth + 1)); }
      return map;
    }
    if (major === 7 && info === 20) return false;
    if (major === 7 && info === 21) return true;
    if (major === 7 && info === 22) return null;
    throw new WebAuthnError('The authenticator data used an unsupported type.');
  };
  const value = item(0);
  return { value, end: at };
}

interface AuthenticatorData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  cosePublicKey?: Map<unknown, unknown>;
}

function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) throw new WebAuthnError('The authenticator data was cut short.');
  const parsed: AuthenticatorData = { rpIdHash: data.subarray(0, 32), flags: data[32]!, signCount: data.readUInt32BE(33) };
  if (parsed.flags & FLAG_ATTESTED) {
    if (data.length < 55) throw new WebAuthnError('The authenticator data was cut short.');
    const length = data.readUInt16BE(53);
    if (55 + length > data.length) throw new WebAuthnError('The authenticator data was cut short.');
    parsed.credentialId = data.subarray(55, 55 + length);
    const key = decodeCbor(data, 55 + length).value;
    if (!(key instanceof Map)) throw new WebAuthnError('The public key could not be read.');
    parsed.cosePublicKey = key;
  }
  return parsed;
}

/** A COSE key as an SPKI public key, the form node:crypto takes back later. */
function publicKeyFromCose(cose: Map<unknown, unknown>): { publicKey: string; algorithm: number } {
  const kty = cose.get(1), alg = cose.get(3);
  const b64 = (label: number) => {
    const part = cose.get(label);
    if (!Buffer.isBuffer(part)) throw new WebAuthnError('The public key could not be read.');
    return part.toString('base64url');
  };
  let key: KeyObject;
  try {
    if (kty === 2 && alg === COSE_ES256 && cose.get(-1) === 1) key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(-2), y: b64(-3) }, format: 'jwk' });
    else if (kty === 1 && alg === COSE_EDDSA && cose.get(-1) === 6) key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64(-2) }, format: 'jwk' });
    else if (kty === 3 && alg === COSE_RS256) key = createPublicKey({ key: { kty: 'RSA', n: b64(-1), e: b64(-2) }, format: 'jwk' });
    else throw new WebAuthnError('That passkey uses a key type this server does not accept.');
  } catch (err) {
    if (err instanceof WebAuthnError) throw err;
    throw new WebAuthnError('The public key could not be read.');
  }
  return { publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64'), algorithm: alg };
}

interface Expected { challenge: string; origin: string; rpId: string }

function checkClientData(clientDataJSON: Buffer, type: string, expected: Expected): void {
  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { client = JSON.parse(clientDataJSON.toString('utf8')) as typeof client; }
  catch { throw new WebAuthnError('The browser response could not be read.'); }
  if (client.type !== type) throw new WebAuthnError('That was the wrong kind of passkey response.');
  if (client.challenge !== expected.challenge) throw new WebAuthnError('That passkey response was for a different request.');
  if (client.origin !== expected.origin) throw new WebAuthnError('That passkey response came from a different address.');
  if (client.crossOrigin === true) throw new WebAuthnError('A passkey cannot be used from inside another site.');
}

function checkAuthenticator(data: AuthenticatorData, rpId: string): void {
  const expected = createHash('sha256').update(rpId).digest();
  if (data.rpIdHash.length !== expected.length || !timingSafeEqual(data.rpIdHash, expected)) throw new WebAuthnError('That passkey belongs to a different server.');
  if (!(data.flags & FLAG_USER_PRESENT)) throw new WebAuthnError('The passkey did not confirm anyone was there.');
  // Verified, not just present. Josi treats a passkey as both factors, so the
  // fingerprint, face or PIN on the device is what makes that true.
  if (!(data.flags & FLAG_USER_VERIFIED)) throw new WebAuthnError('The passkey did not verify who was there.');
}

/** The challenge a response claims to answer, for looking it up. It is checked
 * against the stored one in the verify calls below, not trusted from here. */
export function claimedChallenge(clientDataJSON: unknown): string {
  try {
    const challenge = (JSON.parse(fromBase64url(clientDataJSON, 'clientDataJSON').toString('utf8')) as { challenge?: unknown }).challenge;
    if (typeof challenge === 'string' && challenge) return challenge;
  } catch { /* Refused below. */ }
  throw new WebAuthnError('The browser response could not be read.');
}

export interface VerifiedRegistration { credentialId: string; publicKey: string; algorithm: number; signCount: number }

export function verifyRegistration(response: { clientDataJSON: unknown; attestationObject: unknown }, expected: Expected): VerifiedRegistration {
  checkClientData(fromBase64url(response.clientDataJSON, 'clientDataJSON'), 'webauthn.create', expected);
  const attestation = decodeCbor(fromBase64url(response.attestationObject, 'attestationObject')).value;
  const authData = attestation instanceof Map ? attestation.get('authData') : null;
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError('The authenticator data could not be read.');
  const parsed = parseAuthenticatorData(authData);
  checkAuthenticator(parsed, expected.rpId);
  if (!parsed.credentialId?.length || !parsed.cosePublicKey) throw new WebAuthnError('The passkey did not include its key.');
  if (parsed.credentialId.length > 1023) throw new WebAuthnError('That passkey has an ID too long to be real.');
  return { credentialId: base64url(parsed.credentialId), ...publicKeyFromCose(parsed.cosePublicKey), signCount: parsed.signCount };
}

/** Verifies a sign-in and returns the authenticator's new counter. */
export function verifyAssertion(
  response: { clientDataJSON: unknown; authenticatorData: unknown; signature: unknown },
  expected: Expected,
  stored: { publicKey: string; algorithm: number; signCount: number },
): number {
  const clientData = fromBase64url(response.clientDataJSON, 'clientDataJSON');
  const authData = fromBase64url(response.authenticatorData, 'authenticatorData');
  checkClientData(clientData, 'webauthn.get', expected);
  const parsed = parseAuthenticatorData(authData);
  checkAuthenticator(parsed, expected.rpId);
  const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
  const key = createPublicKey({ key: Buffer.from(stored.publicKey, 'base64'), format: 'der', type: 'spki' });
  const hash = stored.algorithm === COSE_EDDSA ? null : 'sha256';
  if (!verify(hash, signed, key, fromBase64url(response.signature, 'signature'))) throw new WebAuthnError('The passkey signature did not match.');
  // A counter that fails to rise means two copies of the key exist. Many passkeys
  // that sync between devices report 0 forever, and that is allowed.
  if ((stored.signCount > 0 || parsed.signCount > 0) && parsed.signCount <= stored.signCount) throw new WebAuthnError('This passkey may have been copied.');
  return parsed.signCount;
}
