import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { fileKeyStore, macKeychainForTests, openKeyStore } from '@josi-ce/tunnel/node';

const dirs: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'josi-keys-')); dirs.push(dir); return dir; };
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

describe('the file fallback', () => {
  it('writes 0600 inside a private folder, and round-trips', async () => {
    const dir = join(await temp(), 'keys'), store = fileKeyStore(dir);
    await store.set('noise-keys', '{"current":"abc"}');
    expect(await store.get('noise-keys')).toBe('{"current":"abc"}');
    expect((await stat(join(dir, 'noise-keys.key'))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await readdir(dir)).toEqual(['noise-keys.key']);
    await store.delete('noise-keys');
    expect(await store.get('noise-keys')).toBeNull();
  });

  it('refuses a key file other users can read', async () => {
    const dir = await temp(), store = fileKeyStore(dir);
    await store.set('noise-keys', 'x');
    await chmod(join(dir, 'noise-keys.key'), 0o644);
    await expect(store.get('noise-keys')).rejects.toThrow(/permissions/);
  });

  it('is what a machine with no credential store gets, and says so', async () => {
    const store = await openKeyStore({ fallbackDir: await temp(), platform: 'linux', prefer: 'os' });
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) expect(store.kind).toBe('file');
  });

  it('never leaves the value in plain sight of a config reader', async () => {
    const dir = await temp(), store = fileKeyStore(dir);
    await store.set('relay-secret', 'plain-value');
    expect(await readFile(join(dir, 'relay-secret.key'), 'utf8')).not.toContain('plain-value');
  });
});

describe.runIf(process.platform === 'darwin')('the macOS Keychain', () => {
  it('stores a value without it reaching any command line', async () => {
    const dir = await temp(), path = join(dir, 'test.keychain-db');
    execFileSync('/usr/bin/security', ['create-keychain', '-p', 'test-only-keychain', path]);
    try {
      execFileSync('/usr/bin/security', ['unlock-keychain', '-p', 'test-only-keychain', path]);
      const store = macKeychainForTests(path);
      await store.set('noise-keys', '{"current":"secret"}');
      expect(await store.get('noise-keys')).toBe('{"current":"secret"}');
      await store.delete('noise-keys');
      expect(await store.get('noise-keys')).toBeNull();
    } finally { execFileSync('/usr/bin/security', ['delete-keychain', path]); }
  });
});
