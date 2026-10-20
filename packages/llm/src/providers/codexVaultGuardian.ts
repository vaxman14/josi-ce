// Private executable entry point, never imported by the API. Owns a single
// temporary CLI home and process group. Parent disconnect or missing authority
// heartbeat stops the group before its projection is read back and removed.
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { privateTemporaryDirectory, Secret, validateCodexAuthCache } from '@josi-ce/core';
import type { CodexGuardianInput, CodexGuardianOutput, CodexGuardianStart } from './codexVaultWire.js';
import { requireCompatibleCodexHost } from './codexVaultCompatibility.js';

// The first implementation supports the macOS release and POSIX servers.
// Windows needs a Job Object implementation, not a weaker kill-one-child path.
if (!process.send || process.platform === 'win32') process.exit(1);

const send = (value: CodexGuardianOutput) => {
  if (process.connected) process.send!(value, () => {});
};
const MAX_OUTPUT = 4 * 1024 * 1024, MAX_INPUT = 4 * 1024 * 1024;
let child: ChildProcess | undefined, directory: string | undefined;
let directoryHandle: FileHandle | undefined;
let group: number | undefined, started = false, finalizing = false, cancelled = false, timedOut = false;
let spawnError = false, exitCode: number | null = null, childClosed = false;
let stdout = '', stderr = '', outputBytes = 0;
let authorityMono = performance.now(), authorityWall = Date.now();
let operationMono = performance.now(), operationWall = Date.now(), duration = 5_000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function groupExists(): boolean {
  if (!group) return false;
  try { process.kill(-group, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function signalGroup(signal: NodeJS.Signals) {
  if (!group) return;
  try { process.kill(-group, signal); } catch { /* absence is checked separately */ }
}
async function privateDirectoryStillCurrent(): Promise<boolean> {
  if (!directory || !directoryHandle) return false;
  const [held, current] = await Promise.all([directoryHandle.stat(), lstat(directory)]);
  return current.isDirectory() && !current.isSymbolicLink() && held.dev === current.dev && held.ino === current.ino
    && current.uid === process.getuid!() && (current.mode & 0o777) === 0o700
    && await realpath(directory) === directory;
}
async function readCache(): Promise<string | null> {
  let file: FileHandle | undefined;
  try {
    if (!await privateDirectoryStillCurrent()) return null;
    file = await open(join(directory!, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid!()
      || (before.mode & 0o777) !== 0o600 || before.size <= 0 || before.size > 64 * 1024) return null;
    // A bounded fd read never follows a replaced pathname or allocates from an
    // attacker-controlled file size. The entire process group is already gone.
    const bytes = Buffer.alloc(64 * 1024 + 1);
    try {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const after = await file.stat();
      if (bytesRead !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || !await privateDirectoryStillCurrent()) return null;
      return validateCodexAuthCache(new Secret(bytes.subarray(0, bytesRead).toString('utf8'))).reveal();
    } finally { bytes.fill(0); }
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}
async function finish() {
  if (finalizing) return;
  finalizing = true;
  clearInterval(watchdog);
  // The CLI can leave an MCP descendant after its own exit. Keeping the
  // credential claim until the whole owned group is gone prevents overlap.
  signalGroup('SIGTERM');
  const termDeadline = performance.now() + 750;
  while (groupExists() && performance.now() < termDeadline) await sleep(50);
  signalGroup('SIGKILL');
  const killDeadline = performance.now() + 5_000;
  while ((!childClosed || groupExists()) && performance.now() < killDeadline) await sleep(50);
  if (!childClosed || groupExists()) {
    send({ type: 'result', code: exitCode, stdout: '', stderr: '', timedOut, cancelled,
      spawnError, stopped: false, cleaned: false, auth: null });
    // Do not claim cleanup or delete a home still in use. A stuck kernel task
    // keeps the Vault claim unresolved. Continue cleanup after the caller leaves.
    while (!childClosed || groupExists()) { signalGroup('SIGKILL'); await sleep(1_000); }
  }
  const auth = await readCache();
  let cleaned = false;
  try {
    if (directory) {
      if (!await privateDirectoryStillCurrent()) throw new Error();
      await rm(directory, { recursive: true, force: false });
    }
    cleaned = true;
  } catch { /* caller must not mark the projection ready */ }
  await directoryHandle?.close().catch(() => {});
  send({ type: 'result', code: exitCode, stdout, stderr, timedOut, cancelled,
    spawnError, stopped: true, cleaned, auth });
  // Flush the private result before disconnecting. No stdout/stderr is used.
  if (process.connected) process.disconnect();
}
function stop() {
  cancelled = true;
  signalGroup('SIGTERM');
  if (child) void finish();
  else if (!started) { childClosed = true; void finish(); }
  // A stop during directory creation is handled before spawn below.
}
function validStart(value: CodexGuardianStart): boolean {
  return typeof value.command === 'string' && isAbsolute(value.command) && !value.command.includes('\0')
    && Array.isArray(value.args) && value.args.length <= 100
    && value.args.every(a => typeof a === 'string' && a.length <= 16_384 && !a.includes('\0'))
    // The caller may select model/harness options, never redirect auth storage,
    // endpoints or API credentials through a later command-line override.
    && !value.args.some(a => /cli_auth_credentials_store|forced_login_method|chatgpt_base_url|model_provider|openai_base_url|api_key|auth\.json/i.test(a))
    && typeof value.input === 'string' && Buffer.byteLength(value.input) <= MAX_INPUT
    && (value.auth === null || typeof value.auth === 'string' && Buffer.byteLength(value.auth) <= 64 * 1024)
    && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 15 * 60_000;
}
async function start(value: CodexGuardianStart) {
  if (started || finalizing || !validStart(value)) { stop(); return; }
  started = true;
  operationMono = performance.now(); operationWall = Date.now(); duration = value.timeoutMs;
  try {
    requireCompatibleCodexHost();
    // Canonicalize only the fresh Josi-created empty directory. Never search a
    // user's home, existing Codex directory, Keychain or browser profile.
    directory = await realpath(privateTemporaryDirectory('josi-codex-vault-'));
    directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (value.auth !== null) {
      const cache = validateCodexAuthCache(new Secret(value.auth));
      const file = await open(join(directory, 'auth.json'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(cache.reveal(), 'utf8'); await file.sync(); }
      finally { await file.close(); }
    }
    value.auth = null;
    await mkdir(join(directory, 'work'), { mode: 0o700 });
    if (cancelled || !process.connected || !await privateDirectoryStillCurrent()) throw new Error();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, LANG: 'en_US.UTF-8', NO_COLOR: '1', CI: '1',
      HOME: directory, CODEX_HOME: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
      XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory,
    };
    child = spawn(value.command, [
      '-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"',
      ...value.args,
    ], { env, cwd: join(directory, 'work'), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    group = child.pid;
    const absorb = (stream: 'stdout' | 'stderr', text: string) => {
      outputBytes += Buffer.byteLength(text, 'utf8');
      if (outputBytes > MAX_OUTPUT) { stop(); return; }
      if (stream === 'stdout') stdout += text; else stderr += text;
      if (value.args[0] === 'login') send({ type: 'output', text });
    };
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => absorb('stdout', chunk));
    child.stderr!.on('data', (chunk: string) => absorb('stderr', chunk));
    child.on('error', () => { spawnError = true; });
    child.on('close', code => { childClosed = true; exitCode = code; void finish(); });
    child.stdin!.on('error', () => {});
    child.stdin!.end(value.input);
    value.input = '';
    if (cancelled) void finish();
  } catch {
    value.auth = null; value.input = '';
    spawnError = true;
    if (!child) childClosed = true;
    void finish();
  }
}
const watchdog = setInterval(() => {
  const mono = performance.now(), wall = Date.now();
  if (mono - authorityMono > 5_000 || wall - authorityWall > 5_000 || wall < authorityWall
    || !started && mono - operationMono > 5_000) stop();
  if (started && (mono - operationMono > duration || wall - operationWall > duration || wall < operationWall)) {
    timedOut = true; stop();
  }
}, 250);
process.on('message', (raw: CodexGuardianInput) => {
  if (!raw || typeof raw !== 'object') { stop(); return; }
  if (raw.type === 'start') void start(raw);
  else if (raw.type === 'renew' && !cancelled && !finalizing) {
    try { requireCompatibleCodexHost(); } catch { stop(); return; }
    authorityMono = performance.now(); authorityWall = Date.now();
  } else if (raw.type === 'stop') stop();
  else stop();
});
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
send({ type: 'ready' });
