// The Windows SMB controller against a folder standing in for the share.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsNasController } from '../src/http/nasWindows.js';

let base: string;
const signIns: Array<{ host: string; share: string; username?: string }> = [];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'josi-nas-'));
  await mkdir(join(base, 'share', 'josi'), { recursive: true });
  await mkdir(join(base, 'share', 'photos'), { recursive: true });
  await mkdir(join(base, 'share', '.hidden'), { recursive: true });
  await writeFile(join(base, 'share', 'readme.txt'), 'not a folder');
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

const controller = () => windowsNasController({
  stateFile: join(base, 'state', 'nas-mount.json'),
  pathFor: (host, share) => join(base, share),
  connect: async (host, share, username) => { signIns.push({ host, share, username }); if (username === 'wrong') throw new Error('The NAS refused the username or password.'); },
});

describe('a Windows server and an SMB share', () => {
  it('browses the folders at the top of the share, signing in first', async () => {
    const folders = await controller().browse({ protocol: 'smb', host: 'nas.local', share: 'share', username: 'roman', password: 'x' });
    expect(folders).toEqual(['josi', 'photos']);
    expect(signIns.at(-1)).toEqual({ host: 'nas.local', share: 'share', username: 'roman' });
  });

  it('refuses NFS, bad addresses and traversal before touching anything', async () => {
    const c = controller();
    await expect(c.browse({ protocol: 'nfs', host: 'nas.local', share: 'share' })).rejects.toThrow(/over SMB/);
    await expect(c.browse({ protocol: 'smb', host: 'nas local', share: 'share' })).rejects.toThrow(/hostname or IP/);
    await expect(c.browse({ protocol: 'smb', host: 'nas.local', share: 'a/b' })).rejects.toThrow(/without slashes/);
    expect(() => c.mountPath!({ host: 'nas.local', share: 'share', folder: '../etc' })).toThrow(/invalid/);
  });

  it('confirms a folder it can write to, keeps the receipt across a fresh controller, and lets it go', async () => {
    const c = controller();
    const status = await c.configure({ protocol: 'smb', host: 'nas.local', share: 'share', folder: 'josi', configurationRevision: 'rev-1' });
    expect(status).toEqual({ mountedPath: join(base, 'share', 'josi'), configurationRevision: 'rev-1' });
    expect(c.mountPath!({ host: 'nas.local', share: 'share', folder: 'josi' })).toBe(status.mountedPath);
    const saved = JSON.parse(await readFile(join(base, 'state', 'nas-mount.json'), 'utf8'));
    expect(saved).not.toHaveProperty('password');
    expect(await controller().status()).toEqual(status);
    await expect(c.configure({ protocol: 'smb', host: 'nas.local', share: 'share', folder: 'missing' })).rejects.toThrow(/cannot open/);
    await expect(c.configure({ protocol: 'smb', host: 'nas.local', share: 'share', folder: 'readme.txt' })).rejects.toThrow(/not a folder/);
    await expect(c.configure({ protocol: 'smb', host: 'nas.local', share: 'share', folder: 'josi', username: 'wrong' })).rejects.toThrow(/refused the username/);
    await c.remove();
    expect(await controller().status()).toBeNull();
  });
});
