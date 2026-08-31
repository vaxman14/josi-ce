// Sealing secrets for storage in PostgreSQL.
//
// The installation master key lives outside the database (see masterKey.ts).
// Everything sealed here — provider API keys, OAuth client secrets, SMTP
// passwords — is therefore unreadable from a database dump alone. That is the
// property being bought, and it is also the reason the key must be backed up
// separately: restoring the database without it recovers rows nobody can open.
//
// AES-256-GCM: authenticated, so a tampered ciphertext fails to open rather
// than decrypting to attacker-chosen plaintext.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { MasterKey } from './masterKey.js';

export class SealingError extends Error {}

const VERSION = 'v1';

/** A secret in memory.
 *
 * Same discipline as MasterKey: the value is held in a closure, so a spread, a
 * template literal, JSON.stringify or console.log produce a redaction marker
 * instead of the secret. Reading it requires `.reveal()`, which is greppable.
 *
 * Values arriving from a request body are wrapped as early as possible, so the
 * window in which a bare string could be logged by accident is one line long. */
export class Secret {
  #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  get isEmpty(): boolean {
    return this.#value.length === 0;
  }

  toString(): string {
    return '[secret redacted]';
  }

  toJSON(): string {
    return '[secret redacted]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[secret redacted]';
  }
}

/** Wraps a value from untrusted input. Non-strings become an empty secret
 * rather than `"undefined"` being sealed and later handed to a provider. */
export function asSecret(value: unknown): Secret {
  return new Secret(typeof value === 'string' ? value : '');
}

/** Seals a JSON payload. Format: `v1.<iv>.<tag>.<ciphertext>`, all base64.
 *
 * Any `Secret` inside the payload is unwrapped here — this is the one place
 * that is allowed to see through the wrapper, because the result is ciphertext. */
export function seal(key: MasterKey, payload: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.reveal(), iv);
  const plaintext = JSON.stringify(payload, (_k, v) => (v instanceof Secret ? v.reveal() : v));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function openSealed<T = Record<string, unknown>>(key: MasterKey, sealed: string): T {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SealingError('unrecognised sealed value');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.reveal(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  } catch (err) {
    // A wrong key and a tampered ciphertext both land here. Never say which:
    // distinguishing them is an oracle.
    throw new SealingError('could not open sealed value');
  }
}

/** True when a string looks like something this module produced. Used by tests
 * to assert that what reached the database is ciphertext. */
export function looksSealed(value: unknown): boolean {
  return typeof value === 'string' && /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(value);
}
