// Noise_IK_25519_ChaChaPoly_SHA256 (Noise Protocol Framework, revision 34).
//
// The same handshake, framing and rekeying as bananana's noiselink module, and
// tested against the same vectors, but written on @noble so one implementation
// runs in Node and in a browser service worker. WebCrypto has X25519 and no
// ChaCha20-Poly1305, so a browser cannot do this with platform crypto alone.
//
// A static key is an object with a `dh` method, not a byte string. That lets a
// browser keep its device key as a non-extractable CryptoKey, so nothing in
// this file ever sees the private half.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, equal, randomBytes, utf8 } from './bytes.js';

const DHLEN = 32, TAGLEN = 16, FRAME_HEAD = 3, PAD_BLOCK = 256, REKEY_FLAG = 1;
export const MAX_MESSAGE = 65535;
export const MAX_FRAMED = MAX_MESSAGE - TAGLEN - FRAME_HEAD;
export const REKEY_MESSAGES = 1 << 20;
export const REKEY_SECONDS = 3600;
export const PROLOGUE = utf8('josi-relay/1');
const PROTOCOL = utf8('Noise_IK_25519_ChaChaPoly_SHA256');
const NONE = new Uint8Array(0);
const MAX_NONCE = 0xffffffffffffffffn;

export interface StaticKey {
  publicKey: Uint8Array;
  dh(remotePublic: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export function checkedDh(privateKey: Uint8Array, remotePublic: Uint8Array): Uint8Array {
  const out = x25519.getSharedSecret(privateKey, remotePublic);
  if (equal(out, new Uint8Array(DHLEN))) throw new Error('Low-order public key');
  return out;
}

export function staticKeyFrom(privateKey: Uint8Array): StaticKey {
  return { publicKey: x25519.getPublicKey(privateKey), dh: remote => checkedDh(privateKey, remote) };
}

export function generateKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = randomBytes(DHLEN);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(sha256, ck, ikm), one = hmac(sha256, temp, Uint8Array.of(1));
  return [one, hmac(sha256, temp, concat(one, Uint8Array.of(2)))];
}

function nonceBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, n, true);
  return out;
}

export class CipherState {
  n = 0n;
  constructor(public k: Uint8Array | null = null) {}
  encrypt(ad: Uint8Array, plain: Uint8Array): Uint8Array {
    if (!this.k) return plain;
    if (this.n >= MAX_NONCE) throw new Error('Nonce exhausted');
    const out = chacha20poly1305(this.k, nonceBytes(this.n), ad).encrypt(plain);
    this.n++;
    return out;
  }
  decrypt(ad: Uint8Array, ct: Uint8Array): Uint8Array {
    if (!this.k) return ct;
    if (ct.length < TAGLEN) throw new Error('Decryption failed');
    let out: Uint8Array;
    try { out = chacha20poly1305(this.k, nonceBytes(this.n), ad).decrypt(ct); } catch { throw new Error('Decryption failed'); }
    this.n++;
    return out;
  }
  rekey(): void {
    this.k = chacha20poly1305(this.k!, nonceBytes(MAX_NONCE), NONE).encrypt(new Uint8Array(32)).subarray(0, 32);
  }
}

class SymmetricState {
  h: Uint8Array = PROTOCOL.length <= 32 ? concat(PROTOCOL, new Uint8Array(32 - PROTOCOL.length)) : sha256(PROTOCOL);
  ck: Uint8Array = this.h;
  cipher = new CipherState();
  mixHash(data: Uint8Array) { this.h = sha256(concat(this.h, data)); }
  mixKey(ikm: Uint8Array) { const [ck, temp] = hkdf2(this.ck, ikm); this.ck = ck; this.cipher = new CipherState(temp); }
  encryptAndHash(plain: Uint8Array) { const ct = this.cipher.encrypt(this.h, plain); this.mixHash(ct); return ct; }
  decryptAndHash(ct: Uint8Array) { const plain = this.cipher.decrypt(this.h, ct); this.mixHash(ct); return plain; }
  split(): [CipherState, CipherState] { const [a, b] = hkdf2(this.ck, NONE); return [new CipherState(a), new CipherState(b)]; }
}

/** One IK handshake. The initiator passes the responder's static public key. */
export class Handshake {
  done = false;
  send: CipherState | null = null;
  recv: CipherState | null = null;
  remoteStatic: Uint8Array | null;
  private e: Uint8Array | null = null;
  private re: Uint8Array | null = null;
  private readonly ss = new SymmetricState();

  constructor(initiator: boolean, private readonly s: StaticKey, remoteStatic: Uint8Array | null = null, prologue: Uint8Array = PROLOGUE) {
    this.remoteStatic = remoteStatic;
    this.ss.mixHash(prologue);
    if (initiator) {
      if (!remoteStatic) throw new Error('IK initiator needs the responder static key');
      this.ss.mixHash(remoteStatic);
    } else this.ss.mixHash(s.publicKey);
  }

  async writeFirst(payload: Uint8Array = NONE, ephemeral?: Uint8Array): Promise<Uint8Array> {
    const ss = this.ss, rs = this.remoteStatic!;
    this.e = ephemeral ?? randomBytes(DHLEN);
    const epub = x25519.getPublicKey(this.e);
    ss.mixHash(epub); ss.mixKey(checkedDh(this.e, rs));
    const encS = ss.encryptAndHash(this.s.publicKey);
    ss.mixKey(await this.s.dh(rs));
    return concat(epub, encS, ss.encryptAndHash(payload));
  }

  async readFirst(message: Uint8Array): Promise<Uint8Array> {
    if (message.length < DHLEN + DHLEN + TAGLEN + TAGLEN) throw new Error('Short handshake message');
    const ss = this.ss;
    this.re = message.subarray(0, DHLEN);
    ss.mixHash(this.re); ss.mixKey(await this.s.dh(this.re));
    this.remoteStatic = ss.decryptAndHash(message.subarray(DHLEN, DHLEN + DHLEN + TAGLEN));
    ss.mixKey(await this.s.dh(this.remoteStatic));
    return ss.decryptAndHash(message.subarray(DHLEN + DHLEN + TAGLEN));
  }

  async writeSecond(payload: Uint8Array = NONE, ephemeral?: Uint8Array): Promise<Uint8Array> {
    const ss = this.ss;
    this.e = ephemeral ?? randomBytes(DHLEN);
    const epub = x25519.getPublicKey(this.e);
    ss.mixHash(epub); ss.mixKey(checkedDh(this.e, this.re!)); ss.mixKey(checkedDh(this.e, this.remoteStatic!));
    const out = concat(epub, ss.encryptAndHash(payload));
    [this.recv, this.send] = ss.split();   // the responder receives on the first, sends on the second
    this.done = true;
    return out;
  }

  async readSecond(message: Uint8Array): Promise<Uint8Array> {
    if (message.length < DHLEN + TAGLEN) throw new Error('Short handshake message');
    const ss = this.ss;
    this.re = message.subarray(0, DHLEN);
    ss.mixHash(this.re); ss.mixKey(checkedDh(this.e!, this.re)); ss.mixKey(await this.s.dh(this.re));
    const payload = ss.decryptAndHash(message.subarray(DHLEN));
    [this.send, this.recv] = ss.split();
    this.done = true;
    return payload;
  }

  get handshakeHash(): Uint8Array { return this.ss.h; }
}

/** The transport phase. Framed: flags, 2-byte length, the data, then zeros to a
 * multiple of PAD_BLOCK, so the relay learns sizes only to the nearest block.
 * The sender rekeys after REKEY_MESSAGES or REKEY_SECONDS and marks its last
 * message under the old key. */
export class Session {
  frame = false;
  rekeyMessages = REKEY_MESSAGES;
  rekeySeconds = REKEY_SECONDS;
  private sent = 0;
  private rekeyed = Date.now();

  constructor(readonly send: CipherState, readonly recv: CipherState, readonly remoteStatic: Uint8Array | null = null) {}

  static from(handshake: Handshake): Session {
    if (!handshake.done) throw new Error('Handshake not finished');
    return new Session(handshake.send!, handshake.recv!, handshake.remoteStatic);
  }

  framed(): this { this.frame = true; return this; }

  seal(plain: Uint8Array): Uint8Array {
    if (!this.frame) {
      if (plain.length + TAGLEN > MAX_MESSAGE) throw new Error('Message too large');
      return this.send.encrypt(NONE, plain);
    }
    if (plain.length > MAX_FRAMED) throw new Error('Message too large');
    this.sent++;
    const rekey = this.sent >= this.rekeyMessages || Date.now() - this.rekeyed >= this.rekeySeconds * 1000;
    const body = new Uint8Array(Math.min(Math.ceil((FRAME_HEAD + plain.length) / PAD_BLOCK) * PAD_BLOCK, MAX_MESSAGE - TAGLEN));
    body[0] = rekey ? REKEY_FLAG : 0;
    body[1] = plain.length >> 8; body[2] = plain.length & 255;
    body.set(plain, FRAME_HEAD);
    const out = this.send.encrypt(NONE, body);
    if (rekey) { this.send.rekey(); this.sent = 0; this.rekeyed = Date.now(); }
    return out;
  }

  open(ct: Uint8Array): Uint8Array {
    if (ct.length > MAX_MESSAGE) throw new Error('Message too large');
    const plain = this.recv.decrypt(NONE, ct);
    if (!this.frame) return plain;
    if (plain.length < FRAME_HEAD || (plain[0] & ~REKEY_FLAG)) throw new Error('Bad frame');
    const size = (plain[1] << 8) | plain[2];
    if (FRAME_HEAD + size > plain.length) throw new Error('Bad frame');
    if (plain[0] & REKEY_FLAG) this.recv.rekey();
    return plain.subarray(FRAME_HEAD, FRAME_HEAD + size);
  }
}
