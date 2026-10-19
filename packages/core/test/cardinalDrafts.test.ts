import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '../../auth/src/users.js';
import { testDb, type TestDb } from './helpers.js';
import { MasterKey } from '../src/masterKey.js';
import { CardinalDraftStore, cardinalReviewInput, type CardinalMeaningReview } from '../src/cardinalDrafts.js';
import { cardinalContentDigest, type CardinalRule } from '../src/cardinalRules.js';
import { initializeVault, recoverVault, setVaultLock, VaultRecordConflictError } from '../src/vault.js';

const key = new MasterKey(Buffer.alloc(32, 74));
let db: TestDb, owner: string, member: string, recovery: string, store: CardinalDraftStore;
const rule = (): CardinalRule => ({ schemaVersion: 1, label: 'No terminal', wording: 'Do not run shell commands.', actions: ['execution.shell'],
  scope: { userId: '*', serverId: '*', deviceId: { ids: ['11111111-1111-4111-8111-111111111111'] }, workspaceId: '*', taskId: '*' },
  restriction: { kind: 'deny' }, onUnavailable: 'pause' });
const identity = { providerId: 'model-fixture', model: 'fixture-model', configurationVersion: 'revision-1' };
const advice: CardinalMeaningReview = { status: 'available', assessment: { clarity: 'clear', summary: 'The shell restriction has an exact scope.', concerns: [], suggestions: [] } };
const testArgs = () => ({ actorUserId: owner, reviewerIdentity: identity, approvedReviewInputDigest: cardinalContentDigest(cardinalReviewInput(rule())), reviewer: vi.fn(async () => advice) });
beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'rules@example.test', username: 'rules', role: 'super_admin' })).id;
  member = (await createUser(db, { email: 'member@example.test', username: 'member', role: 'member' })).id;
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
  store = new CardinalDraftStore(db, key);
});

describe('Vault-backed Cardinal Rule drafting and testing', () => {
  it('keeps wording, model assessment and tests in encrypted version history, with no activation', async () => {
    const saved = await store.save({ actorUserId: owner, draft: rule() });
    const args = testArgs();
    const tested = await store.test({ ...args, expected: saved.reference });
    expect(tested.document.tested).toMatchObject({ report: { status: 'passed', executionEnabled: false }, review: advice, reviewer: identity });
    expect(args.reviewer).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(args.reviewer.mock.calls)).not.toContain('11111111-1111-4111-8111-111111111111');
    expect((await store.read({ actorUserId: owner, recordId: saved.reference.recordId })).document).toEqual(tested.document);
    const stored = JSON.stringify(await db.query('select * from vault_record_versions'));
    expect(stored).not.toContain(rule().wording);
    expect(stored).not.toContain('exact scope');
    expect(stored).not.toContain(tested.document.tested!.report.contentDigest);
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(rule().wording);
    expect(await db.query('select * from vault_record_versions')).toHaveLength(2);
    expect((store as unknown as Record<string, unknown>).activate).toBeUndefined();
  });

  it('saves incomplete drafts without guessing their meaning or sending them to a model', async () => {
    const saved = await store.save({ actorUserId: owner, draft: 'do no harm' });
    const args = testArgs();
    const tested = await store.test({ ...args, expected: saved.reference });
    expect(tested.document.tested?.report.status).toBe('needs_clarification');
    expect(args.reviewer).not.toHaveBeenCalled();
  });

  it('requires the exact review preview and clears all review/test results after an edit', async () => {
    const saved = await store.save({ actorUserId: owner, draft: rule() });
    const args = testArgs();
    await expect(store.test({ ...args, expected: saved.reference, approvedReviewInputDigest: 'wrong' })).rejects.toThrow(/preview/);
    expect(args.reviewer).not.toHaveBeenCalled();
    const tested = await store.test({ ...args, expected: saved.reference });
    const edited = await store.save({ actorUserId: owner, expected: tested.reference, draft: { ...rule(), wording: 'New wording.' } });
    expect(edited.document.tested).toBeNull();
    await expect(store.test({ ...args, expected: tested.reference })).rejects.toBeInstanceOf(VaultRecordConflictError);
  });

  it('does not attach a late model answer after another edit, a lock, or live role loss', async () => {
    for (const mutation of ['edit', 'lock', 'role'] as const) {
      const saved = await store.save({ actorUserId: owner, draft: rule() });
      const reviewer = async () => {
        if (mutation === 'edit') await store.save({ actorUserId: owner, expected: saved.reference, draft: { ...rule(), label: 'Changed' } });
        if (mutation === 'lock') await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
        if (mutation === 'role') await db.query(`update users set role='member' where id=$1`, [owner]);
        return advice;
      };
      await expect(store.test({ ...testArgs(), reviewer, expected: saved.reference })).rejects.toThrow();
      await db.query(`update users set role='super_admin' where id=$1`, [owner]);
      await setVaultLock(db, { master: true, locked: false, actorUserId: owner });
      expect((await store.read({ actorUserId: owner, recordId: saved.reference.recordId })).document.tested).toBeNull();
    }
  });

  it('stores model failures as separate redacted advice status, never as deterministic success or approval', async () => {
    let saved = await store.save({ actorUserId: owner, draft: rule() });
    saved = await store.test({ ...testArgs(), expected: saved.reference, reviewer: async () => { throw new Error('provider-request-secret'); } });
    expect(saved.document.tested?.report.status).toBe('passed');
    expect(saved.document.tested?.review.status).toBe('unavailable');
    expect(JSON.stringify(saved)).not.toContain('provider-request-secret');
    saved = await store.test({ ...testArgs(), expected: saved.reference, reviewer: async () => ({ status: 'available', assessment: { approved: true } }) as never });
    expect(saved.document.tested?.review.status).toBe('invalid_response');
  });

  it('pins input identities before calling a reviewer and preserves contradictory advice separately', async () => {
    const saved = await store.save({ actorUserId: owner, draft: rule() });
    const args = { ...testArgs(), reviewerIdentity: { ...identity }, expected: { ...saved.reference }, reviewer: async () => {
      args.reviewerIdentity.model = 'changed-model'; args.expected.digest = 'not-the-tested-version';
      return { status: 'available', assessment: { clarity: 'needs_clarification', summary: 'Consider a different scope.', concerns: ['A concern.'], suggestions: [] } } as CardinalMeaningReview;
    } };
    const tested = await store.test(args);
    expect(tested.document.tested?.review).toMatchObject({ status: 'available', assessment: { clarity: 'needs_clarification' } });
    expect(tested.document.tested?.report.status).toBe('passed');
    expect(tested.document.tested?.reviewer.model).toBe(identity.model);
    expect(tested.document.draft).toEqual(rule());
  });

  it('checks the live super admin and keeps recovered drafts inspectable without reauthorizing them', async () => {
    await expect(store.save({ actorUserId: member, draft: rule() })).rejects.toThrow(/super admin/);
    const saved = await store.save({ actorUserId: owner, draft: rule() });
    await expect(store.read({ actorUserId: member, recordId: saved.reference.recordId })).rejects.toThrow(/super admin/);
    const replacement = new MasterKey(Buffer.alloc(32, 75));
    await recoverVault(db, replacement, recovery, owner);
    const recovered = new CardinalDraftStore(db, replacement);
    const read = await recovered.read({ actorUserId: owner, recordId: saved.reference.recordId });
    expect(read.document.draft).toEqual(rule());
    await expect(recovered.test({ ...testArgs(), expected: read.reference })).rejects.toThrow(/reconciliation/);
  });

  it('rolls back test/result/version when audit persistence fails', async () => {
    const saved = await store.save({ actorUserId: owner, draft: rule() });
    const broken = new CardinalDraftStore({ query: db.query, transaction: work => db.transaction!(tx => work({
      query: (sql, params) => { if (sql.includes('insert into events')) throw new Error('synthetic audit outage'); return tx.query(sql, params); },
    })) }, key);
    await expect(broken.test({ ...testArgs(), expected: saved.reference })).rejects.toThrow(/audit outage/);
    expect((await store.read({ actorUserId: owner, recordId: saved.reference.recordId, expected: saved.reference })).document.tested).toBeNull();
    expect(await db.query('select * from vault_record_versions')).toHaveLength(1);
  });
});
