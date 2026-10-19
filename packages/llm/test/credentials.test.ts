import { beforeEach, describe, expect, it } from 'vitest';
import { MasterKey, initializeVault, recoverVault, setVaultLock, seal, isVaultCredentialReference, VaultLockedError } from '@josi-ce/core';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { saveModelConfiguration, resolveModelCredentials, removeModelConfiguration } from '../src/credentials.js';
import { buildProvider, loadStoredProvider } from '../src/registry.js';

const key = new MasterKey(Buffer.alloc(32, 66));
let db: TestDb, owner: string, recovery: string;
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role) values('model@fixture.test','model','super_admin') returning id");
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
});
const configuration = () => ({ role: 'primary' as const, provider: 'openai' as const, model: 'fixture-model', baseUrl: null,
  acknowledged: true, secrets: { apiKey: 'synthetic-model-key' }, settings: {}, actorUserId: owner });
const stored = async (role: 'primary' | 'fallback' = 'primary') => (await loadStoredProvider(db, role))!;
const items = () => db.query("select id from vault_items where service='llm'");

describe('model credential authority', () => {
  it('stores a bound reference that survives replacement-key recovery and administrator succession', async () => {
    await saveModelConfiguration(db, key, configuration());
    const row = await stored();
    expect(row.vault_owner_user_id).toBe(owner);
    expect(isVaultCredentialReference(row.api_key_enc)).toBe(true);
    await db.query("update users set role='member' where id=$1", [owner]);
    const [{ id: successor }] = await db.query<{ id: string }>("insert into users(email,username,role) values('next@fixture.test','next','super_admin') returning id");
    const replacement = new MasterKey(Buffer.alloc(32, 67));
    await recoverVault(db, replacement, recovery, successor);
    expect((await resolveModelCredentials(db, replacement, row)).secrets.apiKey).toBe('synthetic-model-key');
    await saveModelConfiguration(db, replacement, { ...configuration(), actorUserId: successor, secrets: { apiKey: 'synthetic-rotated-key' } });
    expect((await stored()).vault_owner_user_id).toBe(owner);
    expect(await items()).toHaveLength(1);
  });

  it('recovers the historical owner of an older reference after administrator succession', async () => {
    await saveModelConfiguration(db, key, configuration());
    await db.query("update llm_providers set vault_owner_user_id=null where role='primary'");
    await db.query("update users set role='member' where id=$1", [owner]);
    await db.query("insert into users(email,username,role) values('next@fixture.test','next','super_admin')");
    expect((await resolveModelCredentials(db, key, await stored())).secrets.apiKey).toBe('synthetic-model-key');
    expect((await stored()).vault_owner_user_id).toBe(owner);
  });

  it('merges a partial multi-secret update and keeps a blank current reference unchanged', async () => {
    await saveModelConfiguration(db, key, { ...configuration(), provider: 'ernie', secrets: { apiKey: 'fixture-id', secretKey: 'fixture-secret' } });
    await saveModelConfiguration(db, key, { ...configuration(), provider: 'ernie', secrets: { secretKey: 'fixture-new-secret' } });
    expect((await resolveModelCredentials(db, key, await stored())).secrets).toEqual({ apiKey: 'fixture-id', secretKey: 'fixture-new-secret' });
    const before = (await stored()).api_key_enc;
    await saveModelConfiguration(db, key, { ...configuration(), provider: 'ernie', secrets: {} });
    expect((await stored()).api_key_enc).toBe(before);
  });

  it.each(['master', 'box'])('does not read or retain credentials through a %s lock, but permits removal', async kind => {
    await saveModelConfiguration(db, key, configuration());
    const row = await stored();
    await setVaultLock(db, { ...(kind === 'master' ? { master: true } : { ownerUserId: owner }), locked: true, actorUserId: owner });
    await expect(resolveModelCredentials(db, key, row)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(saveModelConfiguration(db, key, { ...configuration(), secrets: {} })).rejects.toBeInstanceOf(VaultLockedError);
    await removeModelConfiguration(db, 'primary', owner);
    expect(await items()).toHaveLength(0);
    expect(await loadStoredProvider(db, 'primary')).toBeNull();
  });

  it('allows switching to a keyless local model while locked and erases the old canonical credential', async () => {
    await saveModelConfiguration(db, key, configuration());
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    await saveModelConfiguration(db, null, { ...configuration(), provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1', secrets: {} });
    expect(await items()).toHaveLength(0);
    expect((await resolveModelCredentials(db, null, await stored())).secrets).toEqual({});
  });

  it('migrates legacy ciphertext and returns the exact version a capability probe prepared', async () => {
    await db.query("insert into llm_providers(role,provider,model,api_key_enc,external_acknowledged) values('primary','openai','fixture-model',$1,true)", [seal(key, { apiKey: 'synthetic-legacy-key' })]);
    const provider = await buildProvider({ db, masterKey: key }, await stored());
    const current = await stored();
    expect(provider.configurationVersion).toBe(current.updated_at);
    expect(isVaultCredentialReference(current.api_key_enc)).toBe(true);
    expect((await resolveModelCredentials(db, key, current)).secrets.apiKey).toBe('synthetic-legacy-key');
  });

  it('refuses stale destinations, deleted selections and cross-slot references', async () => {
    await saveModelConfiguration(db, key, configuration());
    const old = await stored();
    await saveModelConfiguration(db, key, { ...configuration(), baseUrl: 'https://new.fixture.test/v1' });
    await expect(resolveModelCredentials(db, key, old)).rejects.toThrow('changed');
    await saveModelConfiguration(db, key, { ...configuration(), role: 'fallback' });
    await db.query("update llm_providers set api_key_enc=(select api_key_enc from llm_providers where role='fallback') where role='primary'");
    await expect(resolveModelCredentials(db, key, await stored())).rejects.toThrow(/context/);
    await removeModelConfiguration(db, 'primary', owner);
    await expect(resolveModelCredentials(db, key, old)).rejects.toThrow('changed');
  });

  it('requires newly supplied credentials when changing provider and validates all fields before storage', async () => {
    await saveModelConfiguration(db, key, configuration());
    const before = await stored();
    await expect(saveModelConfiguration(db, key, { ...configuration(), provider: 'anthropic', secrets: {} })).rejects.toThrow('needs');
    await expect(saveModelConfiguration(db, key, { ...configuration(), secrets: { secretKey: 'not-allowed' } })).rejects.toThrow('Unexpected');
    await expect(saveModelConfiguration(db, key, { ...configuration(), settings: { apiKey: 'not-a-setting' } })).rejects.toThrow('Unexpected');
    expect(await stored()).toEqual(before);
  });

  it.each(['insert', 'update'])('rolls back the canonical credential when configuration %s fails', async operation => {
    if (operation === 'update') await saveModelConfiguration(db, key, configuration());
    await db.exec(`create function reject_model() returns trigger as $$ begin raise exception 'synthetic model failure'; end; $$ language plpgsql;
      create trigger reject_model before ${operation} on llm_providers for each row execute function reject_model();`);
    await expect(saveModelConfiguration(db, key, { ...configuration(), secrets: { apiKey: 'synthetic-replacement' } })).rejects.toThrow('synthetic model failure');
    expect(await items()).toHaveLength(operation === 'update' ? 1 : 0);
    if (operation === 'update') expect((await resolveModelCredentials(db, key, await stored())).secrets.apiKey).toBe('synthetic-model-key');
  });

  it('rolls back deletion if its audit fails', async () => {
    await saveModelConfiguration(db, key, configuration());
    await db.exec("create function reject_model() returns trigger as $$ begin raise exception 'synthetic model failure'; end; $$ language plpgsql; create trigger reject_model before insert on events for each row execute function reject_model();");
    await expect(removeModelConfiguration(db, 'primary', owner)).rejects.toThrow('synthetic model failure');
    expect(await stored()).not.toBeNull(); expect(await items()).toHaveLength(1);
  });

  it('refuses new secret writes before Vault initialization', async () => {
    await db.query('update vault_state set initialized_at=null');
    await expect(saveModelConfiguration(db, key, configuration())).rejects.toBeInstanceOf(VaultLockedError);
    expect(await items()).toHaveLength(0);
  });
});
