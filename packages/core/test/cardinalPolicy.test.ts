import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../auth/src/sessions.js';
import { hashPassword } from '../../auth/src/passwords.js';
import { reauthenticateProtectedAdmin, type ProtectedAdminProof } from '../../auth/src/protectedAdmin.js';
import { testDb, type TestDb } from './helpers.js';
import { MasterKey } from '../src/masterKey.js';
import { Secret } from '../src/sealing.js';
import { CardinalDraftStore, cardinalReviewInput } from '../src/cardinalDrafts.js';
import { cardinalContentDigest, type CardinalRule } from '../src/cardinalRules.js';
import { cardinalActivationBinding, cardinalRetirementBinding, CARDINAL_POLICY_RECORD_ID, evaluateCardinalPolicyRecord, type CardinalPolicyCommand } from '../src/cardinalPolicy.js';
import { initializeVault, recoverVault, setVaultLock, vaultRecords, type VaultRecordReference } from '../src/vault.js';

let db: TestDb, owner: string, member: string, sessionId: string, recovery: string;
const key = new MasterKey(Buffer.alloc(32, 77)), password = 'synthetic-cardinal-password';
const rule = (): CardinalRule => ({ schemaVersion: 1, label: 'No terminal', wording: 'Do not run shell commands.', actions: ['execution.shell'],
  scope: { userId: '*', serverId: '*', deviceId: '*', workspaceId: '*', taskId: '*' }, restriction: { kind: 'deny' }, onUnavailable: 'pause' });
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role,password_hash) values('cardinal@fixture.test','cardinal','super_admin',$1) returning id", [await hashPassword(password)]);
  [{ id: member }] = await db.query<{ id: string }>("insert into users(email,username,role) values('member@fixture.test','member','member') returning id");
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
  sessionId = (await createSession(db, { userId: owner })).sessionId;
  await db.query("insert into llm_providers(role,provider,model,activated_at,probed_at,cap_chat) values('primary','openai_compatible','fixture-model',now(),now(),true)");
});
async function tested(definition = rule(), expected?: VaultRecordReference) {
  const drafts = new CardinalDraftStore(db, key), saved = await drafts.save({ actorUserId: owner, draft: definition, expected });
  const [model] = await db.query<{ provider: string; model: string; version: string }>("select provider,model,updated_at::text as version from llm_providers where role='primary'");
  return drafts.test({ actorUserId: owner, expected: saved.reference,
    approvedReviewInputDigest: cardinalContentDigest(cardinalReviewInput(definition)),
    reviewerIdentity: { providerId: model.provider, model: model.model, configurationVersion: model.version },
    reviewer: async () => ({ status: 'available', assessment: { clarity: 'needs_clarification', summary: 'The administrator should review this scope.', concerns: ['Consider whether scripts need a separate restriction.'], suggestions: [] } }),
  });
}
async function proof(command: CardinalPolicyCommand) {
  return reauthenticateProtectedAdmin(db, key, { userId: owner, sessionId, password, ...command });
}
// This fixture is deliberately NOT evidence of a real protected-client verifier.
// Production has no installed human-control port yet and exposes no activation route.
function policy(receipt?: ProtectedAdminProof, human?: (command: CardinalPolicyCommand) => Promise<void>, target = db, installKey = key) {
  return vaultRecords(target, installKey).cardinalPolicy({
    verifyFreshAdministrator: async (tx, actorUserId, command) => {
      if (!receipt) throw new Error('fresh account proof missing');
      await receipt.check(tx, { ...command, actorUserId, consume: true });
    },
    verifyProtectedHuman: async (_tx, _actor, command) => {
      if (!human) throw new Error('protected human fixture missing');
      await human(command);
    },
  });
}
const acceptFixture = async (_command: CardinalPolicyCommand) => undefined;
async function activateFirst() {
  const draft = await tested(), request = { actorUserId: owner, draft: draft.reference, policy: null };
  const receipt = await proof(cardinalActivationBinding(request));
  const active = await policy(receipt, acceptFixture).activate(request);
  return { active, draft, request };
}

describe('permanent Cardinal policy with injected protected-control verification', () => {
  it('requires both authority checks, rejects generic writes, and stores permanent rules only in the Vault', async () => {
    const draft = await tested(), args = { actorUserId: owner, draft: draft.reference, policy: null };
    await expect(vaultRecords(db, key).write({ actorUserId: owner, kind: 'cardinal_policy', value: new Secret('{}') })).rejects.toThrow(/Unsupported/);
    await expect(vaultRecords(db, key).cardinalPolicy(undefined as never).activate(args)).rejects.toThrow(/human confirmation is unavailable/);
    const receipt = await proof(cardinalActivationBinding(args));
    await expect(policy(receipt).activate(args)).rejects.toThrow(/human/);
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
    expect(await policy().read(owner)).toBeNull();
    const active = await policy(receipt, acceptFixture).activate(args);
    expect(active.reference.recordId).toBe(CARDINAL_POLICY_RECORD_ID);
    expect(active.document.rules).toHaveLength(1);
    expect(active.document.rules[0].tested.review).toMatchObject({ status: 'available', assessment: { clarity: 'needs_clarification' } });
    expect(active.document.rules[0].definition).toEqual(rule());
    expect(active).toMatchObject({ reconciliationRequired: false, enforcementCurrent: true });
    expect(JSON.stringify(await db.query('select * from vault_record_versions'))).not.toContain(rule().wording);
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(rule().wording);
    await expect(policy(receipt, acceptFixture).activate(args)).rejects.toThrow(/changed/);
  });

  it('keeps the active version while a new draft is edited, then replaces only after new tests and confirmation', async () => {
    const { active, draft } = await activateFirst();
    const drafts = new CardinalDraftStore(db, key);
    const currentDraft = await drafts.read({ actorUserId: owner, recordId: draft.reference.recordId });
    const nextDefinition: CardinalRule = { ...rule(), wording: 'Do not run scripts either.', actions: ['execution.shell', 'execution.script'] };
    const edited = await drafts.save({ actorUserId: owner, expected: currentDraft.reference, draft: nextDefinition });
    expect((await policy().read(owner))!.document.rules[0].definition).toEqual(rule());
    const latest = (await policy().read(owner))!;
    const untested = { actorUserId: owner, draft: edited.reference, policy: latest.reference };
    await expect(policy(await proof(cardinalActivationBinding(untested)), acceptFixture).activate(untested)).rejects.toThrow(/Test this exact/);
    const test = await tested(nextDefinition, edited.reference), current = (await policy().read(owner))!;
    const request = { actorUserId: owner, draft: test.reference, policy: current.reference };
    const replacement = await policy(await proof(cardinalActivationBinding(request)), acceptFixture).activate(request);
    expect(replacement.document.rules).toHaveLength(1);
    expect(replacement.document.rules[0].definition).toEqual(nextDefinition);
    expect(replacement.reference.version).toBe(active.reference.version + 1);
    expect(await db.query('select * from vault_record_versions where record_id=$1', [active.reference.recordId])).toHaveLength(2);
  });

  it('retires only the exact current policy, with both account and protected human verification', async () => {
    const { active, draft } = await activateFirst();
    const request = { actorUserId: owner, ruleId: draft.reference.recordId, policy: active.reference };
    const receipt = await proof(cardinalRetirementBinding(request));
    await expect(policy(receipt).retire(request)).rejects.toThrow(/human/);
    const retired = await policy(receipt, acceptFixture).retire(request);
    expect(retired.document.rules).toEqual([]);
    expect(retired.document.lastChange.operation).toBe('retire');
    expect(retired.reference.version).toBe(active.reference.version + 1);
    await expect(policy(receipt, acceptFixture).retire(request)).rejects.toThrow(/changed/);
    expect(await db.query('select * from vault_record_versions where record_id=$1', [active.reference.recordId])).toHaveLength(2);
  });

  it('rejects tests from an old schema/suite or changed report rather than trusting a passed label', async () => {
    const test = await tested();
    test.document.tested!.report.cases = [];
    const tampered = await vaultRecords(db, key).write({ actorUserId: owner, kind: 'cardinal_draft', expected: test.reference, value: new Secret(JSON.stringify(test.document)) });
    const request = { actorUserId: owner, draft: tampered, policy: null };
    await expect(policy(await proof(cardinalActivationBinding(request)), acceptFixture).activate(request)).rejects.toThrow(/Test this exact/);
    expect(await policy().read(owner)).toBeNull();
  });

  it('rejects a replaced review provider and unavailable model advice', async () => {
    const test = await tested();
    await db.query("update llm_providers set model='replacement' where role='primary'");
    const request = { actorUserId: owner, draft: test.reference, policy: null };
    await expect(policy(await proof(cardinalActivationBinding(request)), acceptFixture).activate(request)).rejects.toThrow(/model changed/);
    const fresh = await tested(rule());
    fresh.document.tested!.review = { status: 'unavailable', message: 'Unavailable.' };
    const unavailable = await vaultRecords(db, key).write({ actorUserId: owner, kind: 'cardinal_draft', expected: fresh.reference, value: new Secret(JSON.stringify(fresh.document)) });
    const unavailableRequest = { actorUserId: owner, draft: unavailable, policy: null };
    await expect(policy(await proof(cardinalActivationBinding(unavailableRequest)), acceptFixture).activate(unavailableRequest)).rejects.toThrow(/Test this exact/);
  });

  it('has one winner for simultaneous confirmation of the same snapshot', async () => {
    const draft = await tested(), request = { actorUserId: owner, draft: draft.reference, policy: null };
    const receipt = await proof(cardinalActivationBinding(request)), store = policy(receipt, acceptFixture);
    const results = await Promise.allSettled([store.activate(request), store.activate(request)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.query('select * from vault_record_versions where record_id=$1', [CARDINAL_POLICY_RECORD_ID])).toHaveLength(1);
  });

  it('rolls back the active snapshot, epoch and receipt when policy persistence fails', async () => {
    const draft = await tested(), request = { actorUserId: owner, draft: draft.reference, policy: null };
    const receipt = await proof(cardinalActivationBinding(request));
    const broken: TestDb = { ...db, transaction: work => db.transaction!(tx => work({ query: (sql, params) => {
      if (sql.includes('insert into vault_record_versions')) throw new Error('synthetic policy outage'); return tx.query(sql, params);
    } })) };
    await expect(policy(receipt, acceptFixture, broken).activate(request)).rejects.toThrow(/policy outage/);
    expect(await policy().read(owner)).toBeNull();
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
    await policy(receipt, acceptFixture).activate(request);
  });

  it('denies members, locked/changed authority and restored mutation while preserving inspection', async () => {
    const { active, draft } = await activateFirst();
    await expect(policy().read(member)).rejects.toThrow(/super admin/);
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    await expect(policy().read(owner)).rejects.toThrow(/locked/);
    await setVaultLock(db, { master: true, locked: false, actorUserId: owner });
    const stale = { actorUserId: owner, draft: draft.reference, policy: active.reference };
    await expect(policy(await proof(cardinalActivationBinding(stale)), acceptFixture).activate(stale)).rejects.toThrow(/changed/);
    const replacement = new MasterKey(Buffer.alloc(32, 78));
    await recoverVault(db, replacement, recovery, owner);
    const recovered = policy(undefined, undefined, db, replacement), current = (await recovered.read(owner))!;
    expect(current.document.rules[0].definition).toEqual(rule());
    expect(current.reconciliationRequired).toBe(true);
    expect((await vaultRecords(db, replacement).checkCardinalPolicy({ actorUserId: member, facts: {
      effects: ['execution.shell'], effectCoverage: 'verified', identities: { userId: member },
    } })).code).toBe('requires_reconciliation');
    await expect(recovered.retire({ actorUserId: owner, ruleId: draft.reference.recordId, policy: current.reference })).rejects.toThrow(/reconciliation/);
  });

  it('gives ordinary execution only a restrictive verdict and references, never rule contents or permission', async () => {
    const records = vaultRecords(db, key), facts = { effects: ['execution.shell'], effectCoverage: 'verified' as const, identities: { userId: member } };
    expect((await records.checkCardinalPolicy({ actorUserId: member, facts })).code).toBe('policy_missing');
    const { active } = await activateFirst();
    const denied = await records.checkCardinalPolicy({ actorUserId: member, facts, expected: active.reference });
    expect(denied).toMatchObject({ verdict: 'deny', code: 'evaluated', policy: active.reference });
    expect(denied.rules).toHaveLength(1);
    expect(JSON.stringify(denied)).not.toContain(rule().wording);
    expect(JSON.stringify(denied)).not.toContain('Consider whether');
    expect((await records.checkCardinalPolicy({ actorUserId: member, facts: { ...facts, effects: ['file.read'] } })).verdict).toBe('no_restriction');
    expect((await records.checkCardinalPolicy({ actorUserId: owner, facts })).code).toBe('identity_unavailable');
    await db.query("update users set status='disabled' where id=$1", [owner]);
    expect((await records.checkCardinalPolicy({ actorUserId: member, facts })).verdict).toBe('deny');
  });

  it('pauses on changed authority, Vault loss, corrupt records and enforcement changes', async () => {
    const { active } = await activateFirst(), records = vaultRecords(db, key);
    const facts = { effects: ['file.read'], effectCoverage: 'verified' as const, identities: { userId: member } };
    const oldEnforcement = { ...active.document, enforcementVersion: 'previous-enforcement-version' };
    expect(evaluateCardinalPolicyRecord({ reference: active.reference, kind: 'cardinal_policy', value: new Secret(JSON.stringify(oldEnforcement)) }, facts).code).toBe('requires_revalidation');
    const oldEvidence = structuredClone(active.document); oldEvidence.rules[0].tested.report.suiteVersion = 'old-suite';
    expect(evaluateCardinalPolicyRecord({ reference: active.reference, kind: 'cardinal_policy', value: new Secret(JSON.stringify(oldEvidence)) }, facts).code).toBe('requires_revalidation');
    expect((await vaultRecords({ query: async () => { throw new Error('private database details'); } }, key).checkCardinalPolicy({ actorUserId: member, facts })).code).toBe('vault_unavailable');
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    expect((await records.checkCardinalPolicy({ actorUserId: member, facts })).code).toBe('vault_unavailable');
    await setVaultLock(db, { master: true, locked: false, actorUserId: owner });
    expect((await records.checkCardinalPolicy({ actorUserId: member, facts, expected: active.reference })).code).toBe('stale_policy');
    await db.query("update vault_record_versions set value_enc='corrupt' where record_id=$1", [active.reference.recordId]);
    expect((await records.checkCardinalPolicy({ actorUserId: member, facts })).verdict).toBe('pause');
  });

  it('supports a subscription provider whose official CLI selects the default model', async () => {
    await db.query("update llm_providers set provider='openai_subscription',model='',external_acknowledged=true,external_acknowledged_at=now() where role='primary'");
    const draft = await tested(), request = { actorUserId: owner, draft: draft.reference, policy: null };
    const active = await policy(await proof(cardinalActivationBinding(request)), acceptFixture).activate(request);
    expect(active.document.rules[0].tested.reviewer.model).toBe('');
  });
});
