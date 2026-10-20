import { parseAutomationConsentChallenge, type AutomationConsentChallenge, type AutomationIdentity } from '@josi-ce/protocol';
import type { Db } from './db.js';
import { Secret } from './sealing.js';
import { VaultRecordError, type VaultRecordReference, type VaultRecordValue } from './vaultRecords.js';

export interface AutomationConsentAuthority {
  /** Current authenticated native storage connection, never client booleans.
   * Called under the Vault lock, including on every later resolution. */
  requireConnection(tx: Db, challenge: AutomationConsentChallenge): Promise<void>;
  /** One-use exact hardware proof, inside this same transaction. */
  verifyLocalHuman(tx: Db, challenge: AutomationConsentChallenge, proof: unknown): Promise<void>;
}
export interface AutomationConsentContext {
  tx: Db; epoch: number;
  policies(): Promise<{ permissions: VaultRecordReference; cardinal: VaultRecordReference }>;
  read(): Promise<VaultRecordValue | null>;
  write(value: Secret): Promise<VaultRecordReference>;
}
export type AutomationConsentBackend = <T>(actor: string, identity: AutomationIdentity, sessionId: string,
  writing: boolean, work: (context: AutomationConsentContext) => Promise<T>) => Promise<T>;
export interface AutomationConsentDocument {
  schemaVersion: 1; state: 'active' | 'stopped'; challenge: AutomationConsentChallenge;
}
const identityOf = (c: AutomationConsentChallenge): AutomationIdentity =>
  ({ userId: c.userId, serverId: c.serverId, deviceId: c.deviceId, workspaceId: c.workspaceId });
const same = (a: VaultRecordReference, b: VaultRecordReference) => a.recordId === b.recordId
  && a.version === b.version && a.digest === b.digest && a.epoch === b.epoch;
const unavailable = () => new VaultRecordError('Local automation consent is unavailable. Review it again in the enrolled native app.');
export function readAutomationConsentRecord(record: VaultRecordValue | null, actor: string, sessionId: string): AutomationConsentDocument | null {
  if (!record) return null;
  try {
    const d = JSON.parse(record.value.reveal()) as AutomationConsentDocument;
    if (record.kind !== 'automation_consent' || record.reference.recordId !== sessionId
      || !d || Object.keys(d).sort().join(',') !== 'challenge,schemaVersion,state' || d.schemaVersion !== 1
      || !['active', 'stopped'].includes(d.state) || !parseAutomationConsentChallenge(d.challenge)
      || d.challenge.userId !== actor || d.challenge.storageSessionId !== sessionId) throw unavailable();
    return d;
  } catch { throw unavailable(); }
}
export class AutomationConsentStore {
  constructor(private backend: AutomationConsentBackend, private authority: AutomationConsentAuthority) {}
  policies(actor: string, identity: AutomationIdentity, sessionId: string) {
    return this.backend(actor, identity, sessionId, false, c => c.policies());
  }
  grant(actor: string, input: AutomationConsentChallenge, proof: unknown) {
    const challenge = parseAutomationConsentChallenge(input);
    if (!challenge || actor !== challenge.userId) throw unavailable();
    return this.backend(actor, identityOf(challenge), challenge.storageSessionId, true, async c => {
      const now = Date.now();
      if (c.epoch !== challenge.keyReference.epoch || now < challenge.issuedAtMs || now >= challenge.expiresAtMs) throw unavailable();
      const policies = await c.policies();
      if (!same(policies.permissions, challenge.permissions) || !same(policies.cardinal, challenge.cardinal)) throw unavailable();
      await this.authority.requireConnection(c.tx, challenge);
      const previous = readAutomationConsentRecord(await c.read(), actor, challenge.storageSessionId);
      if (previous?.state === 'active') throw new VaultRecordError('Stop the previous local automation approval before enabling it again.');
      await this.authority.verifyLocalHuman(c.tx, challenge, proof);
      if (Date.now() >= challenge.expiresAtMs || Date.now() < challenge.issuedAtMs) throw unavailable();
      const reference = await c.write(new Secret(JSON.stringify({ schemaVersion: 1, state: 'active', challenge } satisfies AutomationConsentDocument)));
      return { reference, permissions: policies.permissions, cardinal: policies.cardinal, expiresAtMs: challenge.consentUntilMs };
    });
  }
  resolve(actor: string, identity: AutomationIdentity, sessionId: string, expected: VaultRecordReference) {
    return this.backend(actor, identity, sessionId, false, async c => {
      const record = await c.read(), d = readAutomationConsentRecord(record, actor, sessionId);
      if (!record || !d || d.state !== 'active' || !same(record.reference, expected)
        || c.epoch !== d.challenge.keyReference.epoch || Date.now() < d.challenge.issuedAtMs
        || Date.now() >= d.challenge.consentUntilMs
        || Object.entries(identityOf(d.challenge)).some(([k, v]) => identity[k as keyof AutomationIdentity] !== v)) throw unavailable();
      const policies = await c.policies();
      if (!same(policies.permissions, d.challenge.permissions) || !same(policies.cardinal, d.challenge.cardinal)) throw unavailable();
      await this.authority.requireConnection(c.tx, d.challenge);
      return { reference: record.reference, ...policies, expiresAtMs: d.challenge.consentUntilMs,
        guestBootId: d.challenge.guestBootId, guestChannelId: d.challenge.guestChannelId };
    });
  }
  stop(actor: string, identity: AutomationIdentity, sessionId: string) {
    return this.backend(actor, identity, sessionId, true, async c => {
      const d = readAutomationConsentRecord(await c.read(), actor, sessionId);
      if (!d || d.state === 'stopped') return;
      if (Object.entries(identityOf(d.challenge)).some(([k, v]) => identity[k as keyof AutomationIdentity] !== v)) throw unavailable();
      // Reducing access needs no new human proof or matching old epoch.
      await c.write(new Secret(JSON.stringify({ ...d, state: 'stopped' } satisfies AutomationConsentDocument)));
    });
  }
}
