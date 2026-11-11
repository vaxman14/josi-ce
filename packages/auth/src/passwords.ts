import * as nodeCrypto from 'node:crypto';

// argon2id, OWASP-ish minimums. Deliberately not tunable per call: one cost
// profile means every hash in the table is comparable and upgradeable together.
const OPTS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

type Engine = {
  hash(plain: string): Promise<string>;
  verify(stored: string, plain: string): Promise<boolean>;
};

// Node's own argon2 (node:crypto, Node 24.7 and later). Same algorithm and the
// same stored text ($argon2id$v=19$m=...,t=...,p=...$salt$hash) as
// @node-rs/argon2, so a hash made by one is checked by the other.
type NodeArgon2 = (
  algorithm: string,
  parameters: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number },
  callback: (error: Error | null, key: Buffer) => void,
) => void;
const nodeArgon2 = (nodeCrypto as unknown as { argon2?: NodeArgon2 }).argon2;

function derive(algorithm: string, plain: string, salt: Buffer, length: number, m: number, t: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeArgon2!(algorithm, { message: Buffer.from(plain, 'utf8'), nonce: salt, parallelism: p, tagLength: length, memory: m, passes: t },
      (error, key) => (error ? reject(error) : resolve(Buffer.from(key))));
  });
}
const b64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');
const STORED = /^\$(argon2id|argon2i|argon2d)\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export const builtInEngine: Engine = {
  async hash(plain) {
    const salt = nodeCrypto.randomBytes(16);
    const key = await derive('argon2id', plain, salt, 32, OPTS.memoryCost, OPTS.timeCost, OPTS.parallelism);
    return ['', 'argon2id', 'v=19', `m=${OPTS.memoryCost},t=${OPTS.timeCost},p=${OPTS.parallelism}`, b64(salt), b64(key)].join('$');
  },
  async verify(stored, plain) {
    const match = STORED.exec(stored);
    if (!match) return false;
    const [, algorithm, m, t, p, saltText, keyText] = match;
    const salt = Buffer.from(saltText!, 'base64'), expected = Buffer.from(keyText!, 'base64');
    if (salt.length < 8 || expected.length < 4) return false;
    const key = await derive(algorithm!, plain, salt, expected.length, Number(m), Number(t), Number(p));
    return key.length === expected.length && nodeCrypto.timingSafeEqual(key, expected);
  },
};

/** Whether this machine must not load @node-rs/argon2. Its prebuilt Linux
 * arm64 file uses processor instructions a Raspberry Pi 4 does not have, and
 * loading it kills the whole server (an illegal instruction cannot be caught).
 * Every other platform keeps the module it has always used. */
export function prefersBuiltIn(platform: string = process.platform, arch: string = process.arch): boolean {
  return platform === 'linux' && arch === 'arm64' && typeof nodeArgon2 === 'function';
}

let engine: Promise<Engine> | null = null;
function loadEngine(): Promise<Engine> {
  engine ??= prefersBuiltIn()
    ? Promise.resolve(builtInEngine)
    : import('@node-rs/argon2').then((native) => ({
        hash: (plain: string) => native.hash(plain, OPTS),
        verify: (stored: string, plain: string) => native.verify(stored, plain),
      }));
  return engine;
}

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 12) throw new Error('password must be at least 12 characters');
  return (await loadEngine()).hash(plain);
}

/** Never throws on a malformed/absent hash: a user mid-invite (password_hash
 * null) must fail exactly like a wrong password, with the same timing shape. */
export async function verifyPassword(storedHash: string | null, plain: string): Promise<boolean> {
  const { hash, verify } = await loadEngine();
  if (!storedHash) {
    // Burn comparable time so "no password set" is not distinguishable.
    await hash(plain).catch(() => undefined);
    return false;
  }
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';

/** Temp passwords for seeded/invited accounts. Crypto random, no ambiguous
 * glyphs (no 0/O/1/l/I) because these get typed off a screen. */
export function generatePassword(length = 20): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
