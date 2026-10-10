import { constants, fstatSync, readFileSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Read a root-owned native Linux secret through pinned descriptors.
 *
 * Every parent is opened with O_NOFOLLOW. The leaf must be a single-link,
 * root-owned regular file readable only by root and, optionally, the calling
 * service's primary group. POSIX ACLs must be equivalent to the mode bits, so
 * an unexpected named-user or named-group grant fails closed.
 */
export function readLinuxSecret(path: string): Buffer {
  if (process.platform !== 'linux' || process.env.JOSI_NATIVE_RUNTIME !== '1') {
    throw new Error('Native Linux secret reader unavailable');
  }
  const root = process.env.JOSI_NATIVE_ISOLATED_ROOT;
  if (root) {
    const marker = JSON.parse(readFileSync(`${root}/isolated-test.json`, 'utf8'));
    if (process.getuid!() === 0 || !root.startsWith('/home/roman/JosiDrive/') || marker.purpose !== 'disposable-native-acceptance') {
      throw new Error('Invalid isolated Linux acceptance root');
    }
    return readProtectedLinuxFile(path, process.getuid!(), process.getgid!(), root);
  }
  return readProtectedLinuxFile(path, 0, process.getgid!());
}

export function readProtectedLinuxFile(path: string, owner: number, group: number, anchor = '/'): Buffer {
  const refuse = () => new Error('Protected Linux file permissions are unsafe');
  if (process.platform !== 'linux' || !path.startsWith('/') || /[\x00-\x1f]/.test(path)
    || !Number.isSafeInteger(owner) || owner < 0 || !Number.isSafeInteger(group) || group < 0
    || !anchor.startsWith('/') || anchor.includes('/../') || anchor.includes('/./')
    || (anchor !== '/' && anchor.endsWith('/'))
    || !path.startsWith(anchor === '/' ? '/' : `${anchor}/`)) throw refuse();
  const parts = path.slice(anchor === '/' ? 1 : anchor.length + 1).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw refuse();

  const k = createRequire(import.meta.url)('koffi');
  const libc = k.load('libc.so.6');
  const libacl = k.load('libacl.so.1');
  const open = libc.func('int open(const char *, int, ...)');
  const openat = libc.func('int openat(int, const char *, int, ...)');
  const close = libc.func('int close(int)');
  const aclGetFd = libacl.func('void *acl_get_fd(int)');
  const aclEquivalent = libacl.func('int acl_equiv_mode(void *, _Out_ int *)');
  const aclFree = libacl.func('int acl_free(void *)');
  const noExtendedAcl = (fd: number) => {
    const acl = aclGetFd(fd);
    if (!acl) throw refuse();
    try {
      const mode = [0];
      // 0 means the ACL contains only the three base entries represented by
      // ordinary mode bits. 1 means a named ACL grant exists.
      if (aclEquivalent(acl, mode) !== 0) throw refuse();
    } finally { aclFree(acl); }
  };
  const directory = (fd: number) => {
    const s = fstatSync(fd);
    if (!s.isDirectory() || ![0, owner].includes(s.uid) || (s.mode & 0o022)) throw refuse();
    noExtendedAcl(fd);
  };
  // Linux O_CLOEXEC is stable but absent from some Node type definitions.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x80000;
  let parent = -1;
  let file = -1;
  try {
    parent = open(anchor, flags | constants.O_DIRECTORY);
    if (parent < 0) throw refuse();
    directory(parent);
    for (const part of parts.slice(0, -1)) {
      const next = openat(parent, part, flags | constants.O_DIRECTORY);
      if (next < 0) throw refuse();
      close(parent);
      parent = next;
      directory(parent);
    }
    file = openat(parent, parts.at(-1), flags);
    if (file < 0) throw refuse();
    const s = fstatSync(file);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== owner || (s.mode & 0o7137)
      || ((s.mode & 0o040) && s.gid !== group) || s.size < 1 || s.size > 4096) throw refuse();
    noExtendedAcl(file);
    const bytes = Buffer.alloc(4097);
    let length = 0;
    let received = 0;
    do {
      received = readSync(file, bytes, length, bytes.length - length, null);
      length += received;
    } while (received && length < bytes.length);
    if (length !== s.size) { bytes.fill(0); throw refuse(); }
    return bytes.subarray(0, length);
  } finally {
    if (file >= 0) close(file);
    if (parent >= 0) close(parent);
  }
}
