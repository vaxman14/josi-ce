import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeLinux, nativePosix } from '../src/nativeRuntime.js';
import { scanRequired } from '../src/gates.js';

describe.skipIf(process.platform !== 'linux')('native Linux document handling', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('treats the native Linux runtime as a native POSIX distribution', () => {
    vi.stubEnv('JOSI_NATIVE_RUNTIME', '1');
    expect(nativeLinux()).toBe(true); expect(nativePosix()).toBe(true);
  });
  it('needs no scanner, like the native Mac package, even with a legacy ClamAV flag stored', () => {
    vi.stubEnv('JOSI_NATIVE_RUNTIME', '1');
    const policy = { clamav_enabled: true, clamav_scan_mode: 'on_change' } as any;
    expect(scanRequired(policy, 'index')).toBe(false);
    expect(scanRequired(policy, 'change')).toBe(false);
  });
});
