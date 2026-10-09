import { constants, fstatSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Read an installer-owned secret through pinned descriptors. POSIX modes do
 * not override macOS extended ACLs, so both are checked before reading bytes.
 * Shared files are root-owned, group-readable by exactly the reader's primary
 * service group. The installer must never put unrelated users in that group.
 */
export function readMacSecret(path: string): Buffer {
  if (process.platform !== 'darwin') throw new Error('macOS secret reader unavailable');
  return readProtectedMacFile(path, 0, process.getgid!());
}

/** Explicit owner/group parameters support isolated OS permission tests. Product
 * callers must use readMacSecret, which fixes the trusted owner to root.
 */
export function readProtectedMacFile(path: string, owner: number, group: number, anchor = '/'): Buffer {
  const refuse = () => new Error('Protected macOS file permissions are unsafe');
  if (process.platform !== 'darwin' || !path.startsWith('/') || /[\x00-\x1f]/.test(path)
    || !Number.isSafeInteger(owner) || owner < 0 || !Number.isSafeInteger(group) || group < 0) throw refuse();
  if (!anchor.startsWith('/') || anchor.includes('/../') || anchor.includes('/./')
    || /[\x00-\x1f]/.test(anchor) || (anchor !== '/' && anchor.endsWith('/'))
    || !path.startsWith(anchor === '/' ? '/' : anchor + '/')) throw refuse();
  const parts = path.slice(anchor === '/' ? 1 : anchor.length + 1).split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw refuse();
  const k = createRequire(import.meta.url)('koffi');
  const libc = k.load('/usr/lib/libSystem.B.dylib');
  const open = libc.func('int open(const char *, int, ...)');
  const openat = libc.func('int openat(int, const char *, int, ...)');
  const close = libc.func('int close(int)');
  const errno = libc.func('int *__error()');
  const aclGet = libc.func('void *acl_get_fd_np(int, int)');
  const aclEntry = libc.func('int acl_get_entry(void *, int, _Out_ void **)');
  const aclValid = libc.func('int acl_valid(void *)');
  const aclFree = libc.func('int acl_free(void *)');
  const noAcl = (fd: number) => {
    k.encode(errno(), 'int', 0);
    const acl = aclGet(fd, 0x100); // ACL_TYPE_EXTENDED, from the macOS SDK.
    if (!acl) {
      // The descriptor is pinned: ENOENT means no extended ACL, not a
      // disappearing pathname. Unsupported filesystems/errors stay fail-closed.
      if (k.decode(errno(), 'int') === 2) return;
      throw refuse();
    }
    try {
      // Darwin returns -1 at end of list (rather than Linux's 0).
      // A valid empty Darwin ACL returns EINVAL for its first entry.
      if (aclValid(acl) !== 0) throw refuse();
      k.encode(errno(), 'int', 0);
      const result = aclEntry(acl, 0, [null]);
      if (result !== -1 || k.decode(errno(), 'int') !== 22) throw refuse();
    } finally { aclFree(acl); }
  };
  const checkDirectory = (fd: number) => {
    const s = fstatSync(fd);
    if (!s.isDirectory() || ![0, owner].includes(s.uid) || (s.mode & 0o022)) throw refuse();
    noAcl(fd);
  };
  // Darwin O_CLOEXEC is not exposed in Node's constants on every release.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x01000000;
  let parent = -1, file = -1;
  try {
    parent = open(anchor, flags | constants.O_DIRECTORY);
    if (parent < 0) throw refuse();
    checkDirectory(parent);
    for (const part of parts.slice(0, -1)) {
      const next = openat(parent, part, flags | constants.O_DIRECTORY);
      if (next < 0) throw refuse();
      close(parent); parent = next;
      checkDirectory(parent);
    }
    file = openat(parent, parts.at(-1), flags);
    if (file < 0) throw refuse();
    const s = fstatSync(file);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== owner || (s.mode & 0o7137)
      || ((s.mode & 0o040) && s.gid !== group) || s.size < 1 || s.size > 4096) throw refuse();
    noAcl(file);
    const bytes = Buffer.alloc(4097);
    let length = 0, read;
    do { read = readSync(file, bytes, length, bytes.length - length, null); length += read; }
    while (read && length < bytes.length);
    if (length !== s.size) { bytes.fill(0); throw refuse(); }
    return bytes.subarray(0, length);
  } finally {
    if (file >= 0) close(file);
    if (parent >= 0) close(parent);
  }
}
