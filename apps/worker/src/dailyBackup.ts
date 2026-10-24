// The backup nobody has to remember: once a day, into the server's own
// backups folder, the last few kept, the newest copied to a folder of the
// administrator's choosing when they named one.
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { appendEvent, resolveDataPath, type Db } from '@josi-ce/core';
import { createBackup, type BackupWriter } from '@josi-ce/ops';

interface Schedule { enabled: boolean; hour: number; keep: number; copy_to: string | null; last_run_at: string | null }

/** Runs at most once a day, after the scheduled hour. Returns what it did. */
export async function runDailyBackup(db: Db, writer: BackupWriter, now = new Date()): Promise<'skipped' | 'done' | 'failed'> {
  const [schedule] = await db.query<Schedule>(`select enabled, hour, keep, copy_to, last_run_at from backup_schedule where id = true`).catch(() => []);
  if (!schedule?.enabled) return 'skipped';
  if (now.getHours() < schedule.hour) return 'skipped';
  const today = new Date(now); today.setHours(schedule.hour, 0, 0, 0);
  if (schedule.last_run_at && new Date(schedule.last_run_at) >= today) return 'skipped';
  const [running] = await db.query<{ id: string }>(`select id from backups where state = 'running' limit 1`);
  if (running) return 'skipped';
  // Claimed before the work, so a crash costs today's backup rather than
  // repeating it every tick.
  await db.query(`update backup_schedule set last_run_at = now() where id = true`);

  const stamp = now.toISOString().slice(0, 10);
  let stored: string;
  try {
    const { backup } = await createBackup(db, { kind: 'full', createdBy: null, writer, filename: `josi-daily-${stamp}-${Date.now()}.zip`, automatic: true });
    stored = backup.stored_path;
  } catch (error) {
    console.error('josi-ce worker: daily backup failed:', error instanceof Error ? error.message : error);
    return 'failed';
  }

  // Keep the newest `keep` automatic backups; a person's own backups stay.
  const old = await db.query<{ id: string; stored_path: string }>(
    `select id, stored_path from backups where automatic = true and state = 'complete' order by created_at desc offset $1`, [schedule.keep],
  );
  for (const row of old) {
    await writer.remove(row.stored_path).catch(() => undefined);
    await db.query(`delete from backups where id = $1`, [row.id]);
  }

  if (schedule.copy_to) {
    const source = writer.physicalPath ? writer.physicalPath(stored) : resolveDataPath(stored);
    const target = join(schedule.copy_to, basename(stored));
    try {
      await mkdir(schedule.copy_to, { recursive: true });
      await copyFile(source, `${target}.part`);
      await rm(target, { force: true });
      await copyFile(`${target}.part`, target);
      await rm(`${target}.part`, { force: true });
      await db.query(`update backup_schedule set last_copy_ok = true, last_copy_error = null where id = true`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const why = code === 'ENOENT' ? 'the folder is not there' : code === 'EACCES' || code === 'EPERM' ? 'Josi may not write there' : code === 'ENOSPC' ? 'the disk is full' : 'the copy failed' + (code ? ` (${code})` : '');
      await db.query(`update backup_schedule set last_copy_ok = false, last_copy_error = $1 where id = true`, [why]);
    }
  }
  await appendEvent(db, { actor: 'system', kind: 'backup.daily', payload: { pruned: old.length, copied: !!schedule.copy_to } }).catch(() => undefined);
  return 'done';
}
