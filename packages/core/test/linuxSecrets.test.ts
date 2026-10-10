import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readProtectedLinuxFile } from '../src/linuxSecrets.js';

describe.skipIf(process.platform !== 'linux')('Linux descriptor, mode and ACL secret boundary', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'josi-linux-secret-'));
    chmodSync(root, 0o700); roots.push(root);
    const path = join(root, 'secret'); writeFileSync(path, 'test-value', { mode: 0o600 });
    const read = (name = path) => readProtectedLinuxFile(name, process.getuid!(), process.getgid!(), root).toString();
    return { root, path, read };
  }
  it('reads owner-only and exact primary-group files', () => {
    const value = fixture(); expect(value.read()).toBe('test-value');
    chmodSync(value.path, 0o640); expect(value.read()).toBe('test-value');
  });
  it('refuses links, traversal, broad modes and oversized files', () => {
    const value = fixture(); symlinkSync(value.path, join(value.root, 'link'));
    expect(() => value.read(join(value.root, 'link'))).toThrow();
    expect(() => value.read(join(value.root, 'x') + '/../secret')).toThrow();
    linkSync(value.path, join(value.root, 'hard')); expect(() => value.read()).toThrow();
    rmSync(join(value.root, 'hard'));
    for (const mode of [0o644, 0o660, 0o700]) { chmodSync(value.path, mode); expect(() => value.read()).toThrow(); }
    chmodSync(value.path, 0o600); writeFileSync(value.path, Buffer.alloc(4097)); expect(() => value.read()).toThrow();
  });
  it('refuses named ACL grants and writable ancestors', () => {
    const value = fixture(); execFileSync('setfacl', ['-m', `u:${process.getuid()}:r`, value.path]);
    expect(() => value.read()).toThrow();
    execFileSync('setfacl', ['-b', value.path]);
    mkdirSync(join(value.root, 'nested'), { mode: 0o700 });
    writeFileSync(join(value.root, 'nested/secret'), 'test', { mode: 0o600 });
    chmodSync(join(value.root, 'nested'), 0o770);
    expect(() => value.read(join(value.root, 'nested/secret'))).toThrow();
  });
});
