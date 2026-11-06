import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** For tokens with enough entropy that a plain hash can't be brute forced. */
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const hmacHex = (key: Uint8Array, text: string): string => createHmac('sha256', key).update(text).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** One configured key, with a separate key per use, so a CSRF token can never
 * pass as an OAuth wrapper signature. */
export const deriveKey = (key: Uint8Array, label: string): Buffer => Buffer.from(hkdfSync('sha256', key, new Uint8Array(0), `heyjosi/${label}`, 32));

/** AES-256-GCM. `context` ties the ciphertext to its row, so a sealed value
 * copied onto another account won't open. */
export function seal(key: Uint8Array, plain: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function unseal(key: Uint8Array, sealed: string, context: string): string {
  const [version, iv, body, tag] = sealed.split('.');
  if (version !== 'v1' || !iv || !body || !tag) throw new Error('Bad sealed value');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
