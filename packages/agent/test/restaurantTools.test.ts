import { beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../../auth/src/users.js';
import { createThread, getTask } from '@josi-ce/core';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { executeAssistantTool } from '../src/execute.js';

let db: TestDb;
let owner: string;
let other: string;
let thread: string;

beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'diner@example.test', username: 'diner', role: 'super_admin' })).id;
  other = (await createUser(db, { email: 'other@example.test', username: 'other', role: 'member' })).id;
  thread = (await createThread(db, { ownerUserId: owner })).id;
});

describe('restaurant concierge handoffs', () => {
  it('creates an owner-scoped waiting task with exact booking links and no booking claim', async () => {
    const result = await executeAssistantTool(db, { userId: owner, threadId: thread }, 'prepare_restaurant_reservation_handoff', {
      location: 'Beverly Hills, CA',
      date_time: '2099-02-14T19:30:00-08:00',
      party_size: 4,
      query: 'Italian & seafood',
    }) as any;

    expect(result).toMatchObject({ ok: true, state: 'awaiting_owner', availability_verified: false, booking_status: 'not_booked' });
    expect(result.message).toMatch(/No table has been held or booked/);
    expect(result.handoffs).toHaveLength(2);
    const openTable = new URL(result.handoffs[0].url);
    expect(openTable.origin).toBe('https://www.opentable.com');
    expect(openTable.searchParams.get('dateTime')).toBe('2099-02-14T19:30:00');
    expect(openTable.searchParams.get('covers')).toBe('4');
    expect(openTable.searchParams.get('term')).toBe('Italian & seafood Beverly Hills, CA');

    const task = await getTask(db, result.task_id);
    expect(task).toMatchObject({ owner_user_id: owner, thread_id: thread, template_key: 'restaurant_reservation', state: 'awaiting_owner' });
    expect(task.slots).toMatchObject({ booking_status: 'not_booked', party_size: 4 });
    expect(await db.query(`select id from job_queue where payload->>'taskId'=$1`, [task.id])).toEqual([]);
  });

  it('rejects bad party sizes and times without creating a task', async () => {
    const badParty = await executeAssistantTool(db, { userId: owner, threadId: thread }, 'prepare_restaurant_reservation_handoff', {
      location: 'Los Angeles', date_time: '2099-02-14T19:30:00-08:00', party_size: 0,
    }) as any;
    expect(badParty).toMatchObject({ ok: false, error: 'bad_party_size' });

    const badTime = await executeAssistantTool(db, { userId: owner, threadId: thread }, 'prepare_restaurant_reservation_handoff', {
      location: 'Los Angeles', date_time: 'tomorrow around dinner', party_size: 2,
    }) as any;
    expect(badTime).toMatchObject({ ok: false, error: 'bad_reservation_request' });
    expect(await db.query(`select id from tasks where template_key='restaurant_reservation'`)).toEqual([]);
  });

  it('records completion only from the owner and labels it as user-reported', async () => {
    const prepared = await executeAssistantTool(db, { userId: owner, threadId: thread }, 'prepare_restaurant_reservation_handoff', {
      location: 'Santa Monica', date_time: '2099-03-01T18:00:00-08:00', party_size: 2,
    }) as any;

    const denied = await executeAssistantTool(db, { userId: other, threadId: null }, 'mark_restaurant_reservation_booked', {
      task_id: prepared.task_id, provider: 'OpenTable',
    }) as any;
    expect(denied).toMatchObject({ ok: false, error: 'not_found' });

    const confirmed = await executeAssistantTool(db, { userId: owner, threadId: thread }, 'mark_restaurant_reservation_booked', {
      task_id: prepared.task_id, provider: 'OpenTable', restaurant_name: 'The Test Kitchen', confirmation_code: 'OT-123',
    }) as any;
    expect(confirmed).toMatchObject({ ok: true, state: 'confirmed', booking_status: 'booked_user_reported', verified_by: 'user_report' });
    expect((await getTask(db, prepared.task_id)).slots).toMatchObject({
      provider: 'OpenTable', restaurant_name: 'The Test Kitchen', confirmation_code: 'OT-123', booking_status: 'booked_user_reported',
    });
  });
});
