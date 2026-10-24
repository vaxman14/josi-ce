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
    if (!options.masterKeyPresent) warnings.push('The installation master key is not present on this server. Your data comes back, but saved logins, connected accounts and API keys stay sealed until the key is restored too.');
    if (manifest.installationId && options.installationId && manifest.installationId !== options.installationId)
      warnings.push('This backup comes from a different Josi installation. Restoring it replaces everything here with that installation.');
    if (opened.legacy) warnings.push('This is an older backup with the database only; chat attachments are not in it.');
    warnings.push('Restoring replaces every person, conversation, setting and connection on this server with what is in the backup, and signs everyone out. A snapshot is taken first so it can be undone.');
    return { manifest, legacy: opened.legacy, encrypted: options.encrypted, attachments: opened.attachments.length, warnings, refusals };
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

export interface RestoreFromFileOutcome extends RestoreOutcome {
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
      const outcome = await restoreBackup(db, { backupId: args.backupId ?? null, archive: dump, masterKeyPresent: args.masterKeyPresent, reader: args.reader });
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
      return { ...outcome, attachmentsRestored, manifest: opened.manifest,
        warning: [outcome.warning, attachmentsRestored < 0 ? 'The database was restored but the chat attachments could not be written back; attach files again where needed.' : undefined].filter(Boolean).join(' ') || undefined };
    } finally { if (args.resume) await args.resume().catch(() => undefined); }
  } finally { await opened.close(); }
}
