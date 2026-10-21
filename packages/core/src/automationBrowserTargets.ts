import type { AutomationIdentity } from '@josi-ce/protocol';
import type { AutomationApplicationTarget } from './automationTargets.js';

export interface AutomationBrowserCandidate {
  schemaVersion: '1' | '2'; kind: 'browser'; candidateId: string; guestBootId: string; label: string;
  family: 'chrome' | 'brave' | 'firefox' | 'safari';
  applicationId: string; installationRevision: 1;
  /** Physical guest profile; deliberately distinct from the grantable ID. */
  nativeProfileId: string; profilePath: string | null;
  extensionId: string; extensionVersion: string; extensionDigest: string;
  distribution: 'unpacked-development' | 'store-signed';
}
export interface AutomationBrowserTarget {
  /** An immutable Vault registration, never a browser-selected profile ID.
   * Updating app/extension code requires a new registration and new grants. */
  profileId: string; profileRevision: 1; identity: AutomationIdentity;
  candidate: AutomationBrowserCandidate; registeredAt: string;
}
const fields = ['schemaVersion', 'kind', 'candidateId', 'guestBootId', 'label', 'family', 'applicationId',
  'installationRevision', 'nativeProfileId', 'profilePath', 'extensionId', 'extensionVersion', 'extensionDigest', 'distribution'];
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const text = (v: unknown, limit: number): v is string => typeof v === 'string' && v.trim() === v
  && v.length > 0 && Buffer.byteLength(v) <= limit && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\\]/u.test(v);
const bundles = { chrome: 'com.google.Chrome', brave: 'com.brave.Browser', firefox: 'org.mozilla.firefox', safari: 'com.apple.Safari' } as const;
export function isAutomationBrowserCandidate(value: unknown): value is AutomationBrowserCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as AutomationBrowserCandidate;
  if (Object.keys(v).length !== fields.length || !fields.every(k => Object.hasOwn(v, k))
    || !['1', '2'].includes(v.schemaVersion) || v.kind !== 'browser' || ![v.candidateId, v.guestBootId, v.applicationId, v.nativeProfileId].every(uuid)
    || !text(v.label, 96) || !Object.hasOwn(bundles, v.family) || v.installationRevision !== 1
    || !text(v.extensionVersion, 64) || !/^[0-9]+(?:\.[0-9]+){1,3}$/.test(v.extensionVersion)
    || typeof v.extensionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.extensionDigest)
    || !['unpacked-development', 'store-signed'].includes(v.distribution)) return false;
  if (v.family === 'safari') return v.profilePath === null && v.extensionId === (v.schemaVersion === '2' ? 'com.heyjosi.ce.unified.workspace-safari' : 'com.heyjosi.ce.guestcompanion.workspace-safari');
  if (v.schemaVersion === '2') return v.profilePath === null && (['chrome', 'brave'].includes(v.family)
    ? typeof v.extensionId === 'string' && /^[a-p]{32}$/.test(v.extensionId)
    : text(v.extensionId, 128) && /^[a-zA-Z0-9@{}_.-]+$/.test(v.extensionId));
  if (!text(v.profilePath, 1024) || !v.profilePath.startsWith('/Users/')
    || v.profilePath.split('/').some((part, i) => i > 0 && (!part || part === '.' || part === '..'))
    || !v.profilePath.endsWith('/' + v.nativeProfileId)) return false;
  return ['chrome', 'brave'].includes(v.family)
    ? typeof v.extensionId === 'string' && /^[a-p]{32}$/.test(v.extensionId)
    : text(v.extensionId, 128) && /^[a-zA-Z0-9@{}_.-]+$/.test(v.extensionId);
}
export function browserApplication(target: AutomationBrowserTarget, applications: AutomationApplicationTarget[]): AutomationApplicationTarget | null {
  const c = target.candidate, identity = target.identity;
  if (!isAutomationBrowserCandidate(c)) return null;
  if (c.schemaVersion === '1' && c.family !== 'safari') {
    const suffix = `/Library/Application Support/Josi Workspace/Profiles/${identity.workspaceId}/${c.nativeProfileId}`;
    if (!c.profilePath?.endsWith(suffix) || c.profilePath.slice('/Users/'.length, -suffix.length).includes('/')) return null;
  }
  return applications.find(app => app.applicationId === c.applicationId && app.installationRevision === c.installationRevision
    && app.candidate.bundleId === bundles[c.family]
    && ['userId', 'serverId', 'deviceId', 'workspaceId'].every(key =>
      app.identity[key as keyof AutomationIdentity] === identity[key as keyof AutomationIdentity])) ?? null;
}
export function describeAutomationBrowser(target: AutomationBrowserTarget, application: AutomationApplicationTarget): string {
  const c = target.candidate, app = application.candidate;
  return `Browser registration: ${target.profileId}, revision ${target.profileRevision}\nFamily: ${c.family}\nProfile: ${c.label}\n`
    + `Browser instance: ${c.nativeProfileId}\nProfile location: ${c.profilePath ?? 'Existing browser; no profile access'}\n`
    + `Application registration: ${c.applicationId}, revision ${c.installationRevision}\nBrowser app: ${app.bundlePath}\n`
    + `Bundle: ${app.bundleId}\nSigning identifier: ${app.signingId}\nSigning team: ${app.teamId || '(no team identifier)'}\nApp code hash: ${app.codeHash}\n`
    + `Extension: ${c.extensionId}\nExtension version: ${c.extensionVersion}\nExtension fingerprint: ${c.extensionDigest}\nDistribution: ${c.distribution}`;
}
