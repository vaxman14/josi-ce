// Reading a folder Josi can open itself: a PC folder on the Windows server, a
// root under the mount base in compose, the Mac workspace. The cloud walk in
// connectors/storageSync.ts is the model; this is the same walk over the disk,
// through the same gates, into the same tables, with the same bookkeeping, so
// the Files page and search cannot tell which kind of folder a document came
// from.
//
// Every directory is opened through `withWorkspaceDirectory`, which pins each
// ancestor so a junction swapped in mid-walk cannot lead outside the grant,
// and every file through `openStorageFile`, which refuses links and hard-linked
// files. Nothing here follows a path it has not pinned.
import { constants } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { appendEvent, type Db } from '@josi-ce/core';
import { looksEncrypted, sha256, type Scanner, type StoragePolicy } from './gates.js';
import { ScanBlocked, ceilingsFor, ingestFile, storagePolicy, usageFor } from './ingest.js';
import { extractRichSegments, looksLikeCredentialFile, skipDocument, storeExtraction } from './extract.js';
import { extensionOf, PathEscape } from './paths.js';
import { openStorageFile } from './windowsFiles.js';
import { withWorkspaceDirectory, workspacePath } from './localWorkspace.js';
import { recordSyncFailure } from './versions.js';

export interface LocalSyncCounts { indexed: number; skipped: number; unchanged: number; removed: number; seen: number }
export interface LocalSyncResult {
  status: 'synced' | 'nothing_to_sync' | 'failed';
  counts: LocalSyncCounts;
  errorCategory?: 'unreachable' | 'permission_denied' | 'unknown';
}
export interface LocalSyncOptions {
  scanner?: Scanner;
  /** Files looked at in one run, whatever happens to them. */
  maxEntries?: number;
}

interface LocalMappingRow {
  id: string; owner_user_id: string; relative_path: string; recursive: boolean;
  indexing_enabled: boolean; status: string; container_path: string;
}
interface ExistingDoc { id: string; byte_size: string | number; modified_at: string | null; state: string }

const emptyCounts = (): LocalSyncCounts => ({ indexed: 0, skipped: 0, unchanged: 0, removed: 0, seen: 0 });

export async function syncLocalMapping(db: Db, mappingId: string, opts: LocalSyncOptions = {}): Promise<LocalSyncResult> {
  const [mapping] = await db.query<LocalMappingRow>(
    `select m.id, m.owner_user_id, m.relative_path, m.recursive, m.indexing_enabled, m.status, r.container_path
     from folder_mappings m join storage_roots r on r.id = m.root_id
     where m.id = $1 and m.provider = 'local' and r.enabled = true`,
    [mappingId],
  );
  // Gone, paused, or never consented to indexing: a mapped folder without the
  // indexing consent is opened on request, never read in bulk.
  if (!mapping || mapping.status !== 'active' || !mapping.indexing_enabled) return { status: 'nothing_to_sync', counts: emptyCounts() };
  const policy = await storagePolicy(db);
  if (policy.processing_paused) return { status: 'nothing_to_sync', counts: emptyCounts() };

  const counts = emptyCounts();
  try {
    const walk = await walkAndIngest(db, { mapping, policy, counts }, opts);
    if (walk.complete) counts.removed = await removeUnseen(db, mapping.id, walk.seenPaths);
    await db.query(
      `insert into sync_state (mapping_id, owner_user_id, last_sync_at, consecutive_failures, last_error_category)
       values ($1, $2, now(), 0, null)
       on conflict (mapping_id) do update set last_sync_at = now(), consecutive_failures = 0, last_error_category = null`,
      [mapping.id, mapping.owner_user_id],
    );
    await appendEvent(db, {
      actorUserId: mapping.owner_user_id, actor: 'system', kind: 'storage.synced',
      subjectType: 'folder_mapping', subjectId: mapping.id,
      // Counts, never a filename.
      payload: { provider: 'local', ...counts, complete: walk.complete },
    });
    return { status: 'synced', counts };
  } catch (err) {
    // The folder itself could not be opened (moved, drive gone, permission
    // withdrawn) is the one failure that is the owner's to fix; everything
    // else is a fault worth the real message in the log.
    const code = (err as NodeJS.ErrnoException)?.code;
    const category = err instanceof PathEscape || code === 'ENOENT' || code === 'EACCES' || code === 'EUNSAFE' ? 'unreachable'
      : err instanceof ScanBlocked ? 'unknown' : 'unknown';
    console.error(`[storage.sync] local mapping ${mapping.id} failed, category=${category}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    await recordSyncFailure(db, { mappingId: mapping.id, ownerUserId: mapping.owner_user_id, category });
    return { status: 'failed', counts, errorCategory: category };
  }
}

interface WalkCtx { mapping: LocalMappingRow; policy: StoragePolicy; counts: LocalSyncCounts }

async function walkAndIngest(db: Db, ctx: WalkCtx, opts: LocalSyncOptions): Promise<{ complete: boolean; seenPaths: Set<string> }> {
  const { mapping, counts } = ctx;
  const maxEntries = opts.maxEntries ?? 5000;
  const root = `${mapping.container_path}/${workspacePath(mapping.relative_path)}`;

  const existing = new Map<string, ExistingDoc>();
  for (const row of await db.query<ExistingDoc & { relative_path: string }>(
    `select id, relative_path, byte_size, modified_at, state from documents where mapping_id = $1`, [mapping.id],
  )) existing.set(row.relative_path, row);

  // Read once, threaded through the whole walk in a fixed order, so the quota
  // decisions are a function of the folder and the policy, not of the order
  // the filesystem happened to list names in.
  const usage = await usageFor(db, mapping.owner_user_id);
  const ceilings = await ceilingsFor(db, mapping.owner_user_id);

  const seenPaths = new Set<string>();
  const folders: string[] = [''];
  let entriesSeen = 0;
  let complete = true;

  while (folders.length) {
    folders.sort();
    const prefix = folders.shift()!;
    const files: Array<{ name: string; relativePath: string; size: number; modified: Date }> = [];
    const subfolders: string[] = [];

    await withWorkspaceDirectory(root, prefix, async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entriesSeen >= maxEntries) { complete = false; break; }
        entriesSeen++;
        let name: string;
        try { name = workspacePath(entry.name); } catch { continue; } // hidden, protected or odd names stay out
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { if (mapping.recursive) subfolders.push(prefix ? `${prefix}/${name}` : name); continue; }
        if (!entry.isFile()) continue;
        try {
          const handle = await openStorageFile(`${dir}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1) continue;
            files.push({ name, relativePath: prefix ? `${prefix}/${name}` : name, size: stat.size, modified: stat.mtime });
          } finally { await handle.close(); }
        } catch { /* removed meanwhile, or protected: never widen the grant */ }
      }
    });

    files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    for (const file of files) {
      seenPaths.add(file.relativePath);
      counts.seen++;
      const before = existing.get(file.relativePath);
      if (before && before.modified_at
        && new Date(before.modified_at).getTime() === file.modified.getTime()
        && Number(before.byte_size) === file.size
        && (before.state === 'indexed' || before.state === 'skipped' || before.state === 'blocked')) {
        counts.unchanged++;
        continue;
      }
      await ingestOne(db, ctx, { ...file, prefix, usage, ceilings }, opts);
    }
    folders.push(...subfolders);
    if (!complete) break;
  }
  return { complete, seenPaths };
}

async function ingestOne(
  db: Db, ctx: WalkCtx,
  file: { name: string; relativePath: string; size: number; modified: Date; prefix: string;
    usage: { files: number; bytes: number }; ceilings: { maxFiles: number | null; maxBytes: number | null } },
  opts: LocalSyncOptions,
): Promise<void> {
  const { mapping, policy, counts } = ctx;
  const root = `${mapping.container_path}/${workspacePath(mapping.relative_path)}`;
  const maxBytes = Number(policy.max_file_bytes);

  // Read at most once, under the pinned parent, shared by the scan and the
  // extraction. Reading stops at the policy ceiling plus one byte: enough to
  // know the file grew past it since it was measured.
  let bytes: Buffer | null = null;
  const readBytes = async (): Promise<Buffer> => {
    if (bytes) return bytes;
    bytes = await withWorkspaceDirectory(root, file.prefix, async (dir) => {
      const handle = await openStorageFile(`${dir}/${file.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const buffer = Buffer.alloc(Math.min(file.size, maxBytes) + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maxBytes) throw Object.assign(new Error('file grew past the ceiling'), { code: 'EFBIG' });
        return buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
    });
    return bytes;
  };

  const outcome = await ingestFile(db, {
    mappingId: mapping.id, ownerUserId: mapping.owner_user_id,
    candidate: { relativePath: file.relativePath, filename: file.name, byteSize: file.size },
    deps: { policy, scanner: opts.scanner, readFile: () => readBytes() },
    usage: file.usage, ceilings: file.ceilings,
  });
  await db.query(`update documents set modified_at = $2 where id = $1`, [outcome.documentId, file.modified.toISOString()]);
  if (outcome.kind !== 'accepted') { counts.skipped++; return; }

  const skip = async (reason: 'too_large' | 'unreadable' | 'encrypted' | 'credential_detected' | 'unsupported_type') => {
    await skipDocument(db, { documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason });
    counts.skipped++;
  };
  let content: Buffer;
  try { content = await readBytes(); }
  catch (err) { await skip((err as NodeJS.ErrnoException)?.code === 'EFBIG' ? 'too_large' : 'unreadable'); return; }

  if (looksEncrypted({ filename: file.name, relativePath: file.relativePath, byteSize: content.length, header: content.subarray(0, 4096) })) { await skip('encrypted'); return; }
  const extension = extensionOf(file.name);
  if (looksLikeCredentialFile(file.name, extension === 'txt' ? content.toString('utf8') : '')) { await skip('credential_detected'); return; }
  let segments = null;
  try { segments = await extractRichSegments({ extension, bytes: content, ocrImages: true }); } catch { segments = null; }
  if (!segments) { await skip('unsupported_type'); return; }

  await storeExtraction(db, { documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, segments });
  await db.query(`update documents set byte_size = $2, content_hash = $3 where id = $1`, [outcome.documentId, content.length, sha256(content)]);
  counts.indexed++;
}

/** What a complete walk did not see is gone from the folder, and goes here
 * too — the row, and through the cascade every byte derived from it. */
async function removeUnseen(db: Db, mappingId: string, seen: Set<string>): Promise<number> {
  const rows = await db.query<{ id: string; relative_path: string }>(`select id, relative_path from documents where mapping_id = $1`, [mappingId]);
  const gone = rows.filter((r) => !seen.has(r.relative_path)).map((r) => r.id);
  if (!gone.length) return 0;
  await db.query(`delete from documents where mapping_id = $1 and id = any($2)`, [mappingId, gone]);
  return gone.length;
}
