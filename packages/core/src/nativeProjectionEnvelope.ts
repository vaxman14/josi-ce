import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from 'node:crypto';
import { Secret } from './sealing.js';

/** Transport keys live only in the consuming worker. Neither the Vault nor a
 * durable tool receipt receives a decryption key for captured screen text. */
export function nativeProjectionRecipient() {
  const pair = generateKeyPairSync('x25519');
  const jwk = pair.publicKey.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('Projection recipient is unavailable.');
  return { privateKey: pair.privateKey, publicKey: Buffer.from(jwk.x, 'base64url').toString('base64') };
}
export interface NativeProjectionEnvelope { publicKey: string; box: string }
export function validNativeProjectionEnvelope(value: unknown): value is NativeProjectionEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as NativeProjectionEnvelope;
  return Object.keys(v).sort().join(',') === 'box,publicKey'
    && typeof v.publicKey === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(v.publicKey)
    && typeof v.box === 'string' && v.box.length >= 40 && v.box.length <= 87_420
    && /^[A-Za-z0-9+/]+={0,2}$/.test(v.box) && Buffer.from(v.box, 'base64').toString('base64') === v.box;
}
export function openNativeProjection(privateKey: KeyObject, envelope: NativeProjectionEnvelope, binding: string): Secret {
  if (!validNativeProjectionEnvelope(envelope)) throw new Error('Captured content is unavailable.');
  const shared = diffieHellman({ privateKey, publicKey: createPublicKey({ format: 'jwk',
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(envelope.publicKey, 'base64').toString('base64url') } }) });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(binding), Buffer.from('josi-native-projection.1'), 32));
  const box = Buffer.from(envelope.box, 'base64');
  let plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, box.subarray(0, 12));
    decipher.setAAD(Buffer.from(binding)); decipher.setAuthTag(box.subarray(-16));
    plain = Buffer.concat([decipher.update(box.subarray(12, -16)), decipher.final()]);
    if (plain.length > 64 * 1024) throw new Error('Captured content exceeded its reserved limit.');
    return new Secret(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } finally { shared.fill(0); key.fill(0); plain?.fill(0); }
}
