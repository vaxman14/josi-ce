// Reading a folder on disk: what gets indexed, what policy skips, what a later
// walk drops once the file is gone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createMapping, registerPcFolder, registerRoot, setIndexing } from '../src/mappings.js';
import { syncLocalMapping } from '../src/localSync.js';

let db: TestDb;
let dir: string;
let alice: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'josi-local-'));
  await writeFile(join(dir, 'notes.txt'), 'The tile supplier meeting is on Friday at ten.');
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'shopping.md'), '# Shopping\n- grout, white\n- silicone');
  await writeFile(join(dir, 'setup.exe'), 'MZ not really a program');
  db = await testDb();
  const [admin] = await db.query<{ id: string }>(`insert into users (email, username, role) values ('a@example.test', 'admin', 'super_admin') returning id`);
  const [a] = await db.query<{ id: string }>(`insert into users (email, username, role) values ('alice@example.test', 'alice', 'member') returning id`);
  alice = a.id;
  await db.query(`insert into storage_capabilities (user_id, may_map_local, may_map_cloud, may_index, granted_by) values ($1, true, false, true, $2)`, [alice, admin.id]);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('reading a PC folder on disk', () => {
  it('indexes the readable files, skips what policy excludes, and drops what disappeared', async () => {
    const root = process.platform === 'win32'
      ? await registerPcFolder(db, { path: dir, dataDir: join(dir, 'nowhere') })
      : await registerRoot(db, { containerPath: dir, label: 'Test', base: dirname(dir) });
    const mapping = await createMapping(db, { ownerUserId: alice, provider: 'local', rootId: root.id, relativePath: '', recursive: true });
    await setIndexing(db, { mappingId: mapping.id, ownerUserId: alice, enabled: true });

    const first = await syncLocalMapping(db, mapping.id);
    expect(first.status).toBe('synced');
    expect(first.counts).toMatchObject({ seen: 3, indexed: 2, skipped: 1, removed: 0 });
    const rows = await db.query<{ relative_path: string; state: string; skip_reason: string | null }>(
      `select relative_path, state, skip_reason from documents where mapping_id = $1 order by relative_path`, [mapping.id]);
    expect(rows).toEqual([
      { relative_path: 'notes.txt', state: 'indexed', skip_reason: null },
      { relative_path: 'setup.exe', state: 'skipped', skip_reason: 'extension_not_allowed' },
      { relative_path: 'sub/shopping.md', state: 'indexed', skip_reason: null },
    ]);

    // Nothing changed: nothing is re-read.
    const second = await syncLocalMapping(db, mapping.id);
    expect(second.counts).toMatchObject({ seen: 3, unchanged: 3, indexed: 0 });

    await rm(join(dir, 'notes.txt'));
    const third = await syncLocalMapping(db, mapping.id);
    expect(third.counts).toMatchObject({ seen: 2, removed: 1 });
    const [left] = await db.query<{ n: number }>(`select count(*)::int as n from documents where mapping_id = $1`, [mapping.id]);
    expect(left.n).toBe(2);
  });

  it('does nothing for a folder whose owner never consented to indexing', async () => {
    const root = process.platform === 'win32'
      ? await registerPcFolder(db, { path: join(dir, 'sub'), dataDir: join(dir, 'nowhere') })
      : await registerRoot(db, { containerPath: join(dir, 'sub'), label: 'Sub', base: dirname(dir) });
    const mapping = await createMapping(db, { ownerUserId: alice, provider: 'local', rootId: root.id, relativePath: '', recursive: false });
    expect((await syncLocalMapping(db, mapping.id)).status).toBe('nothing_to_sync');
  });
});
