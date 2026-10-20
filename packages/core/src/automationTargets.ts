// Canonical app identities, not execution authority. An adapter must recheck
// the actual guest app/signature before resolving one of these targets.
import { parseProtectedControlPresentation, type AutomationIdentity, type ProtectedControlPresentation } from '@josi-ce/protocol';
import type { Db } from './db.js';
import { cardinalContentDigest } from './cardinalRules.js';
import { isAutomationIdentity } from './automationPermissions.js';
import { Secret } from './sealing.js';
import { VaultRecordError, VaultRecordConflictError, type VaultRecordReference, type VaultRecordValue } from './vaultRecords.js';

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
  actorUserId: string; identity: AutomationIdentity; candidate: ApplicationCandidate; expected: VaultRecordReference | null;
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
  if (!record) return [];
  try {
    const doc: unknown = JSON.parse(record.value.reveal());
    if (record.kind !== 'automation_targets' || record.reference.recordId !== AUTOMATION_TARGETS_RECORD_ID
      || !exact(doc, ['schemaVersion', 'applications']) || doc.schemaVersion !== 1
      || !Array.isArray(doc.applications) || doc.applications.length > 256) throw new Error();
    const entries = doc.applications as AutomationApplicationTarget[];
    if (entries.some(e => !exact(e, ['applicationId', 'installationRevision', 'identity', 'candidate', 'registeredAt'])
      || !uuid(e.applicationId) || e.installationRevision !== 1 || !isAutomationIdentity(e.identity)
      || !isApplicationCandidate(e.candidate) || e.applicationId !== e.candidate.candidateId
      || typeof e.registeredAt !== 'string' || !Number.isFinite(Date.parse(e.registeredAt))
      || new Date(e.registeredAt).toISOString() !== e.registeredAt)
      || new Set(entries.map(e => e.applicationId)).size !== entries.length) throw new Error();
    return entries;
  } catch { throw new VaultRecordError('The application target registry is invalid.'); }
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
    || args.identity.userId !== args.actorUserId || !isApplicationCandidate(args.candidate)) {
    throw new VaultRecordError('Choose an exact guest application in your own enrolled workspace.');
  }
  await context.requireWorkspace(args.identity);
  const record = await context.read(), entries = readAutomationTargets(record), ref = record?.reference ?? null;
  if (!(ref === null && args.expected === null || ref && args.expected
    && exact(args.expected, ['recordId', 'version', 'digest', 'epoch'])
    && ref.recordId === args.expected.recordId && ref.version === args.expected.version
    && ref.digest === args.expected.digest && ref.epoch === args.expected.epoch)) {
    throw new VaultRecordConflictError('The application registry changed. Refresh and review the current selection.');
  }
  if (entries.length >= 256 || entries.some(e => e.applicationId === args.candidate.candidateId)) {
    throw new VaultRecordError('This app selection is already registered or the target registry is full.');
  }
  if (entries.some(e => sameAutomationIdentity(e.identity, args.identity)
    && (['bundlePath', 'bundleId', 'signingId', 'teamId', 'codeHash'] as const)
      .every(key => e.candidate[key] === args.candidate[key]))) {
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
  return { entries, presentation };
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
      const record = await context.read();
      return { reference: record?.reference ?? null,
        applications: readAutomationTargets(record).filter(e => e.identity.userId === actor),
        reconciliationRequired: context.reconciliationRequired, executionEnabled: false as const };
    });
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
      const { entries, presentation } = await prepare(context, args);
      await this.authority.verifyFreshAdministrator(context.tx, args.actorUserId, command);
      await this.authority.verifyProtectedHuman(context.tx, args.actorUserId, command, presentation);
      entries.push({ applicationId: args.candidate.candidateId, installationRevision: 1, identity: args.identity,
        candidate: args.candidate, registeredAt: new Date().toISOString() });
      const reference = await context.write(new Secret(JSON.stringify({ schemaVersion: 1, applications: entries })));
      return { reference };
    });
  }
}
