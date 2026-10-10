import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeWorkspacePath, nativeWorkspaceProbe, pinNativeWorkspace } from '../src/nativeWorkspace.js';
import { withWorkspaceDirectory } from '../src/localWorkspace.js';
import { macReadFile } from '../src/macosDirectory.js';
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'native-workspace-'));
  const info = await stat(folder);
  vi.stubEnv('JOSI_NATIVE_RUNTIME', '1');vi.stubEnv('JOSI_WORKSPACE_ENABLED', '1');
  vi.stubEnv('JOSI_WORKSPACE_NATIVE_PATH', folder);vi.stubEnv('JOSI_WORKSPACE_NATIVE_ID', `${info.dev}:${info.ino}`);
  return folder;
}
describe.skipIf(process.platform !== 'darwin')('native logical workspace', () => {
  it('maps only the selected logical root, pins descriptors and reads its content', async () => {
    const folder = await fixture();await writeFile(join(folder, 'note.txt'), 'chosen folder');
    expect(nativeWorkspacePath('/workspace/note.txt')).toBe(join(folder, 'note.txt'));
    expect(nativeWorkspacePath('/workspace-other')).toBe('/workspace-other');
    expect(await nativeWorkspaceProbe.available('/workspace', false)).toBe(true);
    expect(await nativeWorkspaceProbe.available('/workspace', true)).toBe(false);
    expect(await withWorkspaceDirectory('/workspace', '', p => macReadFile(p + '/note.txt', 'utf8'))).toBe('chosen folder');
  });
  it('rejects replacement, symlink children and traversal', async () => {
    const folder = await fixture();await symlink('/etc', join(folder, 'escape'));
    await expect(pinNativeWorkspace('/workspace/escape')).rejects.toThrow();
    expect(() => nativeWorkspacePath('/workspace/../etc')).toThrow();
    await rename(folder, folder + '-retained');await mkdir(folder);
    expect(await nativeWorkspaceProbe.available('/workspace', false)).toBe(false);
    await expect(pinNativeWorkspace('/workspace')).rejects.toThrow('replaced');
  });
  it('fails closed after access is declined', async () => {
    await fixture();vi.stubEnv('JOSI_WORKSPACE_ENABLED', '0');
    expect(nativeWorkspacePath('/workspace')).toBe('/workspace');
    expect(await nativeWorkspaceProbe.available('/workspace', false)).toBe(false);
  });
});
