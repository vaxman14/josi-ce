import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import postgres from 'postgres';
import { pgBackupWriter, pgRestoreReader, FULL_CONTENTS, createNativeSnapshot, restoreNativeSnapshot } from '../../packages/ops/dist/index.js';
import { pinWindowsDirectory } from '../../packages/storage/dist/index.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const bin = process.env.JOSI_TEST_PG_BIN;
const root = process.env.JOSI_TEST_PG_ROOT;
const url = new URL(process.env.DATABASE_URL);
url.password = readFileSync(process.env.PGPASSWORD_FILE, 'utf8').trim();
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
function run(exe, args) {
  const result = spawnSync(join(bin, `${exe}.exe`), args, { windowsHide: true, encoding: 'utf8' });
  // Do not expose stderr: database messages may contain connection credentials.
  assert.equal(result.status, 0, `${exe} did not complete`);
}
try {
  const [{ count }] = await sql`select count(*)::integer as count from _migrations`;
  assert.equal(count, readdirSync(join(repo, 'packages/db/migrations')).filter(p => p.endsWith('.sql')).length);
  const [{ setting: listeners }] = await sql`select current_setting('listen_addresses') as setting`;
  assert.equal(listeners, '127.0.0.1');
  await sql`create table native_acceptance (id integer primary key, body text not null)`;
  await sql`insert into native_acceptance values (1, 'Josi native restore: apples, tomorrow, café')`;
  const dump = join(root, 'verified-backup.sql');
  run('pg_dump', ['--no-password', '--no-owner', '--no-privileges', '--clean', '--if-exists', '-f', dump, 'josi']);
  await sql`update native_acceptance set body = 'deliberate test mutation' where id = 1`;
  run('psql', ['--no-password', '-X', '--set', 'ON_ERROR_STOP=1', '--single-transaction', '-d', 'josi', '-f', dump]);
  const [{ body }] = await sql`select body from native_acceptance where id = 1`;
  assert.equal(body, 'Josi native restore: apples, tomorrow, café');
  const [owner] = await sql`insert into users(email, username, role) values ('native-restore@example.test', 'native-restore', 'super_admin') returning id`;
  const [thread] = await sql`insert into threads(owner_user_id, title) values (${owner.id}, 'Native restore acceptance') returning id`;
  await sql`insert into messages(thread_id, direction, body) values (${thread.id}, 'in', 'Remember the café appointment'), (${thread.id}, 'out', 'Your appointment is saved.')`;
  await sql`update deployment_config set domain = 'native-restore.example.test'`;
  process.env.JOSI_NATIVE_RUNTIME = '1';
  process.env.JOSI_DATA_DIR = join(root, 'product-data');
  process.env.PGOPTIONS = '-c default_transaction_read_only=on';
  process.env.PATH = ''; // A real process must use only the explicitly bundled tools.
  const conn = { host: '127.0.0.1', port: Number(url.port), user: 'josi', database: 'josi',
    passwordFile: process.env.PGPASSWORD_FILE, toolsDirectory: bin };
  const writer = pgBackupWriter(conn), reader = pgRestoreReader(conn);
  const destination = '/data/backups/product-acceptance.zip';
  const written = await writer.write({ kind: 'full', contents: FULL_CONTENTS, destination });
  const archive = await writer.read(destination);
  assert.equal(archive.length, written.byteSize);
  assert.equal(createHash('sha256').update(archive).digest('hex'), written.sha256);
  assert.ok(gunzipSync(archive).toString('utf8').includes('Remember the café appointment'));
  await sql`update messages set body = 'deliberate product test mutation' where thread_id = ${thread.id}`;
  await sql`update deployment_config set domain = 'changed.example.test'`;
  const restored = await reader.apply({ archive });
  assert.equal(restored.rowsRestored, 1);
  const messages = await sql`select direction, body from messages where thread_id = ${thread.id} order by direction`;
  assert.deepEqual(messages.map(row => row.body), ['Remember the café appointment', 'Your appointment is saved.']);
  const [config] = await sql`select domain from deployment_config`;
  assert.equal(config.domain, 'native-restore.example.test');
  const broken = gzipSync(Buffer.from("update messages set body = 'must be rolled back'; select native_restore_deliberate_failure();"));
  await assert.rejects(reader.apply({ archive: broken }), error => error.category === 'archive_corrupt');
  assert.equal((await sql`select body from messages where thread_id = ${thread.id} and direction = 'in'`)[0].body, 'Remember the café appointment');
  await assert.rejects(reader.apply({ archive: Buffer.from('invalid archive') }), error => error.category === 'archive_corrupt');
  const dataRoot = process.env.JOSI_DATA_DIR;
  for (const folder of ['snapshots', 'chat-attachments', 'roots', 'roots/project', 'versions', 'versions/document']) {
    mkdirSync(join(dataRoot, folder), { recursive: true });
  }
  const fixtureFiles = [
    ['chat-attachments/attachment.bin', Buffer.from('Uploaded attachment — café')],
    ['roots/project/notes.txt', Buffer.from('A real managed document with an appointment.')],
    ['versions/document/prior.bin', Buffer.from('Prior recovery-copy contents.')],
  ];
  for (const [name, bytes] of fixtureFiles) writeFileSync(join(dataRoot, name), bytes);
  const snapshotId = '4'.repeat(32);
  const snapshot = await createNativeSnapshot(dataRoot, snapshotId, writer);
  const { verifyNativeSnapshot } = await import('@josi-ce/ops');
  assert.equal((await verifyNativeSnapshot(dataRoot, snapshotId, snapshot.manifestSha256)).verified, true);
  await assert.rejects(verifyNativeSnapshot(dataRoot, snapshotId, '0'.repeat(64)));
  assert.equal(snapshot.files, 3);
  assert.deepEqual(gunzipSync(readFileSync(join(dataRoot, 'snapshots', snapshotId, 'database.gz'))).subarray(0, 2), Buffer.from('--'));
  await sql`update messages set body='must restore from full snapshot' where thread_id=${thread.id}`;
  await sql`update deployment_config set domain='mutated-snapshot.example.test'`;
  for (const [name] of fixtureFiles) writeFileSync(join(dataRoot, name), 'deliberately damaged artifact');
  writeFileSync(join(dataRoot, 'roots/new-after-snapshot.txt'), 'must be displaced, not retained in restored view');
  const attemptId = '6'.repeat(32);
  // A power loss can leave a regular but incomplete staging file. It must be
  // recopied safely; unexpected staging content must fail before SQL mutation.
  const interruptedStage = join(dataRoot, 'snapshots', snapshotId, `restore-${attemptId}`, 'staged');
  mkdirSync(join(interruptedStage, 'chat-attachments'), { recursive: true });
  writeFileSync(join(interruptedStage, fixtureFiles[0][0]), fixtureFiles[0][1].subarray(0, 3));
  const unexpectedStageFile = join(interruptedStage, 'chat-attachments/unexpected.bin');
  writeFileSync(unexpectedStageFile, 'not authorized by the snapshot');
  await assert.rejects(restoreNativeSnapshot(dataRoot, snapshotId, snapshot.manifestSha256, reader, attemptId));
  assert.equal((await sql`select domain from deployment_config`)[0].domain, 'mutated-snapshot.example.test');
  assert.equal(readFileSync(join(dataRoot, fixtureFiles[0][0]), 'utf8'), 'deliberately damaged artifact');
  unlinkSync(unexpectedStageFile);
  // Deny a real Windows directory move AFTER the first artifact root swaps.
  // Retrying the same recorded attempt must finish without displacing the
  // already-restored root a second time or losing the original files.
  const heldRoot = pinWindowsDirectory(join(dataRoot, 'roots'));
  try { await assert.rejects(restoreNativeSnapshot(dataRoot, snapshotId, snapshot.manifestSha256, reader, attemptId)); }
  finally { await heldRoot.close(); }
  assert.deepEqual(readFileSync(join(dataRoot, fixtureFiles[0][0])), fixtureFiles[0][1]);
  assert.equal(readFileSync(join(dataRoot, fixtureFiles[1][0]), 'utf8'), 'deliberately damaged artifact');
  const complete = await restoreNativeSnapshot(dataRoot, snapshotId, snapshot.manifestSha256, reader, attemptId);
  assert.equal(complete.filesRestored, 3);
  assert.equal(complete.permissionsPending, true); // Installer must reapply service DACLs before restart.
  for (const [name, bytes] of fixtureFiles) assert.deepEqual(readFileSync(join(dataRoot, name)), bytes);
  assert.equal(existsSync(join(dataRoot, 'roots/new-after-snapshot.txt')), false);
  assert.equal(existsSync(join(complete.recoveryDirectory, 'prior/roots/new-after-snapshot.txt')), true);
  assert.equal((await sql`select body from messages where thread_id=${thread.id} and direction='in'`)[0].body, 'Remember the café appointment');
  assert.equal((await sql`select domain from deployment_config`)[0].domain, 'native-restore.example.test');
  // Even an otherwise verified snapshot must reject an unlisted file.
  const unexpectedSnapshotFile = join(dataRoot, 'snapshots', snapshotId, 'files', 'unexpected.bin');
  writeFileSync(unexpectedSnapshotFile, 'not in the pinned inventory');
  await sql`update deployment_config set domain='must-remain.example.test'`;
  try { await assert.rejects(restoreNativeSnapshot(dataRoot, snapshotId, snapshot.manifestSha256, reader, '8'.repeat(32))); }
  finally { unlinkSync(unexpectedSnapshotFile); }
  assert.equal((await sql`select domain from deployment_config`)[0].domain, 'must-remain.example.test');
  // Corrupt snapshot data must be refused BEFORE restoring SQL or touching live files.
  const snapshotFile = join(dataRoot, 'snapshots', snapshotId, 'files', fixtureFiles[0][0]);
  writeFileSync(snapshotFile, 'corrupted backup data');
  await sql`update deployment_config set domain='must-remain.example.test'`;
  await assert.rejects(restoreNativeSnapshot(dataRoot, snapshotId, snapshot.manifestSha256, reader, '7'.repeat(32)));
  await assert.rejects(verifyNativeSnapshot(dataRoot, snapshotId, snapshot.manifestSha256));
  assert.equal((await sql`select domain from deployment_config`)[0].domain, 'must-remain.example.test');
  assert.deepEqual(readFileSync(join(dataRoot, fixtureFiles[0][0])), fixtureFiles[0][1]);
  // A hard link must not let an application writer smuggle a secret into a snapshot.
  const link = join(dataRoot, 'roots/disallowed-link');
  linkSync(process.env.PGPASSWORD_FILE, link);
  try { await assert.rejects(createNativeSnapshot(dataRoot, '5'.repeat(32), writer)); }
  finally { unlinkSync(link); }
  const report = { passed: true, postgres: '16.15', migrations: count, loopbackOnly: true,
    nativeDumpRestore: true, dumpSha256: createHash('sha256').update(readFileSync(dump)).digest('hex'),
    productBackupFormatTested: true, productBackupSha256: written.sha256,
    realConversationsRestored: true, configurationRestored: true, failedRestoreRolledBack: true,
    usesBundledToolsWithoutPath: true, inheritedPgOptionsIgnored: true,
    externalArtifactFilesRestored: true, snapshotFilesRestored: complete.filesRestored,
    snapshotCorruptionRejectedBeforeMutation: true, snapshotHardLinksRejected: true,
    interruptedDirectorySwapResumed: true,
    interruptedArtifactCopyResumed: true, unexpectedInventoryFilesRejectedBeforeMutation: true,
    servicePermissionsAfterRestoreTested: false, windowsServiceTested: false };
  writeFileSync(join(repo, 'artifacts/windows-native/evidence/postgres-spike.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await sql.end();
}
