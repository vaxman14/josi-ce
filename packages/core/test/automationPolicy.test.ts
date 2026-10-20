import { beforeEach, describe, expect, it } from 'vitest';
import { AUTOMATION_PERMISSION_SEMANTICS, type AutomationPermissionPolicy } from '@josi-ce/protocol';
import { createSession } from '../../auth/src/sessions.js';
import { hashPassword } from '../../auth/src/passwords.js';
import { reauthenticateProtectedAdmin, type ProtectedAdminBinding, type ProtectedAdminProof } from '../../auth/src/protectedAdmin.js';
import { testDb, type TestDb } from './helpers.js';
import { MasterKey } from '../src/masterKey.js';
import { Secret } from '../src/sealing.js';
import { initializeVault, recoverVault, setVaultLock, vaultRecords, type VaultRecordReference } from '../src/vault.js';
import { automationPolicyChangeBinding, AUTOMATION_POLICY_RECORD_ID, evaluateAutomationPolicyRecord, type AutomationPolicyCommand } from '../src/automationPolicy.js';
import { CardinalDraftStore, cardinalReviewInput } from '../src/cardinalDrafts.js';
import { cardinalContentDigest, type CardinalAction, type CardinalRule } from '../src/cardinalRules.js';
import { cardinalActivationBinding } from '../src/cardinalPolicy.js';
import type { AutomationPermissionFacts } from '../src/automationPermissions.js';

let db: TestDb, admin: string, member: string, sessionId: string, recovery: string;
const key = new MasterKey(Buffer.alloc(32, 83)), password = 'synthetic-permissions-password';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
beforeEach(async () => {
  db = await testDb();
  [{ id: admin }] = await db.query<{ id: string }>("insert into users(email,username,role,password_hash) values('permissions@fixture.test','permissions','super_admin',$1) returning id", [await hashPassword(password)]);
  [{ id: member }] = await db.query<{ id: string }>("insert into users(email,username,role) values('member@fixture.test','member','member') returning id");
  recovery = (await initializeVault(db, key, admin)).recoveryKey.reveal();
  sessionId = (await createSession(db, { userId: admin })).sessionId;
});
function definition(): AutomationPermissionPolicy {
  return { schemaVersion: 1, semanticsVersion: AUTOMATION_PERMISSION_SEMANTICS,
    identity: { userId: member, serverId: id(1), deviceId: id(2), workspaceId: id(3) }, enabled: true, unmatched: 'ask',
    rules: [{ id: id(4), action: 'file.read', scope: { kind: 'file', rootId: id(5), rootRevision: 1, segments: ['confidential-planning.txt'], descendants: false },
      mode: { kind: 'standing' }, limits: { maxActionsPerTask: null, maxBytesPerTask: null, maxTaskDurationMs: null } }] };
}
function facts(): AutomationPermissionFacts {
  return { identity: definition().identity, nowMs: 1001, task: { id: id(6), active: true, startedAtMs: 1 }, effectCoverage: 'verified',
    effects: [{ action: 'file.read', target: definition().rules[0].scope, bytes: 5 }], usage: [] };
}
const fresh = (command: ProtectedAdminBinding) => reauthenticateProtectedAdmin(db, key, { userId: admin, sessionId, password, ...command });
// Synthetic human verifier only. This is NOT an enrolled protected UI or an
// assertion that production can establish human presence.
const humanFixture = async (_command: AutomationPolicyCommand) => undefined;
function store(receipt?: ProtectedAdminProof, human?: (command: AutomationPolicyCommand) => Promise<void>, target = db, installKey = key) {
  return vaultRecords(target, installKey).automationPolicy({
    verifyFreshAdministrator: async (tx, actorUserId, command) => {
      if (!receipt) throw new Error('fresh proof missing');
      await receipt.check(tx, { actorUserId, ...command, consume: true });
    },
    verifyProtectedHuman: async (_tx, _actor, command) => {
      if (!human) throw new Error('human proof missing');
      await human(command);
    },
  });
}
async function replace(policy = definition(), expected: VaultRecordReference | null = null) {
  const args = { actorUserId: admin, policy, expected };
  return store(await fresh(automationPolicyChangeBinding(args)), humanFixture).replace(args);
}
async function cardinal(action: CardinalAction = 'execution.shell') {
  await db.query("insert into llm_providers(role,provider,model,activated_at,probed_at,cap_chat) values('primary','openai_compatible','fixture',now(),now(),true)");
  const definition: CardinalRule = { schemaVersion: 1, label: 'Protected restriction', wording: `Deny ${action}.`, actions: [action],
    scope: { userId: '*', serverId: '*', deviceId: '*', workspaceId: '*', taskId: '*' }, restriction: { kind: 'deny' }, onUnavailable: 'pause' };
  const drafts = new CardinalDraftStore(db, key), saved = await drafts.save({ actorUserId: admin, draft: definition });
  const [model] = await db.query<{ provider: string; model: string; version: string }>("select provider,model,updated_at::text as version from llm_providers where role='primary'");
  const tested = await drafts.test({ actorUserId: admin, expected: saved.reference, approvedReviewInputDigest: cardinalContentDigest(cardinalReviewInput(definition)),
    reviewerIdentity: { providerId: model.provider, model: model.model, configurationVersion: model.version },
    reviewer: async () => ({ status: 'available', assessment: { clarity: 'clear', summary: 'Explicit restriction.', concerns: [], suggestions: [] } }) });
  const args = { actorUserId: admin, draft: tested.reference, policy: null }, receipt = await fresh(cardinalActivationBinding(args));
  return vaultRecords(db, key).cardinalPolicy({
    verifyFreshAdministrator: async (tx, actorUserId, command) => receipt.check(tx, { actorUserId, ...command, consume: true }),
    verifyProtectedHuman: async () => undefined, // fixture only, no production verifier
  }).activate(args);
}

describe('Vault-only automation policy lifecycle', () => {
  it('requires both proofs, rejects generic writes and keeps policy/history out of indexes and audit', async () => {
    const args = { actorUserId: admin, policy: definition(), expected: null };
    await expect(vaultRecords(db, key).write({ actorUserId: admin, kind: 'automation_policy', value: new Secret('{}') })).rejects.toThrow(/Unsupported/);
    await expect(vaultRecords(db, key).automationPolicy(undefined as never).replace(args)).rejects.toThrow(/human confirmation/);
    const receipt = await fresh(automationPolicyChangeBinding(args));
    await expect(store(receipt).replace(args)).rejects.toThrow(/human proof/);
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
    expect(await store().read(admin)).toBeNull();
    const saved = await store(receipt, humanFixture).replace(args);
    expect(saved).toMatchObject({ reference: { recordId: AUTOMATION_POLICY_RECORD_ID, version: 1 }, reconciliationRequired: false, enforcementCurrent: true });
    expect(saved.document.policies).toEqual([definition()]);
    const next = await replace({ ...definition(), enabled: false }, saved.reference);
    expect(next.reference.version).toBe(2);
    expect(await db.query('select version from vault_record_versions where record_id=$1 order by version', [saved.reference.recordId])).toEqual([{ version: 1 }, { version: 2 }]);
    expect(JSON.stringify(await db.query('select * from vault_record_heads'))).not.toContain('confidential-planning.txt');
    expect(JSON.stringify(await db.query('select * from vault_record_versions'))).not.toContain('confidential-planning.txt');
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain('confidential-planning.txt');
    await expect(store(receipt, humanFixture).replace(args)).rejects.toThrow(/changed/);
  });
  it('pins exact command contents and rolls a failed protected confirmation back for exact retry', async () => {
    const args = { actorUserId: admin, policy: definition(), expected: null }, binding = automationPolicyChangeBinding(args);
    const receipt = await fresh(binding);
    await expect(store(receipt, humanFixture).replace({ ...args, policy: { ...definition(), enabled: false } })).rejects.toThrow(/Confirm/);
    await expect(store(receipt, async command => { expect(command).toEqual(binding); throw new Error('human cancelled'); }).replace(args)).rejects.toThrow(/cancelled/);
    expect(await store().read(admin)).toBeNull();
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
    expect((await store(receipt, humanFixture).replace(args)).document.policies[0].enabled).toBe(true);
  });
  it('current account role and subject status are checked again; an ordinary member cannot inspect protected settings', async () => {
    const args = { actorUserId: admin, policy: definition(), expected: null }, receipt = await fresh(automationPolicyChangeBinding(args));
    await db.query("update users set role='member' where id=$1", [admin]);
    await expect(store(receipt, humanFixture).replace(args)).rejects.toThrow(/super admin/);
    await db.query("update users set role='super_admin' where id=$1", [admin]);
    await db.query("update users set status='disabled' where id=$1", [member]);
    await expect(store(receipt, humanFixture).replace(args)).rejects.toThrow(/user is unavailable/);
    await db.query("update users set status='active' where id=$1", [member]);
    await store(receipt, humanFixture).replace(args);
    await expect(store().read(member)).rejects.toThrow(/super admin/);
  });
  it('preserves other device policies and refuses reuse of another identity’s grant ID', async () => {
    const first = await replace(), other = definition(); other.identity.deviceId = id(88);
    await expect(replace(other, first.reference)).rejects.toThrow(/unique permission/);
    other.rules[0].id = id(89);
    const second = await replace(other, first.reference);
    expect(second.document.policies).toEqual([definition(), other]);
    const third = await replace({ ...definition(), enabled: false, rules: [] }, second.reference);
    expect(third.document.policies[1]).toEqual(other);
    expect(third.document.policies[0].enabled).toBe(false);
  });
  it('only one simultaneous replacement can spend the same current authority', async () => {
    const first = await replace();
    const a = { actorUserId: admin, policy: { ...definition(), enabled: false }, expected: first.reference };
    const b = { actorUserId: admin, policy: { ...definition(), unmatched: 'deny' as const }, expected: first.reference };
    const pa = await fresh(automationPolicyChangeBinding(a)), pb = await fresh(automationPolicyChangeBinding(b));
    const results = await Promise.allSettled([store(pa, humanFixture).replace(a), store(pb, humanFixture).replace(b)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await store().read(admin))!.reference.version).toBe(2);
  });
  it('audit failure rolls policy, epoch and receipt back together', async () => {
    const args = { actorUserId: admin, policy: definition(), expected: null }, receipt = await fresh(automationPolicyChangeBinding(args));
    const [{ authority_epoch: before }] = await db.query('select authority_epoch from vault_state');
    const broken: TestDb = { ...db, transaction: async work => db.transaction!(tx => work({ ...tx, query: async (sql, params) => {
      if (/insert into events/i.test(sql) && params?.includes('vault.record_written')) throw new Error('synthetic audit failure');
      return tx.query(sql, params);
    } })) };
    await expect(store(receipt, humanFixture, broken).replace(args)).rejects.toThrow(/audit failure/);
    expect(await store().read(admin)).toBeNull();
    expect((await db.query('select authority_epoch from vault_state'))[0].authority_epoch).toBe(before);
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
    await store(receipt, humanFixture).replace(args);
  });
  it('replacement-key recovery permits inspection but never automatically restores authority', async () => {
    const saved = await replace(), replacement = new MasterKey(Buffer.alloc(32, 84));
    await expect(store(undefined, undefined, db, replacement).read(admin)).rejects.toThrow();
    await recoverVault(db, replacement, recovery, admin);
    expect(await store(undefined, undefined, db, replacement).read(admin)).toMatchObject({ reconciliationRequired: true, document: { policies: [definition()] } });
    expect((await vaultRecords(db, replacement).previewAutomation({ actorUserId: member, facts: facts() })).code).toBe('requires_reconciliation');
    await expect(store(undefined, undefined, db, replacement).replace({ actorUserId: admin, policy: definition(), expected: saved.reference })).rejects.toThrow(/reconciliation/);
  });
});

describe('consistent permission and Cardinal authority preview', () => {
  it('does not infer missing Cardinal policy as no restrictions; returns only matched references and analysis', async () => {
    const ordinary = await replace(), records = vaultRecords(db, key);
    expect((await records.previewAutomation({ actorUserId: member, facts: facts() })).code).toBe('policy_missing');
    await cardinal();
    const preview = await records.previewAutomation({ actorUserId: member, facts: facts() });
    expect(preview).toMatchObject({ verdict: 'covered', code: 'evaluated', permissions: { verdict: 'covered' }, cardinal: { verdict: 'no_restriction' }, executionEnabled: false });
    expect(preview.permissions!.policy!.epoch).toBe(preview.cardinal!.policy!.epoch);
    expect(preview.permissions!.policy!.epoch).toBeGreaterThan(ordinary.reference.epoch);
    expect(JSON.stringify(preview)).not.toContain('confidential-planning.txt');
    expect(JSON.stringify(preview)).not.toContain('Protected restriction');
    expect((await records.previewAutomation({ actorUserId: member, facts: facts(), expected: { permissions: preview.permissions!.policy!, cardinal: preview.cardinal!.policy! } })).verdict).toBe('covered');
    expect((await records.previewAutomation({ actorUserId: member, facts: facts(), expected: { permissions: ordinary.reference, cardinal: preview.cardinal!.policy! } })).code).toBe('stale_policy');
  });
  it('Cardinal denial overrides covered ordinary grants and removes their proposed charges', async () => {
    await cardinal('file.read'); await replace();
    const preview = await vaultRecords(db, key).previewAutomation({ actorUserId: member, facts: facts() });
    expect(preview).toMatchObject({ verdict: 'deny', cardinal: { verdict: 'deny' }, permissions: { evaluation: { charges: [] } }, executionEnabled: false });
  });
  it('neither author account loss nor different devices quietly turn restrictions into permission', async () => {
    await cardinal(); await replace(); const records = vaultRecords(db, key);
    const wrongDevice = facts(); wrongDevice.identity.deviceId = id(99);
    expect((await records.previewAutomation({ actorUserId: member, facts: wrongDevice })).verdict).toBe('deny');
    expect((await records.previewAutomation({ actorUserId: admin, facts: facts() })).code).toBe('identity_unavailable');
    await db.query("update users set status='disabled' where id=$1", [admin]);
    expect((await records.previewAutomation({ actorUserId: member, facts: facts() })).verdict).toBe('covered');
    await db.query("update users set status='disabled' where id=$1", [member]);
    expect((await records.previewAutomation({ actorUserId: member, facts: facts() })).code).toBe('identity_unavailable');
  });
  it('stale snapshots, Vault locks, missing transactions, corrupt storage and invalid effects fail closed', async () => {
    await cardinal(); await replace(); const records = vaultRecords(db, key);
    const before = await records.previewAutomation({ actorUserId: member, facts: facts() });
    const expected = { cardinal: before.cardinal!.policy!, permissions: before.permissions!.policy! };
    await setVaultLock(db, { master: true, locked: true, actorUserId: admin });
    expect((await records.previewAutomation({ actorUserId: member, facts: facts() })).code).toBe('vault_unavailable');
    await setVaultLock(db, { master: true, locked: false, actorUserId: admin });
    expect((await records.previewAutomation({ actorUserId: member, facts: facts(), expected })).code).toBe('stale_policy');
    expect((await records.previewAutomation({ actorUserId: member, facts: { ...facts(), effectCoverage: 'incomplete' } })).verdict).toBe('pause');
    expect((await records.previewAutomation({ actorUserId: member, facts: { ...facts(), effects: [] } })).verdict).toBe('pause');
    expect((await vaultRecords({ query: async () => { throw new Error('private database details'); } }, key).previewAutomation({ actorUserId: member, facts: facts() })).code).toBe('vault_unavailable');
    await db.query("update vault_record_versions set value_enc='corrupt' where record_id=$1", [AUTOMATION_POLICY_RECORD_ID]);
    expect((await records.previewAutomation({ actorUserId: member, facts: facts() })).code).toBe('vault_unavailable');
  });
  it('outdated enforcement or semantics cannot use current preview; unsupported document fields are not ignored', async () => {
    const saved = await replace();
    for (const document of [{ ...saved.document, enforcementVersion: 'previous' },
      { ...saved.document, policies: [{ ...definition(), semanticsVersion: 'previous' }] }]) {
      expect(evaluateAutomationPolicyRecord({ kind: 'automation_policy', reference: saved.reference, value: new Secret(JSON.stringify(document)) }, facts()).code).toBe('requires_revalidation');
    }
    expect(() => evaluateAutomationPolicyRecord({ kind: 'automation_policy', reference: saved.reference,
      value: new Secret(JSON.stringify({ ...saved.document, additionalRestrictions: ['unimplemented'] })) }, facts())).toThrow(/invalid/);
  });
});
