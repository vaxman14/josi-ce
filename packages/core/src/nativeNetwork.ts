/** Native services have no container network boundary. A public-address setting
 * must never change their bind address; LAN access requires the proxy lifecycle.
 */
export function apiListenHost(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return platform === 'win32' || env.JOSI_NATIVE_RUNTIME === '1' ? '127.0.0.1' : undefined;
}
