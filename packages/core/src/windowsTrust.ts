import { createRequire } from 'node:module';
import { win32 } from 'node:path';

/** Windows counterpart of "regular file not writable by other accounts" for an
 * executable that will receive a projected credential. The file and every
 * ancestor folder must be owned and changeable only by SYSTEM, Administrators,
 * TrustedInstaller or the current (non-service) user. ACL inheritance means a
 * permissive parent — for example a folder under C:\ that Authenticated Users
 * may modify — would let another account replace the binary, so ancestors are
 * checked for rights that delete, rename, re-ACL or replace their entries. */
export function windowsPathTrusted(path: string): boolean {
  if (process.platform !== 'win32' || !win32.isAbsolute(path) || win32.normalize(path) !== path) return false;
  const k = createRequire(import.meta.url)('koffi');
  const kernel = k.load('kernel32.dll'), security = k.load('advapi32.dll');
  const getNamed = security.func('uint32 __stdcall GetNamedSecurityInfoW(str16, uint32, uint32, _Out_ void **, void *, _Out_ void **, void *, _Out_ void **)');
  const getAce = security.func('int __stdcall GetAce(void *, uint32, _Out_ void **)');
  const sidText = security.func('int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)');
  const tokenOpen = security.func('int __stdcall OpenProcessToken(intptr_t, uint32, _Out_ intptr_t *)');
  const tokenInfo = security.func('int __stdcall GetTokenInformation(intptr_t, uint32, _Out_ void *, uint32, _Out_ uint32 *)');
  const processHandle = kernel.func('intptr_t __stdcall GetCurrentProcess()');
  const close = kernel.func('int __stdcall CloseHandle(intptr_t)');
  const free = kernel.func('void * __stdcall LocalFree(void *)');
  const text = (sid: unknown): string => {
    const value: unknown[] = [null];
    if (!sid || !sidText(sid, value)) throw new Error();
    try { return k.decode.string16(value[0]); } finally { free(value[0]); }
  };
  const trusted = new Set(['S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464']);
  const token: Array<number | bigint> = [0];
  let tokenData: unknown;
  try {
    if (!tokenOpen(processHandle(), 8, token)) return false;
    const length = [0];
    tokenInfo(token[0], 1, null, 0, length);
    if (!length[0] || length[0] > 16384) return false;
    tokenData = k.alloc('uint8', length[0]);
    if (!tokenInfo(token[0], 1, tokenData, length[0], length)) return false;
    const identity = text(k.decode(tokenData, 'void *'));
    // A service identity never owns the binaries it runs.
    if (!identity.startsWith('S-1-5-80-')) trusted.add(identity);
    // File: data, append, attributes, extended attributes, delete, DACL, owner, generic.
    const fileWrite = 0x2 | 0x4 | 0x10 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
    // Folder: delete-child, delete, DACL, owner, generic. Adding a new entry
    // cannot replace an existing name, so create-file/create-folder is allowed.
    const folderWrite = 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
    let current = path, first = true;
    for (;;) {
      if (!checked(current, first ? fileWrite : folderWrite)) return false;
      const parent = win32.dirname(current);
      if (parent === current) return true;
      current = parent; first = false;
    }
  } catch { return false; }
  finally {
    if (token[0]) close(token[0]);
    if (tokenData) k.free(tokenData);
  }

  function checked(target: string, writeMask: number): boolean {
    const owner: unknown[] = [null], dacl: unknown[] = [null], descriptor: unknown[] = [null];
    try {
      // SE_FILE_OBJECT, OWNER | DACL.
      if (getNamed(target, 1, 1 | 4, owner, null, dacl, null, descriptor) !== 0 || !dacl[0]) return false;
      if (!trusted.has(text(owner[0]))) return false;
      const acl = Buffer.from(k.decode(dacl[0], 'uint8', 8));
      const count = acl.readUInt16LE(4);
      if (count > 256) return false;
      for (let index = 0; index < count; index++) {
        const ace: unknown[] = [null];
        if (!getAce(dacl[0], index, ace)) return false;
        const header = Buffer.from(k.decode(ace[0], 'uint8', 8));
        if (header[0] === 1 || (header[1] & 8)) continue; // deny or inherit-only
        if (header[0] !== 0) return false; // only ordinary allow ACEs are interpreted
        if ((header.readUInt32LE(4) & writeMask) === 0) continue;
        const sid = text(k.as(k.address(ace[0]) + 8n, 'void *'));
        if (!trusted.has(sid)) return false;
      }
      return true;
    } finally { if (descriptor[0]) free(descriptor[0]); }
  }
}
