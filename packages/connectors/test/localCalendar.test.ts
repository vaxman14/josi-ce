// The calendar kept on this server: no account, no token, no provider call.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testVault, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey } from '@josi-ce/core';
import {
  can, connectLocalCalendar, createInternalEvent, getInternalEvent, listInternalEvents, processCalendarOutbox, syncCalendarOrigin,
} from '../src/index.js';

let db: TestDb; let alice: string; let bob: string;
const key = new MasterKey(Buffer.alloc(32, 5));

beforeEach(async () => {
  db = await testDb();
  alice = (await createUser(db, { email: 'alice@local.test', username: 'alice', role: 'super_admin' })).id;
  bob = (await createUser(db, { email: 'bob@local.test', username: 'bob', role: 'member' })).id;
  await testVault(db, key);
});

describe('local calendar', () => {
  it('connects once, with both switches on and a writable default source', async () => {
    const first = await connectLocalCalendar(db, { ownerUserId: alice, name: 'Dana' });
    const again = await connectLocalCalendar(db, { ownerUserId: alice });
    expect(again.connectionId).toBe(first.connectionId);
    expect(again.sourceId).toBe(first.sourceId);
    expect((await can(db, { ownerUserId: alice, capability: 'local.calendar.write' })).allowed).toBe(true);
    expect((await can(db, { ownerUserId: alice, capability: 'local.calendar.read' })).allowed).toBe(true);
    expect((await can(db, { ownerUserId: bob, capability: 'local.calendar.read' })).allowed).toBe(false);
    const [source] = await db.query<{ name: string; writable: boolean; selected: boolean; is_write_default: boolean }>(
      `select name, writable, selected, is_write_default from calendar_sources where id=$1`, [first.sourceId]);
    expect(source).toMatchObject({ name: 'Dana', writable: true, selected: true, is_write_default: true });
    const [origin] = await db.query<{ provider: string; status: string; last_sync_at: string | null }>(
      `select provider, status, last_sync_at from calendar_sync_origins where id=$1`, [first.originId]);
    expect(origin.provider).toBe('local'); expect(origin.status).toBe('idle'); expect(origin.last_sync_at).not.toBeNull();
  });

  it('writes events locally and the outbox settles them without a provider call', async () => {
    const local = await connectLocalCalendar(db, { ownerUserId: alice });
    const event = await createInternalEvent(db, { ownerUserId: alice, originId: local.originId,
      event: { title: 'Design review', start: '2026-11-05T18:00:00Z', end: '2026-11-05T18:30:00Z' } });
    expect(event.sync_state).toBe('pending');
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return new Response('{}', { status: 500 }); };
    expect(await processCalendarOutbox(db, { masterKey: key, fetchImpl })).toBe(1);
    expect(calls).toBe(0);
    expect((await getInternalEvent(db, { ownerUserId: alice, eventId: event.id }))?.sync_state).toBe('synced');
    const [outbox] = await db.query<{ status: string }>(`select status from calendar_outbox where event_id=$1`, [event.id]);
    expect(outbox.status).toBe('done');
    expect((await listInternalEvents(db, { ownerUserId: alice, start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z' })).map((e) => e.title)).toEqual(['Design review']);
    expect(await listInternalEvents(db, { ownerUserId: bob, start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z' })).toEqual([]);
  });

  it('a sync is a fresh stamp, never a fetch', async () => {
    const local = await connectLocalCalendar(db, { ownerUserId: alice });
    await db.query(`update calendar_sync_origins set last_sync_at=now()-interval '2 days' where id=$1`, [local.originId]);
    const fetchImpl: typeof fetch = async () => { throw new Error('no network for a local calendar'); };
    await syncCalendarOrigin(db, local.originId, { masterKey: key, fetchImpl });
    const [origin] = await db.query<{ status: string; fresh: boolean }>(
      `select status, last_sync_at > now()-interval '1 minute' as fresh from calendar_sync_origins where id=$1`, [local.originId]);
    expect(origin).toEqual({ status: 'idle', fresh: true });
  });
});
