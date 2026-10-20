import { beforeEach, describe, expect, it } from 'vitest';
import { generate } from 'otplib';
import { CardinalDraftStore, MasterKey, cardinalContentDigest, cardinalDraftTestBinding, cardinalReviewInput, initializeVault, setVaultLock, type Db, type CardinalRule } from '@josi-ce/core';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { hashPassword } from '../src/passwords.js';
import { createSession, revokeSession } from '../src/sessions.js';
import { beginMfaSetup, enableMfa } from '../src/mfa.js';
import { reauthenticateProtectedAdmin, type ProtectedAdminProof, type ProtectedAdminBinding } from '../src/protectedAdmin.js';

const key = new MasterKey(Buffer.alloc(32, 76));
const password = 'synthetic-protected-password';
let db: TestDb, owner: string, member: string, sessionId: string;
const rule: CardinalRule = { schemaVersion: 1, label: 'No terminal', wording: 'Never run shell commands.', actions: ['execution.shell'],
  scope: { userId: '*', serverId: '*', deviceId: '*', workspaceId: '*', taskId: '*' }, restriction: { kind: 'deny' }, onUnavailable: 'pause' };
const binding: ProtectedAdminBinding = { purpose: 'cardinal.draft.save', requestDigest: cardinalContentDigest({ draft: rule, expected: null }) };
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role,password_hash) values('protected@fixture.test','protected','super_admin',$1) returning id", [await hashPassword(password)]);
  [{ id: member }] = await db.query<{ id: string }>("insert into users(email,username,role,password_hash) values('member@fixture.test','member','member',$1) returning id", [await hashPassword(password)]);
  await initializeVault(db, key, owner);
  sessionId = (await createSession(db, { userId: owner })).sessionId;
});
const issue = (extra: Partial<Parameters<typeof reauthenticateProtectedAdmin>[2]> = {}, target: Db = db) => reauthenticateProtectedAdmin(target, key,
  { ...binding, userId: owner, sessionId, password, ...extra });
const check = (proof: ProtectedAdminProof, consume = false, override: Partial<ProtectedAdminBinding & { actorUserId: string }> = {}) =>
  db.transaction!(tx => proof.check(tx, { ...binding, actorUserId: owner, consume, ...override }));
const withProof = (proof: ProtectedAdminProof, target: Db = db) => new CardinalDraftStore(target, key,
  (tx, actorUserId, writing, command) => {
    if (command.purpose === 'cardinal.draft.read') throw new Error('A save receipt is not a read session');
    return proof.check(tx, { ...command, actorUserId, consume: writing });
  });

describe('fresh exact-command administrator verification', () => {
  it('commits one mutation with one verification and keeps receipt hashes free of command/credential values', async () => {
    const proof = await issue();
    expect(JSON.stringify(proof)).toBe('"[protected administrator verification redacted]"');
    const saved = await withProof(proof).save({ actorUserId: owner, draft: rule });
    expect(saved.document.draft).toEqual(rule);
    await expect(withProof(proof).save({ actorUserId: owner, draft: rule })).rejects.toThrow(/Confirm/);
    const stored = JSON.stringify(await db.query('select * from protected_admin_reauth'));
    expect(stored).not.toContain(password); expect(stored).not.toContain(rule.wording); expect(stored).not.toContain(binding.requestDigest);
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(password);
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).not.toBeNull();
  });

  it('refuses wrong credentials, ordinary users, mismatched/expired sessions and unknown purposes', async () => {
    await expect(issue({ password: 'wrong' })).rejects.toMatchObject({ status: 401 });
    await expect(issue({ userId: member })).rejects.toMatchObject({ status: 403 });
    const memberSession = (await createSession(db, { userId: member })).sessionId;
    await expect(issue({ sessionId: memberSession })).rejects.toMatchObject({ status: 401 });
    await expect(issue({ purpose: 'settings.anything' as never })).rejects.toMatchObject({ status: 401 });
    await db.query("update sessions set expires_at=now()-interval '1 second' where id=$1", [sessionId]);
    await expect(issue()).rejects.toMatchObject({ status: 401 });
    expect(await db.query('select * from protected_admin_reauth')).toEqual([]);
  });

  it('binds the actor, exact request and purpose, without consuming on a mismatch', async () => {
    const proof = await issue();
    await expect(check(proof, true, { actorUserId: member })).rejects.toThrow(/Confirm/);
    await expect(check(proof, true, { purpose: 'cardinal.activate' })).rejects.toThrow(/Confirm/);
    await expect(check(proof, true, { requestDigest: 'f'.repeat(64) })).rejects.toThrow(/Confirm/);
    await expect(withProof(proof).save({ actorUserId: owner, draft: { ...rule, wording: 'Changed after confirmation.' } })).rejects.toThrow(/Confirm/);
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
    await check(proof, true);
    await expect(check(proof)).rejects.toThrow(/Confirm/);
  });

  it('expires after the bounded verification window and cannot outlive session revocation', async () => {
    const expired = await issue();
    await db.query("update protected_admin_reauth set expires_at=now()-interval '1 second'");
    await expect(check(expired)).rejects.toThrow(/Confirm/);
    const revoked = await issue();
    await revokeSession(db, sessionId);
    await expect(withProof(revoked).save({ actorUserId: owner, draft: rule })).rejects.toThrow(/Confirm/);
    expect(await db.query('select * from vault_record_heads')).toEqual([]);
  });

  it('invalidates after password, role, authenticator or Vault authority changes', async () => {
    const changedPassword = await issue();
    await db.query('update users set password_hash=$2 where id=$1', [owner, await hashPassword('replacement-protected-password')]);
    await expect(check(changedPassword)).rejects.toThrow(/Confirm/);
    await db.query('update users set password_hash=$2 where id=$1', [owner, await hashPassword(password)]);
    const changedFactor = await issue();
    await beginMfaSetup(db, key, owner);
    await expect(check(changedFactor)).rejects.toThrow(/Confirm/);
    const changedRole = await issue();
    await db.query("update users set role='member' where id=$1", [owner]);
    await expect(check(changedRole)).rejects.toMatchObject({ status: 403 });
    await db.query("update users set role='super_admin' where id=$1", [owner]);
    const changedEpoch = await issue();
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    await expect(check(changedEpoch)).rejects.toThrow(/Vault/);
    await setVaultLock(db, { master: true, locked: false, actorUserId: owner });
    await expect(check(changedEpoch)).rejects.toThrow(/Confirm/);
  });

  it('requires the enabled second factor and consumes recovery codes only once', async () => {
    const secret = await beginMfaSetup(db, key, owner);
    const recovery = await enableMfa(db, key, owner, await generate({ secret }));
    await expect(issue()).rejects.toThrow(/Confirm/);
    await expect(issue({ mfaCode: 'not-a-code' })).rejects.toThrow(/Confirm/);
    await expect(issue({ password: 'wrong', mfaCode: recovery[0] })).rejects.toThrow(/Confirm/);
    const totpProof = await issue({ mfaCode: await generate({ secret }) });
    await check(totpProof);
    const recoveryProof = await issue({ mfaCode: recovery[0] });
    await check(recoveryProof);
    await expect(issue({ mfaCode: recovery[0] })).rejects.toThrow(/Confirm/);
  });

  it('checks current session and exact model identity again after a delayed review', async () => {
    const plainStore = new CardinalDraftStore(db, key);
    const saved = await plainStore.save({ actorUserId: owner, draft: rule });
    const args = { actorUserId: owner, expected: saved.reference,
      approvedReviewInputDigest: cardinalContentDigest(cardinalReviewInput(rule)),
      reviewerIdentity: { providerId: 'primary', model: 'synthetic', configurationVersion: 'one' },
      reviewer: async () => {
        await revokeSession(db, sessionId);
        return { status: 'available' as const, assessment: { clarity: 'clear' as const, summary: 'Exact meaning.', concerns: [], suggestions: [] } };
      } };
    const proof = await issue(cardinalDraftTestBinding(args));
    const guarded = withProof(proof);
    await expect(guarded.test({ ...args, reviewerIdentity: { ...args.reviewerIdentity, model: 'substituted' } })).rejects.toThrow(/Confirm/);
    await expect(guarded.test(args)).rejects.toThrow(/Confirm/);
    expect((await plainStore.read({ actorUserId: owner, recordId: saved.reference.recordId })).document.tested).toBeNull();
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
  });

  it('consumes only at the final test/result commit, not when reading the draft for review', async () => {
    const saved = await new CardinalDraftStore(db, key).save({ actorUserId: owner, draft: rule });
    const args = { actorUserId: owner, expected: saved.reference,
      approvedReviewInputDigest: cardinalContentDigest(cardinalReviewInput(rule)),
      reviewerIdentity: { providerId: 'primary', model: 'synthetic', configurationVersion: 'one' },
      reviewer: async () => {
        expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
        return { status: 'available' as const, assessment: { clarity: 'clear' as const, summary: 'Exact meaning.', concerns: [], suggestions: [] } };
      } };
    const proof = await issue(cardinalDraftTestBinding(args));
    await withProof(proof).test(args);
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).not.toBeNull();
  });

  it('rolls back factor consumption if verification storage or audit fails', async () => {
    const secret = await beginMfaSetup(db, key, owner);
    const recovery = await enableMfa(db, key, owner, await generate({ secret }));
    const broken: Db = { query: db.query, transaction: work => db.transaction!(tx => work({ query: (sql, params) => {
      if (sql.includes('insert into events')) throw new Error('synthetic audit outage'); return tx.query(sql, params);
    } })) };
    await expect(issue({ mfaCode: recovery[0] }, broken)).rejects.toThrow(/audit outage/);
    expect(await db.query('select * from protected_admin_reauth')).toEqual([]);
    const proof = await issue({ mfaCode: recovery[0] });
    await check(proof);
  });

  it('rolls back receipt consumption with a failed rule write, allowing an exact retry', async () => {
    const proof = await issue();
    const broken: Db = { query: db.query, transaction: work => db.transaction!(tx => work({ query: (sql, params) => {
      if (sql.includes('insert into vault_record_versions')) throw new Error('synthetic record outage'); return tx.query(sql, params);
    } })) };
    await expect(withProof(proof, broken).save({ actorUserId: owner, draft: rule })).rejects.toThrow(/record outage/);
    expect((await db.query('select used_at from protected_admin_reauth'))[0].used_at).toBeNull();
    expect(await db.query('select * from vault_record_heads')).toEqual([]);
    await withProof(proof).save({ actorUserId: owner, draft: rule });
  });

  it('allows only one simultaneous mutation to consume the proof', async () => {
    const proof = await issue(), store = withProof(proof);
    const results = await Promise.allSettled([store.save({ actorUserId: owner, draft: rule }), store.save({ actorUserId: owner, draft: rule })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.query('select * from vault_record_heads')).toHaveLength(1);
  });

  it('requires initialized/unlocked Vault state and limits repeated guesses per account', async () => {
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    await expect(issue()).rejects.toThrow(/Vault/);
    await setVaultLock(db, { master: true, locked: false, actorUserId: owner });
    await db.query('delete from rate_limits');
    for (let attempt = 0; attempt < 10; attempt++) await expect(issue({ password: 'wrong' })).rejects.toMatchObject({ status: 401 });
    const anotherSession = (await createSession(db, { userId: owner })).sessionId;
    await expect(issue({ sessionId: anotherSession })).rejects.toMatchObject({ status: 429 });
  });
});
