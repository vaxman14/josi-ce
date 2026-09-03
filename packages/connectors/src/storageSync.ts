// Syncing one mapped cloud folder into the document index.
//
// This is the cloud half of Phase 9's ingestion, built on the spine that
// already exists: `folder_mappings` (the grant), the ingest gates (untrusted
// bytes), `document_text`/`document_segments` (what search reads), and
// `sync_state` (health and pacing). Nothing here invents a parallel pipeline —
// a cloud file goes through exactly the gates a local file would.
//
// THE RULES, in the order they cost something when wrong:
//
//   1. THE OWNER COMES FROM THE MAPPING, never from a payload. A forged job id
//      can only sync a mapping that already exists, for its own owner, through
//      its owner's own connection.
//   2. CAPABILITY IS CHECKED AT THE MOMENT OF USE. A scope revoked at the
//      provider since the folder was mapped pauses the mapping; it does not
//      get discovered halfway through a download.
//   3. A FILE GONE AT THE PROVIDER GOES FROM THE INDEX. The removal pass runs
//      only after a COMPLETE walk — a truncated listing must never be read as
//      "everything else was deleted".
//   4. FAILURE IS A STATUS, NOT A THROW. A revoked grant, an expired token, a
//      rate limit: each becomes a category on `sync_state` the owner can act
//      on, and `recordSyncFailure` pauses the mapping when retrying cannot fix
//      it (M78). A background job that throws is a failure nobody sees.
//
// Full re-list rather than provider delta feeds, deliberately, for this round:
// Google's changes API is drive-wide — watching it would mean receiving events
// about files far outside the folder that was consented to — and one listing
// path shared by both providers is one path whose removal semantics are
// testable. Listings are bounded by the per-user file ceilings that already
// exist. Graph's per-folder delta is a candidate optimisation for later.
import { appendEvent, type Db, type MasterKey } from '@josi-ce/core';
import {
  ScanBlocked, extractSegments, ingestFile, looksEncrypted, recordSyncFailure, sha256, skipDocument,
  storagePolicy, storeExtraction, type Scanner, type StoragePolicy,
} from '@josi-ce/storage';
import { STORAGE_CAPABILITY, type Provider } from './capabilities.js';
import { accessTokenFor, can, getConnection, type ConnectionRow } from './connections.js';
import { loadClient } from './oauthClients.js';
import { ConnectorError, type ErrorCategory, type FetchOptions, type OAuthClient } from './providers.js';
import { FileTooLarge, downloadEntry, listFolderPage, type RemoteEntry } from './providers/files.js';

export interface CloudSyncCounts {
  indexed: number;
  skipped: number;
  unchanged: number;
  removed: number;
  seen: number;
}

export type CloudSyncStatus =
  /** Ran to the end. Counts are the whole story. */
  | 'synced'
  /** Nothing to do: mapping gone, revoked, paused, or indexing off. */
  | 'nothing_to_sync'
  /** Failed with a category recorded on sync_state; possibly paused (M78). */
  | 'failed';

export interface CloudSyncResult {
  status: CloudSyncStatus;
  counts: CloudSyncCounts;
  /** Set when status is 'failed'. */
  errorCategory?: 'token_expired' | 'rate_limited' | 'unreachable' | 'permission_denied' | 'unknown';
}

export interface CloudSyncOptions extends FetchOptions {
  masterKey: MasterKey;
  /** Injected when ClamAV is deployed; ingest refuses to proceed without one
   * when policy requires scanning, which is the honest outage behaviour. */
  scanner?: Scanner;
  /** Bounds one run. A walk that would page forever never finishes and never
   * reports. The bound refusing the REMOVAL pass is what keeps it safe. */
  maxEntries?: number;
}

const emptyCounts = (): CloudSyncCounts => ({ indexed: 0, skipped: 0, unchanged: 0, removed: 0, seen: 0 });

interface CloudMappingRow {
  id: string;
  owner_user_id: string;
  provider: 'google_drive' | 'onedrive';
  connection_id: string;
  remote_folder_id: string;
  recursive: boolean;
  indexing_enabled: boolean;
  status: string;
}

/** folder_mappings.provider speaks in folders; connections speak in accounts. */
const CONNECTION_PROVIDER: Record<CloudMappingRow['provider'], Provider> = {
  google_drive: 'google',
  onedrive: 'microsoft',
};

/** A remote name made safe as one path segment.
 *
 * The database refuses `..` and absolute paths outright (0007's constraints),
 * so a name a provider allows that ours does not becomes a defanged lookalike
 * rather than a refusal — the file is still the owner's, still indexed, still
 * findable by the rest of its name. */
export function sanitizeRemoteName(name: string): string {
  let safe = name.replace(/[/\\\u0000]/g, '_').trim();
  while (safe.includes('..')) safe = safe.replace(/\.\./g, '._');
  return safe || '_';
}

/** What this entry is called in Josi's index. Google-native documents carry
 * the EXPORTED format's extension, so the gates and the extractor agree on
 * what the bytes will be. */
function effectiveName(entry: RemoteEntry): string {
  const safe = sanitizeRemoteName(entry.name);
  if (!entry.exportExtension) return safe;
  return safe.toLowerCase().endsWith(`.${entry.exportExtension}`)
    ? safe
    : `${safe}.${entry.exportExtension}`;
}

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
};

// ------------------------------------------------------------- scheduling

/** Cloud mappings whose turn has come. Excludes everything the run itself
 * would refuse — paused installations, paused mappings, indexing off — so the
 * worker does not enqueue jobs whose whole outcome is "nothing to do". */
export async function dueCloudMappings(db: Db, limit = 20): Promise<Array<{ id: string }>> {
  return db.query<{ id: string }>(
    `select m.id from folder_mappings m
     left join sync_state s on s.mapping_id = m.id
     where m.provider <> 'local'
       and m.status = 'active'
       and m.indexing_enabled = true
       and (s.next_sync_after is null or s.next_sync_after <= now())
       and not (select processing_paused from storage_policy where id = true)
     order by s.next_sync_after asc nulls first
     limit $1`,
    [limit],
  );
}

/** Stamped BEFORE the job runs — the same crash rule as contact sync's
 * markAttempted: a worker that dies mid-run must cost this mapping its turn,
 * not repeat the crash as fast as the queue can loop. */
export async function markSyncScheduled(db: Db, mappingId: string): Promise<void> {
  const [policy] = await db.query<{ cloud_sync_minutes: number }>(
    `select cloud_sync_minutes from storage_policy where id = true`,
  );
  const [mapping] = await db.query<{ owner_user_id: string }>(
    `select owner_user_id from folder_mappings where id = $1`, [mappingId],
  );
  if (!mapping) return;
  await db.query(
    `insert into sync_state (mapping_id, owner_user_id, next_sync_after)
     values ($1, $2, now() + make_interval(mins => $3))
     on conflict (mapping_id) do update set
       next_sync_after = now() + make_interval(mins => $3)`,
    [mappingId, mapping.owner_user_id, policy?.cloud_sync_minutes ?? 15],
  );
}

// ------------------------------------------------------------------ the run

export async function syncCloudMapping(
  db: Db,
  mappingId: string,
  opts: CloudSyncOptions,
): Promise<CloudSyncResult> {
  const [mapping] = await db.query<CloudMappingRow>(
    `select id, owner_user_id, provider, connection_id, remote_folder_id,
            recursive, indexing_enabled, status
     from folder_mappings where id = $1 and provider <> 'local'`,
    [mappingId],
  );
  // Gone, paused, revoked, or never consented to indexing: nothing to sync,
  // and honestly nothing — not an error. M49: a mapped folder without the
  // indexing consent is opened on request, never read in bulk.
  if (!mapping || mapping.status !== 'active' || !mapping.indexing_enabled) {
    return { status: 'nothing_to_sync', counts: emptyCounts() };
  }

  const policy = await storagePolicy(db);
  if (policy.processing_paused) return { status: 'nothing_to_sync', counts: emptyCounts() };

  const connection = await getConnection(db, mapping.connection_id);
  if (!connection || connection.status !== 'active') {
    await recordSyncFailure(db, {
      mappingId: mapping.id, ownerUserId: mapping.owner_user_id, category: 'token_expired',
    });
    return { status: 'failed', counts: emptyCounts(), errorCategory: 'token_expired' };
  }

  // Rule 2: the capability, at the moment of use. The admin ceiling and the
  // owner's own switch both still count — a connection whose owner turned the
  // capability off after mapping stops syncing, exactly as it should.
  const provider = CONNECTION_PROVIDER[mapping.provider];
  const allowed = await can(db, {
    ownerUserId: mapping.owner_user_id, capability: STORAGE_CAPABILITY[provider],
  });
  if (!allowed.allowed) {
    await recordSyncFailure(db, {
      mappingId: mapping.id, ownerUserId: mapping.owner_user_id, category: 'permission_denied',
    });
    return { status: 'failed', counts: emptyCounts(), errorCategory: 'permission_denied' };
  }

  const counts = emptyCounts();
  try {
    const client = await loadClient(db, opts.masterKey, provider);
    const walk = await walkAndIngest(db, { mapping, connection, client, policy, counts }, opts);

    // Rule 3: removal only after a COMPLETE walk.
    if (walk.complete) {
      counts.removed = await removeUnseen(db, mapping.id, walk.seenPaths);
    }

    await db.query(
      `insert into sync_state (mapping_id, owner_user_id, last_sync_at, consecutive_failures, last_error_category)
       values ($1, $2, now(), 0, null)
       on conflict (mapping_id) do update set
         last_sync_at = now(), consecutive_failures = 0, last_error_category = null`,
      [mapping.id, mapping.owner_user_id],
    );
    await appendEvent(db, {
      actorUserId: mapping.owner_user_id,
      actor: 'system',
      kind: 'storage.synced',
      subjectType: 'folder_mapping',
      subjectId: mapping.id,
      // Counts, never a filename.
      payload: { provider: mapping.provider, ...counts, complete: walk.complete },
    });
    return { status: 'synced', counts };
  } catch (err) {
    const category = failureCategory(err);
    await recordSyncFailure(db, {
      mappingId: mapping.id, ownerUserId: mapping.owner_user_id, category,
    });
    return { status: 'failed', counts, errorCategory: category };
  }
}

function failureCategory(
  err: unknown,
): 'token_expired' | 'rate_limited' | 'unreachable' | 'permission_denied' | 'unknown' {
  if (err instanceof ConnectorError) {
    const map: Partial<Record<ErrorCategory, 'token_expired' | 'rate_limited' | 'unreachable' | 'permission_denied'>> = {
      revoked: 'token_expired',
      expired: 'token_expired',
      insufficient_scope: 'permission_denied',
      rate_limited: 'rate_limited',
      network: 'unreachable',
    };
    return map[err.category] ?? 'unknown';
  }
  // Scanner enabled but unreachable: processing must stop visibly, not carry
  // on unscanned. 'unknown' is the honest category sync_state has for it.
  if (err instanceof ScanBlocked) return 'unknown';
  return 'unknown';
}

// -------------------------------------------------------------- the walk

interface WalkCtx {
  mapping: CloudMappingRow;
  connection: ConnectionRow;
  client: OAuthClient;
  policy: StoragePolicy;
  counts: CloudSyncCounts;
}

interface ExistingDoc {
  id: string;
  byte_size: string | number;
  modified_at: string | null;
  state: string;
}

async function walkAndIngest(
  db: Db,
  ctx: WalkCtx,
  opts: CloudSyncOptions,
): Promise<{ complete: boolean; seenPaths: Set<string> }> {
  const { mapping, counts } = ctx;
  const provider = CONNECTION_PROVIDER[mapping.provider];
  const maxEntries = opts.maxEntries ?? 5000;

  const existing = new Map<string, ExistingDoc>();
  for (const row of await db.query<ExistingDoc & { relative_path: string }>(
    `select id, relative_path, byte_size, modified_at, state from documents where mapping_id = $1`,
    [mapping.id],
  )) existing.set(row.relative_path, row);

  const seenPaths = new Set<string>();
  const folders: Array<{ id: string; prefix: string }> = [
    { id: mapping.remote_folder_id, prefix: '' },
  ];
  let entriesSeen = 0;
  let complete = true;

  while (folders.length) {
    const folder = folders.shift()!;
    let pageCursor: string | null = null;
    do {
      // A fresh token per page costs one clock check; a token that expires
      // mid-walk costs the whole run.
      const accessToken = await accessTokenFor(
        db, opts.masterKey, { connection: ctx.connection, client: ctx.client }, opts,
      );
      const page = await listFolderPage(provider, {
        accessToken, folderId: folder.id, pageCursor,
      }, opts);
      pageCursor = page.nextPageCursor;

      for (const entry of page.entries) {
        if (entriesSeen >= maxEntries) { complete = false; break; }
        entriesSeen++;

        if (entry.folder) {
          // M50: recursion is a property of the grant. A non-recursive mapping
          // does not descend, whatever appears later.
          if (mapping.recursive) folders.push({ id: entry.sourceId, prefix: `${folder.prefix}${sanitizeRemoteName(entry.name)}/` });
          continue;
        }

        const filename = effectiveName(entry);
        const relativePath = `${folder.prefix}${filename}`;
        seenPaths.add(relativePath);
        counts.seen++;

        // Unchanged since last time: neither downloaded nor re-gated. The
        // modified stamp and size both have to agree, and only a settled state
        // may stand — a 'discovered' row is a run that never finished.
        const before = existing.get(relativePath);
        if (
          before && entry.modifiedAt && before.modified_at
          && new Date(entry.modifiedAt).getTime() === new Date(before.modified_at).getTime()
          && Number(before.byte_size) === entry.byteSize
          && (before.state === 'indexed' || before.state === 'skipped' || before.state === 'blocked')
        ) {
          counts.unchanged++;
          continue;
        }

        await ingestOne(db, ctx, { entry, relativePath, filename }, opts);
      }
      if (!complete) break;
    } while (pageCursor);
    if (!complete) break;
  }

  return { complete, seenPaths };
}

/** One file through the gates, then — if the gates said yes — through
 * download, encryption check, extraction and indexing. Every ending is a
 * recorded state with a reason the owner can read. */
async function ingestOne(
  db: Db,
  ctx: WalkCtx,
  args: { entry: RemoteEntry; relativePath: string; filename: string },
  opts: CloudSyncOptions,
): Promise<void> {
  const { mapping, policy, counts } = ctx;
  const { entry, relativePath, filename } = args;
  const provider = CONNECTION_PROVIDER[mapping.provider];
  const maxBytes = Number(policy.max_file_bytes);

  // Downloaded at most once, shared between the malware scan and extraction.
  let bytes: Buffer | null = null;
  const fetchBytes = async (): Promise<Buffer> => {
    if (bytes) return bytes;
    const accessToken = await accessTokenFor(
      db, opts.masterKey, { connection: ctx.connection, client: ctx.client }, opts,
    );
    bytes = await downloadEntry(provider, { accessToken, entry, maxBytes }, opts);
    return bytes;
  };

  const outcome = await ingestFile(db, {
    mappingId: mapping.id,
    ownerUserId: mapping.owner_user_id,
    candidate: { relativePath, filename, byteSize: entry.byteSize },
    deps: { policy, scanner: opts.scanner, readFile: () => fetchBytes() },
  });
  await db.query(
    `update documents set modified_at = $2 where id = $1`,
    [outcome.documentId, entry.modifiedAt],
  );

  if (outcome.kind !== 'accepted') { counts.skipped++; return; }

  if (entry.unreadable) {
    // A Google Form has no bytes to read. Counted and said, not silently absent.
    await skipDocument(db, {
      documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'unsupported_type',
    });
    counts.skipped++;
    return;
  }

  try {
    await fetchBytes();
  } catch (err) {
    if (err instanceof FileTooLarge) {
      await skipDocument(db, {
        documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'too_large',
      });
      counts.skipped++;
      return;
    }
    if (err instanceof ConnectorError
      && (err.category === 'provider_error' || err.category === 'network')) {
      // THIS file could not be read; the run continues. Token and scope
      // problems are rethrown above this and fail the whole run instead.
      await skipDocument(db, {
        documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'unreadable',
      });
      counts.skipped++;
      return;
    }
    throw err;
  }

  const content = bytes!;
  // The metadata gates could not see the bytes; the encryption check runs now
  // that they are here. M64: skipped, never cracked, password never asked for.
  if (looksEncrypted({ filename, relativePath, byteSize: content.length, header: content.subarray(0, 4096) })) {
    await skipDocument(db, {
      documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'encrypted',
    });
    counts.skipped++;
    return;
  }

  const segments = extractSegments({
    extension: entry.exportExtension ?? extensionOf(filename),
    bytes: content,
  });
  if (!segments) {
    await skipDocument(db, {
      documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'unsupported_type',
    });
    counts.skipped++;
    return;
  }

  await storeExtraction(db, {
    documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, segments,
  });
  await db.query(
    `update documents set byte_size = $2, content_hash = $3 where id = $1`,
    [outcome.documentId, content.length, sha256(content)],
  );
  counts.indexed++;
}

/** Rule 3's second half: what a complete walk did not see is gone at the
 * provider, and goes here too — the row, and through the cascade every byte
 * derived from it. */
async function removeUnseen(db: Db, mappingId: string, seen: Set<string>): Promise<number> {
  const rows = await db.query<{ id: string; relative_path: string }>(
    `select id, relative_path from documents where mapping_id = $1`,
    [mappingId],
  );
  const goneIds = rows.filter((r) => !seen.has(r.relative_path)).map((r) => r.id);
  if (!goneIds.length) return 0;
  await db.query(`delete from documents where mapping_id = $1 and id = any($2)`, [mappingId, goneIds]);
  return goneIds.length;
}
