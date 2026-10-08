// Local, offline lifecycle snapshots. The existing gzip SQL database format is
// unchanged; a checked file inventory accompanies it for installer rollback.
// The elevated lifecycle caller must quiesce all application writers and hold
// its exclusive transaction lock throughout creation/restore. This is not the
// browser backup format and is not an online filesystem snapshot.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, win32 } from 'node:path';
import { openStorageFile, pinWindowsDirectory, publishWindowsFile } from '@josi-ce/storage';
import { FULL_CONTENTS, type BackupWriter, type RestoreReader } from './backup.js';

const ROOTS = ['chat-attachments', 'roots', 'versions'] as const;
type Entry = { path: string; size: number; sha256: string };
type Manifest = { schemaVersion: 1; id: string; database: { size: number; sha256: string };
  directories: string[]; files: Entry[] };
function refused(): Error { return new Error('Native recovery snapshot is invalid or unavailable. The existing snapshot has been retained.'); }
function checkPath(path: string): string {
  if (!path || path.length > 2048 || path.includes('\\') || path.startsWith('/')
    || !ROOTS.includes(path.split('/')[0] as typeof ROOTS[number])
    || path.split('/').some(part => !part || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw refused();
  return path;
}
function location(dataRoot: string, id: string) {
  if (process.platform !== 'win32' || !/^[A-Za-z]:\\/.test(dataRoot) || win32.normalize(dataRoot) !== dataRoot
    || !/^[a-f0-9]{32}$/.test(id)) throw refused();
  return join(dataRoot, 'snapshots', id);
}
async function copyChecked(source: string, destination?: string, maximum = 2 ** 40, resumeStaged = false): Promise<{ size: number; sha256: string }> {
  const parent = pinWindowsDirectory(win32.dirname(source));
  let destinationParent;
  let input, output;
  try {
    input = await openStorageFile(source, constants.O_RDONLY);
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw refused();
    if (destination) {
      destinationParent = pinWindowsDirectory(win32.dirname(destination));
      // Only unpublished, administrator-owned restore staging can be resumed.
      // Pin/check an existing leaf before truncation; links cannot redirect it.
      output = resumeStaged && await present(destination)
        ? await openStorageFile(destination, constants.O_RDWR) : await open(destination, 'wx');
      if (resumeStaged) await output.truncate(0);
    }
    const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > before.size) throw refused();
      const part = buffer.subarray(0, bytesRead); hash.update(part);
      if (output) await output.writeFile(part);
    }
    const after = await input.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw refused();
    await output?.sync();
    return { size, sha256: hash.digest('hex') };
  } finally { await output?.close(); await destinationParent?.close(); await input?.close(); await parent.close(); }
}

/** An inventory describes the entire tree, including empty directories. */
async function verifyTree(base: string, directories: string[], files: Entry[], wholeTree = false) {
  const expected = new Map<string, 'directory' | Entry>();
  for (const directory of directories) expected.set(directory, 'directory');
  for (const file of files) expected.set(file.path, file);
  if (wholeTree) {
    const held = pinWindowsDirectory(base);
    try {
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!ROOTS.includes(entry.name as typeof ROOTS[number]) || !entry.isDirectory() || entry.isSymbolicLink()) throw refused();
      }
    } finally { await held.close(); }
  }
  for (const directory of directories) {
    const held = pinWindowsDirectory(join(base, directory));
    try {
      for (const entry of await readdir(join(base, directory), { withFileTypes: true })) {
        const relative = checkPath(`${directory}/${entry.name}`), wanted = expected.get(relative);
        if (!wanted || entry.isSymbolicLink()) throw refused();
        if (wanted === 'directory') { if (!entry.isDirectory()) throw refused(); }
        else if (!entry.isFile()) throw refused();
      }
    } finally { await held.close(); }
  }
  for (const file of files) {
    const actual = await copyChecked(join(base, file.path));
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw refused();
  }
}
async function writeRecord(path: string, value: unknown) {
  const pending = `${path}.${randomUUID()}.pending`;
  const file = await open(pending, 'wx');
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  publishWindowsFile(pending, path);
}
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function checkpoint(path: string, value: unknown) {
  if (await present(path)) {
    await copyChecked(path, undefined, 4096);
    if (JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) !== JSON.stringify(value)) throw refused();
  } else await writeRecord(path, value);
}

/** Called only after the installer has stopped application writers. */
export async function createNativeSnapshot(dataRoot: string, id: string, writer: BackupWriter) {
  const snapshot = location(dataRoot, id), guard = pinWindowsDirectory(dataRoot);
  try {
    // This parent is administrator-only in the native data policy. Do not fall
    // back to a user temp directory if the installed layout is incomplete.
    const storage = pinWindowsDirectory(join(dataRoot, 'snapshots'));
    try { await mkdir(snapshot); } finally { await storage.close(); }
    const payload = join(snapshot, 'files'); await mkdir(payload);
    const directories: string[] = [], files: Entry[] = [];
    async function visit(relative: string) {
      checkPath(relative);
      if (files.length + directories.length >= 100000) throw refused();
      const source = join(dataRoot, relative), held = pinWindowsDirectory(source);
      try {
        directories.push(relative); await mkdir(join(payload, relative));
        for (const entry of await readdir(source, { withFileTypes: true })) {
          if (files.length + directories.length >= 100000) throw refused();
          const name = checkPath(`${relative}/${entry.name}`);
          if (entry.isSymbolicLink()) throw refused();
          if (entry.isDirectory()) await visit(name);
          else if (entry.isFile()) files.push({ path: name, ...await copyChecked(join(dataRoot, name), join(payload, name)) });
          else throw refused();
        }
      } finally { await held.close(); }
    }
    for (const root of ROOTS) await visit(root);
    const databasePath = join(snapshot, 'database.gz');
    const database = await writer.write({ kind: 'full', contents: FULL_CONTENTS, destination: databasePath });
    const databaseHandle = await openStorageFile(databasePath, constants.O_RDWR);
    try { await databaseHandle.sync(); } finally { await databaseHandle.close(); }
    const verified = await copyChecked(databasePath);
    if (database.sha256 !== verified.sha256 || database.byteSize !== verified.size) throw refused();
    const manifest: Manifest = { schemaVersion: 1, id, database: verified, directories, files };
    // Publication is last. A partially copied folder has no valid manifest and
    // cannot authorize a migration or overwrite the current installation.
    await writeRecord(join(snapshot, 'manifest.json'), manifest);
    return { id, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, verified.size),
      manifestSha256: (await copyChecked(join(snapshot, 'manifest.json'))).sha256 };
  } catch { throw refused(); } finally { await guard.close(); }
}

async function verifySnapshot(snapshot: string, id: string, expectedHash: string): Promise<Manifest> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw refused();
  const record = await copyChecked(join(snapshot, 'manifest.json'), undefined, 32 * 1024 * 1024);
  if (record.sha256 !== expectedHash) throw refused();
  const value: Manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  if (Object.keys(value).sort().join(',') !== 'database,directories,files,id,schemaVersion'
    || value.schemaVersion !== 1 || value.id !== id || !Array.isArray(value.files) || !Array.isArray(value.directories)
    || value.files.length + value.directories.length > 100000) throw refused();
  const seen = new Set<string>();
  for (const directory of value.directories) {
    checkPath(directory);
    if (seen.has(directory.toLowerCase())) throw refused();
    const parent = directory.slice(0, directory.lastIndexOf('/'));
    if (directory.includes('/') && !seen.has(parent.toLowerCase())) throw refused();
    seen.add(directory.toLowerCase());
  }
  if (ROOTS.some(root => !seen.has(root))) throw refused();
  for (const file of value.files) {
    if (Object.keys(file).sort().join(',') !== 'path,sha256,size') throw refused();
    checkPath(file.path);
    const parent = file.path.slice(0, file.path.lastIndexOf('/'));
    if (!seen.has(parent.toLowerCase()) || seen.has(file.path.toLowerCase())
      || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw refused();
    seen.add(file.path.toLowerCase());
  }
  await verifyTree(join(snapshot, 'files'), value.directories, value.files, true);
  const database = await copyChecked(join(snapshot, 'database.gz'));
  if (database.size !== value.database.size || database.sha256 !== value.database.sha256) throw refused();
  return value;
}

/** Verify a retained backup before resuming the installer checkpoint, without
 * applying SQL, staging files or changing any live artifact. */
export async function verifyNativeSnapshot(dataRoot: string, id: string, manifestHash: string) {
  const snapshot = location(dataRoot, id), guard = pinWindowsDirectory(dataRoot);
  let held;
  try {
    held = pinWindowsDirectory(snapshot);
    const manifest = await verifySnapshot(snapshot, id, manifestHash);
    return { verified: true, id, manifestSha256: manifestHash, files: manifest.files.length };
  } finally { await held?.close(); await guard.close(); }
}

/** SQL failure changes no live files. Later filesystem failure leaves the
 * verified snapshot, staging and displaced data intact for the lifecycle
 * recovery transaction; it never reports the installation as healthy.
 * The caller must reapply the native per-service DACLs before starting services.
 */
export async function restoreNativeSnapshot(dataRoot: string, id: string, manifestHash: string, reader: RestoreReader, attemptId: string) {
  if (!/^[a-f0-9]{32}$/.test(attemptId)) throw refused();
  const snapshot = location(dataRoot, id), guard = pinWindowsDirectory(dataRoot);
  try {
    const held = pinWindowsDirectory(snapshot);
    try {
      const manifest = await verifySnapshot(snapshot, id, manifestHash);
      // The installer persists attemptId before entry. Retrying that transaction
      // resumes the same swaps, including a crash between either directory move.
      const attempt = join(snapshot, `restore-${attemptId}`), staged = join(attempt, 'staged'), prior = join(attempt, 'prior');
      for (const directory of [attempt, staged, prior]) {
        if (!await present(directory)) await mkdir(directory);
        const check = pinWindowsDirectory(directory); await check.close();
      }
      const prepared = join(attempt, 'prepared.json'), identity = { id, manifestHash };
      if (!await present(prepared)) {
        if ((await readdir(prior)).length) throw refused();
        for (const directory of manifest.directories) {
          const path = join(staged, directory);
          if (!await present(path)) await mkdir(path);
          const check = pinWindowsDirectory(path); await check.close();
        }
        for (const file of manifest.files) {
          const destination = join(staged, file.path);
          const copy = await copyChecked(join(snapshot, 'files', file.path), destination, 2 ** 40, true);
          if (copy.size !== file.size || copy.sha256 !== file.sha256) throw refused();
        }
        await verifyTree(staged, manifest.directories, manifest.files, true);
      }
      await checkpoint(prepared, identity);
      // On a resumed swap, some roots are already live. Check all replacements
      // that remain before any SQL mutation, including their exact membership.
      for (const root of ROOTS) {
        const files = manifest.files.filter(file => file.path.startsWith(`${root}/`));
        const directories = manifest.directories.filter(path => path === root || path.startsWith(`${root}/`));
        const base = await present(join(staged, root)) ? staged : dataRoot;
        await verifyTree(base, directories, files);
      }
      // Reapplying the same transactionally restored dump is safe while the
      // lifecycle lock and stopped writers remain in force, even if power was
      // lost immediately after PostgreSQL committed the previous attempt.
      const restored = await reader.apply({ archive: await readFile(join(snapshot, 'database.gz')) });
      await checkpoint(join(attempt, 'database-restored.json'), identity);
      for (const root of ROOTS) {
        const current = join(dataRoot, root), saved = join(prior, root), replacement = join(staged, root);
        for (const path of [current, saved, replacement]) {
          if (await present(path)) { const check = pinWindowsDirectory(path); await check.close(); }
        }
        if (await present(replacement)) {
          if (!await present(saved)) await rename(current, saved);
          if (await present(current)) throw refused();
          await rename(replacement, current);
        } else if (!await present(saved) || !await present(current)) throw refused();
        await verifyTree(dataRoot, manifest.directories.filter(path => path === root || path.startsWith(`${root}/`)),
          manifest.files.filter(file => file.path.startsWith(`${root}/`)));
        await checkpoint(join(attempt, `${root}-restored.json`), identity);
      }
      return { ...restored, filesRestored: manifest.files.length, permissionsPending: true, recoveryDirectory: attempt };
    } finally { await held.close(); }
  } catch { throw refused(); } finally { await guard.close(); }
}
