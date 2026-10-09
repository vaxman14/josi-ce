import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readMacSecret, readProtectedMacFile } from '../src/macosSecrets.js';
import { privateTemporaryDirectory } from '../src/privateTemporaryDirectory.js';

describe.skipIf(process.platform !== 'darwin')('macOS descriptor and extended ACL secret boundary', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'josi-secret-test-'));
    roots.push(root);
    const path = join(root, 'secret');
    writeFileSync(path, 'test-value', { mode: 0o600 });
    const read = (name = path) => readProtectedMacFile(name, process.getuid!(), process.getgid!(), root).toString();
    return { root, path, read };
  }
  it('reads a private file and a primary-service-group read grant', () => {
    const f = fixture();
    expect(f.read()).toBe('test-value');
    chmodSync(f.path, 0o640);
    expect(f.read()).toBe('test-value');
  });
  it('refuses user-owned production secrets', () => {
    const f = fixture();
    if (process.getuid!() !== 0) expect(() => readMacSecret(f.path)).toThrow();
  });
  it('refuses hardlinks, symbolic links, traversal, broad modes and oversized files', () => {
    const f = fixture();
    symlinkSync(f.path, join(f.root, 'link'));
    expect(() => f.read(join(f.root, 'link'))).toThrow();
    expect(() => f.read(join(f.root, 'x') + '/../secret')).toThrow();
    linkSync(f.path, join(f.root, 'hard'));
    expect(() => f.read()).toThrow();
    rmSync(join(f.root, 'hard'));
    for (const mode of [0o644, 0o660, 0o700]) {
      chmodSync(f.path, mode); expect(() => f.read()).toThrow();
    }
    chmodSync(f.path, 0o600);
    writeFileSync(f.path, Buffer.alloc(4097));
    expect(() => f.read()).toThrow();
  });
  it('rejects extended read ACLs even when mode is 0600', () => {
    const f = fixture();
    execFileSync('/bin/chmod', ['+a', `user:${userInfo().username} allow read`, f.path]);
    expect(() => f.read()).toThrow();
  });
  it('rejects writable or linked ancestor directories', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'nested'), { mode: 0o700 });
    writeFileSync(join(f.root, 'nested/secret'), 'test', { mode: 0o600 });
    chmodSync(join(f.root, 'nested'), 0o770);
    expect(() => f.read(join(f.root, 'nested/secret'))).toThrow();
    symlinkSync(join(f.root, 'nested'), join(f.root, 'alias'));
    expect(() => f.read(join(f.root, 'alias/secret'))).toThrow();
  });
  it('removes inherited ACLs before publishing a private temporary directory', () => {
    const f = fixture();
    execFileSync('/bin/chmod', ['+a', 'group:everyone allow read,search,file_inherit,directory_inherit', f.root]);
    const original = process.env.TMPDIR;
    try {
      process.env.TMPDIR = f.root;
      const dir = privateTemporaryDirectory('private-');
      const path = join(dir, 'secret');
      writeFileSync(path, 'protected', { mode: 0o600 });
      expect(readProtectedMacFile(path, process.getuid!(), process.getgid!(), dir).toString()).toBe('protected');
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
    }
  });
});
