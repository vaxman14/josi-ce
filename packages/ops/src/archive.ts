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
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { writeZip, ZipReader, type ZipEntry, type ZipSource } from './zip.js';
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
  contents: { database: boolean; attachments: number; recoveryCopies: boolean;
    /** The installation master key travels inside a SEALED backup only, so a restore onto a new install can open the saved logins. */
    masterKey?: boolean; relayKeys?: number; versions?: number };
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

export function isSealed(bytes: Buffer): boolean { return bytes.length > ENVELOPE.length && bytes.subarray(0, 5).toString('latin1') === 'JOSIP' && /[12]/.test(String.fromCharCode(bytes[5])); }

// ------------------------------------------------- envelope 2: a recipient
//
// The first envelope needs the passphrase every time a file is written, so the
// nightly backup could not be sealed without storing the passphrase. This one
// seals to a PUBLIC key that the passphrase makes: the server keeps only the
// public half (and the salt), seals every backup to it, and cannot open what it
// wrote. Only someone who types the passphrase can derive the private key.
//
//   'JOSIP2' | salt 16 | ephemeral public key 32 | nonce 12 | ciphertext | tag 16
//
// The data key is X25519(ephemeral private, recipient public) run through HKDF.
// The tag is last, so a file of any size is written and read as a stream.
const ENVELOPE2 = Buffer.from('JOSIP2');
const HEADER2 = ENVELOPE2.length + 16 + 32 + 12;
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

export interface BackupRecipient { salt: string; publicKey: string }

function privateFromPassphrase(passphrase: string, salt: Buffer) {
  const seed = scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, seed]), format: 'der', type: 'pkcs8' });
}
function publicFromRaw(raw: Buffer) {
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
}
function dataKey(shared: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, salt, 'josi-backup-v2', 32));
}

/** The public half a passphrase makes; what the server stores. A new random salt each time. */
export function recipientFromPassphrase(passphrase: string): BackupRecipient {
  if (!passphrase || passphrase.length < 8) throw new BackupError('use a backup password of at least 8 characters');
  const salt = randomBytes(16);
  const publicKey = createPublicKey(privateFromPassphrase(passphrase, salt)).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { salt: salt.toString('hex'), publicKey: publicKey.toString('hex') };
}

/** True when `passphrase` is the one this recipient was made from. */
export function passphraseMatchesRecipient(passphrase: string, recipient: BackupRecipient): boolean {
  try {
    const publicKey = createPublicKey(privateFromPassphrase(passphrase, Buffer.from(recipient.salt, 'hex'))).export({ format: 'der', type: 'spki' }).subarray(-32);
    return publicKey.toString('hex') === recipient.publicKey;
  } catch { return false; }
}

/** Seals the file at `plainPath` to `recipient`, writing `destination`. Streams; returns size and sha256. */
export async function sealFileToRecipient(plainPath: string, destination: string, recipient: BackupRecipient): Promise<{ byteSize: number; sha256: string }> {
  const salt = Buffer.from(recipient.salt, 'hex'), pub = Buffer.from(recipient.publicKey, 'hex');
  if (salt.length !== 16 || pub.length !== 32) throw new BackupError('the backup password settings are damaged; set the password again');
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = ephemeral.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = dataKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicFromRaw(pub) }), salt);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const hash = createHash('sha256');
  const out = createWriteStream(destination, { mode: 0o600, flags: 'w' });
  let byteSize = 0;
  const put = async (chunk: Buffer) => { hash.update(chunk); byteSize += chunk.length; if (!out.write(chunk)) await once(out, 'drain'); };
  try {
    await put(Buffer.concat([ENVELOPE2, salt, ephemeralPublic, nonce]));
    for await (const chunk of createReadStream(plainPath).pipe(cipher)) await put(chunk as Buffer);
    await put(cipher.getAuthTag());
    out.end(); await once(out, 'finish');
  } catch (error) { out.destroy(); await rm(destination, { force: true }); throw error; }
  return { byteSize, sha256: hash.digest('hex') };
}

/** Opens an envelope-2 file into `scratch`. Wrong passphrase and damage are the same answer. */
async function openFileSealedToRecipient(path: string, scratch: string, passphrase: string | undefined): Promise<void> {
  if (!passphrase) throw new RestoreError('this backup is encrypted; enter its passphrase', 'archive_corrupt');
  const info = await stat(path);
  if (info.size < HEADER2 + 16) throw new RestoreError('that file is not a Josi backup', 'archive_corrupt');
  const handle = await open(path, 'r');
  const head = Buffer.alloc(HEADER2), tag = Buffer.alloc(16);
  try { await handle.read(head, 0, HEADER2, 0); await handle.read(tag, 0, 16, info.size - 16); } finally { await handle.close(); }
  const salt = head.subarray(6, 22), ephemeralPublic = head.subarray(22, 54), nonce = head.subarray(54, 66);
  const key = dataKey(diffieHellman({ privateKey: privateFromPassphrase(passphrase, salt), publicKey: publicFromRaw(ephemeralPublic) }), salt);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(path, { start: HEADER2, end: info.size - 17 }), decipher, createWriteStream(scratch, { mode: 0o600 }));
  } catch {
    await rm(scratch, { force: true });
    throw new RestoreError('that passphrase does not open this backup', 'archive_corrupt');
  }
}

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

/** Every regular file under `root`, as archive entries under `prefix/`, newest
 * paths last so two runs over the same folder produce the same order. */
async function folderSources(root: string, prefix: string): Promise<ZipSource[]> {
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
        sources.push({ name: `${prefix}/${rel}`, path, mtime: info.mtime });
      }
    }
  };
  await walk(root);
  return sources;
}
const attachmentSources = (root: string) => folderSources(root, 'attachments');

export interface BuildArchiveArgs {
  destination: string;
  kind: 'full' | 'portable';
  databaseDump: Buffer;
  /** The chat attachments folder; absent when the installation has none. */
  attachmentsDir?: string | null;
  josiVersion: string;
  installationId?: string | null;
  /** Seals the file to a password typed now (a one-off backup). */
  passphrase?: string;
  /** Seals the file to a stored recipient (the nightly backup); the server cannot open it again. */
  recipient?: BackupRecipient;
  /** Only used when sealed: the installation master key file goes inside, so a restore
   * onto a new install can open the saved logins. Never written into a plain backup. */
  masterKeyFile?: string | null;
  /** Only used when sealed: the relay keys folder (connector keys the server holds outside the database). */
  keysDir?: string | null;
  /** Previous-version copies of documents; part of every full backup. */
  versionsDir?: string | null;
}

/** Writes the archive; when sealed, the file on disk is the sealed envelope
 * and only ever the envelope. */
export async function buildArchive(args: BuildArchiveArgs): Promise<{ byteSize: number; sha256: string; attachments: number; encrypted: boolean }> {
  const full = args.kind === 'full';
  const sealed = !!(args.passphrase || args.recipient);
  const attachments = full && args.attachmentsDir ? await attachmentSources(args.attachmentsDir) : [];
  const versions = full && args.versionsDir ? await folderSources(args.versionsDir, 'versions') : [];
  const relayKeys = full && sealed && args.keysDir ? await folderSources(args.keysDir, 'keys') : [];
  let keyBytes: Buffer | null = null;
  if (full && sealed && args.masterKeyFile) keyBytes = await readFile(args.masterKeyFile).catch(() => null);
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT, formatVersion: ARCHIVE_FORMAT_VERSION, josiVersion: args.josiVersion, createdAt: new Date().toISOString(),
    kind: args.kind, contents: { database: true, attachments: attachments.length, recoveryCopies: full,
      masterKey: !!keyBytes, relayKeys: relayKeys.length, versions: versions.length },
    installationId: args.installationId ?? null, platform: process.platform,
  };
  await mkdir(dirname(args.destination), { recursive: true });
  const plainPath = sealed ? `${args.destination}.plain-${randomBytes(6).toString('hex')}` : args.destination;
  await rm(plainPath, { force: true });
  let written: { byteSize: number; sha256: string };
  try {
    written = await writeZip(plainPath, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: 'database.sql.gz', data: args.databaseDump },
      ...(keyBytes ? [{ name: 'secrets/master-key', data: keyBytes }] : []),
      ...relayKeys, ...versions, ...attachments,
    ]);
    if (sealed) {
      const recipient = args.recipient ?? recipientFromPassphrase(args.passphrase!);
      written = await sealFileToRecipient(plainPath, args.destination, recipient);
    }
  } finally { if (sealed) await rm(plainPath, { force: true }); }
  return { ...written, attachments: attachments.length, encrypted: sealed };
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
  /** Copies a top-level folder of the archive ('versions', 'keys') into `dir`, replacing what is there. */
  restoreFolder: (prefix: string, dir: string) => Promise<number>;
  /** The installation master key the archive carries, or null (a plain backup carries none). */
  masterKey: () => Promise<Buffer | null>;
  close: () => Promise<void>;
}

/** Opens a backup file, sealed or plain, new or legacy, without changing
 * anything. The caller decides what to do with it. */
export async function openArchive(path: string, passphrase?: string): Promise<OpenedArchive> {
  const head = Buffer.alloc(8);
  const probe = await open(path, 'r');
  try { await probe.read(head, 0, 8, 0); } finally { await probe.close(); }
  let zipPath = path, scratch: string | null = null;
  if (head.subarray(0, 6).equals(ENVELOPE2)) {
    scratch = join(tmpdir(), `josi-open-${randomBytes(8).toString('hex')}`);
    await openFileSealedToRecipient(path, scratch, passphrase);
    zipPath = scratch;
  } else if (isSealed(head)) {
    const plain = openWithPassphrase(await readFile(path), passphrase);
    scratch = join(tmpdir(), `josi-open-${randomBytes(8).toString('hex')}`);
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
      restoreAttachments: async () => 0, restoreFolder: async () => 0, masterKey: async () => null, close: async () => undefined,
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
      restoreAttachments: (dir: string) => restoreEntries(reader, attachments, 'attachments/', dir),
      restoreFolder: (prefix: string, dir: string) => restoreEntries(reader, reader.entries.filter((e) => e.name.startsWith(`${prefix}/`) && !e.name.endsWith('/')), `${prefix}/`, dir),
      async masterKey() { const entry = reader.find('secrets/master-key'); return entry ? reader.read(entry) : null; },
      close,
    };
  } catch (error) { await close(); throw error; }
}

/** Writes `entries` under `dir`, swapping folders rather than files so a failure half way leaves the old ones untouched. */
async function restoreEntries(reader: ZipReader, entries: ZipEntry[], prefix: string, dir: string): Promise<number> {
  const fresh = `${dir}.restoring-${randomBytes(4).toString('hex')}`;
  await rm(fresh, { recursive: true, force: true });
  await mkdir(fresh, { recursive: true });
  let count = 0;
  for (const entry of entries) {
    const rel = entry.name.slice(prefix.length);
    if (rel.split('/').some((p) => p === '..' || p === '' || p === '.')) continue;
    const target = join(fresh, ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await reader.read(entry), { mode: 0o600 });
    count++;
  }
  const old = `${dir}.replaced-${randomBytes(4).toString('hex')}`;
  const had = await stat(dir).then(() => true).catch(() => false);
  if (had) await rename(dir, old);
  try { await rename(fresh, dir); }
  catch (error) { if (had) await rename(old, dir).catch(() => undefined); throw error; }
  if (had) await rm(old, { recursive: true, force: true });
  return count;
}
