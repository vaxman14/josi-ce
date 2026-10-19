import { beforeEach, describe, expect, it } from 'vitest';
import { MasterKey } from '../src/masterKey.js';
import { seal } from '../src/sealing.js';
import { initializeVault, recoverVault, openCredentialPayload, storeVaultCredentialPayload, storeCredentialPayload, setVaultLock } from '../src/vault.js';
import { inspectCredentialMigration, migrateStoredCredentials } from '../src/credentialMigration.js';
import { testDb, type TestDb } from './helpers.js';

const key = new MasterKey(Buffer.alloc(32, 78));
let db: TestDb, owner: string, member: string, recovery: string;
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role) values('migration@fixture.test','migration','super_admin') returning id");
  [{ id: member }] = await db.query<{ id: string }>("insert into users(email,username,role) values('member@fixture.test','member','member') returning id");
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
});
const encrypted = (payload: object) => seal(key, payload);
async function seed() {
  await db.query('update telegram_config set bot_token_enc=$1,webhook_secret_enc=$2', [encrypted({ token: 'synthetic-bot' }), encrypted({ secret: 'synthetic-webhook' })]);
  await db.query("update external_channel_configs set credentials_enc=$1,webhook_secret_enc=$2 where provider='slack'", [encrypted({ token: 'synthetic-slack' }), encrypted({ secret: 'synthetic-slack-webhook' })]);
  await db.query("insert into oauth_clients(provider,client_id,client_secret_enc,redirect_uri,configured_by) values('google','fixture',$1,'https://fixture.test/callback',$2)", [encrypted({ clientSecret: 'synthetic-client' }), owner]);
  await db.query("insert into connector_configs(provider,client_id,client_secret_enc) values('google','old-fixture',$1)", [encrypted({ clientSecret: 'historical-client' })]);
  await db.query("insert into connections(owner_user_id,provider,secrets_enc,status) values($1,'google',$2,'needs_reconnect')", [member, encrypted({ accessToken: 'synthetic-account', refreshToken: 'synthetic-refresh' })]);
  await db.query("insert into oauth_states(id,user_id,provider,scopes,verifier_enc,expires_at) values('synthetic-state-sensitive',$1,'google','',$2,now()+interval '10 minutes')", [member, encrypted({ verifier: 'synthetic-verifier' })]);
  await db.query("insert into auth_oauth_states(state_hash,verifier,expires_at) values('fixture-hash',$1,now()+interval '10 minutes')", [encrypted({ verifier: 'synthetic-login-verifier' })]);
  await db.query("update users set totp_secret_enc=$2 where id=$1", [member, encrypted({ secret: 'synthetic-authenticator' })]);
  await db.query("insert into llm_providers(role,provider,model,api_key_enc,external_acknowledged) values('primary','anthropic','fixture-model',$1,true)", [encrypted({ apiKey: 'synthetic-model' })]);
  await db.query("insert into smtp_profiles(kind,host,password_enc) values('system','smtp.fixture.test',$1)", [encrypted({ password: 'synthetic-mail' })]);
  await db.query("insert into developer_connections(owner_user_id,service,credentials_enc,status) values($1,'github',$2,'needs_reconnect')", [member, encrypted({ token: 'synthetic-developer' })]);
  await db.query("insert into workflow_integrations(provider,name,base_url,credentials_enc,callback_secret_enc,created_by,status) values('n8n','Fixture','https://n8n.fixture.test',$1,$2,$3,'error')", [encrypted({ token: 'synthetic-workflow' }), encrypted({ secret: 'synthetic-callback' }), owner]);
  await db.query("insert into backup_destination(kind,bucket,region,credentials_enc,encryption_key_ref) values('s3','fixture','us-east-1',$1,$2)", [encrypted({ accessKeyId: 'synthetic-id', secretAccessKey: 'synthetic-storage' }), encrypted({ key: Buffer.alloc(32, 80).toString('base64url') })]);
  await db.query("insert into mobile_devices(owner_user_id,device_identity,platform,expo_token_enc,token_fingerprint) values($1,'fixture-device','ios',$2,'fixture-fingerprint')", [member, encrypted({ token: 'synthetic-mobile' })]);
  await db.query("insert into custom_api_connections(name,slug,base_url,host,auth_kind,credentials_enc,created_by_user_id) values('Fixture','fixture','https://api.fixture.test','api.fixture.test','bearer',$1,$2)", [encrypted({ secret: 'synthetic-custom' }), owner]);
}

describe('upgrade-wide credential migration', () => {
  it('migrates every inventoried family, including unused history and disabled consumers, and is idempotent after recovery', async () => {
    await seed();
    const before = await inspectCredentialMigration(db, owner);
    expect(before.filter(source => source.rows)).toHaveLength(15);
    expect(before.reduce((sum, source) => sum + source.legacyFields, 0)).toBe(19);
    const first = await migrateStoredCredentials(db, key, owner);
    expect(first.issues).toEqual([]); expect(first.migrated).toBe(15); expect(first.legacyMigrationComplete).toBe(true);
    expect(JSON.stringify(first)).not.toContain('synthetic-state-sensitive');
    expect((await db.query('select status from connections'))[0].status).toBe('needs_reconnect');
    expect((await db.query('select status from developer_connections'))[0].status).toBe('needs_reconnect');
    expect((await db.query('select status,enabled from workflow_integrations'))[0]).toEqual({ status: 'error', enabled: false });
    expect((await db.query('select enabled from telegram_config'))[0].enabled).toBe(false);
    expect((await db.query("select mode from developer_service_policy where service='github'"))[0].mode).toBe('not_allowed');
    const replacement = new MasterKey(Buffer.alloc(32, 79));
    await recoverVault(db, replacement, recovery, owner);
    const again = await migrateStoredCredentials(db, replacement, owner);
    expect(again).toMatchObject({ migrated: 0, checked: 15, failed: 0, legacyMigrationComplete: true });
    const [active] = await db.query<any>("select * from oauth_clients where provider='google'");
    expect(await openCredentialPayload(db, replacement, { ownerUserId: owner, service: 'oauth_client', slot: 'google', stored: active.client_secret_enc })).toEqual({ clientSecret: 'synthetic-client' });
    const [old] = await db.query<any>('select * from connector_configs');
    expect(await openCredentialPayload(db, replacement, { ownerUserId: owner, service: 'legacy.connector_config', slot: old.id, stored: old.client_secret_enc })).toEqual({ clientSecret: 'historical-client' });
  });

  it('does not overwrite a different canonical value and continues migrating independent records', async () => {
    await seed();
    await storeVaultCredentialPayload(db, key, { ownerUserId: owner, kind: 'api_key', service: 'llm', slot: 'primary', label: 'Current model', payload: { apiKey: 'newer-value' } });
    const result = await migrateStoredCredentials(db, key, owner);
    expect(result).toMatchObject({ failed: 1, migrated: 14, legacyMigrationComplete: false });
    expect(result.issues[0]).toMatchObject({ source: 'llm_providers', category: 'credential_conflict' });
    expect(JSON.stringify(result)).not.toContain('newer-value');
    expect(result.remaining.find(source => source.source === 'llm_providers')?.legacyFields).toBe(1);
  });

  it('rolls back a whole pair when its audit fails and resumes without rewriting successful records', async () => {
    await seed();
    await db.exec("create function reject_migration() returns trigger as $$ begin if new.kind='vault.credentials_migrated' and new.payload->>'source'='workflow_integrations' then raise exception 'synthetic audit failure'; end if; return new; end; $$ language plpgsql; create trigger reject_migration before insert on events for each row execute function reject_migration();");
    const first = await migrateStoredCredentials(db, key, owner);
    expect(first).toMatchObject({ failed: 1, migrated: 14 });
    expect(await db.query("select id from vault_items where service='workflow.n8n'")).toHaveLength(0);
    await db.exec('drop trigger reject_migration on events');
    expect(await migrateStoredCredentials(db, key, owner)).toMatchObject({ failed: 0, migrated: 1, checked: 14, legacyMigrationComplete: true });
  });

  it('rewraps an old item pointer without erasing its metadata or substituting its owner', async () => {
    await seed();
    const ref = await storeVaultCredentialPayload(db, key, { ownerUserId: member, kind: 'api_key', service: 'llm', slot: 'primary', label: 'Historical label', payload: { apiKey: 'synthetic-model' } });
    const [item] = await db.query<any>("select id from vault_items where service='llm'");
    await db.query("update vault_items set metadata='{\"retained\":true}' where id=$1", [item.id]);
    await db.query("update llm_providers set api_key_enc=$1", [encrypted({ vaultItemId: item.id })]);
    const report = await migrateStoredCredentials(db, key, owner);
    expect(report.failed).toBe(0);
    const [after] = await db.query<any>('select label,metadata from vault_items where id=$1', [item.id]);
    expect(after).toEqual({ label: 'Historical label', metadata: { retained: true } });
    expect((await db.query('select vault_owner_user_id from llm_providers'))[0].vault_owner_user_id).toBe(member);
    expect(ref).toContain('vaultref.v1.');
  });

  it('reports an old Nextcloud pointer bound to the wrong connection slot without repairing it into authority', async () => {
    await seed();
    const [connection] = await db.query<any>('select id from connections');
    const wrong = await storeVaultCredentialPayload(db, key, { ownerUserId: member, kind: 'password', service: 'connector.nextcloud', slot: 'wrong-historical-id', label: 'Misbound historical fixture', payload: { appPassword: 'synthetic-nextcloud', username: 'fixture', serverUrl: 'https://cloud.fixture.test' } });
    await db.query("update connections set provider='nextcloud',secrets_enc=$2 where id=$1", [connection.id, wrong]);
    const result = await migrateStoredCredentials(db, key, owner);
    expect(result).toMatchObject({ failed: 1, legacyMigrationComplete: false });
    expect(result.issues[0]).toMatchObject({ source: 'connections', category: 'unavailable_or_misbound' });
    expect((await db.query('select secrets_enc from connections'))[0].secrets_enc).toBe(wrong);
    expect(await db.query("select id from vault_items where service='connector.nextcloud' and slot=$1", [connection.id])).toHaveLength(0);
  });

  it('reports locked owners without unlocking them or skipping their unused credentials', async () => {
    await seed();
    // Materialize a real box before setting its lock.
    await storeVaultCredentialPayload(db, key, { ownerUserId: member, kind: 'other', service: 'fixture', slot: 'box', label: 'Box fixture', payload: { value: 'synthetic' } });
    await setVaultLock(db, { ownerUserId: member, locked: true, actorUserId: member });
    const result = await migrateStoredCredentials(db, key, owner);
    expect(result.failed).toBe(5); expect(result.legacyMigrationComplete).toBe(false);
    expect(result.issues.every(issue => issue.category === 'locked')).toBe(true);
    await expect(inspectCredentialMigration(db, member)).rejects.toThrow(/super admin/);
    await expect(migrateStoredCredentials(db, key, member)).rejects.toThrow(/super admin/);
  });
});


it('never creates new direct-key credentials before the Vault is initialized', async () => {
  const fresh = await testDb();
  await expect(storeCredentialPayload(fresh, key, { ownerUserId: owner, service: 'fixture', slot: 'credential', label: 'Fixture', kind: 'api_key', payload: { token: 'synthetic' } })).rejects.toThrow();
  expect(await fresh.query('select id from vault_items')).toHaveLength(0);
});
