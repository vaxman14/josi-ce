import { fork } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { assertCapability, ClaudeCredentialStore, CodexCredentialStore, Secret, SubscriptionCredentialError, windowsPathTrusted,
  type SubscriptionCredentialAdministration, type SubscriptionCredentialReview } from '@josi-ce/core';
import type { SpawnRunner } from './codexCli.js';
import type { CodexGuardianInput, CodexGuardianOutput, CodexPrivateFile } from './codexVaultWire.js';
import { requireCompatibleCodexHost } from './codexVaultCompatibility.js';
import { requireCompatibleClaudeHost } from './claudeVaultCompatibility.js';
import { validClaudeSubscriptionArgs } from './claudeVaultPolicy.js';

type Result = Extract<CodexGuardianOutput, { type: 'result' }>;
export interface VaultCodexRun {
  /** Resolves only after the guardian reports group closure, removes its
   * projection and commits current refresh material to the Vault. */
  result: Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean;
    cancelled: boolean; spawnError: boolean }>;
  stop(): Promise<void>;
  /** Exact canonical lease identity and locally observed closure. Neither
   * expiry nor parent/guardian exit alone is evidence of consumer closure. */
  leaseId: string;
  consumerStopped(): boolean;
}
export interface VaultCodexStart {
  operation: 'login' | 'chat' | 'status';
  command: string;
  args: string[];
  input?: string;
  timeoutMs: number;
  administration?: { expected: SubscriptionCredentialReview['expected']; authority: SubscriptionCredentialAdministration };
  /** Login parser only; never send raw CLI output to a renderer or log. */
  onLoginOutput?: (text: string) => void;
  requireCurrentAuthority?: () => Promise<void>;
  beforeStart?: () => Promise<void>;
  privateFiles?: CodexPrivateFile[];
}
/** Resolve only an explicitly configured executable or the service PATH.
 * The guardian will not inherit a shell, personal HOME or credential env. */
async function executable(command: string): Promise<string> {
  if (!command || command.includes('\0')) throw new SubscriptionCredentialError('The subscription executable is unavailable.');
  if (process.platform === 'win32') return windowsExecutable(command);
  const candidates = isAbsolute(command) ? [command]
    : command.includes('/') ? [] : (process.env.PATH ?? '').split(':').filter(isAbsolute).map(path => join(path, command));
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate), metadata = await stat(path);
      if (metadata.isFile() && metadata.mode & 0o111 && !(metadata.mode & 0o022)) return path;
    } catch { /* try next service PATH entry */ }
  }
  throw new SubscriptionCredentialError('The subscription executable is unavailable or writable by another account.');
}
/** Windows: a native .exe only (never a .cmd/.ps1 shim that needs a shell),
 * from an absolute path or the service PATH, whose file and parent folders
 * no other account can replace. */
async function windowsExecutable(command: string): Promise<string> {
  const name = /\.exe$/i.test(command) ? command : command + '.exe';
  const candidates = win32.isAbsolute(name) ? [name]
    : /[\\/]/.test(name) ? [] : (process.env.PATH ?? '').split(';').filter(entry => win32.isAbsolute(entry)).map(entry => win32.join(entry, name));
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate), metadata = await stat(path);
      if (metadata.isFile() && /\.exe$/i.test(path) && windowsPathTrusted(win32.normalize(path))) return path;
    } catch { /* try next service PATH entry */ }
  }
  throw new SubscriptionCredentialError('The subscription executable is unavailable or another account can replace it.');
}
/** Windows processes need their system folders; temporary files stay in the
 * server's own private temp folder. No profile, credential or provider env. */
function windowsBaseEnvironment(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return {};
  const keep = ['SystemRoot', 'windir', 'ProgramData', 'ProgramFiles', 'ProgramW6432', 'TEMP', 'TMP'];
  return Object.fromEntries(keep.filter(key => process.env[key]).map(key => [key, process.env[key]]));
}
export async function vaultCodexExecutableAvailable(command: string): Promise<boolean> {
  try { await executable(command); return true; } catch { return false; }
}
const failure = () => new SubscriptionCredentialError(
  'This subscription run could not confirm credential cleanup and Vault write-back. Reconnect or reconcile its login before using it again.');

/** The guardian has no database key; only the parent can renew its five-second
 * authority window after checking the canonical Vault claim. A database hang,
 * Vault lock, parent crash or caller stop therefore stops the consumer. */
export async function startVaultCodex(store: CodexCredentialStore, options: VaultCodexStart): Promise<VaultCodexRun> {
  if (store.consumer !== 'codex') throw failure();
  return startVaultSubscription(store, options);
}
export async function startVaultClaude(store: ClaudeCredentialStore,
  options: Omit<VaultCodexStart, 'operation' | 'administration' | 'onLoginOutput'>): Promise<VaultCodexRun> {
  if (store.consumer !== 'claude' || !validClaudeSubscriptionArgs(options.args)) throw failure();
  return startVaultSubscription(store, { ...options, operation: 'chat' });
}
async function startVaultSubscription(store: CodexCredentialStore | ClaudeCredentialStore,
  options: VaultCodexStart): Promise<VaultCodexRun> {
  assertCapability('subscription_auth');
  assertCapability('local_command_execution');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 15 * 60_000) throw failure();
  if (store.consumer === 'codex') requireCompatibleCodexHost(); else requireCompatibleClaudeHost();
  const command = await executable(options.command);
  const { lease, projection } = await store.begin(options.operation, options.timeoutMs + 30_000, options.administration);
  let guardian: ReturnType<typeof fork>;
  try {
    guardian = fork(fileURLToPath(new URL('./codexVaultGuardian.js', import.meta.url)), [], {
      execArgv: [], env: { PATH: process.env.PATH, JOSI_SUBSCRIPTION_CONSUMER: store.consumer, ...windowsBaseEnvironment() },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  } catch {
    // fork never created a consumer; no refresh could have happened.
    await (projection ? store.finish(lease, projection) : store.abandon(lease)).catch(() => {});
    throw failure();
  }
  let started = false, ready = false, settled = false, finishing = false, stopping = false;
  let polling = false, received: Result | undefined, closed = false;
  const startMono = performance.now(), startWall = Date.now();
  const send = (value: CodexGuardianInput) => {
    if (guardian.connected) guardian.send(value, () => {});
  };
  const stop = () => { stopping = true; send({ type: 'stop' }); };
  let resolve!: (value: Awaited<VaultCodexRun['result']>) => void, reject!: (reason: unknown) => void;
  const result: VaultCodexRun['result'] = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Login returns its challenge before completion. Its controller attaches a
  // handler later; prevent an unhandled-rejection window without consuming it.
  void result.catch(() => {});
  const fail = () => {
    if (settled) return;
    settled = true; clearInterval(ticker); stop();
    if (received) { received.auth = null; received.stdout = ''; received.stderr = ''; }
    reject(failure());
  };
  const finish = async (value: Result) => {
    if (finishing || settled) return;
    finishing = true; clearInterval(ticker);
    const writeDeadline = setTimeout(fail, 15_000);
    try {
      if (!value.stopped) throw failure();
      if (!started && value.cleaned && projection) {
        await store.finish(lease, projection);
      } else if (store.consumer === 'claude' && value.cleaned && projection) {
        // setup-token is not refreshed by this runtime. Only the exact claim's
        // original projection returns to ready after observed group closure.
        await store.finish(lease, projection);
      } else if (!value.cleaned || value.auth === null || options.operation === 'login'
        && (value.cancelled || value.code !== 0 || value.spawnError)) {
        await store.abandon(lease);
        if (!value.cleaned || options.operation !== 'login'
          || value.code === 0 && !value.cancelled && !value.spawnError) throw failure();
      } else await store.finish(lease, new Secret(value.auth));
      if (settled) return;
      settled = true;
      resolve({ code: value.code, stdout: value.stdout, stderr: value.stderr,
        timedOut: value.timedOut, cancelled: value.cancelled, spawnError: value.spawnError });
    } catch { fail(); }
    finally { clearTimeout(writeDeadline); value.auth = null; }
  };
  // Never overlap checks; only a successful current claim grants another
  // heartbeat. An unresolved query cannot keep a guardian alive.
  const poll = async () => {
    if (polling || settled || finishing || stopping || !ready) return;
    polling = true;
    try {
      await store.requireCurrent(lease);
      await options.requireCurrentAuthority?.();
      if (stopping || settled || finishing || !guardian.connected) return;
      send({ type: 'renew' });
      if (!started) {
        await options.beforeStart?.();
        if (stopping || settled || finishing || !guardian.connected) return;
        started = true;
        send({ type: 'start', command, args: options.args, input: options.input ?? '',
          auth: projection?.reveal() ?? null, timeoutMs: options.timeoutMs,
          ...(options.privateFiles ? { privateFiles: options.privateFiles } : {}) });
      }
    } catch { stop(); }
    finally { polling = false; }
  };
  guardian.on('message', (value: CodexGuardianOutput) => {
    if (!value || typeof value !== 'object') return;
    if (settled) {
      if (value.type === 'result' && value.stopped) {
        value.auth = null; value.stdout = ''; value.stderr = ''; received = value;
      }
      return;
    }
    if (value.type === 'ready') { ready = true; void poll(); }
    else if (value.type === 'output' && options.operation === 'login' && typeof value.text === 'string') {
      try { options.onLoginOutput?.(value.text); } catch { stop(); }
    } else if (value.type === 'result') {
      received = value;
      // A result without process-group closure cannot release the claim, even
      // if the guardian later disappears. It reports an unresolved consumer.
      if (!value.stopped) fail();
    }
  });
  guardian.on('error', fail);
  guardian.on('close', () => {
    closed = true;
    if (received?.stopped) void finish(received);
    else fail();
  });
  const ticker = setInterval(() => {
    if (settled || finishing) return;
    const elapsed = Math.max(performance.now() - startMono, Date.now() - startWall);
    if (elapsed > options.timeoutMs + 15_000 || Date.now() < startWall) { fail(); return; }
    if (!ready && elapsed > 5_000) { stop(); return; }
    void poll();
  }, 1_000);
  return {
    result,
    leaseId: lease.id,
    consumerStopped: () => closed && received?.stopped === true && received.cleaned === true,
    async stop() {
      stop();
      // A caller may not start a replacement consumer merely because a signal
      // was sent. Wait for the exact run's closure/write-back or refusal.
      await result;
    },
  };
}

/** Injection seam for the existing provider. No fallback to CODEX_HOME or a
 * personal credential store when a managed run refuses. */
export function vaultCodexRunner(store: CodexCredentialStore, requireCurrentAuthority?: () => Promise<void>): SpawnRunner {
  return async request => {
    const run = await startVaultCodex(store, {
      operation: 'chat', command: request.command, args: request.args,
      input: request.input, timeoutMs: request.timeoutMs,
      requireCurrentAuthority,
      beforeStart: request.beforeStart,
      privateFiles: request.privateFiles,
    });
    const value = await run.result;
    return { code: value.code, stdout: value.stdout, stderr: value.stderr,
      timedOut: value.timedOut, cancelled: value.cancelled };
  };
}

export function vaultClaudeRunner(store: ClaudeCredentialStore, requireCurrentAuthority?: () => Promise<void>): SpawnRunner {
  return async request => {
    const run = await startVaultClaude(store, {
      command: request.command, args: request.args, input: request.input,
      timeoutMs: request.timeoutMs, requireCurrentAuthority,
    });
    const value = await run.result;
    return { code: value.code, stdout: value.stdout, stderr: value.stderr,
      timedOut: value.timedOut, cancelled: value.cancelled };
  };
}
