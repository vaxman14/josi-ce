// One file with everything important, and the way back from it.
//
// A Josi backup is a plain zip: `manifest.json`, the database dump as
// `database.sql.gz`, and every chat attachment under `attachments/`. With a
// passphrase the zip is wrapped whole in an AES-256-GCM envelope whose key is
// derived with scrypt; the envelope starts with `JOSIP1` so the reader knows
// what it holds before asking for the passphrase. Older backups (a bare
// gzipped dump) still restore.
//
// What is deliberately NOT in the archive: the installation master key (M100;
// a backup and its key never travel together), indexed files from folders and
// cloud accounts (they live where they live and re-sync), voice models and
// runtimes (they come with the installer).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { writeZip, ZipReader, type ZipSource } from './zip.js';
import { BackupError, RestoreError } from './backup.js';

export const ARCHIVE_FORMAT = 'josi-backup';
export const ARCHIVE_FORMAT_VERSION = 1;
const ENVELOPE = Buffer.from('JOSIP1');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: number;
  /** The Josi version that wrote it. A newer backup is refused by an older server. */
  josiVersion: string;
  createdAt: string;
  kind: 'full' | 'portable';
  contents: { database: boolean; attachments: number; recoveryCopies: boolean };
  /** The installation's own id, so a restore can say when the backup came from elsewhere. */
  installationId: string | null;
  platform: string;
}

/** Compare dotted versions; a suffix such as `-dev` or `-native.11` is ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (v.split(/[-+]/)[0].match(/\d+/g) ?? []).map(Number);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// --------------------------------------------------------------- envelope

export function sealWithPassphrase(plain: Buffer, passphrase: string): Buffer {
  if (!passphrase) throw new BackupError('a passphrase is needed to encrypt the backup');
  const salt = randomBytes(16);
  const key = scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ENVELOPE, salt, nonce, cipher.getAuthTag(), encrypted]);
}

export function isSealed(bytes: Buffer): boolean { return bytes.length > ENVELOPE.length && bytes.subarray(0, ENVELOPE.length).equals(ENVELOPE); }

export function openWithPassphrase(sealed: Buffer, passphrase: string | undefined): Buffer {
  if (!isSealed(sealed)) return sealed;
  if (!passphrase) throw new RestoreError('this backup is encrypted; enter its passphrase', 'archive_corrupt');
  const salt = sealed.subarray(6, 22), nonce = sealed.subarray(22, 34), tag = sealed.subarray(34, 50), body = sealed.subarray(50);
  const key = scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try { return Buffer.concat([decipher.update(body), decipher.final()]); }
  catch { throw new RestoreError('that passphrase does not open this backup', 'archive_corrupt'); }
}

// ----------------------------------------------------------------- build

/** Every regular file under `root`, as archive entries, newest paths last so
 * two runs over the same folder produce the same order. */
async function attachmentSources(root: string): Promise<ZipSource[]> {
  const sources: ZipSource[] = [];
  const walk = async (dir: string) => {
    let names: string[];
    try { names = (await readdir(dir)).sort(); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) {
        const rel = relative(root, path).split(sep).join(posix.sep);
        if (rel.includes('..') || rel.startsWith('.')) continue;
        sources.push({ name: `attachments/${rel}`, path, mtime: info.mtime });
      }
    }
  };
  await walk(root);
  return sources;
}

export interface BuildArchiveArgs {
  destination: string;
  kind: 'full' | 'portable';
  databaseDump: Buffer;
  /** The chat attachments folder; absent when the installation has none. */
  attachmentsDir?: string | null;
  josiVersion: string;
  installationId?: string | null;
  passphrase?: string;
}

/** Writes the archive; with a passphrase, the file on disk is the sealed
 * envelope and only ever the envelope. */
export async function buildArchive(args: BuildArchiveArgs): Promise<{ byteSize: number; sha256: string; attachments: number; encrypted: boolean }> {
  const attachments = args.kind === 'full' && args.attachmentsDir ? await attachmentSources(args.attachmentsDir) : [];
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT, formatVersion: ARCHIVE_FORMAT_VERSION, josiVersion: args.josiVersion, createdAt: new Date().toISOString(),
    kind: args.kind, contents: { database: true, attachments: attachments.length, recoveryCopies: args.kind === 'full' },
    installationId: args.installationId ?? null, platform: process.platform,
  };
  await mkdir(dirname(args.destination), { recursive: true });
  const plainPath = args.passphrase ? `${args.destination}.plain-${randomBytes(6).toString('hex')}` : args.destination;
  await rm(plainPath, { force: true });
  let written = await writeZip(plainPath, [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'database.sql.gz', data: args.databaseDump },
    ...attachments,
  ]);
  if (args.passphrase) {
    try {
      const sealed = sealWithPassphrase(await readFile(plainPath), args.passphrase);
      await writeFile(args.destination, sealed, { mode: 0o600 });
      const { createHash } = await import('node:crypto');
      written = { byteSize: sealed.length, sha256: createHash('sha256').update(sealed).digest('hex') };
    } finally { await rm(plainPath, { force: true }); }
  }
  return { ...written, attachments: attachments.length, encrypted: !!args.passphrase };
}

// ------------------------------------------------------------------ open

export interface OpenedArchive {
  manifest: ArchiveManifest;
  /** Legacy archives (a bare gzipped dump) have no manifest; this says so. */
  legacy: boolean;
  databaseDump: () => Promise<Buffer>;
  attachments: Array<{ name: string; size: number }>;
  /** Copies every attachment into `dir`, replacing what is there. */
  restoreAttachments: (dir: string) => Promise<number>;
  close: () => Promise<void>;
}

/** Opens a backup file, sealed or plain, new or legacy, without changing
 * anything. The caller decides what to do with it. */
export async function openArchive(path: string, passphrase?: string): Promise<OpenedArchive> {
  const head = Buffer.alloc(8);
  const probe = await open(path, 'r');
  try { await probe.read(head, 0, 8, 0); } finally { await probe.close(); }
  let zipPath = path, scratch: string | null = null;
  if (isSealed(head)) {
    const plain = openWithPassphrase(await readFile(path), passphrase);
    scratch = `${path}.open-${randomBytes(6).toString('hex')}`;
    await writeFile(scratch, plain, { mode: 0o600 });
    zipPath = scratch;
  } else if (!(head[0] === 0x50 && head[1] === 0x4b)) {
    // Not a zip and not sealed: a backup from before the zip format, the dump
    // alone. The reader that applies it is the judge of whether it is one.
    const bytes = await readFile(path);
    return {
      manifest: { format: ARCHIVE_FORMAT, formatVersion: 0, josiVersion: '0.0.0', createdAt: '', kind: 'full',
        contents: { database: true, attachments: 0, recoveryCopies: true }, installationId: null, platform: 'unknown' },
      legacy: true, databaseDump: async () => bytes, attachments: [],
      restoreAttachments: async () => 0, close: async () => undefined,
    };
  }
  let reader: ZipReader;
  try { reader = await ZipReader.open(zipPath); }
  catch { if (scratch) await rm(scratch, { force: true }); throw new RestoreError('that file is not a Josi backup', 'archive_corrupt'); }
  const close = async () => { await reader.close(); if (scratch) await rm(scratch, { force: true }); };
  try {
    const manifestEntry = reader.find('manifest.json'), dumpEntry = reader.find('database.sql.gz');
    if (!manifestEntry || !dumpEntry) throw new RestoreError('that zip is not a Josi backup: it has no manifest or database inside', 'archive_corrupt');
    const manifest = JSON.parse((await reader.read(manifestEntry)).toString('utf8')) as ArchiveManifest;
    if (manifest.format !== ARCHIVE_FORMAT || typeof manifest.josiVersion !== 'string') throw new RestoreError('that zip is not a Josi backup', 'archive_corrupt');
    if (manifest.formatVersion > ARCHIVE_FORMAT_VERSION) throw new RestoreError('this backup was written by a newer Josi than this server', 'version_too_new');
    const attachments = reader.entries.filter((e) => e.name.startsWith('attachments/') && !e.name.endsWith('/'));
    return {
      manifest, legacy: false,
      databaseDump: () => reader.read(dumpEntry),
      attachments: attachments.map((e) => ({ name: e.name.slice('attachments/'.length), size: e.size })),
      async restoreAttachments(dir: string) {
        const fresh = `${dir}.restoring-${randomBytes(4).toString('hex')}`;
        await rm(fresh, { recursive: true, force: true });
        await mkdir(fresh, { recursive: true });
        let count = 0;
        for (const entry of attachments) {
          const rel = entry.name.slice('attachments/'.length);
          if (rel.split('/').some((p) => p === '..' || p === '' || p === '.')) continue;
          const target = join(fresh, ...rel.split('/'));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, await reader.read(entry), { mode: 0o600 });
          count++;
        }
        // Swap folders rather than files, so a failure half way leaves the
        // old attachments untouched.
        const old = `${dir}.replaced-${randomBytes(4).toString('hex')}`;
        const had = await stat(dir).then(() => true).catch(() => false);
        if (had) await rename(dir, old);
        try { await rename(fresh, dir); }
        catch (error) { if (had) await rename(old, dir).catch(() => undefined); throw error; }
        if (had) await rm(old, { recursive: true, force: true });
        return count;
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
