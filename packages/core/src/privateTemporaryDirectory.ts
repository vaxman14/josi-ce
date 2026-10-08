import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/** Equivalent to a POSIX 0700 temporary directory. The Windows DACL is supplied
 * at creation, before private context or document bytes can inherit permissions.
 * No PowerShell process, shell interpolation, or plaintext secret is involved.
 */
export function privateTemporaryDirectory(prefix: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(prefix)) throw new Error('Invalid private directory prefix');
  if (process.platform !== 'win32') return mkdtempSync(join(tmpdir(), prefix));
  const k = createRequire(import.meta.url)('koffi');
  const kernel = k.load('kernel32.dll');
  const security = k.load('advapi32.dll');
  const processHandle = kernel.func('intptr_t __stdcall GetCurrentProcess()');
  const close = kernel.func('int __stdcall CloseHandle(intptr_t)');
  const free = kernel.func('void * __stdcall LocalFree(void *)');
  const tokenOpen = security.func('int __stdcall OpenProcessToken(intptr_t, uint32, _Out_ intptr_t *)');
  const tokenInfo = security.func('int __stdcall GetTokenInformation(intptr_t, uint32, _Out_ void *, uint32, _Out_ uint32 *)');
  const sidText = security.func('int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)');
  const descriptor = security.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32, _Out_ void **, void *)');
  const create = kernel.func('int __stdcall CreateDirectoryW(str16, void *)');
  const lastError = kernel.func('uint32 __stdcall GetLastError()');
  const token: Array<number | bigint> = [0];
  const sidString: unknown[] = [null];
  const sd: unknown[] = [null];
  let tokenData: unknown;
  const refuse = () => new Error('Could not establish private Windows storage');
  try {
    if (!tokenOpen(processHandle(), 8, token)) throw refuse();
    const required = [0];
    tokenInfo(token[0], 1, null, 0, required);
    if (!required[0] || required[0] > 16384) throw refuse();
    // TOKEN_USER contains a pointer back into this same allocation. A marshaled
    // JavaScript Buffer may be copied by the FFI; its embedded pointer would
    // become dangling. Native allocation keeps the SID valid through conversion.
    tokenData = k.alloc('uint8', required[0]);
    if (!tokenInfo(token[0], 1, tokenData, required[0], required)) throw refuse();
    const sid = k.decode(tokenData, 'void *');
    if (!sidText(sid, sidString)) throw refuse();
    const identity: string = k.decode.string16(sidString[0]);
    if (!/^S-1-\d+(?:-\d+)+$/.test(identity)) throw refuse();
    // Current service SID (or the development user), SYSTEM, Administrators.
    // Protection stops permissive inherited entries; children inherit this DACL.
    const sddl = `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${identity})`;
    if (!descriptor(sddl, 1, sd, null)) throw refuse();
    const attributes = Buffer.alloc(process.arch === 'x64' || process.arch === 'arm64' ? 24 : 12);
    attributes.writeUInt32LE(attributes.length, 0);
    k.encode(attributes, attributes.length === 24 ? 8 : 4, 'void *', sd[0]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const path = join(tmpdir(), prefix + randomBytes(12).toString('hex'));
      if (create(path, attributes)) return path;
      if (lastError() !== 183) throw refuse();
    }
    throw refuse();
  } finally {
    if (sd[0]) free(sd[0]);
    if (sidString[0]) free(sidString[0]);
    if (token[0]) close(token[0]);
    if (tokenData) k.free(tokenData);
  }
}
