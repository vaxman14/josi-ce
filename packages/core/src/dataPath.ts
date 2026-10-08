import { win32 } from 'node:path';

/** Database records keep their portable /data/... names. Only filesystem
 * boundaries translate those names into the native installation's data root.
 * This is path translation, not authorization to read an arbitrary file.
 */
export function resolveDataPath(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32' || env.JOSI_NATIVE_RUNTIME !== '1') return path;
  if (path !== '/data' && !path.startsWith('/data/')) return path;
  const root = env.JOSI_DATA_DIR;
  if (!root || !/^[A-Za-z]:[\\/]/.test(root) || root.includes('\0')) {
    throw new Error('Native data storage is not configured');
  }
  const segments = path.slice('/data'.length).split('/').filter(Boolean);
  if (segments.some((part) => part === '.' || part === '..'
    || /[\\<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error('Invalid native data path');
  }
  return win32.join(win32.resolve(root), ...segments);
}
