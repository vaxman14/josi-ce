import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeScanner, NativeScanFailure } from '../src/nativeScanner.js';
import { ScannerUnavailable } from '../src/gates.js';
import { spawn } from 'node:child_process';

const protocol = vi.hoisted(() => ({
  ready: { ready: true, provider: 'windows-amsi', status: 'clean' } as Record<string, unknown>,
  reply: '{"status":"clean"}\n' as string | null,
  startupError: '' as string,
  child: undefined as any,
}));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  return { spawn: vi.fn(() => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    let incoming = Buffer.alloc(0);
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      incoming = Buffer.concat([incoming, chunk]);
      if (incoming.length >= 4 && incoming.length === 4 + incoming.readUInt32BE(0)) {
        child.received = Buffer.from(incoming.subarray(4)); incoming = Buffer.alloc(0);
        if (protocol.reply !== null) queueMicrotask(() => child.stdout.write(protocol.reply));
      }
      done();
    } });
    protocol.child = child;
    queueMicrotask(() => protocol.startupError
      ? child.emit('error', Object.assign(new Error('fixed startup failure'), { code: protocol.startupError }))
      : child.stdout.write(JSON.stringify(protocol.ready) + '\n'));
    return child;
  }) };
});

describe.skipIf(process.platform !== 'win32')('explicit native scan protocol fails closed', () => {
  let scanner: ReturnType<typeof nativeScanner>;
  beforeEach(() => {
    protocol.ready = { ready: true, provider: 'windows-amsi', status: 'clean' };
    protocol.reply = '{"status":"clean"}\n'; protocol.startupError = '';
    scanner = nativeScanner({ python: 'C:\\owned\\python.exe', adapter: 'C:\\owned\\windows_amsi.py', scratch: 'C:\\private\\scanner' });
    vi.mocked(spawn).mockClear();
  });
  afterEach(() => { scanner.close(); vi.useRealTimers(); });
  it.each(['clean', 'blocked', 'error', 'unavailable'])('preserves the helper verdict %s', async status => {
    protocol.reply = JSON.stringify({ status }) + '\n';
    const bytes = Buffer.from('private document bytes');
    expect(await scanner.scanStatus(bytes)).toBe(status);
    expect(protocol.child.received).toEqual(bytes);
    expect(bytes.toString()).toBe('private document bytes');
  });
  it.each(['error', 'unavailable'])('never presents %s as a clean ingestion result', async status => {
    protocol.reply = JSON.stringify({ status }) + '\n';
    await expect(scanner.scan(Buffer.from('document'))).rejects.toMatchObject({ status });
    expect(NativeScanFailure.prototype instanceof ScannerUnavailable).toBe(true);
  });
  it('blocks malware and distinguishes it from a provider failure', async () => {
    protocol.reply = '{"status":"blocked"}\n';
    expect(await scanner.scan(Buffer.from('document'))).toEqual({ clean: false, signature: 'Windows antivirus blocked content' });
  });
  it.each(['{', 'null\n', '[]\n', '{"status":"clean","extra":true}\n', '{"status":"unknown"}\n', 'x'.repeat(8193)])('rejects malformed or oversized output', async reply => {
    protocol.reply = reply;
    vi.useFakeTimers();
    const pending = scanner.scanStatus(Buffer.from('document'));
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await pending).toBe('error');
    expect(protocol.child.kill).toHaveBeenCalled();
  });
  it.each(['error', 'unavailable'])('reports unavailable initialization (%s) without scanning', async status => {
    protocol.ready = { ready: false, provider: 'windows-amsi', status };
    expect(await scanner.scanStatus(Buffer.from('document'))).toBe(status);
    expect(protocol.child.received).toBeUndefined();
  });
  it('rejects an inconsistent initialization message', async () => {
    protocol.ready.status = 'unavailable';
    expect(await scanner.scanStatus(Buffer.from('document'))).toBe('error');
  });
  it('reports a missing executable as unavailable', async () => {
    protocol.startupError = 'ENOENT';
    expect(await scanner.scanStatus(Buffer.from('document'))).toBe('unavailable');
  });
  it('terminates a timed-out helper and rejects concurrent work', async () => {
    protocol.reply = null;
    vi.useFakeTimers();
    const pending = scanner.scanStatus(Buffer.from('document'));
    expect(await scanner.scanStatus(Buffer.from('another document'))).toBe('error');
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await pending).toBe('error');
    expect(protocol.child.kill).toHaveBeenCalled();
  });
  it('sends bounded bytes through pipes with the required Windows drive and no secret arguments', async () => {
    expect(await scanner.scanStatus(Buffer.alloc(32 * 1024 * 1024 + 1))).toBe('error');
    expect(spawn).not.toHaveBeenCalled();
    expect(await scanner.scanStatus(Buffer.from('secret content'))).toBe('clean');
    const args = vi.mocked(spawn).mock.calls[0];
    expect(args[1]).toEqual(['-I', '-B', 'C:\\owned\\windows_amsi.py']);
    expect(args[2]).toMatchObject({ windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const env = (args[2] as any).env;
    expect(env.SystemDrive).toMatch(/^[A-Za-z]:$/);
    expect(Object.keys(env).sort()).toEqual(['PATH', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR']);
  });
});
