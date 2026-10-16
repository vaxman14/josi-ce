import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat, rename, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeWorkspacePath, nativeWorkspaceProbe, pinNativeWorkspace } from '../src/nativeWorkspace.js';
import { withWorkspaceDirectory } from '../src/localWorkspace.js';
import { macReadFile } from '../src/macosDirectory.js';
import { testDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { createMapping } from '../src/mappings.js';
import { workspaceList } from '../src/localWorkspace.js';
import { refreshNativeWorkspace } from '../src/workspaceMount.js';
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'native-workspace-')));
  const info = await stat(folder);
  vi.stubEnv('JOSI_NATIVE_RUNTIME', '1');vi.stubEnv('JOSI_WORKSPACE_ENABLED', '1');
  vi.stubEnv('JOSI_WORKSPACE_NATIVE_PATH', folder);vi.stubEnv('JOSI_WORKSPACE_NATIVE_ID', `${info.dev}:${info.ino}`);
  return folder;
}
describe.skipIf(process.platform !== 'darwin')('native logical workspace', () => {
  it('connects an existing selected native root through the regular mapping API without a physical /workspace directory', async () => {
    const folder = await fixture();await writeFile(join(folder, 'selected-note.txt'), 'selected folder contents');
    vi.stubEnv('JOSI_WORKSPACE_MODE', 'ro');
    const db = await testDb();
    const owner = await createUser(db, { email: 'native-map@example.test', username: 'native-map', role: 'super_admin' });
    const [root] = await db.query<{id:string}>("insert into storage_roots(container_path,label,writable) values('/workspace','Selected folder',false) returning id");
    await db.query('insert into storage_capabilities(user_id,may_map_local,granted_by) values($1,true,$1)', [owner.id]);
    expect(await refreshNativeWorkspace(db, owner.id)).toMatchObject({ status: 'awaiting_mapping' });
    const mapping = await createMapping(db, { ownerUserId: owner.id, provider: 'local', rootId: root.id, recursive: true });
    const listing = await workspaceList(db, owner.id, mapping.id);
    expect(listing.entries.some(entry => entry.name === 'selected-note.txt')).toBe(true);
    expect(mapping.may_edit).toBe(false);
    await symlink('/etc', join(folder, 'outside'));
    await expect(createMapping(db, { ownerUserId: owner.id, provider: 'local', rootId: root.id, relativePath: 'outside' })).rejects.toThrow();
  });
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
