import { macOpen } from './macosDirectory.js';
// Win32 file handles replace /proc/self/fd containment on Windows. A read
// handle with no FILE_SHARE_DELETE prevents rename/replacement, while
// FILE_FLAG_OPEN_REPARSE_POINT makes junctions/symlinks inspectable, not followed.
import { constants } from 'node:fs';
import { open as nodeOpen, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { win32 } from 'node:path';

type Handle = number | bigint;
interface Kernel {
  move(source: string, destination: string, flags: number): number;
  create(path: string, access: number, share: number, security: null, disposition: number, flags: number, template: number): Handle;
  close(handle: Handle): number;
  info(handle: Handle, buffer: Buffer): number;
  error(): number;
}
let kernel: Kernel | undefined;
function api(): Kernel {
  if (process.platform !== 'win32') throw new Error('Windows file API required');
  if (!kernel) {
    // Optional dependency: Linux and macOS never load or require its native code.
    const koffi = createRequire(import.meta.url)('koffi');
    const library = koffi.load('kernel32.dll');
    kernel = {
      move: library.func('int __stdcall MoveFileExW(str16, str16, uint32)'),
      create: library.func('intptr_t __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, intptr_t)'),
      close: library.func('int __stdcall CloseHandle(intptr_t)'),
      info: library.func('int __stdcall GetFileInformationByHandle(intptr_t, _Out_ void *)'),
      error: library.func('uint32 __stdcall GetLastError()'),
    };
  }
  return kernel;
}

/** Same-volume, non-replacing publication after the caller has flushed bytes. */
export function publishWindowsFile(source: string, destination: string): void {
  if (!api().move(nativePath(source), nativePath(destination), 8)) throw failure('EIO');
}

function nativePath(path: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(path) || path.includes('\0') || path.length > 32000) throw failure();
  // Per-call extended local-drive syntax avoids a machine-wide long-path policy
  // change. Callers still validate every component and refuse reparse points.
  return '\\\\?\\' + win32.resolve(path);
}
function failure(code = 'EPERM'): NodeJS.ErrnoException {
  return Object.assign(new Error('Native storage access refused'), { code });
}

function pin(path: string, directory: boolean): () => void {
  const windows = api();
  // Attribute-only access DOES NOT deny replacement on Windows. GENERIC_READ
  // is deliberate and verified by the native directory-swap regression test.
  const handle = windows.create(nativePath(path), 0x80000000, 3, null, 3, 0x02200000, 0);
  if (handle === -1 || handle === -1n) {
    const error = windows.error();
    throw failure(error === 2 || error === 3 ? 'ENOENT' : 'EACCES');
  }
  let held = true;
  const release = () => { if (held) { held = false; windows.close(handle); } };
  try {
    // BY_HANDLE_FILE_INFORMATION, DWORD fields, 52 bytes on both Windows ABIs.
    const info = Buffer.alloc(52);
    if (!windows.info(handle, info)) throw failure();
    const attributes = info.readUInt32LE(0);
    if ((attributes & 0x400) || !!(attributes & 0x10) !== directory) throw failure('EUNSAFE');
    if (!directory && info.readUInt32LE(40) !== 1) throw failure('EUNSAFE');
    return release;
  } catch (error) { release(); throw error; }
}

/** Pin every component, including ancestors of the configured root, before
 * traversing the next. No check-then-open gap permits a junction substitution.
 * Local drive paths only; UNC/device namespaces need a separate reviewed policy.
 */
export function pinWindowsDirectory(path: string): { path: string; close(): Promise<void> } {
  if (!/^[A-Za-z]:[\\/]/.test(path) || path.includes('\0') || path.length > 32000) throw failure();
  const normalized = win32.resolve(path);
  const parts = normalized.slice(3).split('\\').filter(Boolean);
  if (parts.some((part) => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) throw failure('EUNSAFE');
  const releases: Array<() => void> = [];
  try {
    let current = normalized.slice(0, 3);
    releases.push(pin(current, true));
    for (const part of parts) {
      current = win32.join(current, part);
      releases.push(pin(current, true));
    }
    return { path: normalized, async close() { for (const release of releases.reverse()) release(); } };
  } catch (error) { for (const release of releases.reverse()) release(); throw error; }
}

/** Caller keeps the parent directory pinned for this handle's whole lifetime.
 * Exclusive creation cannot follow an existing reparse point. Existing leaves
 * are pinned and checked before Node opens them, and remain pinned until close.
 */
export async function openStorageFile(path: string, flags: number, mode?: number): Promise<FileHandle> {
  if (process.platform === 'darwin') return macOpen(path, flags, mode);
  if (process.platform !== 'win32' || ((flags & constants.O_CREAT) && (flags & constants.O_EXCL))) {
    return nodeOpen(path, flags, mode);
  }
  const release = pin(path, false);
  try {
    const file = await nodeOpen(path, flags, mode);
    const close = file.close.bind(file);
    file.close = async () => { try { await close(); } finally { release(); } };
    return file;
  } catch (error) { release(); throw error; }
}
