// The folder a Docker install hands to Josi for backups (JOSI_BACKUP_DIR, a
// bind mount the person chose). Nightly files are copied there, and a fresh
// install looks there first when it is asked to restore.
import { chmod, copyFile, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface FolderBackup { name: string; byteSize: number; modifiedAt: string; encrypted: boolean }

const BACKUP_NAME = /^josi-[A-Za-z0-9._-]+\.(zip|josi-backup)$/;

/** Josi's own backup files in `dir`, newest first. A folder that is not there lists nothing. */
export async function listBackupFolder(dir: string | null | undefined): Promise<FolderBackup[]> {
  if (!dir) return [];
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const found: FolderBackup[] = [];
  for (const name of names) {
    if (!BACKUP_NAME.test(name) || name.includes('..')) continue;
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info?.isFile() || info.size === 0) continue;
    const head = Buffer.alloc(6);
    const handle = await open(join(dir, name), 'r').catch(() => null);
    if (handle) { try { await handle.read(head, 0, 6, 0); } finally { await handle.close(); } }
    found.push({ name, byteSize: info.size, modifiedAt: info.mtime.toISOString(), encrypted: head.toString('latin1').startsWith('JOSIP') });
  }
  return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 60);
}

/** The path of a file the person picked from the listing, or null when the name is not one of Josi's backups. */
export function backupFolderFile(dir: string | null | undefined, name: unknown): string | null {
  if (!dir || typeof name !== 'string' || !BACKUP_NAME.test(name) || name.includes('..')) return null;
  return join(dir, name);
}

/** Copies a finished backup into the folder and keeps it tidy.
 *
 * Written as `.part` and renamed, so the folder never holds half a file. The
 * mode is group-writable for the services; a sealed file may be read by anyone
 * who can see the folder (it is encrypted), an unsealed one only by the group.
 * `keep` trims the nightly files (`josi-daily-*`) to the newest few; a person's
 * own backups are never removed. */
export async function publishToFolder(source: string, dir: string, options: { sealed: boolean; keep?: number }): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, basename(source));
  await copyFile(source, `${target}.part`);
  await chmod(`${target}.part`, options.sealed ? 0o664 : 0o660).catch(() => undefined);
  await rm(target, { force: true });
  await rename(`${target}.part`, target);
  if (options.keep) {
    const nightly = (await readdir(dir)).filter((name) => /^josi-daily-.+\.(zip|josi-backup)$/.test(name)).sort().reverse();
    for (const name of nightly.slice(options.keep)) await rm(join(dir, name), { force: true }).catch(() => undefined);
  }
}
