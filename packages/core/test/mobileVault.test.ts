import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDb, type TestDb } from './helpers.js';
import { MasterKey } from '../src/masterKey.js';
import { asSecret, seal } from '../src/sealing.js';
import { deleteVaultSlot, initializeVault, isVaultCredentialReference, openCredentialPayload,
  recoverVault, setVaultLock, VaultLockedError } from '../src/vault.js';
import { processPushBatch, processPushReceipts, revokeMobileDevice, upsertMobileDevice } from '../src/mobile.js';

let db: TestDb, admin: string, recovery: string;
const key = new MasterKey(Buffer.alloc(32, 38));
const identity = '10101010-1010-4010-8010-101010101010';
const token = 'ExpoPushToken[synthetic_vault_fixture]';
const input = { deviceIdentity: identity, platform: 'ios' as const, expoToken: token,
  appState: 'background' as const, privacyLocked: true, timezone: 'UTC' };
beforeEach(async () => {
  db = await testDb();
  [ { id: admin } ] = await db.query<{ id: string }>(`insert into users(email,username,role) values('mobile@example.test','mobile-vault','super_admin') returning id`);
  recovery = (await initializeVault(db, key, admin)).recoveryKey.reveal();
});
async function queue(deviceId: string, owner = admin) {
  const [row] = await db.query<{ id: string }>(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body)
    values($1,$2,$3,'assistant','turn',$4,'Josi','Synthetic update') returning id`, [owner, deviceId, randomUUID(), randomUUID()]);
  return row.id;
}
const accepted = () => vi.fn(async () => new Response(JSON.stringify({ data: [{ status: 'ok', id: 'synthetic-ticket' }] }), { status: 200 }));
async function stored(deviceId: string) {
  return (await db.query<{ expo_token_enc: string }>('select expo_token_enc from mobile_devices where id=$1', [deviceId]))[0].expo_token_enc;
}
async function legacy(deviceId: string) {
  const value = seal(key, { token: asSecret(token) });
  await db.query('update mobile_devices set expo_token_enc=$2 where id=$1', [deviceId, value]);
  await deleteVaultSlot(db, { ownerUserId: admin, service: 'mobile.push', slot: identity, actorUserId: admin });
  return value;
}

describe('canonical mobile push credentials', () => {
  it('dispatches through the same recoverable reference after replacing the installation key', async () => {
    const device = await upsertMobileDevice(db, key, admin, input), reference = await stored(device.id);
    expect(isVaultCredentialReference(reference)).toBe(true);
    expect(reference).not.toContain(token);
    const replacement = new MasterKey(Buffer.alloc(32, 39));
    await recoverVault(db, replacement, recovery, admin);
    await queue(device.id);
    const fetcher = accepted();
    expect((await processPushBatch(db, replacement, fetcher as typeof fetch)).ticketed).toBe(1);
    expect(JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].body as string)[0].to).toBe(token);
    expect(await stored(device.id)).toBe(reference);
    expect(JSON.stringify(await db.query('select * from events'))).not.toContain(token);
  });

  it('imports a legacy token on use and atomically replaces its ciphertext', async () => {
    const device = await upsertMobileDevice(db, key, admin, input), old = await legacy(device.id);
    await queue(device.id);
    expect((await processPushBatch(db, key, accepted() as typeof fetch)).ticketed).toBe(1);
    const reference = await stored(device.id);
    expect(reference).not.toBe(old);
    expect(isVaultCredentialReference(reference)).toBe(true);
    expect(await openCredentialPayload(db, key, { ownerUserId: admin, service: 'mobile.push', slot: identity, stored: reference })).toEqual({ token });
  });

  it.each(['master', 'box'])('waits through a %s lock without sending or exhausting retries', async kind => {
    const device = await upsertMobileDevice(db, key, admin, input);
    await queue(device.id);
    const lock = { ...(kind === 'master' ? { master: true } : { ownerUserId: admin }), actorUserId: admin };
    await setVaultLock(db, { ...lock, locked: true });
    const fetcher = accepted();
    for (let i = 0; i < 6; i++) {
      await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 minute'`);
      expect(await processPushBatch(db, key, fetcher as typeof fetch)).toMatchObject({ sent: 0, deferred: 1, retried: 0 });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect((await db.query('select status,attempts,last_error_code from push_deliveries'))[0]).toMatchObject({ status: 'retry', attempts: 0, last_error_code: 'vault_locked' });
    await setVaultLock(db, { ...lock, locked: false });
    await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 minute'`);
    expect((await processPushBatch(db, key, fetcher as typeof fetch)).ticketed).toBe(1);
  });

  it('denies a transplanted reference and a mismatched legacy fingerprint without sending', async () => {
    const a = await upsertMobileDevice(db, key, admin, input);
    const b = await upsertMobileDevice(db, key, admin, { ...input, deviceIdentity: randomUUID(), expoToken: 'ExpoPushToken[synthetic_other]' });
    await db.query('update mobile_devices set expo_token_enc=$2 where id=$1', [a.id, await stored(b.id)]);
    await queue(a.id);
    const fetcher = accepted();
    expect((await processPushBatch(db, key, fetcher as typeof fetch)).retried).toBe(1);
    await db.query('update mobile_devices set expo_token_enc=$2 where id=$1', [a.id, seal(key, { token: 'ExpoPushToken[synthetic_wrong]' })]);
    await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 minute'`);
    expect((await processPushBatch(db, key, fetcher as typeof fetch)).retried).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rolls back canonical storage when device registration cannot commit', async () => {
    await db.exec(`create function reject_mobile() returns trigger as $$ begin raise exception 'synthetic registration failure'; end; $$ language plpgsql;
      create trigger reject_mobile before insert on mobile_devices for each row execute function reject_mobile();`);
    await expect(upsertMobileDevice(db, key, admin, input)).rejects.toThrow('synthetic registration failure');
    expect(await db.query("select id from vault_items where service='mobile.push'")).toHaveLength(0);
    expect(await db.query('select id from mobile_devices')).toHaveLength(0);
    expect(await db.query("select id from events where kind='vault.item_stored'")).toHaveLength(0);
  });

  it('rolls back migration when its reference update fails before sending', async () => {
    const device = await upsertMobileDevice(db, key, admin, input), old = await legacy(device.id);
    await queue(device.id);
    await db.exec(`create function reject_mobile_update() returns trigger as $$ begin raise exception 'synthetic reference failure'; end; $$ language plpgsql;
      create trigger reject_mobile_update before update on mobile_devices for each row execute function reject_mobile_update();`);
    const fetcher = accepted();
    await expect(processPushBatch(db, key, fetcher as typeof fetch)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await stored(device.id)).toBe(old);
    expect(await db.query("select id from vault_items where service='mobile.push'")).toHaveLength(0);
  });

  it('removes superseded and revoked credentials while preserving the new account', async () => {
    const old = await upsertMobileDevice(db, key, admin, input);
    const [member] = await db.query<{ id: string }>(`insert into users(email,username,role) values('other@example.test','other-mobile','member') returning id`);
    const current = await upsertMobileDevice(db, key, member.id, input);
    expect(await db.query("select id from vault_items where owner_user_id=$1 and service='mobile.push'", [admin])).toHaveLength(0);
    expect(await revokeMobileDevice(db, admin, old.id)).toBe(false);
    expect(await db.query("select id from vault_items where owner_user_id=$1 and service='mobile.push'", [member.id])).toHaveLength(1);
    await setVaultLock(db, { master: true, locked: true, actorUserId: admin });
    expect(await revokeMobileDevice(db, member.id, current.id)).toBe(true);
    expect(await db.query("select id from vault_items where service='mobile.push'")).toHaveLength(0);
  });

  it('does not let an old provider receipt delete a rotated canonical token', async () => {
    const device = await upsertMobileDevice(db, key, admin, input);
    await queue(device.id);
    await processPushBatch(db, key, accepted() as typeof fetch);
    const newToken = 'ExpoPushToken[synthetic_rotated]';
    await upsertMobileDevice(db, key, admin, { ...input, expoToken: newToken });
    await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 minute'`);
    await processPushReceipts(db, (async () => new Response(JSON.stringify({ data: { 'synthetic-ticket': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }), { status: 200 })) as typeof fetch);
    expect(await openCredentialPayload(db, key, { ownerUserId: admin, service: 'mobile.push', slot: identity, stored: await stored(device.id) })).toEqual({ token: newToken });
  });

  it('requires initialization for new registration', async () => {
    await db.query('update vault_state set initialized_at=null');
    await expect(upsertMobileDevice(db, key, admin, input)).rejects.toBeInstanceOf(VaultLockedError);
    expect(await db.query('select id from mobile_devices')).toHaveLength(0);
  });
});
