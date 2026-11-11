import { describe, expect, it } from 'vitest';
import { hash, verify } from '@node-rs/argon2';
import { builtInEngine, hashPassword, prefersBuiltIn, verifyPassword } from '../src/passwords.js';

// A Raspberry Pi 4 cannot load @node-rs/argon2, so Linux arm64 hashes with
// Node's own argon2. A database moved between machines must keep working, so
// each engine has to accept the other's hashes.
describe('password engines', () => {
  const plain = 'correct horse battery staple';

  it("uses Node's own argon2 on Linux arm64 only", () => {
    expect(prefersBuiltIn('linux', 'arm64')).toBe(true);
    expect(prefersBuiltIn('linux', 'x64')).toBe(false);
    expect(prefersBuiltIn('darwin', 'arm64')).toBe(false);
    expect(prefersBuiltIn('win32', 'arm64')).toBe(false);
  });

  it('the built-in engine writes the same kind of hash', async () => {
    const stored = await builtInEngine.hash(plain);
    const parts = stored.split('$');
    expect(parts.slice(0, 4)).toEqual(['', 'argon2id', 'v=19', 'm=19456,t=2,p=1']);
    expect(parts[4]).toHaveLength(22);
    expect(parts[5]).toHaveLength(43);
    expect(await builtInEngine.verify(stored, plain)).toBe(true);
    expect(await builtInEngine.verify(stored, plain + 'x')).toBe(false);
  });

  it("each engine accepts the other one's hashes", async () => {
    const fromBuiltIn = await builtInEngine.hash(plain);
    expect(await verify(fromBuiltIn, plain)).toBe(true);
    expect(await verify(fromBuiltIn, 'wrong password here')).toBe(false);
    const fromNative = await hash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    expect(await builtInEngine.verify(fromNative, plain)).toBe(true);
    expect(await builtInEngine.verify(fromNative, 'wrong password here')).toBe(false);
    // Other cost settings and lengths, as an older or imported hash may have.
    const other = await hash(plain, { memoryCost: 8192, timeCost: 3, parallelism: 2, outputLen: 24 });
    expect(await builtInEngine.verify(other, plain)).toBe(true);
  });

  it('a malformed stored hash is a wrong password, never an error', async () => {
    for (const bad of ['', 'nonsense', 'argon2id', ['', 'bcrypt', 'whatever'].join('$')]) {
      expect(await builtInEngine.verify(bad, plain)).toBe(false);
    }
    expect(await verifyPassword(null, plain)).toBe(false);
    expect(await verifyPassword(await hashPassword(plain), plain)).toBe(true);
  });
});
