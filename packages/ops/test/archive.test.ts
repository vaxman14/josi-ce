// The one-file backup: zip in and out, the passphrase envelope, and what a
// restore refuses before touching anything.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ZipReader, crc32, writeZip } from '../src/zip.js';
import { buildArchive, compareVersions, isSealed, openArchive, openWithPassphrase, sealWithPassphrase } from '../src/archive.js';
import { inspectArchive, restoreFromFile } from '../src/restore.js';
import { testDb, type TestDb } from '../../core/test/helpers.js';

let base: string;
let db: TestDb;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'josi-archive-'));
  await mkdir(join(base, 'attachments', 'thread-a'), { recursive: true });
  await writeFile(join(base, 'attachments', 'thread-a', 'photo.jpg'), Buffer.from('not really a photo'));
  await writeFile(join(base, 'attachments', 'note.txt'), 'a note');
  db = await testDb();
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

describe('the zip writer and reader', () => {
  it('round-trips stored entries with checksums', async () => {
    const path = join(base, 'plain.zip');
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    await writeZip(path, [{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/b.bin', data: big }, { name: 'dir/photo.jpg', path: join(base, 'attachments', 'thread-a', 'photo.jpg') }]);
    const zip = await ZipReader.open(path);
    try {
      expect(zip.entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.bin', 'dir/photo.jpg']);
      expect((await zip.read(zip.find('a.txt')!)).toString()).toBe('hello');
      expect((await zip.read(zip.find('dir/b.bin')!)).equals(big)).toBe(true);
      expect((await zip.read(zip.find('dir/photo.jpg')!)).toString()).toBe('not really a photo');
    } finally { await zip.close(); }
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('the passphrase envelope', () => {
  it('opens only with the passphrase it was sealed with', () => {
    const sealed = sealWithPassphrase(Buffer.from('secret zip bytes'), 'correct horse');
    expect(isSealed(sealed)).toBe(true);
    expect(openWithPassphrase(sealed, 'correct horse').toString()).toBe('secret zip bytes');
    expect(() => openWithPassphrase(sealed, 'wrong')).toThrow(/passphrase does not open/);
    expect(() => openWithPassphrase(sealed, undefined)).toThrow(/encrypted/);
    expect(openWithPassphrase(Buffer.from('plain'), undefined).toString()).toBe('plain');
  });
});

describe('a Josi backup archive', () => {
  const dump = gzipSync(Buffer.from('select 1;'));

  it('holds the manifest, the dump and every attachment, sealed when asked', async () => {
    const destination = join(base, 'full.josi-backup');
    const written = await buildArchive({ destination, kind: 'full', databaseDump: dump, attachmentsDir: join(base, 'attachments'), josiVersion: '0.7.0', installationId: 'inst-1', passphrase: 'open sesame' });
    expect(written.attachments).toBe(2);
    expect(written.encrypted).toBe(true);
    expect(isSealed(await readFile(destination))).toBe(true);
    await expect(openArchive(destination, 'nope')).rejects.toThrow(/passphrase/);
    const opened = await openArchive(destination, 'open sesame');
    try {
      expect(opened.manifest.josiVersion).toBe('0.7.0');
      expect(opened.manifest.contents.attachments).toBe(2);
      expect((await opened.databaseDump()).equals(dump)).toBe(true);
      expect(opened.attachments.map((a) => a.name).sort()).toEqual(['note.txt', 'thread-a/photo.jpg']);
      const target = join(base, 'restored');
      expect(await opened.restoreAttachments(target)).toBe(2);
      expect((await readFile(join(target, 'thread-a', 'photo.jpg'))).toString()).toBe('not really a photo');
    } finally { await opened.close(); }
  });

  it('still opens an older gzip-only backup, and refuses what is not a backup', async () => {
    const legacy = join(base, 'legacy.zip');
    await writeFile(legacy, dump);
    const opened = await openArchive(legacy);
    expect(opened.legacy).toBe(true);
    expect((await opened.databaseDump()).equals(dump)).toBe(true);
    await opened.close();
    await writeFile(join(base, 'junk.zip'), 'this is not a zip');
    const junk = await openArchive(join(base, 'junk.zip'));
    expect(junk.legacy).toBe(true); await junk.close();
    await writeZip(join(base, 'other.zip'), [{ name: 'readme.txt', data: Buffer.from('x') }]);
    await expect(openArchive(join(base, 'other.zip'))).rejects.toThrow(/no manifest/);
  });

  it('compares versions the way the refusal needs', () => {
    expect(compareVersions('0.7.0-dev', '0.7.0')).toBe(0);
    expect(compareVersions('0.8.0', '0.7.9')).toBe(1);
    expect(compareVersions('0.1.78-native.11', '0.7.0')).toBe(-1);
  });

  it('inspects before restoring: refuses a newer backup, warns about the key, then restores in order', async () => {
    const destination = join(base, 'newer.zip');
    await buildArchive({ destination, kind: 'full', databaseDump: dump, attachmentsDir: join(base, 'attachments'), josiVersion: '9.0.0' });
    const inspection = await inspectArchive(destination, { serverVersion: '0.7.0', masterKeyPresent: false, installationId: 'here', encrypted: false });
    expect(inspection.refusals[0]).toMatch(/made by Josi 9.0.0/);
    expect(inspection.warnings.join(' ')).toMatch(/master key is not present/);
    const steps: string[] = [];
    await expect(restoreFromFile(db, { path: destination, reader: { async apply() { steps.push('apply'); return { rowsRestored: 1 }; } },
      masterKeyPresent: true, serverVersion: '0.7.0' })).rejects.toThrow(/newer Josi/);
    expect(steps).toEqual([]);

    const current = join(base, 'current.zip');
    await buildArchive({ destination: current, kind: 'full', databaseDump: dump, attachmentsDir: join(base, 'attachments'), josiVersion: '0.7.0' });
    const target = join(base, 'live-attachments');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'stale.txt'), 'gone after restore');
    const out = await restoreFromFile(db, {
      path: current, reader: { async apply({ archive }) { steps.push('apply:' + archive.length); return { rowsRestored: 3 }; } },
      attachmentsDir: target, masterKeyPresent: true, serverVersion: '0.7.0',
      snapshot: async () => { steps.push('snapshot'); }, pause: async () => { steps.push('pause'); }, resume: async () => { steps.push('resume'); },
    });
    expect(steps).toEqual(['snapshot', 'pause', `apply:${dump.length}`, 'resume']);
    expect(out.ok).toBe(true);
    expect(out.attachmentsRestored).toBe(2);
    await expect(readFile(join(target, 'stale.txt'))).rejects.toThrow();
    expect((await readFile(join(target, 'note.txt'))).toString()).toBe('a note');
  });
});
