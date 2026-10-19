import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { MasterKey, initializeVault, recoverVault, setVaultLock, isVaultCredentialReference,
  openCredentialEnvelope, deleteVaultSlot, seal, VaultLockedError } from '@josi-ce/core';
import { createStateStore, saveClient, loadClient, deleteClient } from '../src/index.js';

let db: TestDb, admin: string, member: string, recovery: string;
const key = new MasterKey(Buffer.alloc(32, 51));
const client = { provider: 'google' as const, clientId: 'synthetic-client', clientSecret: 'synthetic-oauth-client-value', redirectUri: 'https://fixture.test/callback' };
const session = '11111111-1111-4111-8111-111111111111';
const slot = (state: string) => createHash('sha256').update(state).digest('hex');
beforeEach(async () => {
  db = await testDb();
  [{ id: admin }] = await db.query<{ id: string }>("insert into users(email,username,role) values('oauth-admin@fixture.test','oauth-admin','super_admin') returning id");
  [{ id: member }] = await db.query<{ id: string }>("insert into users(email,username,role) values('oauth-member@fixture.test','oauth-member','member') returning id");
  recovery = (await initializeVault(db, key, admin)).recoveryKey.reveal();
});
const save = () => saveClient(db, key, { ...client, actorUserId: admin });
const start = () => createStateStore(db, key).start({ userId: member, sessionId: session, provider: 'google', scopes: 'scope', capabilities: [] });
const consume = (state: string, useKey = key) => createStateStore(db, useKey).consume({ state, sessionId: session, provider: 'google' });
const items = (service: string) => db.query('select id from vault_items where service=$1', [service]);

describe('OAuth application Vault authority', () => {
  it('imports legacy application secrets and survives replacement-key recovery', async () => {
    await db.query('insert into oauth_clients(provider,client_id,client_secret_enc,redirect_uri,configured_by) values($1,$2,$3,$4,$5)',
      [client.provider, client.clientId, seal(key, { clientSecret: client.clientSecret }), client.redirectUri, admin]);
    expect(await loadClient(db, key, 'google')).toEqual(client);
    const [row] = await db.query<{ client_secret_enc: string; vault_owner_user_id: string }>('select * from oauth_clients');
    expect(isVaultCredentialReference(row.client_secret_enc)).toBe(true);
    expect(row.vault_owner_user_id).toBe(admin);
    const replacement = new MasterKey(Buffer.alloc(32, 52));
    await recoverVault(db, replacement, recovery, admin);
    expect(await loadClient(db, replacement, 'google')).toEqual(client);
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(client.clientSecret);
  });

  it('upgrades old references, preserves ownership and denies cross-provider substitution', async () => {
    await save();
    const [old] = await db.query<{ client_secret_enc: string }>('select * from oauth_clients');
    const reference = await openCredentialEnvelope(db, key, old.client_secret_enc);
    await db.query('update oauth_clients set client_secret_enc=$1', [seal(key, { vaultItemId: reference.vaultItemId })]);
    expect(await loadClient(db, key, 'google')).toEqual(client);
    await db.query('update oauth_clients set configured_by=$1', [member]);
    expect(await loadClient(db, key, 'google')).toEqual(client);
    await saveClient(db, key, { ...client, provider: 'microsoft', actorUserId: admin });
    await db.query("update oauth_clients set client_secret_enc=(select client_secret_enc from oauth_clients where provider='microsoft') where provider='google'");
    await expect(loadClient(db, key, 'google')).rejects.toThrow(/context/);
  });

  it.each(['create', 'rotate', 'import'])('rolls back a failed %s with its Vault write', async operation => {
    if (operation === 'rotate') await save();
    if (operation === 'import') await db.query('insert into oauth_clients(provider,client_id,client_secret_enc,redirect_uri,configured_by) values($1,$2,$3,$4,$5)',
      [client.provider, client.clientId, seal(key, { clientSecret: client.clientSecret }), client.redirectUri, admin]);
    const before = await db.query('select client_secret_enc from oauth_clients');
    await db.exec(`create function reject_oauth_write() returns trigger as $$ begin raise exception 'synthetic configuration failure'; end; $$ language plpgsql;
      create trigger reject_oauth_write before insert or update on oauth_clients for each row execute function reject_oauth_write();`);
    await expect(operation === 'import' ? loadClient(db, key, 'google') : saveClient(db, key, { ...client, clientSecret: 'replacement-value', actorUserId: admin })).rejects.toThrow('synthetic configuration failure');
    expect(await db.query('select client_secret_enc from oauth_clients')).toEqual(before);
    expect(await items('oauth_client')).toHaveLength(operation === 'rotate' ? 1 : 0);
    if (operation === 'rotate') expect(await loadClient(db, key, 'google')).toEqual(client);
  });

  it.each(['master', 'box'])('denies reads and writes under a %s lock while permitting removal', async kind => {
    await save();
    await setVaultLock(db, { ...(kind === 'master' ? { master: true } : { ownerUserId: admin }), locked: true, actorUserId: admin });
    await expect(loadClient(db, key, 'google')).rejects.toBeInstanceOf(VaultLockedError);
    await expect(save()).rejects.toBeInstanceOf(VaultLockedError);
    await deleteClient(db, { provider: 'google', actorUserId: admin });
    expect(await items('oauth_client')).toHaveLength(0);
    expect(await db.query('select provider from oauth_clients')).toHaveLength(0);
  });
});

describe('temporary connection verifiers', () => {
  it('survives recovery, consumes once under competing callbacks and removes the canonical secret', async () => {
    const { state, verifier } = await start();
    const replacement = new MasterKey(Buffer.alloc(32, 53));
    await recoverVault(db, replacement, recovery, admin);
    const results = await Promise.all([consume(state, replacement), consume(state, replacement)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const accepted = results.find(result => result.ok)!;
    expect(accepted.ok && accepted.handshake.verifier).toBe(verifier);
    expect(results).toContainEqual({ ok: false, reason: 'consumed' });
    expect(await items('oauth.pkce')).toHaveLength(0);
    expect((await db.query('select verifier_enc from oauth_states'))[0].verifier_enc).toBeNull();
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(verifier);
  });

  it.each(['master', 'box'])('retains a valid callback under a %s lock, then allows retry', async kind => {
    const { state } = await start();
    const lock = { ...(kind === 'master' ? { master: true } : { ownerUserId: member }), actorUserId: admin };
    await setVaultLock(db, { ...lock, locked: true });
    await expect(consume(state)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(start()).rejects.toBeInstanceOf(VaultLockedError);
    expect((await db.query('select consumed_at from oauth_states'))[0].consumed_at).toBeNull();
    await setVaultLock(db, { ...lock, locked: false });
    expect((await consume(state)).ok).toBe(true);
  });

  it('keeps callback/session/provider binding and rejects a transplanted verifier', async () => {
    const first = await start(), second = await start(), store = createStateStore(db, key);
    expect(await store.consume({ state: first.state, provider: 'microsoft', sessionId: session })).toEqual({ ok: false, reason: 'wrong_provider' });
    expect(await store.consume({ state: first.state, provider: 'google', sessionId: 'different' })).toEqual({ ok: false, reason: 'session_mismatch' });
    expect(await items('oauth.pkce')).toHaveLength(2);
    await db.query('update oauth_states set verifier_enc=(select verifier_enc from oauth_states where id=$2) where id=$1', [first.state, second.state]);
    await expect(consume(first.state)).rejects.toThrow(/context/);
    expect((await consume(second.state)).ok).toBe(true);
  });

  it('imports an existing in-flight legacy verifier without leaving a second secret copy', async () => {
    const { state, verifier } = await start();
    await deleteVaultSlot(db, { ownerUserId: member, service: 'oauth.pkce', slot: slot(state), actorUserId: member });
    await db.query('update oauth_states set verifier_enc=$2 where id=$1', [state, seal(key, { verifier })]);
    const result = await consume(state);
    expect(result.ok && result.handshake.verifier).toBe(verifier);
    expect(await items('oauth.pkce')).toHaveLength(0);
  });

  it.each(['insert', 'update'])('rolls back temporary credentials and state when %s fails', async operation => {
    const started = operation === 'update' ? await start() : null;
    await db.exec(`create function reject_state_write() returns trigger as $$ begin raise exception 'synthetic state failure'; end; $$ language plpgsql;
      create trigger reject_state_write before ${operation} on oauth_states for each row execute function reject_state_write();`);
    await expect(started ? consume(started.state) : start()).rejects.toThrow('synthetic state failure');
    expect(await items('oauth.pkce')).toHaveLength(started ? 1 : 0);
    if (started) expect((await db.query('select consumed_at from oauth_states'))[0].consumed_at).toBeNull();
  });

  it('erases expired credentials while locked before the state-row grace period elapses', async () => {
    await start();
    await db.query("update oauth_states set expires_at=now()-interval '1 minute'");
    await setVaultLock(db, { master: true, locked: true, actorUserId: admin });
    expect(await createStateStore(db, null).purge()).toBe(0);
    expect(await items('oauth.pkce')).toHaveLength(0);
    expect((await db.query('select verifier_enc from oauth_states'))[0].verifier_enc).toBeNull();
  });

  it('refuses missing, corrupt, uninitialized or unavailable verifier authority without weakening PKCE', async () => {
    const { state } = await start();
    await db.query('update oauth_states set verifier_enc=$2 where id=$1', [state, seal(key, { verifier: 'invalid' })]);
    await expect(consume(state)).rejects.toThrow(/invalid/);
    await db.query('update oauth_states set verifier_enc=null where id=$1', [state]);
    await expect(consume(state)).rejects.toThrow(/unavailable/);
    await expect(createStateStore(db, null).start({ userId: member, provider: 'google', scopes: '', capabilities: [] })).rejects.toBeInstanceOf(VaultLockedError);
    await db.query('update vault_state set initialized_at=null');
    await expect(start()).rejects.toBeInstanceOf(VaultLockedError);
    await expect(save()).rejects.toBeInstanceOf(VaultLockedError);
    expect((await db.query('select consumed_at from oauth_states'))[0].consumed_at).toBeNull();
  });
});
