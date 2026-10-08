import { createRequire } from 'node:module';
import { win32 } from 'node:path';

/** Read a small native secret through the same handle whose DACL was checked.
 * A permissive inherited DACL, link, extra hard link, unknown ACE, or unexpected
 * owner fails closed before secret bytes enter JavaScript. No shell is used.
 */
export function readWindowsSecret(path: string, purpose: 'application' | 'voice-control' | 'database-bootstrap' = 'application'): Buffer {
  const refuse = () => new Error('Native secret storage is not private; repair the installation.');
  if (process.platform !== 'win32' || !/^[A-Za-z]:[\\/]/.test(path)
    || win32.normalize(path) !== path || path.slice(3).split('\\').some(part =>
      !part || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw refuse();
  const k = createRequire(import.meta.url)('koffi');
  const kernel = k.load('kernel32.dll'), security = k.load('advapi32.dll');
  const create = kernel.func('intptr_t __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, intptr_t)');
  const close = kernel.func('int __stdcall CloseHandle(intptr_t)');
  const free = kernel.func('void * __stdcall LocalFree(void *)');
  const info = kernel.func('int __stdcall GetFileInformationByHandle(intptr_t, _Out_ void *)');
  const read = kernel.func('int __stdcall ReadFile(intptr_t, _Out_ void *, uint32, _Out_ uint32 *, void *)');
  const processHandle = kernel.func('intptr_t __stdcall GetCurrentProcess()');
  const tokenOpen = security.func('int __stdcall OpenProcessToken(intptr_t, uint32, _Out_ intptr_t *)');
  const tokenInfo = security.func('int __stdcall GetTokenInformation(intptr_t, uint32, _Out_ void *, uint32, _Out_ uint32 *)');
  const sidText = security.func('int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)');
  const lookup = security.func('int __stdcall LookupAccountNameW(str16, str16, _Out_ void *, _Inout_ uint32 *, _Out_ void *, _Inout_ uint32 *, _Out_ uint32 *)');
  const getSecurity = security.func('uint32 __stdcall GetSecurityInfo(intptr_t, uint32, uint32, _Out_ void **, void *, _Out_ void **, void *, _Out_ void **)');
  const getAce = security.func('int __stdcall GetAce(void *, uint32, _Out_ void **)');
  const token: Array<number | bigint> = [0];
  const descriptor: unknown[] = [null], owner: unknown[] = [null], dacl: unknown[] = [null];
  let tokenData: unknown;
  let handle: number | bigint = -1;
  function text(sid: unknown): string {
    const value: unknown[] = [null];
    if (!sid || !sidText(sid, value)) throw refuse();
    try { return k.decode.string16(value[0]); } finally { free(value[0]); }
  }
  try {
    if (!tokenOpen(processHandle(), 8, token)) throw refuse();
    const length = [0];
    tokenInfo(token[0], 1, null, 0, length);
    if (!length[0] || length[0] > 16384) throw refuse();
    tokenData = k.alloc('uint8', length[0]);
    if (!tokenInfo(token[0], 1, tokenData, length[0], length)) throw refuse();
    const identity = text(k.decode(tokenData, 'void *'));
    const administrators = new Set(['S-1-5-18', 'S-1-5-32-544']);
    const readers = new Set([identity]);
    const services = purpose === 'database-bootstrap' ? ['JosiDatabase']
      : purpose === 'voice-control' ? ['JosiWeb', 'JosiVoiceControl'] : ['JosiWeb', 'JosiWorker'];
    for (const service of services) {
      const sidLength = [0], domainLength = [0], use = [0];
      lookup(null, `NT SERVICE\\${service}`, null, sidLength, null, domainLength, use);
      if (!sidLength[0] || sidLength[0] > 1024 || domainLength[0] > 1024) continue;
      const sid = k.alloc('uint8', sidLength[0]);
      try {
        if (lookup(null, `NT SERVICE\\${service}`, sid, sidLength,
          Buffer.alloc(domainLength[0] * 2), domainLength, use)) readers.add(text(sid));
      } finally { k.free(sid); }
    }
    // Test/development identity may own its own private fixture. A service never
    // owns production key files: owner rights could otherwise rewrite the DACL.
    if (!identity.startsWith('S-1-5-80-')) administrators.add(identity);
    handle = create(path, 0x80020000, 1, null, 3, 0x00200000, 0);
    if (handle === -1 || handle === -1n) throw refuse();
    const details = Buffer.alloc(52);
    if (!info(handle, details) || (details.readUInt32LE(0) & (0x10 | 0x400))
      || details.readUInt32LE(40) !== 1 || details.readUInt32LE(32) !== 0
      || details.readUInt32LE(36) === 0 || details.readUInt32LE(36) > 4096) throw refuse();
    if (getSecurity(handle, 1, 1 | 4, owner, null, dacl, null, descriptor) !== 0
      || !dacl[0] || !administrators.has(text(owner[0]))) throw refuse();
    const acl = Buffer.from(k.decode(dacl[0], 'uint8', 8));
    const count = acl.readUInt16LE(4);
    if (!count || count > 64) throw refuse();
    for (let index = 0; index < count; index++) {
      const ace: unknown[] = [null];
      if (!getAce(dacl[0], index, ace)) throw refuse();
      const header = Buffer.from(k.decode(ace[0], 'uint8', 8));
      // Only ordinary allow/deny ACEs; callback/conditional/object ACEs are not
      // part of the installer's closed secret policy and are not interpreted.
      if (header[0] !== 0 && header[0] !== 1) throw refuse();
      if (header[0] === 1 || (header[1] & 8)) continue; // deny or inherit-only
      if (header.readUInt16LE(2) < 16) throw refuse();
      const sid = text(k.as(k.address(ace[0]) + 8n, 'void *'));
      if (administrators.has(sid)) continue;
      // Service identities may read, query and synchronize; no write/delete or
      // security-descriptor authority is permitted on secret files.
      if (!readers.has(sid) || (header.readUInt32LE(4) & ~0x00120089) !== 0) throw refuse();
    }
    const size = details.readUInt32LE(36), bytes = Buffer.alloc(size), received = [0];
    if (!read(handle, bytes, size, received, null) || received[0] !== size) throw refuse();
    return bytes;
  } catch {
    throw refuse();
  } finally {
    if (descriptor[0]) free(descriptor[0]);
    if (handle !== -1 && handle !== -1n) close(handle);
    if (token[0]) close(token[0]);
    if (tokenData) k.free(tokenData);
  }
}
