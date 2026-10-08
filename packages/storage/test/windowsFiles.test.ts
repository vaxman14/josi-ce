import { afterEach, describe, expect, it } from 'vitest';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStorageFile, pinWindowsDirectory, publishWindowsFile } from '../src/windowsFiles.js';
import { writeAttachment, writeAttachmentFromFile, readAttachment, removeAttachment, probeAttachmentStorage } from '../src/chatAttachments.js';

describe.skipIf(process.platform !== 'win32')('native Windows pinned storage', () => {
  const owned: string[] = [];
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'josi-native-files-'));
    owned.push(root);
    const storage = join(root, 'storage');
    const outside = join(root, 'outside');
    await mkdir(storage); await mkdir(outside);
    return { root, storage, outside };
  }
  afterEach(async () => { for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true }); });

  it('reads, flushes, removes and probes real attachments', async () => {
    const { storage } = await fixture();
    const id = randomUUID();
    await writeAttachment(id, Buffer.from('café attachment'), storage);
    expect((await readAttachment(id, storage)).toString()).toBe('café attachment');
    await expect(writeAttachment(id, Buffer.from('overwrite'), storage)).rejects.toThrow();
    await removeAttachment(id, storage);
    expect(await probeAttachmentStorage(storage)).toEqual({ ok: true });
    await expect(readAttachment(id, storage)).rejects.toThrow();
  });
  it('pins every ancestor across asynchronous operations', async () => {
    const { root, storage } = await fixture();
    const pinned = pinWindowsDirectory(storage);
    try {
      await expect(rename(storage, join(root, 'swapped'))).rejects.toThrow();
      await expect(rename(root, root + '-swapped')).rejects.toThrow();
      await writeFile(join(storage, 'inside'), 'ok');
    } finally { await pinned.close(); }
    await rename(storage, join(root, 'swapped'));
  });
  it('copies a staged upload and never deletes an existing attachment on collision', async () => {
    const { root, storage } = await fixture();
    const source = join(root, 'upload');
    await writeFile(source, 'staged upload bytes');
    const id = randomUUID();
    await writeAttachmentFromFile(id, source, storage);
    expect((await readAttachment(id, storage)).toString()).toBe('staged upload bytes');
    await writeFile(source, 'must not replace original');
    await expect(writeAttachmentFromFile(id, source, storage)).rejects.toThrow();
    expect((await readAttachment(id, storage)).toString()).toBe('staged upload bytes');
  });
  it('rejects junctions at the root and in any ancestor', async () => {
    const { root, outside } = await fixture();
    const alias = join(root, 'alias');
    await mkdir(join(outside, 'child'));
    await symlink(outside, alias, 'junction');
    expect(() => pinWindowsDirectory(alias)).toThrow();
    expect(() => pinWindowsDirectory(join(alias, 'child'))).toThrow();
    await expect(writeAttachment(randomUUID(), Buffer.from('no'), alias)).rejects.toThrow();
  });
  it('rejects hardlinked and reparse leaves without changing outside bytes', async () => {
    const { storage, outside } = await fixture();
    const id = randomUUID();
    const source = join(outside, 'private');
    await writeFile(source, 'must remain unchanged');
    await link(source, join(storage, id));
    await expect(readAttachment(id, storage)).rejects.toThrow();
    expect(await readFile(source, 'utf8')).toBe('must remain unchanged');
    const junctionId = randomUUID();
    await symlink(outside, join(storage, junctionId), 'junction');
    await expect(readAttachment(junctionId, storage)).rejects.toThrow();
  });
  it('holds an existing leaf until its Node file handle closes', async () => {
    const { root, storage } = await fixture();
    const path = join(storage, 'file');
    await writeFile(path, 'pinned bytes');
    const pinned = pinWindowsDirectory(storage);
    try {
      const file = await openStorageFile(path, constants.O_RDONLY);
      try {
        await expect(rename(path, join(root, 'moved'))).rejects.toThrow();
        expect((await file.readFile()).toString()).toBe('pinned bytes');
      } finally { await file.close(); }
      await rename(path, join(root, 'moved'));
    } finally { await pinned.close(); }
  });
  it('pins and publishes paths beyond MAX_PATH without changing Windows policy', async () => {
    const { storage } = await fixture();
    const deep = join(storage, ...Array.from({ length: 7 }, (_, index) => `directory-${index}-${'a'.repeat(24)}`));
    expect(deep.length).toBeGreaterThan(260);
    await mkdir(deep, { recursive: true });
    const guard = pinWindowsDirectory(deep);
    try {
      const pending = join(deep, 'checkpoint.pending'), published = join(deep, 'checkpoint.json');
      const file = await openStorageFile(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      try { await file.writeFile('durable checkpoint'); await file.sync(); } finally { await file.close(); }
      publishWindowsFile(pending, published);
      const verified = await openStorageFile(published, constants.O_RDONLY);
      try { expect((await verified.readFile()).toString()).toBe('durable checkpoint'); } finally { await verified.close(); }
      await writeFile(pending, 'must not replace');
      expect(() => publishWindowsFile(pending, published)).toThrow();
      expect(await readFile(published, 'utf8')).toBe('durable checkpoint');
    } finally { await guard.close(); }
  });
});
