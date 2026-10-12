import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { probeAttachmentStorage, readAttachment, removeAttachment, writeAttachment } from '../src/chatAttachments.js';

describe.skipIf(process.platform !== 'darwin' || process.getuid?.() === 0)('Darwin attachment storage behind search-only parents', () => {
  async function fixture(run: (parent: string, leaf: string) => Promise<void>) {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'josi-search-only-')));
    const parent = join(base, 'protected-parent'), leaf = join(parent, 'attachments');
    await mkdir(parent, { mode: 0o700 });await mkdir(leaf, { mode: 0o700 });
    await chmod(parent, 0o111);
    try { await run(parent, leaf); }
    finally { await chmod(parent, 0o700);await chmod(leaf, 0o700);await rm(base, { recursive: true }); }
  }
  it('writes, reads and removes attachments without listing protected ancestors', async () => {
    await fixture(async (parent, leaf) => {
      await expect(readdir(parent)).rejects.toMatchObject({ code: 'EACCES' });
      expect(await probeAttachmentStorage(leaf)).toEqual({ ok: true });
      const id = randomUUID();await writeAttachment(id, Buffer.from('retained attachment'), leaf);
      expect((await readAttachment(id, leaf)).toString()).toBe('retained attachment');
      await removeAttachment(id, leaf);expect(await readdir(leaf)).toEqual([]);
      await expect(readdir(parent)).rejects.toMatchObject({ code: 'EACCES' });
    });
  });
  it('still refuses unreadable storage and symlink ancestors', async () => {
    await fixture(async (parent, leaf) => {
      await chmod(leaf, 0o300);
      expect(await probeAttachmentStorage(leaf)).toMatchObject({ ok: false, code: 'storage_permission' });
      await chmod(leaf, 0o700);await chmod(parent, 0o700);
      const linked = join(parent, 'linked');await symlink(leaf, linked);
      expect(await probeAttachmentStorage(linked)).toMatchObject({ ok: false, code: 'storage_unsafe' });
    });
  });
});
