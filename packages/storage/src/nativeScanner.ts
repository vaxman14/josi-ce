import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { ScannerUnavailable, type Scanner, type ScanResult } from './gates.js';

export interface NativeScannerOptions {
  python: string;
  adapter: string;
  scratch: string;
}
const MAX_BYTES = 32 * 1024 * 1024;
export type NativeScanStatus = 'clean' | 'blocked' | 'error' | 'unavailable';
export class NativeScanFailure extends ScannerUnavailable {
  constructor(readonly status: 'error' | 'unavailable') {
    super(status === 'error' ? 'Windows antivirus scan failed; processing stopped' : 'Windows antivirus scanning unavailable; processing stopped');
  }
}
const unavailable = () => new NativeScanFailure('unavailable');

/** The inherited anonymous pipes are the authorization boundary. No socket,
 * source filename, shell command, provider secret or document log is involved.
 * Exactly one scan may be in flight; failure always rejects the ingestion gate.
 */
export function nativeScanner(options: NativeScannerOptions): Scanner & { close(): void; scanStatus(bytes: Buffer): Promise<NativeScanStatus> } {
  const configured = process.platform === 'win32' && Object.values(options).every((p) => !!p && isAbsolute(p));
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending: { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  let idle: NodeJS.Timeout | undefined;
  let busy = false;
  let cooldownUntil = 0;
  let buffer = '';

  function close(status: 'error' | 'unavailable' = 'error'): void {
    clearTimeout(idle);
    const previous = child;
    child = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new NativeScanFailure(status));
      pending = undefined;
    }
    // Windows terminates only this isolated scanner process. It starts no
    // subprocesses; the owning SCM host also terminates its whole process tree.
    previous?.kill();
    buffer = '';
  }
  function fail(status: 'error' | 'unavailable' = 'error'): void { cooldownUntil = Date.now() + 60_000; close(status); }
  function response(timeout: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, timer: setTimeout(fail, timeout) };
    });
  }
  async function start(): Promise<void> {
    if (child) return;
    const env: NodeJS.ProcessEnv = {
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      // AMSI's installed provider initialization requires the OS system drive.
      // Derive it from the trusted Windows directory, never a user's profile.
      SystemDrive: win32.parse(process.env.SystemRoot ?? 'C:\\Windows').root.replace(/\\$/, ''),
      TEMP: options.scratch, TMP: options.scratch,
      PATH: dirname(options.python) + ';' + join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
    };
    child = spawn(options.python, ['-I', '-B', options.adapter],
    { windowsHide: true, shell: false, cwd: options.scratch, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const current = child;
    current.once('error', (error: NodeJS.ErrnoException) => { if (child === current) fail(error.code === 'ENOENT' ? 'unavailable' : 'error'); });
    current.once('close', () => { if (child === current) fail(); });
    current.stdin.on('error', () => { if (child === current) fail(); });
    current.stderr.resume(); // Library details may contain personal document data.
    current.stdout.on('data', (data: Buffer) => {
      if (child !== current) return;
      buffer += data.toString('utf8');
      if (buffer.length > 8192) { fail(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!pending) { fail(); return; }
        let value: unknown;
        try { value = JSON.parse(line); } catch { fail(); return; }
        if (!value || typeof value !== 'object' || Array.isArray(value) || 'error' in value) { fail(); return; }
        const request = pending;
        pending = undefined;
        clearTimeout(request.timer);
        request.resolve(value as Record<string, unknown>);
      }
    });
    const ready = await response(15_000);
    if (Object.keys(ready).sort().join(',') !== 'provider,ready,status' || ready.provider !== 'windows-amsi'
      || !((ready.ready === true && ready.status === 'clean') || (ready.ready === false && ['error', 'unavailable'].includes(String(ready.status))))) {
      fail(); throw new NativeScanFailure('error');
    }
    if (ready.ready !== true) {
      fail(); throw new NativeScanFailure(ready.status === 'unavailable' ? 'unavailable' : 'error');
    }
  }
  return {
    close,
    async scan(bytes: Buffer): Promise<ScanResult> {
      const status = await this.scanStatus(bytes);
      if (status === 'error' || status === 'unavailable') throw new NativeScanFailure(status);
      return status === 'clean' ? { clean: true } : { clean: false, signature: 'Windows antivirus blocked content' };
    },
    async scanStatus(bytes: Buffer): Promise<NativeScanStatus> {
      if (!configured) return 'unavailable';
      if (busy || bytes.length > MAX_BYTES) return 'error';
      if (Date.now() < cooldownUntil) return 'unavailable';
      busy = true;
      clearTimeout(idle);
      try {
        await start();
        if (!child) throw unavailable();
        const result = response(45_000);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(bytes.length);
        child.stdin.write(header);
        child.stdin.write(bytes);
        const value = await result;
        if (Object.keys(value).length !== 1 || !['clean', 'blocked', 'error', 'unavailable'].includes(String(value.status))) {
          fail(); return 'error';
        }
        idle = setTimeout(close, 60_000);
        idle.unref();
        return value.status as NativeScanStatus;
      } catch (error) {
        fail(); return error instanceof NativeScanFailure ? error.status : 'error';
      } finally { busy = false; }
    },
  };
}
