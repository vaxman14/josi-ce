import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { privateTemporaryDirectory } from '../src/privateTemporaryDirectory.js';
import { readWindowsSecret } from '../src/windowsSecrets.js';
import { loadMasterKey } from '../src/masterKey.js';
import { connectionStringFromEnv } from '../src/connect.js';

const directories: string[] = [];
function fixture(bytes: string | Buffer = 'a'.repeat(64)) {
  const root = privateTemporaryDirectory('josi-secret-test-');
  directories.push(root);
  const path = join(root, 'private.txt');
  writeFileSync(path, bytes, { flag: 'wx' });
  return { root, path };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('actual Windows secret permissions', () => {
  it('reads a private file after checking its handle, owner and DACL', () => {
    const { path } = fixture();
    expect(readWindowsSecret(path).toString()).toBe('a'.repeat(64));
    vi.stubEnv('JOSI_NATIVE_RUNTIME', '1');
    expect(loadMasterKey({ path }).reveal()).toHaveLength(32);
    expect(new URL(connectionStringFromEnv({ DATABASE_URL: 'postgresql://josi@127.0.0.1/josi',
      JOSI_NATIVE_RUNTIME: '1', PGPASSWORD_FILE: path })).password).toBe('a'.repeat(64));
  });
  it('rejects real broad read or write ACLs, and never includes contents in an error', () => {
    for (const right of ['Read', 'Write']) {
      const { path } = fixture();
      const result = spawnSync(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command',
          "$p=$env:JOSI_ACL_TEST_FILE; $a=[IO.File]::GetAccessControl($p); $s=[Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $r=[Security.AccessControl.FileSystemAccessRule]::new($s,$env:JOSI_ACL_TEST_RIGHT,'Allow'); $a.AddAccessRule($r); [IO.File]::SetAccessControl($p,$a)"],
        { env: { ...process.env, JOSI_ACL_TEST_FILE: path, JOSI_ACL_TEST_RIGHT: right }, windowsHide: true, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(() => readWindowsSecret(path)).toThrow('not private');
      vi.stubEnv('JOSI_NATIVE_RUNTIME', '1');
      expect(() => loadMasterKey({ path })).toThrow('Use Repair');
      try { readWindowsSecret(path); } catch (error) {
        expect(String(error)).not.toContain('a'.repeat(64));
        expect(String(error)).not.toContain(path);
      }
    }
  });
  it('rejects hard links and a reparse-point leaf', () => {
    const { root, path } = fixture();
    const link = join(root, 'extra.txt');
    linkSync(path, link);
    expect(() => readWindowsSecret(path)).toThrow('not private');
    rmSync(link);
    const junction = join(root, 'redirect');
    symlinkSync(root, junction, 'junction');
    expect(() => readWindowsSecret(junction)).toThrow('not private');
  });
  it('rejects empty, excessive, missing and non-file inputs', () => {
    for (const data of ['', Buffer.alloc(4097, 97)]) {
      expect(() => readWindowsSecret(fixture(data).path)).toThrow('not private');
    }
    const { root } = fixture();
    expect(() => readWindowsSecret(root)).toThrow('not private');
    expect(() => readWindowsSecret(join(root, 'missing'))).toThrow('not private');
  });
  it('refuses device, UNC, alternate-stream and ambiguous paths', () => {
    for (const path of ['relative', '\\\\server\\share\\key', '\\\\?\\C:\\key', 'C:\\NUL',
      'C:\\key:stream', 'C:\\dir\\..\\key', 'C:\\key.', 'C:/key']) {
      expect(() => readWindowsSecret(path)).toThrow('not private');
    }
  });
});
