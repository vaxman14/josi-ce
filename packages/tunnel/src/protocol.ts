// The first two handshake payloads. docs/RELAY_PROTOCOL.md is the prose version
// and what the Swift and C# clients were written from.
import { fromUtf8, utf8 } from './bytes.js';

export type Hello =
  | { v: 1; op: 'connect'; client: string; ts: number }
  | { v: 1; op: 'pair'; code: string; name: string; platform: string; ts: number };

export type Welcome =
  | { ok: true; device: string; server: string; lan?: string[]; rotate?: RotationNotice }
  | { ok: false; error: 'unknown_device' | 'revoked' | 'bad_code' | 'busy' | 'stale' };

/** Told to a device that reached the server on its previous key. */
export interface RotationNotice { publicKey: string; until: string | null }

/** Control messages, inside an established session. */
export type Control =
  | { t: 'rotate-device'; publicKey: string }
  | { t: 'rotate-device-ok' }
  | { t: 'rotate-device-refused'; error: string }
  | { t: 'rotate-server'; publicKey: string; until: string | null }
  | { t: 'revoked' };

/** How far a handshake's clock may be from ours. */
export const HELLO_SKEW_MS = 5 * 60_000;

export const encodeJson = (value: unknown): Uint8Array => utf8(JSON.stringify(value));
export const decodeJson = <T>(bytes: Uint8Array): T => JSON.parse(fromUtf8(bytes)) as T;
