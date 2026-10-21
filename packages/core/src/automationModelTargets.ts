// Model destination identity only. No credential read, provider call, policy
// grant or permission to transmit content occurs here.
import { randomUUID } from 'node:crypto';
import type { AutomationIdentity } from '@josi-ce/protocol';
import type { Db } from './db.js';
import { cardinalContentDigest } from './cardinalRules.js';
import { isAutomationIdentity } from './automationPermissions.js';
import { VaultRecordError } from './vaultRecords.js';

export interface AutomationModelCandidate {
  schemaVersion: '1'; kind: 'model'; candidateId: string;
  role: 'primary' | 'fallback'; providerId: string; model: string;
  configurationVersion: string; baseUrl: string | null; configurationDigest: string;
}
export interface AutomationModelTarget {
  configurationId: string; configurationRevision: 1; identity: AutomationIdentity;
  candidate: AutomationModelCandidate; registeredAt: string;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const exact = (v: unknown, fields: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === fields.length && fields.every(f => Object.hasOwn(v, f));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() === v
  && v.length > 0 && Buffer.byteLength(v, 'utf8') <= max && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
function baseUrl(value: unknown): boolean {
  if (value === null) return true;
  if (!text(value, 2048) || /[\s\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export function isAutomationModelCandidate(v: unknown): v is AutomationModelCandidate {
  return exact(v, ['schemaVersion', 'kind', 'candidateId', 'role', 'providerId', 'model', 'configurationVersion', 'baseUrl', 'configurationDigest'])
    && v.schemaVersion === '1' && v.kind === 'model' && uuid(v.candidateId) && ['primary', 'fallback'].includes(String(v.role))
    && text(v.providerId, 64) && /^[a-z0-9_]+$/.test(v.providerId) && text(v.model, 256)
    && text(v.configurationVersion, 100) && baseUrl(v.baseUrl)
    && typeof v.configurationDigest === 'string' && /^[a-f0-9]{64}$/.test(v.configurationDigest);
}
export function isAutomationModelTarget(v: unknown): v is AutomationModelTarget {
  return exact(v, ['configurationId', 'configurationRevision', 'identity', 'candidate', 'registeredAt'])
    && uuid(v.configurationId) && v.configurationRevision === 1 && isAutomationIdentity(v.identity)
    && isAutomationModelCandidate(v.candidate) && v.candidate.candidateId === v.configurationId
    && typeof v.registeredAt === 'string' && Number.isFinite(Date.parse(v.registeredAt))
    && new Date(v.registeredAt).toISOString() === v.registeredAt;
}
/** Bind all saved routing metadata, not merely the visible model name.
 * updated_at also changes on saves/probes/credential replacement. Final
 * transmission must additionally use the LLM registry's expectedPrimary
 * guard, current credential version, local-only policy and beforeDispatch. */
export async function currentAutomationModelCandidate(db: Db, role: 'primary' | 'fallback', id: string): Promise<AutomationModelCandidate | null> {
  if (!['primary', 'fallback'].includes(role) || !uuid(id)) throw new VaultRecordError('Choose an exact configured model.');
  const [row] = await db.query<{
    role: 'primary' | 'fallback'; provider: string; model: string; base_url: string | null;
    updated_at: string; activated_at: string | null; probed_at: string | null; cap_chat: boolean | null;
    provider_config: unknown; subscription_command: string | null;
  }>(`select role,provider,model,base_url,updated_at::text as updated_at,activated_at,probed_at,cap_chat,
      provider_config,subscription_command from llm_providers where role=$1 for share`, [role]);
  if (!row?.activated_at || !row.probed_at || row.cap_chat !== true) return null;
  // ChatGPT captures use a supervised inference invocation, with Josi owning
  // each proposed action. A named model is required for a stable destination.
  if (row.provider === 'anthropic_subscription' || !row.model.trim()) return null;
  const routing = { role: row.role, provider: row.provider, model: row.model, baseUrl: row.base_url,
    configurationVersion: row.updated_at, providerConfig: row.provider_config, subscriptionCommand: row.subscription_command };
  if (Buffer.byteLength(JSON.stringify(routing), 'utf8') > 16 * 1024) throw new VaultRecordError('The saved model configuration is too large to register.');
  const candidate: AutomationModelCandidate = { schemaVersion: '1', kind: 'model', candidateId: id,
    role: row.role, providerId: row.provider, model: row.model, configurationVersion: row.updated_at,
    baseUrl: row.base_url, configurationDigest: cardinalContentDigest(routing) };
  if (!isAutomationModelCandidate(candidate)) throw new VaultRecordError('The saved model destination cannot be represented exactly.');
  return candidate;
}
export async function listAutomationModelCandidates(db: Db): Promise<AutomationModelCandidate[]> {
  const result: AutomationModelCandidate[] = [];
  for (const role of ['primary', 'fallback'] as const) {
    const candidate = await currentAutomationModelCandidate(db, role, randomUUID());
    if (candidate) result.push(candidate);
  }
  return result;
}
export async function requireCurrentAutomationModel(db: Db, candidate: AutomationModelCandidate) {
  if (!isAutomationModelCandidate(candidate)) throw new VaultRecordError('Choose an exact configured model.');
  const current = await currentAutomationModelCandidate(db, candidate.role, candidate.candidateId);
  if (!current || cardinalContentDigest(current) !== cardinalContentDigest(candidate)) {
    throw new VaultRecordError('The selected model configuration changed. Select and register the current destination before granting transmission.');
  }
}
export function describeAutomationModel(target: AutomationModelTarget): string {
  const c = target.candidate;
  return `Registered model ${target.configurationId}, configuration revision ${target.configurationRevision}:\n`
    + `Role: ${c.role}\nProvider: ${c.providerId}\nModel: ${c.model}\nEndpoint: ${c.baseUrl ?? 'Provider default'}\n`
    + `Saved configuration version: ${c.configurationVersion}\nConfiguration fingerprint: ${c.configurationDigest}`;
}
