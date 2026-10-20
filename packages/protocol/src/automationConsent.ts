import { parseProtectedHostChallenge, type ProtectedHostChallenge } from './protectedHost.js';
import type { VaultAuthorityReference } from './automation.js';

/** Local participation only: every command still needs its own current
 * permission, Cardinal Rule, target and effect-reservation checks. */
export interface AutomationConsentChallenge extends ProtectedHostChallenge {
  workspaceId: string; label: string; storageSessionId: string;
  guestBootId: string; guestChannelId: string; consentUntilMs: number;
  permissions: VaultAuthorityReference; cardinal: VaultAuthorityReference;
}
const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
function reference(v: unknown, epoch: number): v is VaultAuthorityReference {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as VaultAuthorityReference;
  return Object.keys(r).sort().join(',') === 'digest,epoch,recordId,version' && uuid(r.recordId)
    && Number.isSafeInteger(r.version) && r.version > 0 && r.epoch === epoch
    && typeof r.digest === 'string' && /^[a-f0-9]{64}$/.test(r.digest);
}
export function parseAutomationConsentChallenge(value: unknown): AutomationConsentChallenge | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { workspaceId, label, storageSessionId, guestBootId, guestChannelId, consentUntilMs,
    permissions, cardinal, ...host } = value as Record<string, unknown>;
  const c = parseProtectedHostChallenge(host);
  if (!c || ![workspaceId, storageSessionId, guestBootId, guestChannelId].every(uuid)
    || typeof label !== 'string' || !label || label.trim() !== label || label.length > 120
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(label)
    || !Number.isSafeInteger(consentUntilMs) || Number(consentUntilMs) <= c.expiresAtMs
    || Number(consentUntilMs) - c.issuedAtMs > 2 * 60 * 60_000
    || !reference(permissions, c.keyReference.epoch) || !reference(cardinal, c.keyReference.epoch)
    || permissions.recordId !== '5864be11-7936-43c5-a8bc-5c725df6c1fd'
    || cardinal.recordId !== 'ea230e88-65fc-4c35-b05d-1792c00471cf') return null;
  return { ...c, workspaceId: workspaceId as string, label, storageSessionId: storageSessionId as string,
    guestBootId: guestBootId as string, guestChannelId: guestChannelId as string,
    consentUntilMs: Number(consentUntilMs), permissions, cardinal };
}
export function automationConsentMessage(value: AutomationConsentChallenge): string {
  const c = parseAutomationConsentChallenge(value);
  if (!c) throw new Error('Invalid local automation consent.');
  const ref = (r: VaultAuthorityReference) => [r.recordId, r.version, r.digest, r.epoch];
  return 'josi-automation-consent.1\n' + JSON.stringify([
    c.schemaVersion, c.id, c.nonce, c.serverOrigin, c.serverId, c.userId, c.deviceId,
    ref(c.keyReference), c.wrappingFingerprint, c.issuedAtMs, c.expiresAtMs,
    c.workspaceId, c.label, c.storageSessionId, c.guestBootId, c.guestChannelId, c.consentUntilMs,
    ref(c.permissions), ref(c.cardinal),
  ]);
}
