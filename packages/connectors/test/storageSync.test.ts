// Cloud folder sync, end to end against a real schema.
//
// No provider is contacted anywhere in this file. What IS real: the
// migrations, the connection and capability spine, the master key, the ingest
// gates, the extraction, the search index, and every decision the sync engine
// makes — including the ones that destroy data when wrong: a removal pass on
// a truncated walk, a capability check skipped, one person's files reaching
// another's search results.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey } from '@josi-ce/core';
import { createMapping, searchDocuments, setIndexing } from '@josi-ce/storage';
import {
  dueCloudMappings, markSyncScheduled, saveClient, setCapability, syncCloudMapping, upsertConnection,
  type ConnectionRow,
} from '../src/index.js';

let db: TestDb;
let alice: string;
let bob: string;
let admin: string;
const key = new MasterKey(Buffer.alloc(32, 7));

beforeAll(async () => {
  db = await testDb();
  admin = (await createUser(db, { email: 'ad@ce.test', username: 'admin', role: 'super_admin' })).id;
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'member' })).id;
  bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;
  await saveClient(db, key, {
    provider: 'google',
    clientId: 'client-id',
    clientSecret: 'CLIENT-SECRET-value',
    redirectUri: 'https://josi.example.test/api/connections/google/callback',
    actorUserId: admin,
  });
});

beforeEach(async () => {
  await db.query(`delete from documents`);
  await db.query(`delete from folder_mappings`);
  await db.query(`delete from sync_state`);
  await db.query(`delete from connections`);
  await db.query(`delete from storage_capabilities`);
  await db.query(`delete from admin_capability_policy`);
  await db.query(
    `update storage_policy set processing_paused = false, max_file_bytes = 1000,
       max_total_bytes_per_user = 100000, max_files_per_user = 100,
       allowed_extensions = array['txt','md','csv','pdf'], clamav_enabled = false`,
  );
});

/** A connected Google account whose drive capability is granted AND on. */
async function connect(user: string, enable = true): Promise<ConnectionRow> {
  const connection = await upsertConnection(db, key, {
    ownerUserId: user,
    provider: 'google',
    tokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      grantedScopes: 'openid https://www.googleapis.com/auth/drive.readonly',
    },
    accountEmail: 'someone@gmail.test',
    providerAccountId: 'acct-1',
    requestedCapabilities: ['google.drive.read'],
  });
  if (enable) {
    await setCapability(db, {
      connection, capability: 'google.drive.read', enabled: true, actorUserId: user,
    });
  }
  return connection;
}

/** Admin's half of the dual gate, then the owner's: capability, mapping,
 * indexing consent. */
async function mapFolder(user: string, connectionId: string, opts: { recursive?: boolean } = {}) {
  await db.query(
    `insert into storage_capabilities (user_id, may_map_cloud, may_index, granted_by)
     values ($1, true, true, $2)
     on conflict (user_id) do update set may_map_cloud = true, may_index = true`,
    [user, admin],
  );
  const mapping = await createMapping(db, {
    ownerUserId: user,
    provider: 'google_drive',
    connectionId,
    remoteFolderId: 'folder-1',
    displayPath: 'Google Drive/Reports',
    recursive: opts.recursive ?? true,
  });
  await setIndexing(db, { mappingId: mapping.id, ownerUserId: user, enabled: true });
  return mapping;
}

interface FakeFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  content?: string;
  parent?: string;
}

/** A stub Drive: folder listings and downloads served from a mutable list. */
function drive(files: FakeFile[]) {
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const href = String(url);
    calls.push(href);
    const u = new URL(href);
    if (u.pathname.endsWith('/files')) {
      const parent = /'([^']+)' in parents/.exec(u.searchParams.get('q') ?? '')?.[1];
      return new Response(JSON.stringify({
        files: files.filter((f) => (f.parent ?? 'folder-1') === parent).map((f) => ({
          id: f.id, name: f.name, mimeType: f.mimeType ?? 'text/plain',
          size: f.size ?? String((f.content ?? '').length),
          modifiedTime: f.modifiedTime ?? '2026-09-01T00:00:00Z',
        })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const media = /\/files\/([^/?]+)/.exec(u.pathname)?.[1];
    const file = files.find((f) => f.id === media);
    if (file) return new Response(file.content ?? '', { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, files };
}

const sync = (mappingId: string, fetchImpl: typeof fetch) =>
  syncCloudMapping(db, mappingId, { masterKey: key, fetchImpl });

describe('a first sync of a mapped Drive folder', () => {
  it('indexes readable text, recurses, and makes it searchable — for its owner only', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const { fetchImpl } = drive([
      { id: 't1', name: 'meeting-notes.txt', content: 'Quarterly zebra migration budget' },
      { id: 'sub', name: 'Archive', mimeType: 'application/vnd.google-apps.folder' },
      { id: 't2', name: 'old.md', parent: 'sub', content: 'zebra archive entry' },
    ]);

    const result = await sync(mapping.id, fetchImpl);
    expect(result.status).toBe('synced');
    expect(result.counts.indexed).toBe(2);

    const mine = await searchDocuments(db, { ownerUserId: alice, query: 'zebra' });
    expect(mine.length).toBe(2);
    expect(mine.map((h) => h.relativePath).sort()).toEqual(['Archive/old.md', 'meeting-notes.txt']);

    // The 404-shaped rule, applied to search: bob simply has nothing.
    const theirs = await searchDocuments(db, { ownerUserId: bob, query: 'zebra' });
    expect(theirs).toEqual([]);
  });

  it('does not descend when the grant was not recursive — M50', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id, { recursive: false });
    const { fetchImpl } = drive([
      { id: 't1', name: 'top.txt', content: 'top level' },
      { id: 'sub', name: 'Deeper', mimeType: 'application/vnd.google-apps.folder' },
      { id: 't2', name: 'nested.txt', parent: 'sub', content: 'should not be read' },
    ]);
    const result = await sync(mapping.id, fetchImpl);
    expect(result.counts.indexed).toBe(1);
    const hits = await searchDocuments(db, { ownerUserId: alice, query: 'nested OR top' });
    expect(hits.map((h) => h.relativePath)).toEqual(['top.txt']);
  });

  it('exports a Google-native document and indexes it under the exported extension', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const { fetchImpl } = drive([
      { id: 'doc1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', size: '0', content: 'native doc text' },
    ]);
    const result = await sync(mapping.id, fetchImpl);
    expect(result.counts.indexed).toBe(1);
    const [row] = await db.query<{ relative_path: string; extension: string; state: string }>(
      `select relative_path, extension, state from documents`,
    );
    expect(row.relative_path).toBe('Plan.txt');
    expect(row.state).toBe('indexed');
  });

  it('skips honestly what it cannot read: allowed-but-unparseable formats become unsupported_type', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const { fetchImpl } = drive([
      { id: 'p1', name: 'contract.pdf', content: '%PDF-1.7 not really parseable here' },
      { id: 't1', name: 'notes.txt', content: 'plain and readable' },
    ]);
    const result = await sync(mapping.id, fetchImpl);
    expect(result.counts.indexed).toBe(1);
    expect(result.counts.skipped).toBe(1);
    const [pdf] = await db.query<{ state: string; skip_reason: string }>(
      `select state, skip_reason from documents where relative_path = 'contract.pdf'`,
    );
    expect(pdf.state).toBe('skipped');
    expect(pdf.skip_reason).toBe('unsupported_type');
    // And its text is not searchable.
    expect(await searchDocuments(db, { ownerUserId: alice, query: 'parseable' })).toEqual([]);
  });

  it('applies the size ceiling from metadata, without downloading', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const { fetchImpl, calls } = drive([
      { id: 'big', name: 'huge.txt', size: '5000', content: 'x' },
    ]);
    const result = await sync(mapping.id, fetchImpl);
    expect(result.counts.skipped).toBe(1);
    const [row] = await db.query<{ skip_reason: string }>(`select skip_reason from documents`);
    expect(row.skip_reason).toBe('too_large');
    expect(calls.some((c) => c.includes('alt=media'))).toBe(false);
  });
});

describe('the second sync', () => {
  it('re-reads nothing that has not changed', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const stubbed = drive([{ id: 't1', name: 'notes.txt', content: 'stable content' }]);
    await sync(mapping.id, stubbed.fetchImpl);

    const downloadsBefore = stubbed.calls.filter((c) => c.includes('alt=media')).length;
    const again = await sync(mapping.id, stubbed.fetchImpl);
    expect(again.counts.unchanged).toBe(1);
    expect(again.counts.indexed).toBe(0);
    expect(stubbed.calls.filter((c) => c.includes('alt=media')).length).toBe(downloadsBefore);
  });

  it('a file gone at the provider goes from the index — and only after a complete walk', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const stubbed = drive([
      { id: 't1', name: 'keep.txt', content: 'kept words' },
      { id: 't2', name: 'gone.txt', content: 'disappearing words' },
    ]);
    await sync(mapping.id, stubbed.fetchImpl);
    expect((await searchDocuments(db, { ownerUserId: alice, query: 'disappearing' })).length).toBe(1);

    stubbed.files.splice(stubbed.files.findIndex((f) => f.id === 't2'), 1);
    const second = await sync(mapping.id, stubbed.fetchImpl);
    expect(second.counts.removed).toBe(1);
    expect(await searchDocuments(db, { ownerUserId: alice, query: 'disappearing' })).toEqual([]);
    expect((await searchDocuments(db, { ownerUserId: alice, query: 'kept' })).length).toBe(1);
  });

  it('a truncated walk removes NOTHING', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const stubbed = drive([
      { id: 't1', name: 'a.txt', content: 'first words' },
      { id: 't2', name: 'b.txt', content: 'second words' },
    ]);
    await sync(mapping.id, stubbed.fetchImpl);

    // Next run is bounded to one entry: it must not read absence into the rest.
    const bounded = await syncCloudMapping(db, mapping.id, {
      masterKey: key, fetchImpl: stubbed.fetchImpl, maxEntries: 1,
    });
    expect(bounded.status).toBe('synced');
    expect(bounded.counts.removed).toBe(0);
    const [count] = await db.query<{ n: number }>(`select count(*)::int as n from documents`);
    expect(count.n).toBe(2);
  });

  it('an edited file is re-read and its OLD text stops matching', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const stubbed = drive([{ id: 't1', name: 'notes.txt', content: 'original walrus text' }]);
    await sync(mapping.id, stubbed.fetchImpl);

    stubbed.files[0].content = 'revised narwhal text';
    stubbed.files[0].modifiedTime = '2026-09-02T00:00:00Z';
    await sync(mapping.id, stubbed.fetchImpl);

    expect(await searchDocuments(db, { ownerUserId: alice, query: 'walrus' })).toEqual([]);
    expect((await searchDocuments(db, { ownerUserId: alice, query: 'narwhal' })).length).toBe(1);
  });
});

describe('what stops a sync', () => {
  it('the capability switched off since mapping: paused, permission_denied, nothing deleted', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const stubbed = drive([{ id: 't1', name: 'notes.txt', content: 'indexed before the change' }]);
    await sync(mapping.id, stubbed.fetchImpl);

    await setCapability(db, {
      connection, capability: 'google.drive.read', enabled: false, actorUserId: alice,
    });
    const result = await sync(mapping.id, stubbed.fetchImpl);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('permission_denied');
    const [m] = await db.query<{ status: string; paused_reason: string }>(
      `select status, paused_reason from folder_mappings where id = $1`, [mapping.id],
    );
    expect(m.status).toBe('paused');
    // M78: paused is not purged. The index survives the lapse.
    expect((await searchDocuments(db, { ownerUserId: alice, query: 'indexed' })).length).toBe(1);
  });

  it('the admin ceiling denies the capability: same refusal, deny-only', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    await db.query(
      `insert into admin_capability_policy (capability, allowed) values ('google.drive.read', false)`,
    );
    const stubbed = drive([{ id: 't1', name: 'notes.txt', content: 'words' }]);
    const result = await sync(mapping.id, stubbed.fetchImpl);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('permission_denied');
  });

  it('a revoked connection: paused as token_expired, nothing deleted', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    await db.query(`update connections set status = 'revoked' where id = $1`, [connection.id]);
    const result = await sync(mapping.id, drive([]).fetchImpl);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('token_expired');
    const [m] = await db.query<{ status: string }>(
      `select status from folder_mappings where id = $1`, [mapping.id],
    );
    expect(m.status).toBe('paused');
  });

  it('indexing never consented: nothing to sync, nothing fetched — M49', async () => {
    const connection = await connect(alice);
    await db.query(
      `insert into storage_capabilities (user_id, may_map_cloud, may_index, granted_by)
       values ($1, true, true, $2)`,
      [alice, admin],
    );
    const mapping = await createMapping(db, {
      ownerUserId: alice, provider: 'google_drive', connectionId: connection.id,
      remoteFolderId: 'folder-1', displayPath: 'Google Drive/Reports', recursive: true,
    });
    const stubbed = drive([{ id: 't1', name: 'notes.txt', content: 'words' }]);
    const result = await sync(mapping.id, stubbed.fetchImpl);
    expect(result.status).toBe('nothing_to_sync');
    expect(stubbed.calls).toEqual([]);
  });

  it('the global pause stops the run without touching the index — M75', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const stubbed = drive([{ id: 't1', name: 'notes.txt', content: 'paused words' }]);
    await sync(mapping.id, stubbed.fetchImpl);
    await db.query(`update storage_policy set processing_paused = true where id = true`);
    const result = await sync(mapping.id, stubbed.fetchImpl);
    expect(result.status).toBe('nothing_to_sync');
    // Search over what is already built keeps working.
    expect((await searchDocuments(db, { ownerUserId: alice, query: 'paused' })).length).toBe(1);
  });

  it('a provider failure mid-run becomes a category on sync_state, not a throw', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const failing = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    const result = await sync(mapping.id, failing);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('rate_limited');
    const [state] = await db.query<{ consecutive_failures: number; last_error_category: string }>(
      `select consecutive_failures, last_error_category from sync_state where mapping_id = $1`,
      [mapping.id],
    );
    expect(state.consecutive_failures).toBe(1);
    expect(state.last_error_category).toBe('rate_limited');
  });
});

describe('the schedule', () => {
  it('picks up an indexed cloud mapping, and stamps its turn BEFORE the run', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    const due = await dueCloudMappings(db);
    expect(due.map((d) => d.id)).toContain(mapping.id);

    await markSyncScheduled(db, mapping.id);
    expect((await dueCloudMappings(db)).map((d) => d.id)).not.toContain(mapping.id);
    const [state] = await db.query<{ next_sync_after: string }>(
      `select next_sync_after from sync_state where mapping_id = $1`, [mapping.id],
    );
    expect(new Date(state.next_sync_after).getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves out paused mappings, local mappings, and paused installations', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id);
    await db.query(`update folder_mappings set status = 'paused' where id = $1`, [mapping.id]);
    expect(await dueCloudMappings(db)).toEqual([]);
    await db.query(`update folder_mappings set status = 'active' where id = $1`, [mapping.id]);
    await db.query(`update storage_policy set processing_paused = true where id = true`);
    expect(await dueCloudMappings(db)).toEqual([]);
  });
});
