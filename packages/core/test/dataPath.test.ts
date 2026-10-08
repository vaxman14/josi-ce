import { describe, expect, it } from 'vitest';
import { resolveDataPath } from '../src/dataPath.js';

const native = { JOSI_NATIVE_RUNTIME: '1', JOSI_DATA_DIR: 'C:\\ProgramData\\Josi CE Server' };
describe('portable database paths at the native filesystem boundary', () => {
  it('preserves stored names and other distributions', () => {
    expect(resolveDataPath('/data/backups/a.zip', native, 'linux')).toBe('/data/backups/a.zip');
    expect(resolveDataPath('/data/backups/a.zip', {}, 'win32')).toBe('/data/backups/a.zip');
    expect(resolveDataPath('D:\\Selected folder\\a.zip', native, 'win32')).toBe('D:\\Selected folder\\a.zip');
    expect(resolveDataPath('/database/a', native, 'win32')).toBe('/database/a');
  });
  it('maps portable names into the configured Windows root', () => {
    expect(resolveDataPath('/data/backups/a.zip', native, 'win32')).toBe('C:\\ProgramData\\Josi CE Server\\backups\\a.zip');
  });
  it('fails closed for missing roots, traversal, alternate streams and device names', () => {
    expect(() => resolveDataPath('/data/backups/a.zip', { JOSI_NATIVE_RUNTIME: '1' }, 'win32')).toThrow();
    for (const path of ['/data/../secret', '/data/a/./b', '/data/a\\b', '/data/a:stream', '/data/COM1.zip', '/data/a.']) {
      expect(() => resolveDataPath(path, native, 'win32')).toThrow();
    }
  });
});
