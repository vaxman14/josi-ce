// Pairing codes and the sealed invite the relay holds for them.
//
// A code carries 160 random bits, shown as 32 Crockford base32 characters. The
// relay is given only a hash of it (the invite id) and a box sealed with a key
// derived from it, so it can hand the box over and enforce expiry but can't
// open the box or work back to the code. The server is what decides a code was
// used, once, inside the Noise handshake the code is sent in.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, fromB64url, fromUtf8, randomBytes, toB64url, toHex, utf8 } from './bytes.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_BYTES = 20;
export const CODE_CHARS = 32;
export const PAIRING_TTL_SECONDS = 600;

function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += ALPHABET[(value >> bits) & 31]; value &= (1 << bits) - 1; }
  }
  return out;
}

export function newPairingCode(): string { return base32(randomBytes(CODE_BYTES)); }

/** Dashes and case are for people. O, I and L are read as the digits they look like. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replaceAll('O', '0').replaceAll('I', '1').replaceAll('L', '1');
}

export function isPairingCode(code: string): boolean {
  return code.length === CODE_CHARS && [...code].every(ch => ALPHABET.includes(ch));
}

export function displayCode(code: string): string { return code.match(/.{1,4}/g)!.join('-'); }

export const inviteId = (code: string): string => toHex(sha256(utf8(`josi-invite-id/1|${code}`))).slice(0, 32);
const inviteKey = (code: string): Uint8Array => sha256(utf8(`josi-invite-key/1|${code}`));
/** What the server stores. Never the code. */
export const codeHash = (code: string): string => toHex(sha256(utf8(`josi-pairing-code/1|${code}`)));

/** Everything a device needs to reach a server, and nothing that lets it in. */
export interface InviteBox {
  v: 1;
  /** The server's Noise static public key, base64url. */
  server: string;
  site: string;
  /** e.g. wss://relay.heyjosi.com, or the owner's relay. */
  relay: string;
  name?: string | null;
  lan?: string[];
}

export function sealInvite(code: string, box: InviteBox): string {
  const nonce = randomBytes(12);
  return toB64url(concat(nonce, chacha20poly1305(inviteKey(code), nonce).encrypt(utf8(JSON.stringify(box)))));
}

export function openInvite(code: string, sealed: string): InviteBox {
  const raw = fromB64url(sealed);
  const box = JSON.parse(fromUtf8(chacha20poly1305(inviteKey(code), raw.subarray(0, 12)).decrypt(raw.subarray(12)))) as InviteBox;
  if (box.v !== 1 || typeof box.server !== 'string' || typeof box.site !== 'string') throw new Error('Bad invite');
  return box;
}

/** A QR needs no relay lookup: it carries the server key itself. The fragment
 * keeps the code out of any request when a phone camera opens the link. */
export function pairingLink(origin: string, code: string, box: InviteBox): string {
  return `${origin.replace(/\/$/, '')}/#josi-pair=${code}.${toB64url(utf8(JSON.stringify(box)))}`;
}

export function parsePairingLink(link: string): { code: string; box: InviteBox } | null {
  const match = /#josi-pair=([0-9A-Z]+)\.([A-Za-z0-9_-]+)$/.exec(link);
  if (!match || !isPairingCode(match[1])) return null;
  try { return { code: match[1], box: JSON.parse(fromUtf8(fromB64url(match[2]))) as InviteBox }; } catch { return null; }
}
