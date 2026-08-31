// The worker's job handling.
//
// Exercised as a function rather than by starting the process, so the failure
// paths — unknown kind, missing task, retry, dead — are actually reachable.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser } from '../../../packages/auth/src/users.js';
import { createTask, enqueue, placeHold, requestApproval, transition } from '@josi-ce/core';
import { processQueue } from '../../worker/src/jobs.js';

let db: TestDb;
let owner: string;

beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'w@ce.test', username: 'worker-owner', role: 'super_admin' })).id;
});

describe('the worker drains the queue', () => {
  it('claims, runs and completes a job', async () => {
    const task = await createTask(db, { ownerUserId: owner, templateKey: 'follow_up' });
    await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });

    const outcome = await processQueue(db, 'w1');
    expect(outcome).toEqual({ claimed: 1, done: 1, failed: 0 });
    const [row] = await db.query<{ status: string }>(`select status from job_queue`);
    expect(row.status).toBe('done');
  });

  it('fails an unknown job kind rather than marking it done', async () => {
    // A job nobody handles is a bug. Completing it would hide that forever.
    await enqueue(db, { kind: 'invented.kind' });
    const outcome = await processQueue(db, 'w1');
    expect(outcome.failed).toBe(1);
    const [row] = await db.query<{ status: string; last_error: string }>(
      `select status, last_error from job_queue`,
    );
    expect(row.status).toBe('queued'); // will retry, then go dead
    expect(row.last_error).toMatch(/no handler/);
  });

  it('fails a wake for a task that no longer exists', async () => {
    await enqueue(db, { kind: 'task.wake', payload: { taskId: '00000000-0000-0000-0000-000000000000' } });
    expect((await processQueue(db, 'w1')).failed).toBe(1);
  });

  it('leaves a ready task alone when nothing can carry it out yet', async () => {
    // Phase 5 ships no executors. The honest behaviour is to wait, not to fail
    // — a failed task reads, to the person waiting, like Josi tried and could
    // not.
    const task = await createTask(db, {
      ownerUserId: owner, templateKey: 'send_message',
      slots: { recipient: 'a@b.test', subject: 's', body_brief: 'b' },
    });
    await transition(db, task.id, 'ready');
    await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });

    expect((await processQueue(db, 'w1')).done).toBe(1);
    const [row] = await db.query<{ state: string; fail_reason: string | null }>(
      `select state, fail_reason from tasks where id = $1`, [task.id],
    );
    expect(row.state).toBe('ready');
    expect(row.fail_reason).toBeNull();
  });

  it('expires holds on schedule', async () => {
    const task = await createTask(db, { ownerUserId: owner, templateKey: 'follow_up' });
    await placeHold(db, {
      taskId: task.id, resourceKey: 'r', startsAt: new Date(), endsAt: new Date(), ttlSeconds: 1,
    });
    await db.query(`update holds set expires_at = now() - interval '1 minute'`);
    await enqueue(db, { kind: 'holds.expire' });

    await processQueue(db, 'w1');
    const [row] = await db.query<{ status: string }>(`select status from holds`);
    expect(row.status).toBe('expired');
  });

  it('expires approvals nobody answered', async () => {
    const task = await createTask(db, { ownerUserId: owner, templateKey: 'follow_up' });
    await requestApproval(db, {
      taskId: task.id, ownerUserId: owner, actionClass: 'email_send', action: 'send_email',
      summary: 's', payload: {}, ttlSeconds: 1,
    });
    await db.query(`update approvals set expires_at = now() - interval '1 minute'`);
    await enqueue(db, { kind: 'approvals.expire' });

    await processQueue(db, 'w1');
    const [row] = await db.query<{ status: string }>(`select status from approvals`);
    expect(row.status).toBe('expired');
  });

  it('promotes a due schedule into a job', async () => {
    await db.query(
      `insert into schedules (kind, interval_seconds, next_run_at) values ('holds.expire', 60, now() - interval '1 minute')`,
    );
    const outcome = await processQueue(db, 'w1');
    expect(outcome.claimed).toBe(1);
    // And it was rescheduled rather than firing every tick.
    const [row] = await db.query<{ due: boolean }>(`select next_run_at > now() as due from schedules`);
    expect(row.due).toBe(true);
  });

  it('does not hand the same job to two workers', async () => {
    await enqueue(db, { kind: 'holds.expire' });
    const [a, b] = [await processQueue(db, 'w1'), await processQueue(db, 'w2')];
    expect(a.claimed + b.claimed).toBe(1);
  });

  it('keeps job payloads free of content', async () => {
    // A queue row is readable by anything that can reach the database, so a
    // payload carrying a message body would route around every ownership check
    // in the product.
    const task = await createTask(db, {
      ownerUserId: owner, templateKey: 'follow_up', slots: { what: 'PRIVATE-SLOT' },
    });
    await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });
    const dump = JSON.stringify(await db.query(`select * from job_queue`));
    expect(dump).not.toContain('PRIVATE-SLOT');
  });
});
