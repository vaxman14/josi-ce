import { spawn, execFile } from 'node:child_process';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { deviceConsentMessage, parseDeviceConsentChallenge, type DeviceConsentChallenge } from '@josi-ce/protocol';

const execute = promisify(execFile);
const helper = '/Applications/Josi.app/Contents/Helpers/JosiDeviceConsentHost';
const directory = '/Library/Application Support/Josi CE Server/control';
/** Item 29, Windows: the consent helper is the Josi app itself, started by the
 * server in its "--device-consent" mode on the computer that runs the server.
 * It shows the exact enrollment on that screen, asks Windows Hello, and
 * answers over the same framed pipe as the Mac helper (no socket). The path
 * comes from the server's own environment, never from a request. */
export function windowsConsentHelper(): { command: string; args: string[] } | null {
  if (process.platform !== 'win32') return null;
  const command = process.env.JOSI_DEVICE_CONSENT_HELPER ?? '';
  if (!/^[A-Za-z]:\\/.test(command) || !/\.exe$/i.test(command) || command.length > 1024) return null;
  let args = ['--device-consent'];
  // Development and tests only: node.exe with a script that plays the helper.
  if (process.env.JOSI_DEVICE_CONSENT_HELPER_ARGS) {
    try { const parsed: unknown = JSON.parse(process.env.JOSI_DEVICE_CONSENT_HELPER_ARGS); if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) args = parsed; } catch { /* default */ }
  }
  return { command, args };
}
export async function windowsConsentAvailable(): Promise<boolean> {
  const found = windowsConsentHelper();
  // A service has no screen to show the request on; only an interactive
  // session (SESSIONNAME is set by Windows for those) can host the window.
  if (!found || !process.env.SESSIONNAME) return false;
  try { const file = await lstat(found.command); return file.isFile() && !file.isSymbolicLink() && await realpath(found.command) === found.command; }
  catch { return false; }
}
const requirement = '=anchor apple generic and identifier "com.heyjosi.ce.device-consent" and certificate leaf[subject.OU] = "LRH75YR6QW"';
const refused = () => new Error('Local device-owner consent is unavailable or expired.');
export interface NativeDeviceConsent {
  readonly challengeDigest: string;
  status(): 'waiting' | 'approved' | 'cancelled' | 'expired';
  /** Server-only capability. No HTTP result or software-supplied signature
   * can construct it. Consume inside the final enrollment transaction. */
  consume(challenge: DeviceConsentChallenge): void;
  close(): void;
}
export async function startNativeDeviceConsent(value: DeviceConsentChallenge, signal: AbortSignal): Promise<NativeDeviceConsent> {
  const challenge = parseDeviceConsentChallenge(value);
  const windows = windowsConsentHelper();
  if (!(process.platform === 'darwin' || windows) || !challenge || signal.aborted || challenge.issuedAtMs > Date.now()
    || challenge.expiresAtMs <= Date.now()) throw refused();
  const message = Buffer.from(deviceConsentMessage(challenge));
  const digest = createHash('sha256').update(message).digest('hex');
  let owner: number | undefined;
  if (windows) {
    if (!await windowsConsentAvailable()) throw refused();
  } else {
    const file = await lstat(helper), folder = await lstat(directory); owner = process.getuid?.();
    if (!owner || !file.isFile() || file.isSymbolicLink() || file.uid !== 0 || file.mode & 0o022
      || !folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== owner || folder.mode & 0o022
      || await realpath(helper) !== helper || await realpath(directory) !== directory) throw refused();
    await execute('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement, helper], {
      timeout: 10_000, maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin' }, signal,
    });
  }
  if (signal.aborted || challenge.expiresAtMs <= Date.now()) throw refused();
  // On Windows the helper is a window on the server's desktop: it needs the
  // system folders and the signed-in user's profile, nothing from Josi's own
  // environment (no database address, key file or token paths).
  const child = windows
    ? spawn(windows.command, windows.args, { shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false,
      env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', WINDIR: process.env.SystemRoot ?? 'C:\\Windows', PATH: (process.env.SystemRoot ?? 'C:\\Windows') + '\\System32',
        USERPROFILE: process.env.USERPROFILE ?? '', LOCALAPPDATA: process.env.LOCALAPPDATA ?? '', APPDATA: process.env.APPDATA ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' } })
    : spawn(helper, [], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
  const socket = `${directory}/${challenge.id}.sock`;
  let state: 'starting' | 'waiting' | 'approved' | 'cancelled' | 'expired' = 'starting';
  let previousWall = Date.now(), previousMono = performance.now();
  const deadline = previousMono + challenge.expiresAtMs - previousWall;
  let consumed = false, stopped = false, inode: number | null = null, buffer = Buffer.alloc(0), frames = 0;
  let readyResolve: () => void = () => {}, readyReject: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => { state = 'expired'; close(); }, challenge.expiresAtMs - Date.now()); timer.unref();
  const readyTimer = setTimeout(() => close(), Math.min(10_000, challenge.expiresAtMs - Date.now())); readyTimer.unref();
  async function cleanupSocket() {
    if (inode === null || windows) return;
    try {
      const info = await lstat(socket);
      if (info.isSocket() && info.ino === inode && info.uid === owner) await unlink(socket);
    } catch { /* Helper may already have removed its own socket. */ }
  }
  function close() {
    if (stopped) return;
    stopped = true;
    if (state !== 'expired') state = 'cancelled';
    clearTimeout(timer); clearTimeout(readyTimer);
    signal.removeEventListener('abort', close);
    readyReject(refused());
    child.stdin.destroy(); child.stdout.destroy(); child.kill('SIGKILL');
    buffer.fill(0); buffer = Buffer.alloc(0);
    // A random per-attempt path is never reused. Remove only the inode observed
    // after this exact helper's ready frame, and only after its process exits.
    if (child.exitCode !== null || child.signalCode !== null) void cleanupSocket();
    else child.once('exit', () => { void cleanupSocket(); });
  }
  function current() {
    const wall = Date.now(), mono = performance.now();
    if (wall < previousWall || mono < previousMono || wall >= challenge!.expiresAtMs || mono >= deadline) {
      state = 'expired'; close();
    }
    previousWall = wall; previousMono = mono;
    return !stopped;
  }
  child.once('error', close);
  child.stdin.on('error', close);
  child.once('close', () => {
    if (state !== 'approved') close();
    void cleanupSocket();
  });
  child.stdout.on('data', (part: Buffer) => {
    if (!current() || buffer.length + part.length > 16 * 1024) { close(); return; }
    buffer = Buffer.concat([buffer, part]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32BE(0);
      if (!size || size > 4096) { close(); return; }
      if (buffer.length < size + 4) return;
      let item: Record<string, unknown>;
      try { item = JSON.parse(buffer.subarray(4, size + 4).toString('utf8')); } catch { close(); return; }
      buffer = Buffer.from(buffer.subarray(size + 4));
      if (++frames > 2 || !item || Object.keys(item).sort().join(',') !== 'challengeDigest,id,schemaVersion,state'
        || item.schemaVersion !== 1 || item.id !== challenge.id || item.challengeDigest !== digest) { close(); return; }
      if (state === 'starting' && item.state === 'ready') {
        state = 'waiting'; clearTimeout(readyTimer);
        if (windows) { if (current()) readyResolve(); else close(); continue; }
        void lstat(socket).then(info => {
          if (!info.isSocket() || info.uid !== owner) throw refused();
          inode = info.ino;
          if (!current()) { void cleanupSocket(); throw refused(); }
          readyResolve();
        }).catch(close);
      } else if (state === 'waiting' && item.state === 'approved') state = 'approved';
      else { close(); return; }
    }
  });
  signal.addEventListener('abort', close, { once: true });
  const body = Buffer.from(JSON.stringify({ schemaVersion: 1, id: challenge.id, challengeDigest: digest,
    expiresAtMs: challenge.expiresAtMs, message: message.toString('base64') }));
  message.fill(0);
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  child.stdin.write(Buffer.concat([header, body]), error => { body.fill(0); if (error) close(); });
  if (signal.aborted) close();
  try { await ready; } catch { close(); throw refused(); }
  return Object.freeze({
    challengeDigest: digest,
    status() { current(); return state === 'starting' ? 'waiting' : state; },
    consume(expected: DeviceConsentChallenge) {
      if (!current() || state !== 'approved' || consumed
        || deviceConsentMessage(expected) !== deviceConsentMessage(challenge)) throw refused();
      consumed = true;
    },
    close,
  });
}
