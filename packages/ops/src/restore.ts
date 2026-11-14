// Restoring from a backup file: look first, then replace, with a way back.
import type { Db } from '@josi-ce/core';
import { appendEvent } from '@josi-ce/core';
import { RestoreError, restoreBackup, type RestoreOutcome, type RestoreReader } from './backup.js';
import { compareVersions, openArchive, type ArchiveManifest } from './archive.js';

export interface ArchiveInspection {
  manifest: ArchiveManifest;
  legacy: boolean;
  encrypted: boolean;
  attachments: number;
  /** The backup carries the installation master key, so saved logins come back with it. */
  carriesMasterKey: boolean;
  /** Facts the person should read before saying "restore". */
  warnings: string[];
  /** Refusals: the restore will not run while any of these stand. */
  refusals: string[];
}

/** Opens the file and says what is inside and what restoring it would mean.
 * Nothing is changed. */
export async function inspectArchive(path: string, options: { passphrase?: string; serverVersion: string; masterKeyPresent: boolean; installationId?: string | null; encrypted: boolean }): Promise<ArchiveInspection> {
  const opened = await openArchive(path, options.passphrase);
  try {
    const { manifest } = opened;
    const warnings: string[] = [], refusals: string[] = [];
    if (!opened.legacy && compareVersions(manifest.josiVersion, options.serverVersion) > 0)
      refusals.push(`This backup was made by Josi ${manifest.josiVersion}; this server runs ${options.serverVersion}. Update the server first.`);
    if (manifest.kind === 'portable') refusals.push('This is a portable export, not a backup: it has no recovery copies and cannot restore an installation.');
    const carriesMasterKey = opened.legacy ? false : (manifest.contents.masterKey === true);
    if (!options.masterKeyPresent && !carriesMasterKey) warnings.push('The installation master key is not present on this server. Your data comes back, but saved logins, connected accounts and API keys stay sealed until the key is restored too.');
    if (manifest.installationId && options.installationId && manifest.installationId !== options.installationId)
      warnings.push('This backup comes from a different Josi installation. Restoring it replaces everything here with that installation.');
    if (!carriesMasterKey && !opened.legacy && manifest.contents.recoveryCopies && manifest.installationId && options.installationId && manifest.installationId !== options.installationId)
      warnings.push('This backup is not encrypted, so it does not carry the installation key: connected accounts and saved logins will have to be connected again on this server.');
    if (opened.legacy) warnings.push('This is an older backup with the database only; chat attachments are not in it.');
    warnings.push('Restoring replaces every person, conversation, setting and connection on this server with what is in the backup, and signs everyone out. A snapshot is taken first so it can be undone.');
    return { manifest, legacy: opened.legacy, encrypted: options.encrypted, attachments: opened.attachments.length, carriesMasterKey, warnings, refusals };
  } finally { await opened.close(); }
}

export interface RestoreFromFileArgs {
  path: string;
  passphrase?: string;
  reader: RestoreReader;
  /** Where chat attachments live; the archive's are swapped in. */
  attachmentsDir?: string | null;
  masterKeyPresent: boolean;
  serverVersion: string;
  /** The backup row this file belongs to, when it is one of the server's own. */
  backupId?: string | null;
  /** The key this server holds now, to tell whether the backup's differs. */
  currentMasterKey?: Buffer | null;
  /** Hands the backup's master key to whatever can put it in place (it needs more rights than the web service has). */
  installMasterKey?: (key: Buffer) => Promise<void>;
  /** Where previous-version copies and relay keys live; swapped in like the attachments. */
  versionsDir?: string | null;
  keysDir?: string | null;
  /** Taken before anything is replaced; its failure stops the restore. */
  snapshot?: () => Promise<void>;
  /** Hold background work while the database is swapped. */
  pause?: () => Promise<void>;
  resume?: () => Promise<void>;
  actorUserId?: string | null;
  /** The restoring person's own session, which outlives the restore so they
   * can read the outcome; everyone else's is revoked. */
  keepSessionId?: string | null;
}

/** After the database is replaced, the backups table is the backup's own
 * memory of itself: the backup being restored sits there still "running"
 * (the dump was taken mid-write), rows for files that never reached this
 * disk linger, and the snapshot taken a moment ago has no row at all. Make
 * the table say what is on disk. */
export async function reconcileBackupRows(db: Db, writer: { physicalPath?: (p: string) => string }, snapshot?: { path: string; byteSize: number; sha256: string; createdBy: string | null } | null): Promise<void> {
  const { stat } = await import('node:fs/promises');
  const rows = await db.query<{ id: string; stored_path: string; state: string }>(`select id, stored_path, state from backups`);
  for (const row of rows) {
    const physical = writer.physicalPath ? writer.physicalPath(row.stored_path) : row.stored_path;
    const info = await stat(physical).catch(() => null);
    if (!info || !info.isFile() || info.size === 0) { await db.query(`delete from backups where id = $1`, [row.id]); continue; }
    if (row.state === 'running') {
      await db.query(`update backups set state = 'complete', byte_size = $2, completed_at = coalesce(completed_at, now()), progress_percent = 100, progress_phase = 'verified', progress_step = progress_steps where id = $1`, [row.id, info.size]);
    }
  }
  if (snapshot) {
    await db.query(
      `insert into backups (kind, stored_path, includes_recovery_copies, includes_documents, master_key_confirmed, created_by, state, automatic, byte_size, sha256, completed_at, progress_percent, progress_phase, progress_step)
       values ('full', $1, true, true, false, $2, 'complete', true, $3, $4, now(), 100, 'verified', 5)`,
      [snapshot.path, snapshot.createdBy, snapshot.byteSize, snapshot.sha256],
    );
  }
}

export interface RestoreFromFileOutcome extends RestoreOutcome {
  /** True when the master key was replaced: the services must restart to use it. */
  restartNeeded: boolean;
  attachmentsRestored: number;
  manifest: ArchiveManifest;
}

/** The whole restore: inspect, snapshot, pause, replace the database, swap
 * the attachments, sign everyone out, resume. */
export async function restoreFromFile(db: Db, args: RestoreFromFileArgs): Promise<RestoreFromFileOutcome> {
  const opened = await openArchive(args.path, args.passphrase);
  try {
    if (!opened.legacy && compareVersions(opened.manifest.josiVersion, args.serverVersion) > 0)
      throw new RestoreError('this backup was made by a newer Josi than this server', 'version_too_new');
    if (opened.manifest.kind === 'portable') throw new RestoreError('a portable export cannot restore an installation', 'archive_corrupt');
    const dump = await opened.databaseDump();
    if (args.snapshot) await args.snapshot();
    if (args.pause) await args.pause();
    try {
      // The backup's own key beats whatever this server has: a new install made
      // its own key, and the backup's logins are sealed with the old one.
      const archiveKey = await opened.masterKey();
      const sameKey = !!archiveKey && !!args.currentMasterKey && archiveKey.equals(args.currentMasterKey);
      const keyInstallable = !!archiveKey && !sameKey && !!args.installMasterKey;
      const outcome = await restoreBackup(db, { backupId: args.backupId ?? null, archive: dump,
        masterKeyPresent: archiveKey ? (sameKey || keyInstallable) : args.masterKeyPresent, reader: args.reader });
      let keyNote: string | undefined;
      let restartNeeded = false;
      if (keyInstallable) {
        try { await args.installMasterKey!(archiveKey!); restartNeeded = true; }
        catch { outcome.credentialsRecovered = false; keyNote = 'The data is back, but the installation key from the backup could not be put in place, so connected accounts and saved logins stay sealed. Connect them again, or restore the key by hand.'; }
      } else if (archiveKey && !sameKey) {
        outcome.credentialsRecovered = false;
        keyNote = 'This backup carries the installation key, but this server cannot replace its own key. Connected accounts and saved logins stay sealed until the key is restored.';
      }
      for (const [prefix, dir] of [['versions', args.versionsDir], ['keys', args.keysDir]] as const) {
        if (dir && !opened.legacy && (opened.manifest.contents as Record<string, unknown>)[prefix === 'keys' ? 'relayKeys' : 'versions']) {
          await opened.restoreFolder(prefix, dir).catch(() => undefined);
        }
      }
      let attachmentsRestored = 0;
      if (args.attachmentsDir && !opened.legacy) {
        try { attachmentsRestored = await opened.restoreAttachments(args.attachmentsDir); }
        catch { attachmentsRestored = -1; }
      }
      // Every session in the restored table belongs to the backup's moment;
      // none of them is this person's, and none should stay valid.
      await db.query(`update sessions set revoked_at = now() where revoked_at is null and ($1::uuid is null or id <> $1::uuid)`, [args.keepSessionId ?? null]).catch(() => undefined);
      await appendEvent(db, {
        actorUserId: args.actorUserId ?? undefined, actor: args.actorUserId ? 'super_admin' : 'system', kind: 'backup.restored',
        payload: { backupId: args.backupId ?? null, fromFile: !args.backupId, josiVersion: opened.manifest.josiVersion, attachmentsRestored, credentialsRecovered: outcome.credentialsRecovered },
      }).catch(() => undefined);
      return { ...outcome, attachmentsRestored, manifest: opened.manifest, restartNeeded,
        warning: [archiveKey && outcome.credentialsRecovered ? undefined : outcome.warning, keyNote, attachmentsRestored < 0 ? 'The database was restored but the chat attachments could not be written back; attach files again where needed.' : undefined].filter(Boolean).join(' ') || undefined };
    } finally { if (args.resume) await args.resume().catch(() => undefined); }
  } finally { await opened.close(); }
}
