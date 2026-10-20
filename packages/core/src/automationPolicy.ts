// Canonical automation grants live only in the existing Vault. A policy edit
// cannot enroll a device or authorize a dispatch; device-owner consent is an
// independent local gate, including when the server is on another machine.
import { AUTOMATION_PERMISSION_SEMANTICS, type AutomationPermissionPolicy, type AutomationPermissionEvaluation, type ProtectedControlPresentation } from '@josi-ce/protocol';
import type { Db } from './db.js';
import { cardinalContentDigest } from './cardinalRules.js';
import { evaluateAutomationPermissions, isAutomationIdentity, validateAutomationPermissionPolicy, type AutomationPermissionFacts } from './automationPermissions.js';
import { VaultRecordConflictError, VaultRecordError, type VaultRecordReference, type VaultRecordValue } from './vaultRecords.js';
import { Secret } from './sealing.js';
import { automationReplacementPresentation } from './automationPolicyReview.js';

export const AUTOMATION_POLICY_RECORD_ID = '5864be11-7936-43c5-a8bc-5c725df6c1fd';
export const AUTOMATION_ENFORCEMENT_VERSION = 'automation-enforcement.1';
export interface AutomationPolicyDocument {
  schemaVersion: 1; enforcementVersion: string; policies: AutomationPermissionPolicy[];
  lastChange: { actorUserId: string; at: string };
}
export interface AutomationPolicyView {
  reference: VaultRecordReference; document: AutomationPolicyDocument;
  reconciliationRequired: boolean; enforcementCurrent: boolean;
}
export interface AutomationPolicyCommand { purpose: 'automation.policy.replace'; requestDigest: string }
export interface AutomationPolicyReplacement { actorUserId: string; policy: AutomationPermissionPolicy; expected: VaultRecordReference | null }
export interface AutomationPolicyProtectedReview { command: AutomationPolicyCommand; presentation: ProtectedControlPresentation }
export interface AutomationPolicyAuthority {
  /** Trusted local verifiers. No HTTP/LLM callbacks or dialog/network waits
   * inside a transaction. Both proofs must bind this exact command. */
  verifyFreshAdministrator(tx: Db, actorUserId: string, command: AutomationPolicyCommand): Promise<void>;
  verifyProtectedHuman(tx: Db, actorUserId: string, command: AutomationPolicyCommand, presentation: ProtectedControlPresentation): Promise<void>;
}
export interface AutomationPolicyTransaction {
  tx: Db; reconciliationRequired: boolean;
  readPolicy(): Promise<VaultRecordValue | null>;
  requireApplicationTargets(policy: AutomationPermissionPolicy): Promise<string[]>;
  writePolicy(value: Secret): Promise<VaultRecordReference>;
}
export type AutomationPolicyBackend = <T>(actorUserId: string, writing: boolean, work: (tx: AutomationPolicyTransaction) => Promise<T>) => Promise<T>;
export interface AutomationPolicyDecision {
  verdict: AutomationPermissionEvaluation['verdict'];
  code: 'evaluated' | 'policy_missing' | 'identity_unavailable' | 'requires_revalidation';
  policy: VaultRecordReference | null;
  evaluation: AutomationPermissionEvaluation | null;
}
function identityKey(identity: AutomationPermissionPolicy['identity']): string {
  return [identity.userId, identity.serverId, identity.deviceId, identity.workspaceId].join(':');
}
export function readAutomationPolicyRecord(record: VaultRecordValue, reconciliationRequired: boolean): AutomationPolicyView {
  let doc: AutomationPolicyDocument;
  try { doc = JSON.parse(record.value.reveal()); } catch { throw new VaultRecordError('The automation policy is unreadable.'); }
  if (record.kind !== 'automation_policy' || record.reference.recordId !== AUTOMATION_POLICY_RECORD_ID
    || doc?.schemaVersion !== 1 || Object.keys(doc).sort().join(',') !== 'enforcementVersion,lastChange,policies,schemaVersion'
    || typeof doc.enforcementVersion !== 'string' || !Array.isArray(doc.policies) || doc.policies.length > 100
    || !doc.lastChange || Object.keys(doc.lastChange).sort().join(',') !== 'actorUserId,at'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(doc.lastChange.actorUserId)
    || typeof doc.lastChange.at !== 'string' || !Number.isFinite(Date.parse(doc.lastChange.at))
    || doc.policies.some(p => !p || typeof p.semanticsVersion !== 'string'
      || !validateAutomationPermissionPolicy({ ...p, semanticsVersion: AUTOMATION_PERMISSION_SEMANTICS }).valid)
    || new Set(doc.policies.map(p => identityKey(p.identity))).size !== doc.policies.length
    || new Set(doc.policies.flatMap(p => p.rules.map(r => r.id))).size !== doc.policies.reduce((n, p) => n + p.rules.length, 0)) {
    throw new VaultRecordError('The automation policy is invalid.');
  }
  return { reference: record.reference, document: doc, reconciliationRequired,
    enforcementCurrent: doc.enforcementVersion === AUTOMATION_ENFORCEMENT_VERSION
      && doc.policies.every(p => p.semanticsVersion === AUTOMATION_PERMISSION_SEMANTICS) };
}
export function automationPolicyChangeBinding(args: { policy: AutomationPermissionPolicy; expected: VaultRecordReference | null }): AutomationPolicyCommand {
  return { purpose: 'automation.policy.replace', requestDigest: cardinalContentDigest({ policy: args.policy, expected: args.expected }) };
}
/** Internal evaluation of a current authenticated Vault snapshot. No policy
 * contents or authority-expansion capability are returned to the agent. */
export function evaluateAutomationPolicyRecord(record: VaultRecordValue, facts: AutomationPermissionFacts): AutomationPolicyDecision {
  const current = readAutomationPolicyRecord(record, false);
  if (!current.enforcementCurrent) return { verdict: 'pause', code: 'requires_revalidation', policy: record.reference, evaluation: null };
  if (!isAutomationIdentity(facts?.identity)) return { verdict: 'pause', code: 'identity_unavailable', policy: record.reference, evaluation: null };
  const match = current.document.policies.find(p => identityKey(p.identity) === identityKey(facts.identity));
  if (!match) return { verdict: 'deny', code: 'policy_missing', policy: record.reference, evaluation: null };
  const evaluation = evaluateAutomationPermissions(match, facts);
  return { verdict: evaluation.verdict, code: 'evaluated', policy: record.reference, evaluation };
}
async function replacementContents(tx: AutomationPolicyTransaction, snapshot: AutomationPolicyReplacement) {
  if (tx.reconciliationRequired) throw new VaultRecordError('Vault authority requires recovery reconciliation.');
  const parsed = validateAutomationPermissionPolicy(snapshot.policy);
  if (!parsed.valid) throw new VaultRecordError('Use exact supported automation permissions and explicit limits.');
  const record = await tx.readPolicy(), current = record ? readAutomationPolicyRecord(record, tx.reconciliationRequired) : null;
  if (!(current === null && snapshot.expected === null || current && snapshot.expected
    && current.reference.recordId === snapshot.expected.recordId && current.reference.version === snapshot.expected.version
    && current.reference.digest === snapshot.expected.digest && current.reference.epoch === snapshot.expected.epoch)) {
    throw new VaultRecordConflictError('Automation permissions changed. Review the current settings again.');
  }
  if (current && !current.enforcementCurrent) throw new VaultRecordError('Automation permissions require enforcement revalidation.');
  const applicationTargets = await tx.requireApplicationTargets(parsed.policy);
  const [subject] = await tx.tx.query("select id from users where id=$1 and status='active' for share", [parsed.policy.identity.userId]);
  if (!subject) throw new VaultRecordError('The automation user is unavailable.');
  const policies = current ? [...current.document.policies] : [];
  const index = policies.findIndex(p => identityKey(p.identity) === identityKey(parsed.policy.identity));
  if (index < 0) policies.push(parsed.policy); else policies[index] = parsed.policy;
  if (policies.length > 100 || new Set(policies.flatMap(p => p.rules.map(r => r.id))).size !== policies.reduce((n, p) => n + p.rules.length, 0)) {
    throw new VaultRecordError('Use unique permission rule identities within the supported policy count.');
  }
  const previous = current?.document.policies.find(p => identityKey(p.identity) === identityKey(parsed.policy.identity)) ?? null;
  return { policies, presentation: automationReplacementPresentation(previous, parsed.policy, applicationTargets) };
}
export class AutomationPolicyStore {
  constructor(private readonly backend: AutomationPolicyBackend, private readonly authority: AutomationPolicyAuthority) {}
  async read(actorUserId: string): Promise<AutomationPolicyView | null> {
    return this.backend(actorUserId, false, async tx => { const record = await tx.readPolicy(); return record ? readAutomationPolicyRecord(record, tx.reconciliationRequired) : null; });
  }
  /** Read-only exact review, regenerated at the eventual protected mutation. */
  async prepareReplacement(args: AutomationPolicyReplacement): Promise<AutomationPolicyProtectedReview> {
    const snapshot = structuredClone(args);
    return this.backend(snapshot.actorUserId, false, async tx => {
      const { presentation } = await replacementContents(tx, snapshot);
      return { command: automationPolicyChangeBinding(snapshot), presentation };
    });
  }
  /** Exact replacement of one identity's policy; all other identities remain
   * unchanged. Disable/remove grants by explicitly saving a disabled policy.
   * History is append-only and every replacement needs protected confirmation. */
  async replace(args: AutomationPolicyReplacement): Promise<AutomationPolicyView> {
    const snapshot = structuredClone(args), parsed = validateAutomationPermissionPolicy(snapshot.policy);
    if (!parsed.valid) throw new VaultRecordError('Use exact supported automation permissions and explicit limits.');
    const command = Object.freeze(automationPolicyChangeBinding(snapshot));
    return this.backend(snapshot.actorUserId, true, async tx => {
      const { policies, presentation } = await replacementContents(tx, snapshot);
      if (typeof this.authority?.verifyFreshAdministrator !== 'function' || typeof this.authority?.verifyProtectedHuman !== 'function') {
        throw new VaultRecordError('Protected human confirmation is unavailable.');
      }
      await this.authority.verifyFreshAdministrator(tx.tx, snapshot.actorUserId, command);
      await this.authority.verifyProtectedHuman(tx.tx, snapshot.actorUserId, command, presentation);
      const document: AutomationPolicyDocument = { schemaVersion: 1, enforcementVersion: AUTOMATION_ENFORCEMENT_VERSION, policies,
        lastChange: { actorUserId: snapshot.actorUserId, at: new Date().toISOString() } };
      const reference = await tx.writePolicy(new Secret(JSON.stringify(document)));
      return { reference, document, reconciliationRequired: false, enforcementCurrent: true };
    });
  }
}
