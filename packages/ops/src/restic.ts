import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendEvent, enqueue, type Db } from '@josi-ce/core';

export type DestinationKind = 'local' | 'nas' | 's3' | 'r2' | 'b2';
export type AgentErrorCategory = 'repository_unavailable' | 'authentication_failed'
  | 'permission_denied' | 'disk_full' | 'archive_missing' | 'timeout' | 'unknown';

export interface BackupDestination {
  id: string; name: string; kind: DestinationKind; repository: string;
  secret_ref: string; enabled: boolean;
}
export interface RetentionPolicy { keepDaily: number; keepWeekly: number; keepMonthly: number }
export interface CommandResult { code: number; stdout: string | Buffer; stderr: string }
export type CommandRunner = (command: string, args: string[], options: {
  env: NodeJS.ProcessEnv; timeoutMs: number;
}) => Promise<CommandResult>;

export class BackupAgentError extends Error {
  constructor(message: string, readonly category: AgentErrorCategory = 'unknown') { super(message); }
}

export const BACKUP_SECRET_ROOT = '/run/josi-backup-secrets';
const LOCAL_ROOTS = ['/backup-targets/', '/mnt/backups/'];

export function validateRepository(kind: DestinationKind, repository: string): string {
  const value = repository.trim();
  if (kind === 'local' || kind === 'nas') {
    const absolute = resolve(value);
    if (!LOCAL_ROOTS.some((root) => `${absolute}/`.startsWith(root))) {
      throw new BackupAgentError('local and NAS repositories must be mounted beneath /backup-targets or /mnt/backups', 'permission_denied');
    }
    return absolute;
  }
  if (kind === 'b2') {
    if (!/^b2:[A-Za-z0-9._-]+(?::[^\s]*)?$/.test(value)) throw new BackupAgentError('invalid B2 repository');
    return value;
  }
  if (!/^s3:https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._/-]+$/.test(value)) {
    throw new BackupAgentError('S3-compatible repositories must use s3:https://host/bucket/path');
  }
  return value;
}

function classify(stderr: string): AgentErrorCategory {
  const text = stderr.toLowerCase();
  if (text.includes('wrong password') || text.includes('access denied') || text.includes('invalidaccesskeyid')) return 'authentication_failed';
  if (text.includes('permission denied')) return 'permission_denied';
  if (text.includes('no space left')) return 'disk_full';
  if (text.includes('no such file') || text.includes('does not exist')) return 'archive_missing';
  if (text.includes('timeout') || text.includes('deadline exceeded')) return 'timeout';
  if (text.includes('unable to open config') || text.includes('connection refused') || text.includes('no route to host')) return 'repository_unavailable';
  return 'unknown';
}

export const spawnCommand: CommandRunner = (command, args, options) => new Promise((resolveResult, reject) => {
  const child = spawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = []; let stderr = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new BackupAgentError('Restic timed out', 'timeout')); }, options.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => { clearTimeout(timer); resolveResult({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr }); });
});

async function secretEnv(destination: BackupDestination, secretRoot = BACKUP_SECRET_ROOT): Promise<NodeJS.ProcessEnv> {
  const base = `${secretRoot}/${destination.secret_ref}`;
  const passwordFile = `${base}_restic_password`;
  // Prove the password exists now, so a typo is classified before Restic emits
  // an implementation-specific error. Never return or log its contents.
  await readFile(passwordFile);
  const env: NodeJS.ProcessEnv = { ...process.env, RESTIC_PASSWORD_FILE: passwordFile };
  const read = async (suffix: string) => (await readFile(`${base}_${suffix}`, 'utf8')).trim();
  if (destination.kind === 's3' || destination.kind === 'r2') {
    env.AWS_ACCESS_KEY_ID = await read('access_key_id');
    env.AWS_SECRET_ACCESS_KEY = await read('secret_access_key');
  } else if (destination.kind === 'b2') {
    env.B2_ACCOUNT_ID = await read('account_id');
    env.B2_ACCOUNT_KEY = await read('account_key');
  }
  return env;
}

async function runRestic(destination: BackupDestination, args: string[], runner: CommandRunner, secretRoot?: string) {
  let env: NodeJS.ProcessEnv;
  try { env = await secretEnv(destination, secretRoot); }
  catch { throw new BackupAgentError('backup destination credentials are not mounted', 'authentication_failed'); }
  const result = await runner('restic', ['-r', validateRepository(destination.kind, destination.repository), ...args], { env, timeoutMs: 60 * 60_000 });
  if (result.code !== 0) throw new BackupAgentError('Restic could not complete the operation', classify(result.stderr));
  return result;
}

async function ensureRepository(destination: BackupDestination, runner: CommandRunner, secretRoot?: string): Promise<void> {
  let env: NodeJS.ProcessEnv;
  try { env = await secretEnv(destination, secretRoot); }
  catch { throw new BackupAgentError('backup destination credentials are not mounted', 'authentication_failed'); }
  const repository = validateRepository(destination.kind, destination.repository);
  const probe = await runner('restic', ['-r', repository, 'cat', 'config'], { env, timeoutMs: 60_000 });
  if (probe.code === 0) return;
  const missing = /repository.*does not exist|is there a repository|config file does not exist/i.test(probe.stderr);
  if (!missing) throw new BackupAgentError('Restic could not open the repository', classify(probe.stderr));
  const initialized = await runner('restic', ['-r', repository, 'init'], { env, timeoutMs: 60_000 });
  if (initialized.code !== 0) throw new BackupAgentError('Restic could not initialize the repository', classify(initialized.stderr));
}

export async function runBackupAgent(db: Db, args: {
  destination: BackupDestination; backupId: string; archivePath: string; actorUserId: string;
  retention: RetentionPolicy; runner?: CommandRunner; secretRoot?: string;
}): Promise<{ runId: string; snapshotId: string | null }> {
  if (!args.destination.enabled) throw new BackupAgentError('that backup destination is disabled');
  const [run] = await db.query<{ id: string }>(
    `insert into backup_agent_runs (destination_id, backup_id, operation, state) values ($1,$2,'backup','running') returning id`,
    [args.destination.id, args.backupId],
  );
  const runner = args.runner ?? spawnCommand;
  try {
    await ensureRepository(args.destination, runner, args.secretRoot);
    const backed = await runRestic(args.destination, ['backup', '--json', '--tag', `josi-backup-${args.backupId}`, args.archivePath], runner, args.secretRoot);
    const summary = backed.stdout.toString().trim().split('\n').map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } })
      .find((item) => item.message_type === 'summary');
    const snapshotId = typeof summary?.snapshot_id === 'string' ? summary.snapshot_id : null;
    await runRestic(args.destination, ['forget', '--prune', '--keep-daily', String(args.retention.keepDaily), '--keep-weekly', String(args.retention.keepWeekly), '--keep-monthly', String(args.retention.keepMonthly)], runner, args.secretRoot);
    await runRestic(args.destination, ['check', '--read-data-subset=5%'], runner, args.secretRoot);
    await db.query(`update backup_agent_runs set state='complete', snapshot_id=$2, finished_at=now() where id=$1`, [run.id, snapshotId]);
    await appendEvent(db, { actorUserId: args.actorUserId, actor: 'super_admin', kind: 'backup.replicated', subjectType: 'backup', subjectId: args.backupId, payload: { destinationId: args.destination.id, snapshotId } });
    return { runId: run.id, snapshotId };
  } catch (error) {
    const category = error instanceof BackupAgentError ? error.category : 'unknown';
    await db.query(`update backup_agent_runs set state='failed', error_category=$2, finished_at=now() where id=$1`, [run.id, category]);
    throw error instanceof BackupAgentError ? error : new BackupAgentError('backup agent failed', category);
  }
}

export async function verifyResticSnapshot(db: Db, args: {
  destination: BackupDestination; backupId: string; archivePath: string; expectedSha256: string;
  actorUserId: string; runner?: CommandRunner; secretRoot?: string;
}): Promise<{ runId:string; verified:boolean }> {
  const [snapshot] = await db.query<{ snapshot_id:string|null }>(
    `select snapshot_id from backup_agent_runs where destination_id=$1 and backup_id=$2
       and operation='backup' and state='complete' order by started_at desc limit 1`,
    [args.destination.id, args.backupId],
  );
  if (!snapshot?.snapshot_id) throw new BackupAgentError('no completed off-host snapshot exists', 'archive_missing');
  const [run] = await db.query<{ id:string }>(
    `insert into backup_agent_runs (destination_id,backup_id,operation,state) values ($1,$2,'restore_test','running') returning id`,
    [args.destination.id, args.backupId],
  );
  try {
    const restored = await runRestic(args.destination, ['dump', snapshot.snapshot_id, args.archivePath], args.runner ?? spawnCommand, args.secretRoot);
    const bytes = Buffer.isBuffer(restored.stdout) ? restored.stdout : Buffer.from(restored.stdout);
    const actual = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    if (actual !== args.expectedSha256) throw new BackupAgentError('restored backup did not match its original checksum', 'archive_missing');
    await db.query(`update backup_agent_runs set state='complete',snapshot_id=$2,finished_at=now() where id=$1`, [run.id, snapshot.snapshot_id]);
    await appendEvent(db, { actorUserId:args.actorUserId, actor:'super_admin', kind:'backup.restore_test_passed', subjectType:'backup', subjectId:args.backupId, payload:{ destinationId:args.destination.id, snapshotId:snapshot.snapshot_id } });
    return { runId:run.id, verified:true };
  } catch (error) {
    const category = error instanceof BackupAgentError ? error.category : 'unknown';
    await db.query(`update backup_agent_runs set state='failed',error_category=$2,finished_at=now() where id=$1`, [run.id, category]);
    throw error instanceof BackupAgentError ? error : new BackupAgentError('restore test failed', category);
  }
}

export function nextRun(cadence: 'daily' | 'weekly', hourUtc: number, weekday: number | null, from = new Date()): Date {
  const next = new Date(from); next.setUTCMinutes(0, 0, 0); next.setUTCHours(hourUtc);
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  if (cadence === 'weekly') {
    const wanted = weekday ?? 0;
    next.setUTCDate(next.getUTCDate() + ((wanted - next.getUTCDay() + 7) % 7));
    if (next <= from) next.setUTCDate(next.getUTCDate() + 7);
  }
  return next;
}

export async function enqueueDueBackups(db: Db, at = new Date()): Promise<number> {
  const due = await db.query<{ id: string; destination_id: string; cadence: 'daily'|'weekly'; hour_utc: number; weekday: number|null }>(
    `select id,destination_id,cadence,hour_utc,weekday from backup_schedules where enabled and next_run_at <= $1 for update skip locked`, [at],
  );
  for (const schedule of due) {
    await enqueue(db, { kind: 'backup.run', payload: { destinationId: schedule.destination_id, scheduleId: schedule.id } });
    await db.query(`update backup_schedules set last_enqueued_at=$2,next_run_at=$3 where id=$1`, [schedule.id, at, nextRun(schedule.cadence, schedule.hour_utc, schedule.weekday, at)]);
  }
  return due.length;
}
