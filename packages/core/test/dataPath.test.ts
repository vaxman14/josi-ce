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
  it('maps macOS storage without changing stored names or selected external paths', () => {
    const env = { JOSI_NATIVE_RUNTIME: '1', JOSI_DATA_DIR: '/Library/Application Support/Josi CE Server' };
    expect(resolveDataPath('/data/backups/a.zip', env, 'darwin')).toBe(env.JOSI_DATA_DIR + '/backups/a.zip');
    expect(resolveDataPath('/data', env, 'darwin')).toBe(env.JOSI_DATA_DIR);
    expect(resolveDataPath('/Volumes/Documents/a', env, 'darwin')).toBe('/Volumes/Documents/a');
    expect(resolveDataPath('/data/a', {}, 'darwin')).toBe('/data/a');
    for (const path of ['/data/../secret', '/data/a/./b', '/data/a\\b', '/data/a\0b']) {
      expect(() => resolveDataPath(path, env, 'darwin')).toThrow();
    }
    for (const root of ['', '/', 'relative', '/data/../secret', '/data/', '/data\n']) {
      expect(() => resolveDataPath('/data/a', { ...env, JOSI_DATA_DIR: root }, 'darwin')).toThrow();
    }
  });
  it('fails closed for missing roots, traversal, alternate streams and device names', () => {
    expect(() => resolveDataPath('/data/backups/a.zip', { JOSI_NATIVE_RUNTIME: '1' }, 'win32')).toThrow();
    for (const path of ['/data/../secret', '/data/a/./b', '/data/a\\b', '/data/a:stream', '/data/COM1.zip', '/data/a.']) {
      expect(() => resolveDataPath(path, native, 'win32')).toThrow();
    }
  });
});
