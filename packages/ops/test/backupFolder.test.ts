// The backup folder a Docker install hands to Josi.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupFolderFile, listBackupFolder, publishToFolder } from '../src/backupFolder.js';

let base: string;
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'josi-folder-')); });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

describe('publishing into the folder', () => {
  it('writes a whole file, never a half one, and keeps only the newest nightly files', async () => {
    const source = join(base, 'src');
    await mkdir(source, { recursive: true });
    const target = join(base, 'out');
    for (const day of ['11', '12', '13', '14']) {
      const file = join(source, `josi-daily-2026-11-${day}-1.josi-backup`);
      await writeFile(file, `backup ${day}`);
      await publishToFolder(file, target, { sealed: true, keep: 2 });
    }
    await writeFile(join(source, 'josi-full-5.josi-backup'), 'by hand');
    await publishToFolder(join(source, 'josi-full-5.josi-backup'), target, { sealed: true, keep: 2 });
    const names = (await readdir(target)).sort();
    expect(names).toEqual(['josi-daily-2026-11-13-1.josi-backup', 'josi-daily-2026-11-14-1.josi-backup', 'josi-full-5.josi-backup']);
    if (process.platform !== 'win32') expect((await stat(join(target, names[0]))).mode & 0o777).toBe(0o664);
  });
});

describe('listing and picking', () => {
  it('lists only Josi backup files and refuses any name that is not one of them', async () => {
    const dir = join(base, 'list');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'josi-full-1.zip'), 'PK');
    await writeFile(join(dir, 'josi-full-2.josi-backup'), 'JOSIP2....');
    await writeFile(join(dir, 'other.zip'), 'x');
    await writeFile(join(dir, 'josi-empty.zip'), '');
    expect((await listBackupFolder(dir)).map((f) => f.name).sort()).toEqual(['josi-full-1.zip', 'josi-full-2.josi-backup']);
    expect((await listBackupFolder(join(base, 'nope')))).toEqual([]);
    expect(await listBackupFolder(null)).toEqual([]);
    expect(backupFolderFile(dir, 'josi-full-1.zip')).toBe(join(dir, 'josi-full-1.zip'));
    for (const bad of ['../josi-x.zip', 'other.zip', '/etc/passwd', 'josi-..zip', 'josi-a/b.zip', 5, undefined]) expect(backupFolderFile(dir, bad)).toBeNull();
    expect(backupFolderFile(null, 'josi-full-1.zip')).toBeNull();
  });
});
