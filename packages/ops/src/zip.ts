// A small ZIP writer and reader, enough for Josi's own backup archives.
//
// Entries are stored, not deflated: the database dump inside is already
// gzipped and attachments are mostly images, so deflating again buys nothing
// and costs a pass over every byte. The format is plain PKZIP (local headers,
// central directory, end record), so any unzip tool opens a Josi backup, and
// the reader here opens archives those tools wrote too, as long as entries are
// stored or deflated and the archive stays under 4 GB (no ZIP64).
import { createHash } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipSource {
  /** Forward-slash path inside the archive. */
  name: string;
  /** Bytes, or a file on disk read in chunks. */
  data?: Buffer;
  path?: string;
  mtime?: Date;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const LIMIT = 0xffffffff;

/** Writes `sources` to `destination` as one archive. Returns size and the
 * SHA-256 of the written file. */
export async function writeZip(destination: string, sources: ZipSource[]): Promise<{ byteSize: number; sha256: string }> {
  const out = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let offset = 0;
  const central: Buffer[] = [];
  const write = async (chunk: Buffer) => { await out.write(chunk); hash.update(chunk); offset += chunk.length; };
  try {
    for (const source of sources) {
      const name = Buffer.from(source.name, 'utf8');
      if (!source.name || source.name.startsWith('/') || source.name.includes('..') || name.length > 65535) throw new Error('bad archive entry name');
      const when = dosTime(source.mtime ?? new Date());
      const start = offset;
      // Sizes and CRC are known only after reading a file, so the local header
      // uses a data descriptor (bit 3) and the central directory the real values.
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0808, 6); local.writeUInt16LE(0, 8);
      local.writeUInt16LE(when.time, 10); local.writeUInt16LE(when.date, 12);
      local.writeUInt32LE(0, 14); local.writeUInt32LE(0, 18); local.writeUInt32LE(0, 22);
      local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      await write(local); await write(name);
      let crc = 0, size = 0;
      if (source.data) { crc = crc32(source.data); size = source.data.length; await write(source.data); }
      else if (source.path) {
        const file = await open(source.path, 'r');
        try {
          const chunk = Buffer.alloc(1024 * 1024);
          while (true) {
            const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            const piece = chunk.subarray(0, bytesRead);
            crc = crc32(piece, crc); size += bytesRead;
            await write(Buffer.from(piece));
          }
        } finally { await file.close(); }
      } else throw new Error('an archive entry needs data or a path');
      if (size > LIMIT || offset > LIMIT) throw new Error('the archive is larger than 4 GB, which this format cannot hold');
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0808, 8); entry.writeUInt16LE(0, 10);
      entry.writeUInt16LE(when.time, 12); entry.writeUInt16LE(when.date, 14);
      entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(size, 20); entry.writeUInt32LE(size, 24);
      entry.writeUInt16LE(name.length, 28); entry.writeUInt16LE(0, 30); entry.writeUInt16LE(0, 32); entry.writeUInt16LE(0, 34); entry.writeUInt16LE(0, 36);
      entry.writeUInt32LE(0, 38); entry.writeUInt32LE(start, 42);
      central.push(entry, name);
    }
    const directoryStart = offset;
    for (const chunk of central) await write(chunk);
    const directorySize = offset - directoryStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
    end.writeUInt16LE(sources.length, 8); end.writeUInt16LE(sources.length, 10);
    end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(directoryStart, 16); end.writeUInt16LE(0, 20);
    await write(end);
    await out.sync();
  } finally { await out.close(); }
  return { byteSize: offset, sha256: hash.digest('hex') };
}

export interface ZipEntry { name: string; size: number; compressedSize: number; method: number; offset: number; crc: number }

export class ZipReader {
  private constructor(private readonly file: FileHandle, readonly entries: ZipEntry[], readonly byteSize: number) {}

  static async open(path: string): Promise<ZipReader> {
    const file = await open(path, 'r');
    try {
      const size = (await stat(path)).size;
      const tailSize = Math.min(size, 65557);
      const tail = Buffer.alloc(tailSize);
      await file.read(tail, 0, tailSize, size - tailSize);
      let at = -1;
      for (let i = tailSize - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
      if (at < 0) throw new Error('not a zip archive');
      const count = tail.readUInt16LE(at + 10);
      const directorySize = tail.readUInt32LE(at + 12);
      const directoryStart = tail.readUInt32LE(at + 16);
      if (directoryStart + directorySize > size) throw new Error('zip directory is out of range');
      const directory = Buffer.alloc(directorySize);
      await file.read(directory, 0, directorySize, directoryStart);
      const entries: ZipEntry[] = [];
      let p = 0;
      for (let i = 0; i < count; i++) {
        if (p + 46 > directory.length || directory.readUInt32LE(p) !== 0x02014b50) throw new Error('zip directory is damaged');
        const method = directory.readUInt16LE(p + 10);
        const crc = directory.readUInt32LE(p + 16);
        const compressedSize = directory.readUInt32LE(p + 20);
        const uncompressed = directory.readUInt32LE(p + 24);
        const nameLength = directory.readUInt16LE(p + 28), extraLength = directory.readUInt16LE(p + 30), commentLength = directory.readUInt16LE(p + 32);
        const offset = directory.readUInt32LE(p + 42);
        const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
        if (method !== 0 && method !== 8) throw new Error(`unsupported zip method for ${name}`);
        entries.push({ name, size: uncompressed, compressedSize, method, offset, crc });
        p += 46 + nameLength + extraLength + commentLength;
      }
      return new ZipReader(file, entries, size);
    } catch (error) { await file.close(); throw error; }
  }

  find(name: string): ZipEntry | undefined { return this.entries.find((e) => e.name === name); }

  /** The whole entry in memory, CRC checked. */
  async read(entry: ZipEntry): Promise<Buffer> {
    const header = Buffer.alloc(30);
    await this.file.read(header, 0, 30, entry.offset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`zip entry ${entry.name} is damaged`);
    const dataStart = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (dataStart + entry.compressedSize > this.byteSize) throw new Error(`zip entry ${entry.name} is out of range`);
    const raw = Buffer.alloc(entry.compressedSize);
    await this.file.read(raw, 0, entry.compressedSize, dataStart);
    const data = entry.method === 8 ? inflateRawSync(raw) : raw;
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error(`zip entry ${entry.name} failed its checksum`);
    return data;
  }

  async close(): Promise<void> { await this.file.close(); }
}
