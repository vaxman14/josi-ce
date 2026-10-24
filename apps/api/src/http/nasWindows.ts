// SMB shares on a Windows server.
//
// Compose installations reach a NAS through the installer's restricted storage
// helper, which mounts the share into the container. A Windows server needs
// none of that: an SMB share is a network path the process can open directly,
// and credentials, where the share wants them, are handed to Windows for the
// session through the same call Explorer uses. Nothing is persisted but the
// receipt (host, share, folder, revision) — never the password — so after a
// restart the routes call `reconnect` with the credentials they hold sealed in
// the database before they touch the share.
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, rm, stat, writeFile, open } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NasController, NasMountStatus, NasSharePlan } from './nasController.js';

export class NasShareError extends Error {}

interface Mpr {
  add(resource: unknown, password: string | null, username: string | null, flags: number): number;
  cancel(name: string, flags: number, force: number): number;
}
let mpr: Mpr | undefined;
function winnet(): Mpr {
  if (process.platform !== 'win32') throw new NasShareError('SMB shares this way are a Windows server feature');
  if (!mpr) {
    const koffi = createRequire(import.meta.url)('koffi');
    const library = koffi.load('mpr.dll');
    const NETRESOURCEW = koffi.struct('NETRESOURCEW', {
      dwScope: 'uint32', dwType: 'uint32', dwDisplayType: 'uint32', dwUsage: 'uint32',
      lpLocalName: 'str16', lpRemoteName: 'str16', lpComment: 'str16', lpProvider: 'str16',
    });
    mpr = {
      add: library.func('uint32 __stdcall WNetAddConnection2W(NETRESOURCEW *resource, str16 password, str16 username, uint32 flags)'),
      cancel: library.func('uint32 __stdcall WNetCancelConnection2W(str16 name, uint32 flags, int force)'),
    };
  }
  return mpr;
}

/** What Windows said, in the words of someone standing at the NAS. */
function explain(code: number, host: string, share: string): string {
  switch (code) {
    case 0: return '';
    case 5: return `The NAS refused access to \\\\${host}\\${share} for that account.`;
    case 53: return `Josi cannot reach ${host}. Check the address and that the NAS is on.`;
    case 67: return `${host} has no share named "${share}".`;
    case 86: return 'The NAS knows that username but not that password. Check the password set for that user on the NAS itself.';
    case 1326: return 'The NAS refused the username or password.';
    case 1219: return 'Windows already has a session with this NAS under another account. Sign out of it (net use /delete) or use the same account.';
    case 1231: case 1232: return `The network path to ${host} is not available from this server.`;
    default: return `Windows could not connect to \\\\${host}\\${share} (error ${code}).`;
  }
}

export interface WindowsNasOptions {
  /** Where the receipt lives; the data folder's state directory by default. */
  stateFile?: string;
  /** Injected by tests: where the share is on disk, and how to sign in. */
  pathFor?: (host: string, share: string) => string;
  connect?: (host: string, share: string, username: string | undefined, password: string | undefined) => Promise<void>;
}

function hostOk(host: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host); }
function shareOk(share: string): boolean { return share.length > 0 && share.length <= 80 && !/[\\/:*?"<>|\x00-\x1f]/.test(share); }
function folderParts(folder: string): string[] {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..' || /[:*?"<>|\x00-\x1f]/.test(p))) throw new NasShareError('the NAS folder is invalid');
  return parts;
}

export function windowsNasController(options: WindowsNasOptions = {}): NasController {
  const stateFile = options.stateFile ?? win32.join(process.env.JOSI_DATA_DIR ?? '.', 'state', 'nas-mount.json');
  const pathFor = options.pathFor ?? ((host: string, share: string) => `\\\\${host}\\${share}`);
  const connect = options.connect ?? (async (host, share, username, password) => {
    if (!username) return; // the server's own account; Windows asks nobody
    const net = winnet();
    const resource = { dwScope: 0, dwType: 1, dwDisplayType: 0, dwUsage: 0, lpLocalName: null, lpRemoteName: pathFor(host, share), lpComment: null, lpProvider: null };
    let code = net.add(resource, password ?? null, username, 4 /* CONNECT_TEMPORARY */);
    if (code === 1219) { net.cancel(pathFor(host, share), 0, 1); code = net.add(resource, password ?? null, username, 4); }
    if (code !== 0) throw new NasShareError(explain(code, host, share));
  });
  let current: NasMountStatus | null = null;

  const check = (plan: { protocol: string; host: string; share: string }) => {
    if (plan.protocol !== 'smb') throw new NasShareError('A Windows server reaches NAS shares over SMB. Choose SMB, or share the folder over SMB on the NAS.');
    if (!hostOk(plan.host)) throw new NasShareError('enter the NAS address as a hostname or IP address');
    if (!shareOk(plan.share)) throw new NasShareError('enter the share name as it appears on the NAS, without slashes');
  };
  const readState = async (): Promise<NasMountStatus | null> => {
    if (current) return current;
    try {
      const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<NasMountStatus>;
      if (typeof parsed.mountedPath === 'string' && typeof parsed.configurationRevision === 'string') current = { mountedPath: parsed.mountedPath, configurationRevision: parsed.configurationRevision };
    } catch { current = null; }
    return current;
  };

  return {
    // `join` keeps a trailing separator on a bare share root; the path is
    // stored and compared, so it is spelled one way.
    mountPath: (plan) => win32.join(pathFor(plan.host, plan.share), ...folderParts(plan.folder)).replace(/(?<=[^\\])\\$/, ''),
    async reconnect(plan) { check(plan); await connect(plan.host, plan.share, plan.username, plan.password); },
    async browse(plan) {
      check(plan);
      await connect(plan.host, plan.share, plan.username, plan.password);
      let entries;
      try { entries = await readdir(pathFor(plan.host, plan.share), { withFileTypes: true }); }
      catch (err) { throw new NasShareError(reason(err, plan.host, plan.share)); }
      return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('$')).map((e) => e.name).sort();
    },
    async configure(plan) {
      check(plan);
      await connect(plan.host, plan.share, plan.username, plan.password);
      const path = win32.join(pathFor(plan.host, plan.share), ...folderParts(plan.folder));
      try {
        const info = await stat(path);
        if (!info.isDirectory()) throw new NasShareError('that is a file on the share, not a folder');
        const probe = win32.join(path, `.josi-write-test-${randomUUID()}`);
        const file = await open(probe, 'wx');
        await file.close();
        await rm(probe);
      } catch (err) {
        if (err instanceof NasShareError) throw err;
        throw new NasShareError(reason(err, plan.host, plan.share));
      }
      current = { mountedPath: path, configurationRevision: plan.configurationRevision ?? randomUUID() };
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify({ ...current, host: plan.host, share: plan.share, folder: folderParts(plan.folder).join('/') }), { mode: 0o600 });
      return current;
    },
    status: () => readState(),
    async remove() {
      const was = await readState();
      current = null;
      await rm(stateFile, { force: true });
      if (was && process.platform === 'win32' && !options.connect) {
        try { winnet().cancel(was.mountedPath.split('\\').slice(0, 4).join('\\'), 0, 1); } catch { /* nothing to let go of */ }
      }
    },
  };
}

function reason(err: unknown, host: string, share: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  // Windows answers a share that is not there with a code Node has no name for.
  if (code === 'ENOENT' || code === 'ENOTFOUND' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'UNKNOWN') return `Josi cannot open \\\\${host}\\${share}. Check the address, the share name, and that the NAS is on.`;
  if (code === 'EACCES' || code === 'EPERM') return `The NAS refused access to \\\\${host}\\${share}. Check the username and password, and that the account may write there.`;
  if (code === 'ETIMEDOUT') return `${host} did not answer in time.`;
  return `Josi could not use \\\\${host}\\${share}` + (code ? ` (${code}).` : '.');
}
