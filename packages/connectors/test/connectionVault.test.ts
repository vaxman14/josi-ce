import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { MasterKey, initializeVault, recoverVault, setVaultLock, isVaultCredentialReference, openCredentialEnvelope,
  openCredentialPayload, deleteVaultSlot, seal, VaultLockedError } from '@josi-ce/core';
import { accessTokenFor, connectNextcloud, deleteConnection, getConnection, nextcloudCredentialsFor, refreshTokenForRevocation, upsertConnection, type ConnectionRow } from '../src/index.js';

let db: TestDb, owner: string, recovery: string;
const key = new MasterKey(Buffer.alloc(32, 55));
const client = { provider: 'google' as const, clientId: 'synthetic-client', clientSecret: 'synthetic-client-value', redirectUri: 'https://fixture.test/callback' };
const tokens = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresIn: 3600, grantedScopes: 'scope' };
const nextcloud = { serverUrl: 'https://cloud.fixture.test', username: 'synthetic-user', appPassword: 'synthetic-app-password' };
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role) values('connection@fixture.test','connection-admin','super_admin') returning id");
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
});
const connect = (extra: Partial<Parameters<typeof upsertConnection>[2]> = {}) => upsertConnection(db, key, {
  ownerUserId: owner, provider: 'google', tokens, accountEmail: 'account@fixture.test', providerAccountId: 'account-one', requestedCapabilities: [], ...extra,
});
const read = (connection: ConnectionRow, useKey = key) => accessTokenFor(db, useKey, { connection, client }, { fetchImpl: async () => { throw new Error('unexpected synthetic request'); } });
async function legacy(row: ConnectionRow, payload: object) {
  await db.query('update connections set secrets_enc=$2 where id=$1', [row.id, seal(key, payload)]);
  await deleteVaultSlot(db, { ownerUserId: owner, service: `connector.${row.provider}`, slot: row.id, actorUserId: owner });
  return (await getConnection(db, row.id))!;
}

describe('connection Vault authority', () => {
  it('migrates OAuth and Nextcloud legacy credentials and recovers under a replacement installation key', async () => {
    const oauth = await legacy(await connect(), { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    const cloud = await legacy(await connectNextcloud(db, key, { ownerUserId: owner, ...nextcloud }), nextcloud);
    expect(await read(oauth)).toBe(tokens.accessToken);
    expect(await nextcloudCredentialsFor(db, key, cloud)).toEqual(nextcloud);
    expect(isVaultCredentialReference((await getConnection(db, oauth.id))!.secrets_enc)).toBe(true);
    const replacement = new MasterKey(Buffer.alloc(32, 56));
    await recoverVault(db, replacement, recovery, owner);
    expect(await read(oauth, replacement)).toBe(tokens.accessToken);
    expect(await nextcloudCredentialsFor(db, replacement, cloud)).toEqual(nextcloud);
  });

  it('upgrades old references and refuses another account slot', async () => {
    const one = await connect(), two = await connect({ providerAccountId: 'account-two', accountEmail: 'second@fixture.test' });
    const reference = await openCredentialEnvelope(db, key, one.secrets_enc!);
    await db.query('update connections set secrets_enc=$2 where id=$1', [one.id, seal(key, { vaultItemId: reference.vaultItemId })]);
    expect(await read(one)).toBe(tokens.accessToken);
    await db.query('update connections set secrets_enc=$2 where id=$1', [one.id, two.secrets_enc]);
    await expect(read(one)).rejects.toThrow(/context/);
  });

  it('keeps the same Nextcloud slot across reconnects and rejects an old destination snapshot', async () => {
    const first = await connectNextcloud(db, key, { ownerUserId: owner, ...nextcloud });
    const second = await connectNextcloud(db, key, { ownerUserId: owner, ...nextcloud, appPassword: 'rotated-synthetic-password' });
    expect(second.id).toBe(first.id);
    expect(await db.query("select id from vault_items where service='connector.nextcloud'")).toHaveLength(1);
    expect((await nextcloudCredentialsFor(db, key, first)).appPassword).toBe('rotated-synthetic-password');
    await connectNextcloud(db, key, { ownerUserId: owner, ...nextcloud, serverUrl: 'https://other.fixture.test' });
    await expect(nextcloudCredentialsFor(db, key, second)).rejects.toThrow(/configuration changed/);
  });

  it.each(['master', 'box'])('denies old and current credential access under a %s lock, but permits deletion', async kind => {
    const current = await connect(), old = await legacy(await connectNextcloud(db, key, { ownerUserId: owner, ...nextcloud }), nextcloud);
    await setVaultLock(db, { ...(kind === 'master' ? { master: true } : { ownerUserId: owner }), locked: true, actorUserId: owner });
    await expect(read(current)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(nextcloudCredentialsFor(db, key, old)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(connect()).rejects.toBeInstanceOf(VaultLockedError);
    expect((await getConnection(db, current.id))!.last_check_ok).toBe(true);
    await deleteConnection(db, { connectionId: current.id, actorUserId: owner, actor: 'user' });
    expect(await getConnection(db, current.id)).toBeNull();
    expect(await db.query("select id from vault_items where service='connector.google'")).toHaveLength(0);
  });

  it('serializes simultaneous refreshes and keeps a provider-rotated refresh token', async () => {
    const connection = await connect({ tokens: { ...tokens, expiresIn: 1 } });
    let sent = 0;
    const fetchImpl: typeof fetch = async () => {
      sent++;
      return new Response(JSON.stringify({ access_token: 'renewed-access', refresh_token: 'renewed-refresh', expires_in: 3600 }), { status: 200 });
    };
    const results = await Promise.all([1, 2].map(() => accessTokenFor(db, key, { connection, client }, { fetchImpl })));
    expect(results).toEqual(['renewed-access', 'renewed-access']);
    expect(sent).toBe(1);
    const row = (await getConnection(db, connection.id))!;
    const payload = await openCredentialPayload<{ refreshToken: string }>(db, key, { ownerUserId: owner, service: 'connector.google', slot: row.id, stored: row.secrets_enc! });
    expect(payload.refreshToken).toBe('renewed-refresh');
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain('renewed-refresh');
  });

  it('does not discard an unreadable refresh token during incremental reconnect', async () => {
    const row = await connect();
    await db.query('update connections set secrets_enc=$2 where id=$1', [row.id, 'invalid-ciphertext']);
    await expect(connect({ tokens: { ...tokens, refreshToken: null } })).rejects.toThrow();
    expect((await getConnection(db, row.id))!.secrets_enc).toBe('invalid-ciphertext');
  });

  it('preserves the previous Nextcloud password when reconnect storage fails', async () => {
    const row = await connectNextcloud(db, key, { ownerUserId: owner, ...nextcloud });
    await db.exec(`create function reject_cloud_rotation() returns trigger as $$ begin raise exception 'synthetic cloud failure'; end; $$ language plpgsql;
      create trigger reject_cloud_rotation before update on connections for each row execute function reject_cloud_rotation();`);
    await expect(connectNextcloud(db, key, { ownerUserId: owner, ...nextcloud, appPassword: 'replacement-password' })).rejects.toThrow('synthetic cloud failure');
    expect(await nextcloudCredentialsFor(db, key, row)).toEqual(nextcloud);
    expect(await db.query("select id from vault_items where service='connector.nextcloud'")).toHaveLength(1);
  });

  it('requires Vault initialization for new connections', async () => {
    await db.query('update vault_state set initialized_at=null');
    await expect(connect()).rejects.toBeInstanceOf(VaultLockedError);
    await expect(connectNextcloud(db, key, { ownerUserId: owner, ...nextcloud })).rejects.toBeInstanceOf(VaultLockedError);
    expect(await db.query('select id from connections')).toHaveLength(0);
  });

  it.each(['import', 'refresh', 'reconnect'])('keeps the previous credential when a %s cannot commit', async operation => {
    let row = await connect({ tokens: { ...tokens, expiresIn: operation === 'refresh' ? 1 : 3600 } });
    if (operation === 'import') row = await legacy(row, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    await db.exec(`create function reject_connection_update() returns trigger as $$ begin raise exception 'synthetic update failure'; end; $$ language plpgsql;
      create trigger reject_connection_update before update on connections for each row execute function reject_connection_update();`);
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ access_token: 'renewed-access', refresh_token: 'renewed-refresh', expires_in: 3600 }), { status: 200 });
    await expect(operation === 'reconnect' ? connect({ tokens: { ...tokens, accessToken: 'replacement-access' } }) : accessTokenFor(db, key, { connection: row, client }, { fetchImpl })).rejects.toThrow('synthetic update failure');
    expect((await getConnection(db, row.id))!.secrets_enc).toBe(row.secrets_enc);
    const payload = await openCredentialPayload<{ accessToken: string }>(db, key, { ownerUserId: owner, service: 'connector.google', slot: row.id, stored: row.secrets_enc! });
    expect(payload.accessToken).toBe(tokens.accessToken);
    expect(await db.query("select id from vault_items where service='connector.google'")).toHaveLength(operation === 'import' ? 0 : 1);
  });

  it('rolls back new connection credentials and capabilities if the audit cannot commit', async () => {
    await db.exec(`create function reject_connection_audit() returns trigger as $$ begin if new.kind='connection.authorized' then raise exception 'synthetic audit failure'; end if; return new; end; $$ language plpgsql;
      create trigger reject_connection_audit before insert on events for each row execute function reject_connection_audit();`);
    await expect(connect()).rejects.toThrow('synthetic audit failure');
    await expect(connectNextcloud(db, key, { ownerUserId: owner, ...nextcloud })).rejects.toThrow('synthetic audit failure');
    expect(await db.query('select id from connections')).toHaveLength(0);
    expect(await db.query('select id from vault_items')).toHaveLength(0);
    expect(await db.query('select connection_id from connection_capabilities')).toHaveLength(0);
  });

  it('refuses deleted/revoked connections and never recreates a missing reconnect target', async () => {
    const row = await connect();
    await db.query("update connections set status='revoked' where id=$1", [row.id]);
    await expect(read(row)).rejects.toThrow(/no longer active/);
    await deleteConnection(db, { connectionId: row.id, actorUserId: owner, actor: 'user' });
    await expect(read(row)).rejects.toThrow(/no longer active/);
    await expect(connect({ targetConnectionId: row.id })).rejects.toThrow(/gone/);
    expect(await db.query('select id from vault_items')).toHaveLength(0);
  });

  it('resolves a legacy provider-revocation token only after local withdrawal and with an unlocked owner box', async () => {
    const row = await legacy(await connect(), { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    await expect(refreshTokenForRevocation(db, key, row)).rejects.toThrow(/changed/);
    // Legacy import must enforce the box lock even though the old ciphertext
    // itself could be decrypted with the installation key.
    await connectNextcloud(db, key, { ownerUserId: owner, ...nextcloud });
    await db.query("update connections set status='revoked' where id=$1", [row.id]);
    await setVaultLock(db, { ownerUserId: owner, locked: true, actorUserId: owner });
    await expect(refreshTokenForRevocation(db, key, row)).rejects.toBeInstanceOf(VaultLockedError);
    await setVaultLock(db, { ownerUserId: owner, locked: false, actorUserId: owner });
    expect(await refreshTokenForRevocation(db, key, row)).toBe(tokens.refreshToken);
    await expect(read(row)).rejects.toThrow(/no longer active/);
  });
});
