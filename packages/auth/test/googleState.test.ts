import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { MasterKey, initializeVault, recoverVault, setVaultLock, seal, isVaultCredentialReference, VaultLockedError } from '@josi-ce/core';
import { startGoogleLogin, consumeGoogleLogin, purgeGoogleLoginStates, GOOGLE_NATIVE_RETURN_URI } from '../src/googleState.js';

let db: TestDb, owner: string, recovery: string;
const key = new MasterKey(Buffer.alloc(32, 57));
const digest = (state: string) => createHash('sha256').update(state).digest('hex');
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role) values('login-vault@fixture.test','login-vault','super_admin') returning id");
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
  await db.query("insert into oauth_clients(provider,client_id,client_secret_enc,redirect_uri,configured_by) values('google','fixture',$1,'https://fixture.test/callback',$2)", [seal(key, { clientSecret: 'synthetic-client-value' }), owner]);
});
const start = () => startGoogleLogin(db, key, GOOGLE_NATIVE_RETURN_URI);
const items = () => db.query("select id from vault_items where service='auth.google.pkce'");

describe('Google login verifier authority', () => {
  it('stores a recoverable Vault reference, matches PKCE and consumes exactly once', async () => {
    const { state, challenge } = await start();
    const [row] = await db.query<{ verifier: string }>('select verifier from auth_oauth_states');
    expect(isVaultCredentialReference(row.verifier)).toBe(true);
    const replacement = new MasterKey(Buffer.alloc(32, 58));
    await recoverVault(db, replacement, recovery, owner);
    const results = await Promise.all([1, 2].map(() => consumeGoogleLogin(db, replacement, state)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const accepted = results.find(Boolean)!;
    expect(accepted.nativeReturnUri).toBe(GOOGLE_NATIVE_RETURN_URI);
    expect(createHash('sha256').update(accepted.verifier!).digest('base64url')).toBe(challenge);
    expect(await items()).toHaveLength(0);
    expect((await db.query('select verifier from auth_oauth_states'))[0].verifier).toBe('');
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(accepted.verifier!);
  });

  it.each(['master', 'box'])('does not consume a successful callback under a %s lock', async kind => {
    const { state } = await start();
    const lock = { ...(kind === 'master' ? { master: true } : { ownerUserId: owner }), actorUserId: owner };
    await setVaultLock(db, { ...lock, locked: true });
    await expect(consumeGoogleLogin(db, key, state)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(start()).rejects.toBeInstanceOf(VaultLockedError);
    expect((await db.query('select used_at from auth_oauth_states'))[0].used_at).toBeNull();
    await setVaultLock(db, { ...lock, locked: false });
    expect(await consumeGoogleLogin(db, key, state)).not.toBeNull();
  });

  it('clears cancelled and expired login secrets while locked without decrypting them', async () => {
    const cancelled = await start(), expired = await start();
    await db.query("update auth_oauth_states set expires_at=now()-interval '1 minute' where state_hash=$1", [digest(expired.state)]);
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    expect(await consumeGoogleLogin(db, key, cancelled.state, false)).toEqual({ verifier: null, nativeReturnUri: GOOGLE_NATIVE_RETURN_URI });
    expect(await consumeGoogleLogin(db, key, expired.state)).toBeNull();
    expect(await items()).toHaveLength(0);
    expect(await consumeGoogleLogin(db, key, cancelled.state, false)).toBeNull();
  });

  it('purges expired credentials before the diagnostic grace period', async () => {
    await start();
    await db.query("update auth_oauth_states set expires_at=now()-interval '1 minute'");
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    expect(await purgeGoogleLoginStates(db)).toBe(0);
    expect(await items()).toHaveLength(0);
    await db.query("update auth_oauth_states set expires_at=now()-interval '2 hours'");
    expect(await purgeGoogleLoginStates(db)).toBe(1);
  });

  it('imports an existing legacy login verifier and erases it on consumption', async () => {
    const state = 'synthetic-legacy-state', verifier = 'a'.repeat(64);
    await db.query("insert into auth_oauth_states(state_hash,verifier,expires_at) values($1,$2,now()+interval '10 minutes')", [digest(state), seal(key, { verifier })]);
    expect(await consumeGoogleLogin(db, key, state)).toEqual({ verifier, nativeReturnUri: null });
    expect(await items()).toHaveLength(0);
    expect((await db.query('select verifier from auth_oauth_states'))[0].verifier).toBe('');
  });

  it('refuses cross-state credential substitution and unexpected native return URIs', async () => {
    const one = await start(), two = await start();
    await db.query('update auth_oauth_states set verifier=(select verifier from auth_oauth_states where state_hash=$2) where state_hash=$1', [digest(one.state), digest(two.state)]);
    await expect(consumeGoogleLogin(db, key, one.state)).rejects.toThrow(/context/);
    await db.query("update auth_oauth_states set native_return_uri='https://untrusted.fixture.test' where state_hash=$1", [digest(two.state)]);
    await expect(consumeGoogleLogin(db, key, two.state)).rejects.toThrow(/return URI/);
    await expect(startGoogleLogin(db, key, 'josi://untrusted/callback')).rejects.toThrow(/return URI/);
  });

  it.each(['insert', 'update'])('rolls back both temporary secret and state on failed %s', async operation => {
    const pending = operation === 'update' ? await start() : null;
    await db.exec(`create function reject_login_state() returns trigger as $$ begin raise exception 'synthetic login failure'; end; $$ language plpgsql;
      create trigger reject_login_state before ${operation} on auth_oauth_states for each row execute function reject_login_state();`);
    await expect(pending ? consumeGoogleLogin(db, key, pending.state) : start()).rejects.toThrow('synthetic login failure');
    expect(await items()).toHaveLength(pending ? 1 : 0);
    if (pending) expect((await db.query('select used_at from auth_oauth_states'))[0].used_at).toBeNull();
  });

  it('does not fall back when the verifier is corrupt or the Vault is uninitialized', async () => {
    const { state } = await start();
    await db.query("update auth_oauth_states set verifier='corrupt' where state_hash=$1", [digest(state)]);
    await expect(consumeGoogleLogin(db, key, state)).rejects.toThrow();
    expect((await db.query('select used_at from auth_oauth_states'))[0].used_at).toBeNull();
    await db.query('update vault_state set initialized_at=null');
    await expect(start()).rejects.toBeInstanceOf(VaultLockedError);
    expect(await consumeGoogleLogin(db, key, 'unknown')).toBeNull();
  });
});
