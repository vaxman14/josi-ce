import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { asSecret, initializeVault, MasterKey, openCredentialEnvelope, seal, recoverVault, setVaultLock, VaultLockedError } from '@josi-ce/core';
import { loadConfig, openToken, openWebhookSecret, removeBot, setBotToken } from '../src/telegram/config.js';

let db: TestDb, admin: string, recovery: string;
const key = new MasterKey(Buffer.alloc(32, 35));
const token = '12345:' + 'x'.repeat(35);
const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ ok: true, result: { id: 77, is_bot: true, username: 'fixture_bot' } }), { status: 200 });
beforeEach(async () => {
  db = await testDb();
  admin = (await createUser(db, { email: 'channel@example.test', username: 'channel-admin', role: 'super_admin' })).id;
  recovery = (await initializeVault(db, key, admin)).recoveryKey.reveal();
});
async function legacy() {
  await db.query('update telegram_config set bot_token_enc=$1,webhook_secret_enc=$2', [seal(key, { token }), seal(key, { secret: 'synthetic-webhook-value' })]);
  return loadConfig(db);
}

describe('Telegram canonical Vault migration', () => {
  it('atomically replaces legacy ciphertext with owner-bound references and preserves credential values', async () => {
    const old = await legacy();
    expect((await openToken(db, key, old)).reveal()).toBe(token);
    expect((await openWebhookSecret(db, key, old)).reveal()).toBe('synthetic-webhook-value');
    const current = await loadConfig(db);
    expect(current.vault_owner_user_id).toBe(admin);
    expect(await openCredentialEnvelope(db, key, current.bot_token_enc!)).toHaveProperty('vaultItemId');
    expect(await openCredentialEnvelope(db, key, current.webhook_secret_enc!)).toHaveProperty('vaultItemId');
    expect((await openToken(db, key, current)).reveal()).toBe(token);
    expect(await db.query("select id from vault_items where service='channel.telegram'")).toHaveLength(2);
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(token);
    await expect(openToken(db, key, old)).rejects.toThrow(/changed/);
  });

  it('does not resolve or import a legacy credential while the Vault is locked', async () => {
    const old = await legacy();
    await setVaultLock(db, { master: true, locked: true, actorUserId: admin });
    await expect(openToken(db, key, old)).rejects.toBeInstanceOf(VaultLockedError);
    expect((await loadConfig(db)).bot_token_enc).toBe(old.bot_token_enc);
    expect(await db.query('select id from vault_items')).toHaveLength(0);
  });

  it('rolls back import and audit if reference replacement fails', async () => {
    const old = await legacy();
    await db.exec(`create function reject_telegram() returns trigger as $$ begin raise exception 'synthetic update failure'; end; $$ language plpgsql;
      create trigger reject_telegram before update on telegram_config for each row execute function reject_telegram();`);
    await expect(openToken(db, key, old)).rejects.toThrow('synthetic update failure');
    expect((await loadConfig(db)).bot_token_enc).toBe(old.bot_token_enc);
    expect(await db.query('select id from vault_items')).toHaveLength(0);
    expect(await db.query("select id from events where kind='vault.item_stored'")).toHaveLength(0);
  });

  it('stores rotations in the Vault and rejects a configuration snapshot taken before rotation', async () => {
    await setBotToken(db, { masterKey: key, token: asSecret(token), actorUserId: admin, fetchImpl });
    const old = await loadConfig(db);
    await setBotToken(db, { masterKey: key, token: asSecret('67890:' + 'y'.repeat(35)), actorUserId: admin, fetchImpl });
    await expect(openToken(db, key, old)).rejects.toThrow(/changed/);
    const current = await loadConfig(db);
    expect((await openToken(db, key, current)).reveal()).toBe('67890:' + 'y'.repeat(35));
    await setVaultLock(db, { master: true, locked: true, actorUserId: admin });
    await expect(openToken(db, key, current)).rejects.toBeInstanceOf(VaultLockedError);
    // Revocation is still available while locked, even if remote cleanup fails.
    expect(await removeBot(db, { masterKey: key, actorUserId: admin, fetchImpl })).toEqual({ webhookDeleted: false });
    expect((await loadConfig(db)).bot_token_enc).toBeNull();
    expect(await db.query("select id from vault_items where service='channel.telegram'")).toHaveLength(0);
  });

  it('upgrades an old install-key reference before recovery and keeps both channel credentials usable', async () => {
    await setBotToken(db, { masterKey: key, token: asSecret(token), actorUserId: admin, fetchImpl });
    const current = await loadConfig(db);
    const pointer = await openCredentialEnvelope(db, key, current.bot_token_enc!);
    await db.query('update telegram_config set bot_token_enc=$1', [seal(key, { vaultItemId: pointer.vaultItemId })]);
    expect((await openToken(db, key, await loadConfig(db))).reveal()).toBe(token);
    const migrated = await loadConfig(db);
    const webhook = (await openWebhookSecret(db, key, migrated)).reveal();
    const replacement = new MasterKey(Buffer.alloc(32, 41));
    await recoverVault(db, replacement, recovery, admin);
    expect((await openToken(db, replacement, migrated)).reveal()).toBe(token);
    expect((await openWebhookSecret(db, replacement, migrated)).reveal()).toBe(webhook);
  });

  it('never writes a fallback credential before Vault initialization', async () => {
    await db.query('update vault_state set initialized_at=null');
    await expect(setBotToken(db, { masterKey: key, token: asSecret(token), actorUserId: admin, fetchImpl })).rejects.toBeInstanceOf(VaultLockedError);
    expect((await loadConfig(db)).bot_token_enc).toBeNull();
    expect(await db.query('select id from vault_items')).toHaveLength(0);
  });
});
