// Real macOS storage + synthetic persistent Vault. No browser/profile/VM or
// installed server is opened. hdiutil receives passwords only on stdin.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import {
  MasterKey, pgliteDb, privateTemporaryDirectory, initializeVault, storeVaultCredentialPayload,
  openCredentialPayload, deleteVaultSlot, setVaultLock, recoverVault, vaultRecords, VaultError, VaultLockedError,
} from '../../../packages/core/dist/index.js';

if (process.platform !== 'darwin' || process.argv[2] !== '--execute-disposable-proof') {
  throw new Error('Run this macOS-only development probe with --execute-disposable-proof.');
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const free = await statfs(tmpdir());
if (Number(free.bavail) * Number(free.bsize) < 8 * 1024 ** 3) throw new Error('The disposable storage probe requires an 8 GiB free-space reserve.');
const directory = await realpath(privateTemporaryDirectory('josi-vault-workspace-proof-'));
const image = join(directory, 'workspace.sparsebundle'), mount = join(directory, 'mounted');
const databasePath = join(directory, 'vault-db'), samplePath = join(mount, 'synthetic-session.bin');
await mkdir(mount, { mode: 0o700 });
let database, stage = 'initialization', succeeded = false, cleaned = false, osAttachCalls = 0;
let result;
const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' };
function phase(name) { stage = name; console.log('Disposable workspace proof: ' + name); }

function command(executable, args, input = undefined) {
  return new Promise(resolveResult => {
    const child = execFile(executable, args, { cwd: directory, env: environment, encoding: 'buffer', timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolveResult({ ok: !error, stdout, code: error ? (typeof error.code === 'number' ? error.code : 'tool_failed') : 0 }));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
async function disk(args, password) {
  const input = password === undefined ? undefined : Buffer.from(password + '\0');
  try { return await command('/usr/bin/hdiutil', args, input); }
  finally { input?.fill(0); }
}
async function mustDisk(args, password) {
  const value = await disk(args, password);
  if (!value.ok) throw new Error('Disk image operation failed.'); // never include command diagnostics
  return value;
}
async function attachments() {
  const info = await mustDisk(['info', '-plist']);
  const parse = await command('/usr/bin/python3', ['-c',
    'import json,os,plistlib,re,sys\np=plistlib.loads(sys.stdin.buffer.read())\n'
      + 'items=[i for i in p.get("images",[]) if os.path.realpath(i.get("image-path",""))==os.path.realpath(sys.argv[1])]\n'
      + 'devices=sorted(set(e["dev-entry"] for i in items for e in i.get("system-entities",[]) if re.fullmatch(r"/dev/disk[0-9]+",e.get("dev-entry",""))))\n'
      + 'print(json.dumps({"count":len(items),"devices":devices}))', image], info.stdout);
  if (!parse.ok) throw new Error('Could not verify disposable disk attachment state.');
  return JSON.parse(parse.stdout.toString('utf8'));
}
async function fileAbsent() {
  try { await readFile(samplePath); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw new Error('Unexpected workspace path state.'); }
}

try {
  phase('synthetic_vault');
  database = new PGlite(databasePath);
  let db = pgliteDb(database), installKey = new MasterKey(randomBytes(32));
  const migrations = join(repo, 'packages/db/migrations');
  for (const name of (await readdir(migrations)).filter(v => v.endsWith('.sql')).sort()) await database.exec(await readFile(join(migrations, name), 'utf8'));
  const [{ id: owner }] = await db.query("insert into users(email,username,role) values('workspace-proof@example.test','workspace-proof','super_admin') returning id");
  const { recoveryKey } = await initializeVault(db, installKey, owner);
  const slot = randomUUID(), service = 'unified.p0.workspace';
  const reference = await storeVaultCredentialPayload(db, installKey, { ownerUserId: owner, kind: 'password', service, slot,
    label: 'Disposable encrypted workspace fixture', payload: { imagePassword: randomBytes(48).toString('base64url') } });
  const credential = async () => {
    const payload = await openCredentialPayload(db, installKey, { ownerUserId: owner, service, slot, stored: reference });
    assert.equal(typeof payload.imagePassword, 'string');
    return payload.imagePassword;
  };
  const attach = async () => {
    const password = await credential(); // denial must occur before an OS call
    osAttachCalls++;
    await mustDisk(['attach', '-stdinpass', '-nobrowse', '-noautoopen', '-mountpoint', mount, image], password);
  };
  phase('create_encrypted_image');
  await mustDisk(['create', '-size', '128m', '-fs', 'APFS', '-type', 'SPARSEBUNDLE', '-volname', 'JosiVaultProof',
    '-encryption', 'AES-256', '-stdinpass', '-nospotlight', image], await credential());
  phase('vault_mount');
  await attach();
  const sample = randomBytes(128);
  await writeFile(samplePath, sample, { mode: 0o600 });
  const handle = await open(samplePath, 'r+');
  let busyDetach, handleReadable;
  try {
    await handle.sync();
    phase('busy_handle');
    busyDetach = await disk(['detach', mount]);
    try { const check = Buffer.alloc(sample.length); await handle.read(check, 0, check.length, 0); handleReadable = check.equals(sample); }
    catch { handleReadable = false; }
  } finally { await handle.close(); }
  if (!busyDetach.ok) await mustDisk(['detach', mount]);
  assert.equal(await fileAbsent(), true);
  assert.equal((await attachments()).count, 0);

  phase('wrong_password');
  const wrong = await disk(['attach', '-stdinpass', '-nobrowse', '-noautoopen', '-mountpoint', mount, image], 'incorrect-disposable-proof-value');
  assert.equal(wrong.ok, false);
  assert.equal((await attachments()).count, 0);
  phase('locked_vault');
  await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
  const callsBeforeLock = osAttachCalls;
  await assert.rejects(attach(), VaultLockedError);
  assert.equal(osAttachCalls, callsBeforeLock);
  await setVaultLock(db, { master: true, locked: false, actorUserId: owner });
  await attach();
  assert.deepEqual(await readFile(samplePath), sample);
  await mustDisk(['detach', mount]);

  phase('persistent_vault_recovery');
  await database.close();
  database = new PGlite(databasePath); db = pgliteDb(database);
  installKey = new MasterKey(randomBytes(32));
  await assert.rejects(credential()); // replacement wrapping key cannot silently open old authority
  await recoverVault(db, installKey, recoveryKey.reveal(), owner);
  const authority = await vaultRecords(db, installKey).checkCardinalPolicy({ actorUserId: owner,
    facts: { effects: ['browser.observe'], effectCoverage: 'verified', identities: { userId: owner } } });
  assert.equal(authority.code, 'requires_reconciliation');
  // Administrator recovery inspection only. No automation workspace/browser is
  // launched, and the pending authority reconciliation flag is never cleared.
  await attach();
  assert.deepEqual(await readFile(samplePath), sample);
  await mustDisk(['detach', mount]);

  phase('revoked_reference');
  await deleteVaultSlot(db, { ownerUserId: owner, service, slot, actorUserId: owner });
  const callsBeforeRemoval = osAttachCalls;
  await assert.rejects(attach(), VaultError);
  assert.equal(osAttachCalls, callsBeforeRemoval);
  await storeVaultCredentialPayload(db, installKey, { ownerUserId: owner, kind: 'password', service, slot,
    label: 'New disposable identity', payload: { imagePassword: randomBytes(48).toString('base64url') } });
  await assert.rejects(attach(), VaultError);
  assert.equal(osAttachCalls, callsBeforeRemoval);
  assert.equal(await fileAbsent(), true);
  assert.equal((await attachments()).count, 0);
  result = { probe: 'vault-controlled-encrypted-workspace', passed: true, createdAt: new Date().toISOString(),
    logicalImageMiB: 128, syntheticVaultOnly: true, passwordPassedOnStdin: true, probeWritesKeychain: false,
    wrongPasswordDenied: true, lockedVaultDeniedBeforeOsCall: true, dataSurvivedRemount: true,
    persistentVaultReopened: true, replacementInstallKeyRequiredRecovery: true, recoveryInspectionRemount: true,
    automationStillRequiresReconciliation: true, deletedReferenceDenied: true, recreatedSlotCannotReviveReference: true,
    busyDetachRefused: !busyDetach.ok, openHandleReadableAfterDetachAttempt: handleReadable,
    automaticLockUnmountImplemented: false, realBrowserTested: false, realVmTested: false, crashRecoveryTested: false };
  succeeded = true;
} catch {
  // Never serialize caught OS/DB errors: they can include supplied input.
  result = { probe: 'vault-controlled-encrypted-workspace', passed: false, failedStage: stage };
} finally {
  try {
    // Re-enumerate after each detach; device numbers can be reused by the OS.
    for (let attempt = 0; attempt < 4; attempt++) {
      const attached = await attachments();
      if (!attached.count) break;
      if (!attached.devices.length || !(await disk(['detach', attached.devices[0]])).ok) throw new Error('Could not detach the disposable fixture.');
    }
    if ((await attachments()).count !== 0) throw new Error('Disposable image is still attached.');
    const mounted = await stat(mount).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (mounted && mounted.dev !== (await stat(directory)).dev) throw new Error('Mount point still belongs to another filesystem.');
    await database?.close();
    await rm(directory, { recursive: true, force: true }); // exclusively this invocation's private fixture, after detach verification
    cleaned = true;
  } catch {
    // Retain the fixture rather than recursively deleting through a live mount.
    succeeded = false;
  }
  result = { ...result, passed: succeeded, cleanedUp: cleaned, ...(cleaned ? {} : { retainedFixturePath: directory }) };
  const evidence = join(repo, 'build/unified-p0/vault-workspace-proof');
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  if (!succeeded) process.exitCode = 1;
}
