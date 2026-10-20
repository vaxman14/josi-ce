// Canonical app identities, not execution authority. An adapter must recheck
// the actual guest app/signature before resolving one of these targets.
import { parseProtectedControlPresentation, type AutomationIdentity, type ProtectedControlPresentation } from '@josi-ce/protocol';
import type { Db } from './db.js';
import { cardinalContentDigest } from './cardinalRules.js';
import { isAutomationIdentity } from './automationPermissions.js';
import { Secret } from './sealing.js';
import { VaultRecordError, VaultRecordConflictError, type VaultRecordReference, type VaultRecordValue } from './vaultRecords.js';
import { isAutomationModelCandidate, isAutomationModelTarget, requireCurrentAutomationModel, describeAutomationModel,
  type AutomationModelCandidate, type AutomationModelTarget } from './automationModelTargets.js';

export const AUTOMATION_TARGETS_RECORD_ID = '32eae367-3509-4241-9829-81c28b7b4088';
export interface ApplicationCandidate {
  schemaVersion: '1'; candidateId: string; guestBootId: string; kind: 'application';
  label: string; bundlePath: string; bundleId: string; signingId: string; teamId: string; codeHash: string;
}
export interface AutomationApplicationTarget {
  applicationId: string; installationRevision: 1; identity: AutomationIdentity;
  candidate: ApplicationCandidate; registeredAt: string;
}
export interface AutomationTargetRegistration {
  actorUserId: string; identity: AutomationIdentity; candidate: ApplicationCandidate | AutomationModelCandidate; expected: VaultRecordReference | null;
}
export interface AutomationTargetCommand { purpose: 'automation.target.register'; requestDigest: string }
export interface AutomationTargetAuthority {
  verifyFreshAdministrator(tx: Db, actor: string, command: AutomationTargetCommand): Promise<void>;
  verifyProtectedHuman(tx: Db, actor: string, command: AutomationTargetCommand, presentation: ProtectedControlPresentation): Promise<void>;
}
interface Context {
  tx: Db; reconciliationRequired: boolean;
  read(): Promise<VaultRecordValue | null>;
  requireWorkspace(identity: AutomationIdentity): Promise<void>;
  write(value: Secret): Promise<VaultRecordReference>;
}
type Backend = <T>(actor: string, writing: boolean, work: (context: Context) => Promise<T>, existingTransaction?: Db) => Promise<T>;
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string'
  && (empty || v.length > 0) && v.trim() === v && Buffer.byteLength(v, 'utf8') <= max
  && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
export function isApplicationCandidate(v: unknown): v is ApplicationCandidate {
  return exact(v, ['schemaVersion', 'candidateId', 'guestBootId', 'kind', 'label', 'bundlePath', 'bundleId', 'signingId', 'teamId', 'codeHash'])
    && v.schemaVersion === '1' && v.kind === 'application' && uuid(v.candidateId) && uuid(v.guestBootId)
    && text(v.label, 96) && text(v.bundlePath, 768) && v.bundlePath.startsWith('/') && v.bundlePath.endsWith('.app')
    && !v.bundlePath.split('/').some((p, i) => i > 0 && (!p || p === '.' || p === '..'))
    && text(v.bundleId, 200) && text(v.signingId, 200) && text(v.teamId, 64, true)
    && typeof v.codeHash === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.codeHash);
}
export function readAutomationTargets(record: VaultRecordValue | null): AutomationApplicationTarget[] {
  return readAutomationTargetDocument(record).applications;
}
export function readAutomationTargetDocument(record: VaultRecordValue | null): { applications: AutomationApplicationTarget[]; models: AutomationModelTarget[] } {
  if (!record) return { applications: [], models: [] };
  try {
    const doc: unknown = JSON.parse(record.value.reveal());
    if (record.kind !== 'automation_targets' || record.reference.recordId !== AUTOMATION_TARGETS_RECORD_ID
      || !(exact(doc, ['schemaVersion', 'applications']) && doc.schemaVersion === 1
        || exact(doc, ['schemaVersion', 'applications', 'models']) && doc.schemaVersion === 2)
      || !Array.isArray(doc.applications) || doc.applications.length > 256) throw new Error();
    const entries = doc.applications as AutomationApplicationTarget[];
    const models = doc.schemaVersion === 1 ? [] : doc.models;
    if (!Array.isArray(models) || models.length + entries.length > 256 || !models.every(isAutomationModelTarget)) throw new Error();
    if (entries.some(e => !exact(e, ['applicationId', 'installationRevision', 'identity', 'candidate', 'registeredAt'])
      || !uuid(e.applicationId) || e.installationRevision !== 1 || !isAutomationIdentity(e.identity)
      || !isApplicationCandidate(e.candidate) || e.applicationId !== e.candidate.candidateId
      || typeof e.registeredAt !== 'string' || !Number.isFinite(Date.parse(e.registeredAt))
      || new Date(e.registeredAt).toISOString() !== e.registeredAt)
      || new Set([...entries.map(e => e.applicationId), ...models.map(e => e.configurationId)]).size !== entries.length + models.length) throw new Error();
    return { applications: entries, models };
  } catch { throw new VaultRecordError('The automation target registry is invalid.'); }
}
export function sameAutomationIdentity(a: AutomationIdentity, b: AutomationIdentity): boolean {
  return a.userId === b.userId && a.serverId === b.serverId && a.deviceId === b.deviceId && a.workspaceId === b.workspaceId;
}
function binding(args: AutomationTargetRegistration): AutomationTargetCommand {
  return { purpose: 'automation.target.register', requestDigest: cardinalContentDigest({
    identity: args.identity, candidate: args.candidate, expected: args.expected,
  }) };
}
async function prepare(context: Context, args: AutomationTargetRegistration) {
  if (context.reconciliationRequired || !isAutomationIdentity(args.identity)
    || args.identity.userId !== args.actorUserId || !(isApplicationCandidate(args.candidate) || isAutomationModelCandidate(args.candidate))) {
    throw new VaultRecordError('Choose an exact app or model target for your own enrolled workspace.');
  }
  await context.requireWorkspace(args.identity);
  const record = await context.read(), document = readAutomationTargetDocument(record), entries = document.applications, models = document.models, ref = record?.reference ?? null;
  if (!(ref === null && args.expected === null || ref && args.expected
    && exact(args.expected, ['recordId', 'version', 'digest', 'epoch'])
    && ref.recordId === args.expected.recordId && ref.version === args.expected.version
    && ref.digest === args.expected.digest && ref.epoch === args.expected.epoch)) {
    throw new VaultRecordConflictError('The target registry changed. Refresh and review the current selection.');
  }
  if (entries.length + models.length >= 256 || [...entries.map(e => e.applicationId), ...models.map(e => e.configurationId)].includes(args.candidate.candidateId)) {
    throw new VaultRecordError('This selection is already registered or the target registry is full.');
  }
  if (args.candidate.kind === 'model') {
    const candidate = args.candidate;
    await requireCurrentAutomationModel(context.tx, candidate);
    if (models.some(m => sameAutomationIdentity(m.identity, args.identity) && m.candidate.configurationDigest === candidate.configurationDigest)) {
      throw new VaultRecordError('This exact model configuration is already registered for this workspace.');
    }
    const target: AutomationModelTarget = { configurationId: candidate.candidateId, configurationRevision: 1,
      identity: args.identity, candidate, registeredAt: new Date().toISOString() };
    const i = args.identity;
    const presentation = parseProtectedControlPresentation({
      wording: `Register ${candidate.providerId} / ${candidate.model} as a model destination for permission setup.`,
      meaning: [
        `User: ${i.userId}\nServer: ${i.serverId}\nDevice: ${i.deviceId}\nWorkspace: ${i.workspaceId}`,
        describeAutomationModel(target),
        'This stores the exact configured destination in the Vault. Registration sends no content and grants no transmission permission. Configure model.transmit and its limits separately.',
        'Any saved configuration change invalidates this destination. Existing grants do not move to the new configuration or another provider. A fallback requires its own exact permission.',
        'The executor must match this current configuration immediately before every transmission. This does not enable an unfinished observation or model-projection adapter.',
      ].join('\n\n'), advisory: [],
    });
    if (!presentation) throw new VaultRecordError('The exact model destination cannot be displayed safely.');
    return { entries, models, presentation };
  }
  const candidate = args.candidate;
  if (entries.some(e => sameAutomationIdentity(e.identity, args.identity)
    && (['bundlePath', 'bundleId', 'signingId', 'teamId', 'codeHash'] as const)
      .every(key => e.candidate[key] === candidate[key]))) {
    throw new VaultRecordError('This exact application is already registered. Use its existing permissions.');
  }
  const c = args.candidate, i = args.identity;
  const presentation = parseProtectedControlPresentation({
    wording: `Register ${c.label} for separate-desktop permission setup.`,
    meaning: [
      `User: ${i.userId}\nServer: ${i.serverId}\nDevice: ${i.deviceId}\nWorkspace: ${i.workspaceId}`,
      `Application: ${c.label}\nGuest location: ${c.bundlePath}\nBundle identifier: ${c.bundleId}\nSigning identifier: ${c.signingId}\nSigning team: ${c.teamId || '(no team identifier)'}\nCode hash: ${c.codeHash}`,
      `Target: ${c.candidateId}\nInstallation revision: 1\nSelected during guest boot: ${c.guestBootId}`,
      'This saves the reviewed app identity in the Vault. It grants no observation, input, launch, network, file or credential access. Configure those permissions separately.',
      'This record is immutable. A different app installation must be selected and registered under a new target; existing grants do not move to it.',
      'The executor must verify the actual app against this identity before each use. This selection is not remote attestation or proof that an app is safe.',
    ].join('\n\n'), advisory: [],
  });
  if (!presentation) throw new VaultRecordError('The full application identity cannot be displayed safely.');
  return { entries, models, presentation };
}
export class AutomationTargetStore {
  constructor(private readonly backend: Backend, private readonly authority: AutomationTargetAuthority) {}
  /** Trusted transport resolution, under the same transaction as its live
   * device/session check. This returns identity metadata, never an input grant. */
  resolve(actor: string, identity: AutomationIdentity, applicationId: string, installationRevision: number, transaction: Db) {
    const scope = structuredClone(identity);
    if (!isAutomationIdentity(scope) || scope.userId !== actor || !uuid(applicationId)
      || !Number.isSafeInteger(installationRevision) || installationRevision < 1) {
      throw new VaultRecordError('Choose an exact registered application in this workspace.');
    }
    return this.backend(actor, false, async context => {
      if (context.reconciliationRequired) throw new VaultRecordError('Vault authority requires recovery reconciliation.');
      await context.requireWorkspace(scope);
      const record = await context.read();
      const target = readAutomationTargets(record).find(t => t.applicationId === applicationId
        && t.installationRevision === installationRevision && sameAutomationIdentity(t.identity, scope));
      if (!target || !record) throw new VaultRecordError('This application installation is not registered for the current workspace.');
      return { reference: record.reference, application: {
        workspaceId: scope.workspaceId, applicationId, installationRevision,
        bundlePath: target.candidate.bundlePath, bundleId: target.candidate.bundleId,
        signingId: target.candidate.signingId, teamId: target.candidate.teamId, codeHash: target.candidate.codeHash,
      } };
    }, transaction);
  }
  inventory(actor: string) {
    return this.backend(actor, false, async context => {
      const record = await context.read(), document = readAutomationTargetDocument(record);
      return { reference: record?.reference ?? null,
        applications: document.applications.filter(e => e.identity.userId === actor),
        models: document.models.filter(e => e.identity.userId === actor),
        reconciliationRequired: context.reconciliationRequired, executionEnabled: false as const };
    });
  }
  /** Resolves a canonical destination in the same TX as transmission authority.
   * The caller must bind this to the actual registry dispatch, not a tool
   * argument or a later unpinned/fallback chat call. */
  resolveModel(actor: string, identity: AutomationIdentity, configurationId: string, configurationRevision: number, transaction: Db) {
    const scope = structuredClone(identity);
    if (!isAutomationIdentity(scope) || scope.userId !== actor || !uuid(configurationId) || configurationRevision !== 1) {
      throw new VaultRecordError('Choose an exact registered model configuration for this workspace.');
    }
    return this.backend(actor, false, async context => {
      if (context.reconciliationRequired) throw new VaultRecordError('Vault authority requires recovery reconciliation.');
      await context.requireWorkspace(scope);
      const record = await context.read();
      const target = readAutomationTargetDocument(record).models.find(m => m.configurationId === configurationId
        && m.configurationRevision === configurationRevision && sameAutomationIdentity(m.identity, scope));
      if (!record || !target) throw new VaultRecordError('The model destination is not registered for this workspace.');
      await requireCurrentAutomationModel(context.tx, target.candidate);
      return { reference: record.reference, target: structuredClone(target) };
    }, transaction);
  }
  prepareRegistration(input: AutomationTargetRegistration) {
    const args = structuredClone(input);
    return this.backend(args.actorUserId, false, async context => ({
      command: binding(args), presentation: (await prepare(context, args)).presentation,
    }));
  }
  register(input: AutomationTargetRegistration) {
    const args = structuredClone(input), command = binding(args);
    return this.backend(args.actorUserId, true, async context => {
      const { entries, models, presentation } = await prepare(context, args);
      await this.authority.verifyFreshAdministrator(context.tx, args.actorUserId, command);
      await this.authority.verifyProtectedHuman(context.tx, args.actorUserId, command, presentation);
      if (args.candidate.kind === 'model') {
        models.push({ configurationId: args.candidate.candidateId, configurationRevision: 1, identity: args.identity,
          candidate: args.candidate, registeredAt: new Date().toISOString() });
      } else {
        entries.push({ applicationId: args.candidate.candidateId, installationRevision: 1, identity: args.identity,
          candidate: args.candidate, registeredAt: new Date().toISOString() });
      }
      const reference = await context.write(new Secret(JSON.stringify(models.length
        ? { schemaVersion: 2, applications: entries, models } : { schemaVersion: 1, applications: entries })));
      return { reference };
    });
  }
}
