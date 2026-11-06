// Where a server keeps its private keys: the operating system's own credential
// store when there is one. A file is the last resort, for a headless box or a
// container that has no store, and the status page says when it's in use.
//
// Secrets never go on a command line, where any local user could read them from
// the process list: `security` takes them on stdin through its interactive mode,
// `secret-tool` reads them from stdin, and Windows gets a direct API call.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SERVICE = 'josi-ce';

export type KeyStoreKind = 'macos-keychain' | 'windows-credential-manager' | 'linux-secret-service' | 'file';

export interface KeyStore {
  kind: KeyStoreKind;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

function piped(command: string, args: string[], input: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout }));
    child.stdin.end(input);
  });
}

const SAFE_NAME = /^[a-z0-9-]{1,64}$/;
const SAFE_VALUE = /^[A-Za-z0-9_.:{}",\[\]-]*$/;
function checkName(name: string): void { if (!SAFE_NAME.test(name)) throw new Error('Bad key name'); }
/** Stored values are base64url or JSON of it. Anything else is base64url-wrapped,
 * so nothing can break out of `security`'s command line. */
const pack = (value: string) => `b64.${Buffer.from(value).toString('base64url')}`;
const unpack = (value: string) => value.startsWith('b64.') ? Buffer.from(value.slice(4), 'base64url').toString() : value;

function macKeychain(keychain?: string): KeyStore {
  const target = keychain ? ` "${keychain}"` : '';
  return {
    kind: 'macos-keychain',
    async get(name) {
      checkName(name);
      try {
        const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-a', name, '-s', SERVICE, '-w', ...(keychain ? [keychain] : [])]);
        return unpack(stdout.trim());
      } catch { return null; }
    },
    async set(name, value) {
      checkName(name);
      const packed = pack(value);
      if (!SAFE_VALUE.test(packed)) throw new Error('Bad key value');
      const { code } = await piped('/usr/bin/security', ['-i'], `add-generic-password -U -a ${name} -s ${SERVICE} -w ${packed}${target}\n`);
      if (code !== 0) throw new Error('Keychain write failed');
      if (await this.get(name) !== value) throw new Error('Keychain write failed');
    },
    async delete(name) {
      checkName(name);
      await run('/usr/bin/security', ['delete-generic-password', '-a', name, '-s', SERVICE, ...(keychain ? [keychain] : [])]).catch(() => undefined);
    },
  };
}

function linuxSecretService(): KeyStore {
  const attributes = (name: string) => ['service', SERVICE, 'account', name];
  return {
    kind: 'linux-secret-service',
    async get(name) {
      checkName(name);
      try { const { stdout } = await run('secret-tool', ['lookup', ...attributes(name)]); return stdout ? unpack(stdout.trim()) : null; } catch { return null; }
    },
    async set(name, value) {
      checkName(name);
      const { code } = await piped('secret-tool', ['store', `--label=Josi CE ${name}`, ...attributes(name)], pack(value));
      if (code !== 0) throw new Error('Secret Service write failed');
    },
    async delete(name) { checkName(name); await run('secret-tool', ['clear', ...attributes(name)]).catch(() => undefined); },
  };
}

function windowsCredentialManager(): KeyStore {
  const k = createRequire(import.meta.url)('koffi');
  const advapi = k.load('advapi32.dll');
  const CREDENTIAL = k.struct('CREDENTIALW', {
    Flags: 'uint32', Type: 'uint32', TargetName: 'str16', Comment: 'str16', LastWritten: 'uint64', CredentialBlobSize: 'uint32',
    CredentialBlob: 'void *', Persist: 'uint32', AttributeCount: 'uint32', Attributes: 'void *', TargetAlias: 'str16', UserName: 'str16',
  });
  const CredWriteW = advapi.func('bool __stdcall CredWriteW(CREDENTIALW *credential, uint32 flags)');
  const CredReadW = advapi.func('bool __stdcall CredReadW(str16 target, uint32 type, uint32 flags, _Out_ void **credential)');
  const CredDeleteW = advapi.func('bool __stdcall CredDeleteW(str16 target, uint32 type, uint32 flags)');
  const CredFree = advapi.func('void __stdcall CredFree(void *buffer)');
  const GENERIC = 1, LOCAL_MACHINE = 2;
  const target = (name: string) => `${SERVICE}/${name}`;
  return {
    kind: 'windows-credential-manager',
    async get(name) {
      checkName(name);
      const out: unknown[] = [null];
      if (!CredReadW(target(name), GENERIC, 0, out)) return null;
      try {
        const credential = k.decode(out[0], CREDENTIAL) as { CredentialBlobSize: number; CredentialBlob: unknown };
        const blob = k.decode(credential.CredentialBlob, k.array('uint8', credential.CredentialBlobSize, 'Typed')) as Uint8Array;
        return unpack(Buffer.from(blob).toString());
      } finally { CredFree(out[0]); }
    },
    async set(name, value) {
      checkName(name);
      const blob = Buffer.from(pack(value));
      const ok = CredWriteW({ Flags: 0, Type: GENERIC, TargetName: target(name), Comment: null, LastWritten: 0, CredentialBlobSize: blob.length,
        CredentialBlob: blob, Persist: LOCAL_MACHINE, AttributeCount: 0, Attributes: null, TargetAlias: null, UserName: SERVICE }, 0);
      if (!ok) throw new Error('Credential Manager write failed');
    },
    async delete(name) { checkName(name); CredDeleteW(target(name), GENERIC, 0); },
  };
}

/** The headless fallback: a directory only this user can enter, one 0600 file per key. */
export function fileKeyStore(dir: string): KeyStore {
  const path = (name: string) => { checkName(name); return join(dir, `${name}.key`); };
  return {
    kind: 'file',
    async get(name) {
      try {
        const file = path(name);
        if (process.platform !== 'win32' && (await stat(file)).mode & 0o077) throw new Error('This key file can be read by other users. Fix its permissions (0600).');
        return unpack((await readFile(file, 'utf8')).trim());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async set(name, value) {
      const file = path(name), temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temp, pack(value), { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, file);
    },
    async delete(name) { await rm(path(name), { force: true }); },
  };
}

async function works(store: KeyStore): Promise<boolean> {
  const name = `probe-${randomBytes(4).toString('hex')}`;
  try {
    await store.set(name, 'probe');
    const ok = await store.get(name) === 'probe';
    await store.delete(name);
    return ok;
  } catch { return false; }
}

/** The best store this machine really has. A store that exists but refuses to
 * work (a service account with no login keychain, a box with no D-Bus session)
 * counts as absent, which is why it's tried rather than assumed. */
export async function openKeyStore(opts: { fallbackDir: string; platform?: NodeJS.Platform; prefer?: string }): Promise<KeyStore> {
  const platform = opts.platform ?? process.platform;
  if ((opts.prefer ?? process.env.JOSI_KEY_STORE) === 'file') return fileKeyStore(opts.fallbackDir);
  let store: KeyStore | null = null;
  try {
    if (platform === 'darwin') store = macKeychain();
    else if (platform === 'win32') store = windowsCredentialManager();
    else if (platform === 'linux' && process.env.DBUS_SESSION_BUS_ADDRESS) store = linuxSecretService();
  } catch { store = null; }
  if (store && await works(store)) return store;
  return fileKeyStore(opts.fallbackDir);
}

export const macKeychainForTests = macKeychain;
