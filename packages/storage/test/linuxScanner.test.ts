import { afterEach, describe, expect, it, vi } from 'vitest';
import { macScannerHealth, nativeLinux, nativePosix, requireMacScan } from '../src/macosScanner.js';

describe.skipIf(process.platform !== 'linux')('native Linux fail-closed document scanning', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('treats the native Linux runtime as a protected POSIX distribution', () => {
    vi.stubEnv('JOSI_NATIVE_RUNTIME','1');
    expect(nativeLinux()).toBe(true); expect(nativePosix()).toBe(true);
  });
  it('blocks ingestion and reports unavailable when no scanner socket is configured', async () => {
    vi.stubEnv('JOSI_NATIVE_RUNTIME','1'); vi.stubEnv('JOSI_SCANNER_SOCKET','');
    await expect(macScannerHealth()).resolves.toMatchObject({required:true,enforced:true,status:'unavailable'});
    await expect(requireMacScan(Buffer.from('document'))).rejects.toThrow('blocked');
  });
});
