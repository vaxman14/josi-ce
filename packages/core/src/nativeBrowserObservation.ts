import type { AutomationBrowserTarget } from './automationBrowserTargets.js';

export interface NativeBrowserPin {
  profileId: string; family: 'chrome' | 'brave' | 'firefox' | 'safari';
  nativeProfileId: string; profilePath: string | null;
  extensionId: string; extensionVersion: string; extensionDigest: string;
  distribution: 'unpacked-development' | 'store-signed';
}
export function nativeBrowserPin(target: AutomationBrowserTarget): NativeBrowserPin {
  const c = target.candidate;
  return { profileId: target.profileId, family: c.family, nativeProfileId: c.nativeProfileId, profilePath: c.profilePath,
    extensionId: c.extensionId, extensionVersion: c.extensionVersion, extensionDigest: c.extensionDigest, distribution: c.distribution };
}
export function exactBrowserOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string' || origin.length > 2048 || /[\s*\\]/u.test(origin)) return false;
  try { const url = new URL(origin); return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && url.origin === origin; }
  catch { return false; }
}
export function isBrowserApplication(bundleId: string): boolean {
  return ['com.google.Chrome', 'com.brave.Browser', 'org.mozilla.firefox', 'com.apple.Safari'].includes(bundleId);
}
/** No titles, full URLs, DOM text or secrets enter the dispatch proof. The
 * signed guest verifies these values against its actual native browser peer. */
export function browserDispatchTarget(value: unknown, pin: NativeBrowserPin, codeHash: string, origin: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  const keys = ['kind', 'profileId', 'nativeProfileId', 'family', 'extensionId', 'extensionDigest', 'processId', 'launchedAtMs', 'codeHash', 'origin'];
  return Object.keys(t).length === keys.length && keys.every(k => Object.hasOwn(t, k))
    && t.kind === 'browser' && t.profileId === pin.profileId && t.nativeProfileId === pin.nativeProfileId
    && t.family === pin.family && t.extensionId === pin.extensionId && t.extensionDigest === pin.extensionDigest
    && t.codeHash === codeHash && t.origin === origin && exactBrowserOrigin(t.origin)
    && Number.isSafeInteger(t.processId) && Number(t.processId) > 0 && Number(t.processId) <= 0x7fffffff
    && Number.isSafeInteger(t.launchedAtMs) && Number(t.launchedAtMs) > 0 && Number(t.launchedAtMs) <= Date.now();
}
