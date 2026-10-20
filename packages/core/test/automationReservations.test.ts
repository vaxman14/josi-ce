import { beforeEach, describe, expect, it } from 'vitest';
import { AUTOMATION_PERMISSION_SEMANTICS, type AutomationPermissionPolicy } from '@josi-ce/protocol';
import { testDb, type TestDb } from './helpers.js';
import { createSession } from '../../auth/src/sessions.js';
import { hashPassword } from '../../auth/src/passwords.js';
import { reauthenticateProtectedAdmin } from '../../auth/src/protectedAdmin.js';
import { MasterKey } from '../src/masterKey.js';
import { Secret } from '../src/sealing.js';
import { initializeVault, putVaultItem, recoverVault, setVaultLock, vaultRecords } from '../src/vault.js';
import { CardinalDraftStore, cardinalReviewInput } from '../src/cardinalDrafts.js';
import { cardinalContentDigest, type CardinalRule } from '../src/cardinalRules.js';
import { cardinalActivationBinding } from '../src/cardinalPolicy.js';
import { automationPolicyChangeBinding } from '../src/automationPolicy.js';
import { submitDurableTurn, claimDurableTurn, durableTurnHasIncompleteEffects, failDurableTurn } from '../src/mobile.js';
import type { AutomationReservationRequest, AutomationReservationProofPort } from '../src/automationReservations.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = new MasterKey(Buffer.alloc(32, 86)), password = 'synthetic-journal-password';
let db: TestDb, admin: string, owner: string, other: string, sessionId: string, taskId: string, turnId: string, leaseToken: string, recovery: string;
let expected: AutomationReservationRequest['expected'];
const identity = () => ({ userId: owner, serverId: id(1), deviceId: id(2), workspaceId: id(3) });
const scope = () => ({ kind: 'file' as const, rootId: id(4), rootRevision: 1, segments: ['private-planning.txt'], descendants: false });
function permissions(maxActions = 2, maxBytes: number | null = 20): AutomationPermissionPolicy {
  return { schemaVersion: 1, semanticsVersion: AUTOMATION_PERMISSION_SEMANTICS, identity: identity(), enabled: true, unmatched: 'deny', rules: [
    { id: id(5), action: 'file.read', scope: scope(), mode: { kind: 'standing' }, limits: { maxActionsPerTask: maxActions, maxBytesPerTask: maxBytes, maxTaskDurationMs: null } },
  ] };
}
async function setPermissions(definition = permissions()) {
  const before = await vaultRecords(db, key).automationPolicy(undefined as never).read(admin);
  const args = { actorUserId: admin, policy: definition, expected: before?.reference ?? null };
  const proof = await reauthenticateProtectedAdmin(db, key, { userId: admin, sessionId, password, ...automationPolicyChangeBinding(args) });
  await vaultRecords(db, key).automationPolicy({ verifyFreshAdministrator: (tx, actorUserId, command) => proof.check(tx, { actorUserId, ...command, consume: true }),
    verifyProtectedHuman: async () => undefined }).replace(args); // synthetic protected-control fixture
  const preview = await vaultRecords(db, key).previewAutomation({ actorUserId: owner, facts: { identity: identity(), nowMs: Date.now(), task: { id: taskId, active: true, startedAtMs: Date.now() - 1000 },
    effectCoverage: 'verified', effects: [{ action: 'file.read', target: scope(), bytes: 10 }], usage: [{ ruleId: id(5), taskId, actions: 0, bytes: 0 }] } });
  expected = { permissions: preview.permissions!.policy!, cardinal: preview.cardinal!.policy! };
}
beforeEach(async () => {
  db = await testDb();
  [{ id: admin }] = await db.query<{ id: string }>("insert into users(email,username,role,password_hash) values('journal-admin@fixture.test','journal-admin','super_admin',$1) returning id", [await hashPassword(password)]);
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role) values('journal-owner@fixture.test','journal-owner','member') returning id");
  [{ id: other }] = await db.query<{ id: string }>("insert into users(email,username,role) values('other@fixture.test','other','member') returning id");
  recovery = (await initializeVault(db, key, admin)).recoveryKey.reveal(); sessionId = (await createSession(db, { userId: admin })).sessionId;
  await createSession(db, { userId: owner });
  const [{ id: threadId }] = await db.query<{ id: string }>("insert into threads(owner_user_id,title) values($1,'Journal fixture') returning id", [owner]);
  await db.query("insert into task_templates(key,name,contract) values('automation-fixture','Automation fixture','{}')");
  [{ id: taskId }] = await db.query<{ id: string }>("insert into tasks(owner_user_id,template_key,thread_id,state) values($1,'automation-fixture',$2,'ready') returning id", [owner, threadId]);
  const submitted = await submitDurableTurn(db, { ownerUserId: owner, threadId, clientMessageId: 'journal-1', message: 'Synthetic work' });
  const claimed = await claimDurableTurn(db, submitted.turn.id, 600); turnId = claimed!.id; leaseToken = claimed!.lease_token;
  await db.query("insert into llm_providers(role,provider,model,activated_at,probed_at,cap_chat) values('primary','openai_compatible','fixture',now(),now(),true)");
  const definition: CardinalRule = { schemaVersion: 1, label: 'No shell', wording: 'Deny shell execution.', actions: ['execution.shell'],
    scope: { userId: '*', serverId: '*', deviceId: '*', workspaceId: '*', taskId: '*' }, restriction: { kind: 'deny' }, onUnavailable: 'pause' };
  const drafts = new CardinalDraftStore(db, key), saved = await drafts.save({ actorUserId: admin, draft: definition });
  const [model] = await db.query<{ provider: string; model: string; version: string }>("select provider,model,updated_at::text as version from llm_providers where role='primary'");
  const tested = await drafts.test({ actorUserId: admin, expected: saved.reference, approvedReviewInputDigest: cardinalContentDigest(cardinalReviewInput(definition)),
    reviewerIdentity: { providerId: model.provider, model: model.model, configurationVersion: model.version }, reviewer: async () => ({ status: 'available', assessment: { clarity: 'clear', summary: 'Explicit.', concerns: [], suggestions: [] } }) });
  const args = { actorUserId: admin, draft: tested.reference, policy: null };
  const proof = await reauthenticateProtectedAdmin(db, key, { userId: admin, sessionId, password, ...cardinalActivationBinding(args) });
  await vaultRecords(db, key).cardinalPolicy({ verifyFreshAdministrator: (tx, actorUserId, command) => proof.check(tx, { actorUserId, ...command, consume: true }), verifyProtectedHuman: async () => undefined }).activate(args);
  await setPermissions();
});
// Fixture ports only. Production has no enrolled device/signed receipt verifier.
const proofs: AutomationReservationProofPort = {
  verifyDispatch: async (_tx, _context, proof) => { if (proof !== 'dispatch-fixture') throw new Error('device dispatch fixture refused'); },
  verifyOutcome: async (_tx, _context, proof) => { if (proof !== 'outcome-fixture') throw new Error('device evidence fixture refused'); },
};
const store = (ports = proofs, target = db, installKey = key) => vaultRecords(target, installKey).automationReservations(ports);
function request(n = 1): AutomationReservationRequest {
  return { actorUserId: owner, taskId, turnId, leaseToken, effectIdentity: id(100 + n), proposalId: id(200 + n), identity: identity(),
    effects: [{ action: 'file.read', target: scope(), bytes: 10 }], effectCoverage: 'verified', expected: structuredClone(expected),
    expiresAtMs: Date.now() + 30_000, payload: new Secret('synthetic private action payload') };
}
const dispatch = (id: string, ports = proofs) => store(ports).markDispatched({ actorUserId: owner, id, turnId, leaseToken, proof: 'dispatch-fixture' });
const settle = (id: string, outcome: 'succeeded' | 'no_effect' | 'uncertain' = 'succeeded') => store().settle({ actorUserId: owner, id, outcome, evidenceIds: outcome === 'uncertain' ? [] : [idEvidence], proof: 'outcome-fixture' });
const idEvidence = id(60);

describe('durable Vault-bound automation reservations', () => {
  it('reserves once with the existing durable effect fence, encrypts payload and preserves budget across store recreation', async () => {
    const first = await store().reserve(request()); expect(first.created).toBe(true); expect(first.reservation).toMatchObject({ state: 'reserved', executionEnabled: false });
    expect(await durableTurnHasIncompleteEffects(db, turnId)).toBe(true);
    expect((await store().reserve(request())).created).toBe(false);
    await expect(store().reserve({ ...request(), payload: new Secret('changed payload') })).rejects.toThrow(/different exact action/);
    await store().reserve(request(2)); await expect(store().reserve(request(3))).rejects.toThrow(/limits do not cover/);
    expect(await db.query('select id from assistant_turn_effects where turn_id=$1', [turnId])).toHaveLength(2);
    for (const table of ['automation_reservations', 'assistant_turn_effects', 'events']) {
      const dump = JSON.stringify(await db.query(`select * from ${table}`));
      expect(dump).not.toContain('private-planning.txt'); expect(dump).not.toContain('synthetic private action payload');
    }
    expect(await store().read(other, first.reservation.id)).toBeNull();
  });
  it('concurrent attempts cannot overspend the last grant action or create duplicate effects', async () => {
    await setPermissions(permissions(1, 10));
    const results = await Promise.allSettled([store().reserve(request()), store().reserve(request(2))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.query('select id from automation_reservations')).toHaveLength(1);
    expect(await db.query('select id from assistant_turn_effects where turn_id=$1', [turnId])).toHaveLength(1);
  });
  it('a new turn and proposal cannot replay the same original-task effect or hide its unfinished state', async () => {
    const saved = (await store().reserve(request())).reservation;
    await failDurableTurn(db, { turnId, leaseToken, code: 'interrupted', retryable: false });
    const [{ thread_id: threadId }] = await db.query<{ thread_id: string }>('select thread_id from tasks where id=$1', [taskId]);
    const next = await submitDurableTurn(db, { ownerUserId: owner, threadId, clientMessageId: 'journal-next', message: 'Continue the original work' });
    const turn = await claimDurableTurn(db, next.turn.id, 600); turnId = turn!.id; leaseToken = turn!.lease_token;
    const duplicate = await store().reserve({ ...request(), proposalId: id(299) });
    expect(duplicate).toMatchObject({ created: false, reservation: { id: saved.id, state: 'reserved', proposalId: saved.proposalId } });
    expect(await db.query('select id from automation_reservations')).toHaveLength(1);
    expect(await db.query('select id from assistant_turn_effects where turn_id=$1', [turnId])).toHaveLength(0);
    await expect(dispatch(saved.id)).rejects.toThrow(/different durable turn/);
  });
  it('later permission revisions retain prior consumption under stable rule IDs', async () => {
    await store().reserve(request()); await setPermissions(permissions(1, 10));
    await expect(store().reserve(request(2))).rejects.toThrow(/limits/);
    await setPermissions(permissions(3, 30));
    expect((await store().reserve(request(2))).created).toBe(true);
    expect((await store().reserve(request(3))).created).toBe(true);
    await expect(store().reserve(request(4))).rejects.toThrow(/limits/);
  });
  it('reads original task state/time and live turn lease instead of trusting request clocks or counters', async () => {
    await db.query("update tasks set state='held' where id=$1", [taskId]); await expect(store().reserve(request())).rejects.toThrow(/not active/);
    await db.query("update tasks set state='ready',created_at=now()-interval '1 hour' where id=$1", [taskId]);
    const p = permissions(); p.rules[0].limits!.maxTaskDurationMs = 60_000; await setPermissions(p);
    await expect(store().reserve(request())).rejects.toThrow(/limits/);
    await setPermissions(); await db.query("update assistant_turns set lease_expires_at=now()-interval '1 second' where id=$1", [turnId]);
    await expect(store().reserve(request())).rejects.toThrow(/lease/);
    expect(await db.query('select id from automation_reservations')).toHaveLength(0);
  });
  it('rejects wrong owner, changed scopes, incomplete effects, stale policy and unknown byte budgets', async () => {
    for (const changed of [
      { ...request(), actorUserId: other }, { ...request(), identity: { ...identity(), deviceId: id(99) } },
      { ...request(), effectCoverage: 'incomplete' as const }, { ...request(), effects: [{ ...request().effects[0], bytes: null }] },
      { ...request(), expiresAtMs: Date.now() - 1 }, { ...request(), expiresAtMs: Date.now() + 120_000 },
    ]) await expect(store().reserve(changed)).rejects.toThrow();
    const old = request(); await setPermissions(); await expect(store().reserve(old)).rejects.toThrow(/permissions/);
    expect(await db.query('select id from automation_reservations')).toHaveLength(0);
  });
  it('requires exact device proof at dispatch, consumes the reservation once and verifies outcome evidence', async () => {
    await setPermissions(permissions(1, 10)); const saved = (await store().reserve(request())).reservation;
    await expect(store({} as never).markDispatched({ actorUserId: owner, id: saved.id, turnId, leaseToken, proof: null })).rejects.toThrow(/dispatch is unavailable/);
    await expect(store().markDispatched({ actorUserId: owner, id: saved.id, turnId, leaseToken, proof: 'wrong' })).rejects.toThrow(/refused/);
    expect((await dispatch(saved.id)).state).toBe('dispatched'); await expect(dispatch(saved.id)).rejects.toThrow(/no longer/);
    await expect(store().cancelBeforeDispatch(owner, saved.id)).rejects.toThrow(/reconciliation/);
    await expect(store().settle({ actorUserId: owner, id: saved.id, outcome: 'succeeded', evidenceIds: [], proof: 'outcome-fixture' })).rejects.toThrow(/evidence/);
    await expect(store().settle({ actorUserId: owner, id: saved.id, outcome: 'succeeded', evidenceIds: [idEvidence], proof: 'wrong' })).rejects.toThrow(/refused/);
    expect((await settle(saved.id)).state).toBe('succeeded'); expect((await settle(saved.id)).state).toBe('succeeded');
    expect(await durableTurnHasIncompleteEffects(db, turnId)).toBe(false);
    await expect(settle(saved.id, 'no_effect')).rejects.toThrow(/different outcome/);
    await expect(store().reserve(request(2))).rejects.toThrow(/limits/);
  });
  it('policy/lease changes between reservation and dispatch stop release, including during proof verification', async () => {
    const saved = (await store().reserve(request())).reservation; await setPermissions();
    await expect(dispatch(saved.id)).rejects.toThrow(/authority/);
    const next = (await store().reserve(request(2))).reservation;
    await expect(dispatch(next.id, { ...proofs, verifyDispatch: async tx => { await tx.query("update assistant_turns set lease_expires_at=now()-interval '1 second' where id=$1", [turnId]); } })).rejects.toThrow(/lease/);
    expect((await store().read(owner, next.id))!.state).toBe('reserved');
    expect((await dispatch(next.id)).state).toBe('dispatched'); // failed verifier mutation rolled back
  });
  it('uncertain results keep the old effect unresolved until verified reconciliation, even after turn failure', async () => {
    const saved = (await store().reserve(request())).reservation; await dispatch(saved.id);
    expect((await settle(saved.id, 'uncertain')).state).toBe('uncertain'); expect(await durableTurnHasIncompleteEffects(db, turnId)).toBe(true);
    await failDurableTurn(db, { turnId, leaseToken, code: 'device_disconnected', retryable: false });
    expect((await settle(saved.id, 'no_effect')).state).toBe('no_effect'); expect(await durableTurnHasIncompleteEffects(db, turnId)).toBe(false);
  });
  it('cancellation before dispatch closes the same effect fence without refunding reserved limits', async () => {
    await setPermissions(permissions(1, 10)); const saved = (await store().reserve(request())).reservation;
    expect((await store().cancelBeforeDispatch(owner, saved.id)).state).toBe('cancelled');
    expect((await store().cancelBeforeDispatch(owner, saved.id)).state).toBe('cancelled');
    expect(await durableTurnHasIncompleteEffects(db, turnId)).toBe(false);
    await expect(dispatch(saved.id)).rejects.toThrow(/no longer/);
    await expect(store().reserve(request(2))).rejects.toThrow(/limits/);
  });
  it('audit failure rolls back reservation, consumption and the existing tool-effect fence', async () => {
    const broken: TestDb = { ...db, transaction: async work => db.transaction!(tx => work({ ...tx, query: async (sql, params) => {
      if (/insert into events/i.test(sql) && params?.includes('automation.reserved')) throw new Error('synthetic audit failure');
      return tx.query(sql, params);
    } })) };
    await expect(store(proofs, broken).reserve(request())).rejects.toThrow(/audit failure/);
    expect(await db.query('select id from automation_reservations')).toHaveLength(0);
    expect(await db.query('select id from assistant_turn_effects where turn_id=$1', [turnId])).toHaveLength(0);
    expect((await store().reserve(request())).created).toBe(true);
  });
  it('outcome audit failure rolls the receipt and shared effect completion back for exact retry', async () => {
    const saved = (await store().reserve(request())).reservation; await dispatch(saved.id);
    const broken: TestDb = { ...db, transaction: async work => db.transaction!(tx => work({ ...tx, query: async (sql, params) => {
      if (/insert into events/i.test(sql) && params?.includes('automation.succeeded')) throw new Error('synthetic receipt audit failure');
      return tx.query(sql, params);
    } })) };
    await expect(store(proofs, broken).settle({ actorUserId: owner, id: saved.id, outcome: 'succeeded', evidenceIds: [idEvidence], proof: 'outcome-fixture' })).rejects.toThrow(/audit failure/);
    expect((await store().read(owner, saved.id))!.state).toBe('dispatched');
    expect(await durableTurnHasIncompleteEffects(db, turnId)).toBe(true);
    expect((await settle(saved.id)).state).toBe('succeeded');
  });
  it('tampered state/ciphertext cannot reset replay or consumption; SQL counters cannot forge spare budget', async () => {
    const saved = (await store().reserve(request())).reservation;
    await db.query("update automation_reservations set state='succeeded' where id=$1", [saved.id]);
    await expect(store().read(owner, saved.id)).rejects.toThrow(/context/);
    await expect(store().reserve(request(2))).rejects.toThrow(/context/);
    await db.query("update automation_reservations set state='reserved',plan_enc='corrupt' where id=$1", [saved.id]);
    await expect(store().reserve(request(2))).rejects.toThrow(/unreadable/);
  });
  it('locked Vault stops access; recovery can inspect/reconcile prior outcomes but cannot reserve new execution', async () => {
    const saved = (await store().reserve(request())).reservation; await dispatch(saved.id);
    await setVaultLock(db, { master: true, locked: true, actorUserId: admin });
    await expect(store().read(owner, saved.id)).rejects.toThrow();
    await setVaultLock(db, { master: true, locked: false, actorUserId: admin });
    const replacement = new MasterKey(Buffer.alloc(32, 87)); await recoverVault(db, replacement, recovery, admin);
    const recovered = store(proofs, db, replacement); expect((await recovered.read(owner, saved.id))!.state).toBe('dispatched');
    await expect(recovered.reserve(request(2))).rejects.toThrow(/reconciliation/);
    expect((await recovered.settle({ actorUserId: owner, id: saved.id, outcome: 'succeeded', evidenceIds: [idEvidence], proof: 'outcome-fixture' })).state).toBe('succeeded');
    expect((await db.query('select authority_reconciliation_required from vault_state'))[0].authority_reconciliation_required).toBe(true);
  });
  it('the owner’s private Vault lock still stops automation after global authority references are refreshed', async () => {
    await putVaultItem(db, key, { ownerUserId: owner, kind: 'secure_note', service: 'fixture', slot: 'fixture', label: 'Fixture', value: new Secret('synthetic note') });
    const saved = (await store().reserve(request())).reservation;
    await setVaultLock(db, { ownerUserId: owner, locked: true, actorUserId: owner });
    const records = vaultRecords(db, key);
    expected = { permissions: (await records.automationPolicy(undefined as never).read(admin))!.reference,
      cardinal: (await records.cardinalPolicy(undefined as never).read(admin))!.reference };
    await expect(store().reserve(request(2))).rejects.toThrow(/Vault box is locked/);
    await expect(store().read(owner, saved.id)).rejects.toThrow(/Vault box is locked/);
    const restricted = await records.checkCardinalPolicy({ actorUserId: owner, facts: { effects: ['file.read'], effectCoverage: 'verified', identities: { ...identity(), taskId } } });
    expect(restricted).toMatchObject({ verdict: 'pause', code: 'vault_unavailable' });
    const preview = await records.previewAutomation({ actorUserId: owner, facts: { identity: identity(), nowMs: Date.now(), task: { id: taskId, active: true, startedAtMs: Date.now() - 1000 },
      effectCoverage: 'verified', effects: request().effects, usage: [], }, expected });
    expect(preview).toMatchObject({ verdict: 'pause', code: 'vault_unavailable' });
    await setVaultLock(db, { ownerUserId: owner, locked: false, actorUserId: owner });
    await expect(dispatch(saved.id)).rejects.toThrow(/authority/); // unlock cannot revive the old reserved action
  });
});
