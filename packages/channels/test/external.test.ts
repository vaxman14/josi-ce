import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { ensureWorkspace } from '../../core/src/workspace.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey, isVaultCredentialReference, initializeVault, setVaultLock, recoverVault, seal, openCredentialEnvelope, VaultLockedError } from '@josi-ce/core';
import {
  consumeExternalLinkCode, describeExternalConfig, listExternalLinks, loadExternalConfig,
  mintExternalLinkCode, openExternalConfig, resolveExternalLink, revokeExternalLink,
  setExternalEnabled, setExternalProbe, storeExternalConfig,
} from '../src/external.js';

let db: TestDb; let alice: string; let recovery: string; const key = new MasterKey(Buffer.alloc(32, 19));

beforeEach(async () => {
  db = await testDb(); await ensureWorkspace(db, {});
  alice = (await createUser(db, { email: 'alice@external.test', username: 'alice', role: 'super_admin' })).id;
  recovery = (await initializeVault(db, key, alice)).recoveryKey.reveal();
});

describe('external channel trust boundary', () => {
  it('seals configuration, exposes metadata only, and requires a good probe before enablement', async () => {
    await storeExternalConfig(db, { provider: 'slack', masterKey: key, actorUserId: alice, credentials: { signingSecret: 'sign', botToken: 'token' } });
    const row = await loadExternalConfig(db, 'slack');
    expect(isVaultCredentialReference(row.credentials_enc)).toBe(true);
    expect(JSON.stringify(describeExternalConfig(row))).not.toContain('token');
    expect(await openExternalConfig(db, key, row)).toMatchObject({ signingSecret: 'sign', botToken: 'token' });
    await expect(setExternalEnabled(db, 'slack', true)).rejects.toThrow(/test/);
    await setExternalProbe(db, 'slack', true, null); await setExternalEnabled(db, 'slack', true);
    expect((await loadExternalConfig(db, 'slack')).enabled).toBe(true);
  });

  it('links only with a single-use unexpired code and revokes immediately', async () => {
    const minted = await mintExternalLinkCode(db, 'whatsapp', alice);
    const [stored] = await db.query<{ code_hash: string }>('select code_hash from external_channel_link_codes');
    expect(stored.code_hash).not.toContain(minted.code);
    const linked = await consumeExternalLinkCode(db, { provider: 'whatsapp', code: minted.code, externalIdentity: '1555', conversationId: '1555' });
    expect(linked?.user_id).toBe(alice);
    expect(await consumeExternalLinkCode(db, { provider: 'whatsapp', code: minted.code, externalIdentity: '1666', conversationId: '1666' })).toBeNull();
    expect((await resolveExternalLink(db, 'whatsapp', '1555'))?.id).toBe(linked?.id);
    expect(await revokeExternalLink(db, linked!.id, alice)).toBe(true);
    expect(await resolveExternalLink(db, 'whatsapp', '1555')).toBeNull();
    expect(await listExternalLinks(db, alice)).toHaveLength(1);
  });

  it('requires explicit Signal risk acknowledgement', async () => {
    await expect(storeExternalConfig(db, { provider: 'signal', masterKey: key, actorUserId: alice, credentials: { bridgeUrl: 'https://signal.test', account: '+1', bridgeSecret: 's' } })).rejects.toThrow(/risk/);
  });

  it.each(['slack', 'whatsapp'] as const)('migrates both %s credentials atomically and enforces the Vault lock', async provider => {
    await db.query('update external_channel_configs set credentials_enc=$2,webhook_secret_enc=$3 where provider=$1',
      [provider, seal(key, { signingSecret: 'synthetic-signing-value' }), seal(key, { secret: 'synthetic-webhook-value' })]);
    const old = await loadExternalConfig(db, provider);
    expect(await openExternalConfig(db, key, old)).toEqual({ signingSecret: 'synthetic-signing-value', webhookSecret: 'synthetic-webhook-value' });
    const current = await loadExternalConfig(db, provider);
    expect(current.vault_owner_user_id).toBe(alice);
    expect(await openCredentialEnvelope(db, key, current.credentials_enc!)).toHaveProperty('vaultItemId');
    expect(await openCredentialEnvelope(db, key, current.webhook_secret_enc!)).toHaveProperty('vaultItemId');
    expect(await db.query('select id from vault_items where service=$1', [`channel.${provider}`])).toHaveLength(2);
    await expect(openExternalConfig(db, key, old)).rejects.toThrow(/changed/);
    await setVaultLock(db, { master: true, locked: true, actorUserId: alice });
    await expect(openExternalConfig(db, key, current)).rejects.toBeInstanceOf(VaultLockedError);
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain('synthetic-signing-value');
  });

  it('preserves legacy fields and imports neither secret if the pair cannot commit', async () => {
    await db.query("update external_channel_configs set credentials_enc=$1,webhook_secret_enc=$2 where provider='slack'",
      [seal(key, { signingSecret: 'synthetic-signing-value' }), seal(key, { secret: 'synthetic-webhook-value' })]);
    const old = await loadExternalConfig(db, 'slack');
    await db.exec(`create function reject_external_config() returns trigger as $$ begin raise exception 'synthetic config failure'; end; $$ language plpgsql;
      create trigger reject_external_config before update on external_channel_configs for each row execute function reject_external_config();`);
    await expect(openExternalConfig(db, key, old)).rejects.toThrow('synthetic config failure');
    expect(await loadExternalConfig(db, 'slack')).toEqual(old);
    expect(await db.query('select id from vault_items')).toHaveLength(0);
    expect(await db.query("select id from events where kind='vault.item_stored'")).toHaveLength(0);
  });

  it('keeps the migrated credential pair usable after installation-key recovery', async () => {
    await storeExternalConfig(db, { provider: 'slack', masterKey: key, actorUserId: alice, credentials: { signingSecret: 'synthetic-signing', botToken: 'synthetic-token' } });
    const current = await loadExternalConfig(db, 'slack');
    const pointer = await openCredentialEnvelope(db, key, current.credentials_enc!);
    await db.query("update external_channel_configs set credentials_enc=$1 where provider='slack'", [seal(key, { vaultItemId: pointer.vaultItemId })]);
    const expected = await openExternalConfig(db, key, await loadExternalConfig(db, 'slack'));
    const migrated = await loadExternalConfig(db, 'slack');
    const replacement = new MasterKey(Buffer.alloc(32, 42));
    await recoverVault(db, replacement, recovery, alice);
    expect(await openExternalConfig(db, replacement, migrated)).toEqual(expected);
  });

  it('rejects a cross-provider reference instead of resolving another channel credential', async () => {
    for (const provider of ['slack', 'whatsapp'] as const) {
      await storeExternalConfig(db, { provider, masterKey: key, actorUserId: alice, credentials: { signingSecret: `synthetic-${provider}` } });
    }
    const other = await loadExternalConfig(db, 'whatsapp');
    await db.query("update external_channel_configs set credentials_enc=$1 where provider='slack'", [other.credentials_enc]);
    await expect(openExternalConfig(db, key, await loadExternalConfig(db, 'slack'))).rejects.toThrow(/context/);
  });
});
