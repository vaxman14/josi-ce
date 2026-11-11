// Two-way reminder sync with a phone's own reminder list.
//
// The phone pushes items it knows by its own identifier, reads Josi's back,
// and ticks things off. What must hold: the same identifier is always one row,
// another member's identical identifier is a different reminder, a reminder
// marked done never fires, and a pushed reminder is an ordinary Josi reminder
// — it fires, and Josi's own tools can list it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, testVault, type TestDb } from '../../../packages/core/test/helpers.js';
import {
  MasterKey, ReminderError, completeReminder, createReminder, createThread,
  listNativeReminderActions, upsertExternalReminder, upsertMobileDevice,
} from '@josi-ce/core';
import { executeAssistantTool } from '../../../packages/agent/src/execute.js';
import { processQueue } from '../../worker/src/jobs.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-reminder-sync-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 7);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const KEY = new MasterKey(KEY_BYTES);

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

interface Res { status: number; body: any; setCookie: string[]; headers: Headers }

async function call(path: string, opts: { method?: string; body?: unknown; jar?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET', headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual',
  });
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.getSetCookie?.() ?? [], headers: res.headers };
}

function mergeJar(existing: string | undefined, setCookie: string[]): string {
  const jar = new Map<string, string>();
  for (const part of (existing ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const raw of setCookie) {
    const first = raw.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function signIn(identifier: string, password: string): Promise<string> {
  const pre = await call('/api/auth/csrf');
  const jar = mergeJar(undefined, pre.setCookie);
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier, password }, jar });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.setCookie);
}

const PW = { alice: 'alice-password-123', bob: 'bob-password-123' };
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);
const push = (over: Record<string, unknown> = {}) => ({
  title: 'Buy milk', notes: 'the oat kind', due_at: inMinutes(30).toISOString(),
  timezone: 'Europe/Berlin', source: 'ios', external_id: 'x-apple-reminder://ABC-123', ...over,
});

/** Delivery happens when due; pull the row and its queued jobs back so
 * `processQueue` can claim them without sleeping. */
async function makeDue() {
  await db.query(`update reminders set due_at = now() - interval '1 second' where status='scheduled'`);
  await db.query(`update job_queue set run_at = now() where kind = 'reminder.deliver'`);
}

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: 'admin-password-123' })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW.bob })).id;
  await testVault(db, KEY);
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost:3000', masterKeyCheck: { path: keyPath } });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookies.alice = await signIn('alice', PW.alice);
  cookies.bob = await signIn('bob', PW.bob);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  await db.query(`delete from job_queue`);
  await db.query(`delete from push_deliveries`);
  await db.query(`delete from reminders`);
  await db.query(`delete from messages`);
  await db.query(`delete from threads`);
  await db.query(`delete from rate_limits`);
});

describe('POST /api/reminders', () => {
  it('creates a scheduled reminder that carries its source and external id', async () => {
    const res = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push() });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.reminder).toMatchObject({
      body: 'Buy milk', notes: 'the oat kind', timezone: 'Europe/Berlin', status: 'scheduled',
      source: 'ios', external_id: 'x-apple-reminder://ABC-123', revision: 1,
      completed_at: null, delivered_at: null, thread_id: null,
    });
    expect(res.body.reminder.id).toMatch(/^[0-9a-f-]{36}$/);
    const jobs = await db.query<{ payload: any }>(`select payload from job_queue where kind='reminder.deliver'`);
    expect(jobs.map(j => j.payload)).toEqual([{ reminderId: res.body.reminder.id, revision: 1 }]);
  });

  it('updates in place when the same external id arrives again, and never duplicates', async () => {
    const first = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push() });
    const due = inMinutes(90).toISOString();
    const second = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push({ title: 'Buy oat milk', notes: null, due_at: due }) });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.reminder).toMatchObject({ id: first.body.reminder.id, body: 'Buy oat milk', notes: null, revision: 2, status: 'scheduled' });
    expect(Math.abs(new Date(second.body.reminder.due_at).getTime() - new Date(due).getTime())).toBeLessThan(1000);
    expect(await db.query(`select id from reminders`)).toHaveLength(1);

    // The identical push again changes nothing: no new revision, no new job.
    const third = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push({ title: 'Buy oat milk', notes: null, due_at: due }) });
    expect(third.status).toBe(200);
    expect(third.body.reminder.revision).toBe(2);
    expect(await db.query(`select id from reminders`)).toHaveLength(1);
    expect(await db.query(`select id from job_queue where kind='reminder.deliver'`)).toHaveLength(2);
  });

  it('keeps one row when the same external id is pushed concurrently', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push() })));
    expect(results.map(r => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(new Set(results.map(r => r.body.reminder.id)).size).toBe(1);
    expect(await db.query(`select id from reminders`)).toHaveLength(1);
  });

  it('the unique index itself refuses a duplicate, whatever the code does', async () => {
    const insert = () => db.query(
      `insert into reminders(owner_user_id,body,due_at,source,external_id) values($1,'x',now()+interval '1 hour','ios','same')`, [ids.alice]);
    await insert();
    await expect(insert()).rejects.toThrow(/reminders_external_identity|duplicate/i);
  });

  it('another member with the same external id gets their own reminder', async () => {
    const alice = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push({ title: 'ALICE-PRIVATE' }) });
    const bob = await call('/api/reminders', { method: 'POST', jar: cookies.bob, body: push({ title: 'BOB-OWN' }) });
    expect(bob.status).toBe(201);
    expect(bob.body.reminder.id).not.toBe(alice.body.reminder.id);
    expect(JSON.stringify(bob.body)).not.toContain('ALICE-PRIVATE');
    const rows = await db.query<{ owner_user_id: string; body: string }>(`select owner_user_id, body from reminders order by body`);
    expect(rows).toEqual([{ owner_user_id: ids.alice, body: 'ALICE-PRIVATE' }, { owner_user_id: ids.bob, body: 'BOB-OWN' }]);
  });

  it('refuses malformed input with a 400 and stores nothing', async () => {
    const bad: Array<Record<string, unknown>> = [
      { source: 'android' }, { source: undefined }, { external_id: '' }, { external_id: 'x'.repeat(201) }, { external_id: undefined },
      { external_id: 42 }, { title: '   ' }, { title: 'x'.repeat(2001) }, { title: undefined }, { notes: 'n'.repeat(4001) }, { notes: 7 },
      { due_at: 'not a date' }, { due_at: undefined }, { due_at: new Date(Date.now() - 60_000).toISOString() },
      { due_at: inMinutes(400 * 24 * 60).toISOString() }, { timezone: 'Mars/Olympus' }, { timezone: undefined },
    ];
    for (const over of bad) {
      const res = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push(over) });
      expect(res.status, JSON.stringify(over).slice(0, 60)).toBe(400);
      expect(typeof res.body.error).toBe('string');
    }
    expect(await db.query(`select id from reminders`)).toHaveLength(0);
    // The longest identifier allowed is accepted.
    expect((await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push({ external_id: 'x'.repeat(200) }) })).status).toBe(201);
  });

  it('refuses anonymous callers and slows a runaway sync', async () => {
    const anonJar = mergeJar(undefined, (await call('/api/auth/csrf')).setCookie);
    expect((await call('/api/reminders', { method: 'POST', jar: anonJar, body: push() })).status).toBe(401);
    expect((await call('/api/reminders', { jar: anonJar })).status).toBe(401);

    await db.query(`insert into rate_limits(bucket,subject,window_started_at,count) values('reminder_sync',$1,now(),300)`, [`reminder_sync:${ids.alice}`]);
    const limited = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push() });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call('/api/reminders', { method: 'POST', jar: cookies.bob, body: push() })).status).toBe(201);
  });

  it('answers at the assistant address too', async () => {
    const res = await call('/api/assistant/reminders', { method: 'POST', jar: cookies.alice, body: push() });
    expect(res.status).toBe(201);
    const done = await call(`/api/assistant/reminders/${res.body.reminder.id}/complete`, { method: 'POST', jar: cookies.alice });
    expect(done.body.reminder.status).toBe('completed');
  });
});

describe('a reminder pushed from the phone is an ordinary Josi reminder', () => {
  it('fires when due: a chat message, a delivered row', async () => {
    const res = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push() });
    await makeDue();
    expect(await processQueue(db, 'w1', 5, { masterKey: KEY })).toMatchObject({ done: 1, failed: 0 });
    const [row] = await db.query<{ status: string; delivered_at: string | null }>(`select status, delivered_at from reminders where id=$1`, [res.body.reminder.id]);
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).toBeTruthy();
    const messages = await db.query<{ body: string }>(`select body from messages`);
    expect(messages.map(m => m.body)).toEqual(['Reminder: Buy milk']);
  });

  it('is listed by Josi’s own reminder tool', async () => {
    const res = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push() });
    const thread = await createThread(db, { ownerUserId: ids.alice });
    const listed = await executeAssistantTool(db, { userId: ids.alice, threadId: thread.id }, 'list_reminders', {}) as { ok: boolean; reminders: Array<Record<string, unknown>> };
    expect(listed.ok).toBe(true);
    expect(listed.reminders).toEqual([expect.objectContaining({ reminder_id: res.body.reminder.id, message: 'Buy milk', status: 'scheduled' })]);
  });

  it('is scheduled again when the phone moves a fired reminder to a new future time', async () => {
    const res = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push() });
    await makeDue();
    await processQueue(db, 'w1', 5, { masterKey: KEY });
    const moved = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push({ due_at: inMinutes(120).toISOString() }) });
    expect(moved.body.reminder).toMatchObject({ id: res.body.reminder.id, status: 'scheduled', delivered_at: null, revision: 2 });
  });
});

describe('POST /api/reminders/:id/complete', () => {
  it('marks done, is idempotent, and answers 404 for somebody else’s', async () => {
    const mine = await createReminder(db, { ownerUserId: ids.alice, body: 'made by Josi', dueAt: inMinutes(30) });
    for (const who of ['bob'] as const) {
      expect((await call(`/api/reminders/${mine.id}/complete`, { method: 'POST', jar: cookies[who] })).status).toBe(404);
    }
    expect((await db.query<{ status: string }>(`select status from reminders where id=$1`, [mine.id]))[0].status).toBe('scheduled');
    expect((await call(`/api/reminders/not-a-uuid/complete`, { method: 'POST', jar: cookies.alice })).status).toBe(404);
    expect((await call(`/api/reminders/00000000-0000-4000-8000-000000000000/complete`, { method: 'POST', jar: cookies.alice })).status).toBe(404);

    const done = await call(`/api/reminders/${mine.id}/complete`, { method: 'POST', jar: cookies.alice });
    expect(done.status).toBe(200);
    expect(done.body.reminder).toMatchObject({ id: mine.id, status: 'completed', revision: 2 });
    expect(done.body.reminder.completed_at).toBeTruthy();

    const again = await call(`/api/reminders/${mine.id}/complete`, { method: 'POST', jar: cookies.alice });
    expect(again.status).toBe(200);
    expect(again.body.reminder).toMatchObject({ id: mine.id, status: 'completed', revision: 2, completed_at: done.body.reminder.completed_at });
  });

  it('a completed reminder does not fire, push, or post later', async () => {
    const thread = await createThread(db, { ownerUserId: ids.alice });
    // A registered phone, and a control reminder that DOES push to it, so the
    // empty outbox below means something.
    const device = await upsertMobileDevice(db, KEY, ids.alice, { deviceIdentity: '10101010-1010-4010-8010-101010101010', platform: 'ios',
      expoToken: 'ExpoPushToken[reminder_sync]', appState: 'background', privacyLocked: false, timezone: 'UTC' });
    const control = await createReminder(db, { ownerUserId: ids.alice, threadId: thread.id, body: 'control', dueAt: inMinutes(30) });
    await makeDue();
    await processQueue(db, 'w0', 5, { masterKey: KEY });
    expect(await db.query(`select id from push_deliveries where device_id=$1 and route_id=$2`, [device.id, control.id])).toHaveLength(1);
    await db.query(`delete from push_deliveries`);
    await db.query(`delete from messages`);
    await db.query(`delete from job_queue`);
    const r = await createReminder(db, { ownerUserId: ids.alice, threadId: thread.id, body: 'never say this', dueAt: inMinutes(30) });
    expect((await call(`/api/reminders/${r.id}/complete`, { method: 'POST', jar: cookies.alice })).status).toBe(200);
    await db.query(`update reminders set due_at = now() - interval '1 second' where id=$1`, [r.id]);
    await db.query(`update job_queue set run_at = now() where kind = 'reminder.deliver'`);
    expect(await processQueue(db, 'w1', 5, { masterKey: KEY })).toMatchObject({ done: 1, failed: 0 });
    expect(await db.query(`select id from messages`)).toHaveLength(0);
    expect(await db.query(`select id from push_deliveries`)).toHaveLength(0);
    const [row] = await db.query<{ status: string; delivered_at: string | null }>(`select status, delivered_at from reminders where id=$1`, [r.id]);
    expect(row).toEqual({ status: 'completed', delivered_at: null });
    // Josi no longer lists it as coming up, and a native mirror is told to drop it.
    const listed = await executeAssistantTool(db, { userId: ids.alice, threadId: thread.id }, 'list_reminders', {}) as { reminders: unknown[] };
    expect(listed.reminders).toEqual([]);
    expect(await listNativeReminderActions(db, { ownerUserId: ids.alice })).toEqual([
      { version: 1, id: r.id, threadId: thread.id, revision: 2, operation: 'cancel' },
    ]);
  });

  it('completes one that already fired, leaves a cancelled one cancelled, and a later push cannot revive a done one', async () => {
    const fired = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push() });
    await makeDue();
    await processQueue(db, 'w1', 5, { masterKey: KEY });
    const done = await call(`/api/reminders/${fired.body.reminder.id}/complete`, { method: 'POST', jar: cookies.alice });
    expect(done.body.reminder.status).toBe('completed');
    expect(done.body.reminder.delivered_at).toBeTruthy();
    const pushedAgain = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push({ due_at: inMinutes(60).toISOString() }) });
    expect(pushedAgain.status).toBe(200);
    expect(pushedAgain.body.reminder).toMatchObject({ id: fired.body.reminder.id, status: 'completed' });

    const other = await createReminder(db, { ownerUserId: ids.alice, body: 'cancelled one', dueAt: inMinutes(30) });
    await call(`/api/assistant/reminders/${other.id}/cancel`, { method: 'POST', jar: cookies.alice });
    const stays = await call(`/api/reminders/${other.id}/complete`, { method: 'POST', jar: cookies.alice });
    expect(stays.status).toBe(200);
    expect(stays.body.reminder.status).toBe('cancelled');
  });
});

describe('GET /api/reminders', () => {
  it('returns source, external id and a truthful state for every reminder, owner-scoped', async () => {
    const synced = await call('/api/reminders', { method: 'POST', jar: cookies.alice, body: push() });
    const own = await createReminder(db, { ownerUserId: ids.alice, body: 'JOSI-UPCOMING', dueAt: inMinutes(40) });
    const done = await createReminder(db, { ownerUserId: ids.alice, body: 'JOSI-DONE', dueAt: inMinutes(50) });
    const dropped = await createReminder(db, { ownerUserId: ids.alice, body: 'JOSI-CANCELLED', dueAt: inMinutes(60) });
    await call(`/api/reminders/${done.id}/complete`, { method: 'POST', jar: cookies.alice });
    await call(`/api/assistant/reminders/${dropped.id}/cancel`, { method: 'POST', jar: cookies.alice });
    await createReminder(db, { ownerUserId: ids.bob, body: 'BOB-PRIVATE', dueAt: inMinutes(30) });

    const res = await call('/api/reminders', { jar: cookies.alice });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(Object.keys(res.body).sort()).toEqual(['recent', 'upcoming']);
    expect(res.body.upcoming).toEqual([
      expect.objectContaining({ id: synced.body.reminder.id, body: 'Buy milk', notes: 'the oat kind', status: 'scheduled', source: 'ios', external_id: 'x-apple-reminder://ABC-123' }),
      expect.objectContaining({ id: own.id, body: 'JOSI-UPCOMING', status: 'scheduled', source: 'josi', external_id: null, notes: null }),
    ]);
    const recent = Object.fromEntries(res.body.recent.map((r: { body: string }) => [r.body, r]));
    expect(Object.keys(recent).sort()).toEqual(['JOSI-CANCELLED', 'JOSI-DONE']);
    expect(recent['JOSI-DONE']).toMatchObject({ status: 'completed', source: 'josi', external_id: null });
    expect(recent['JOSI-DONE'].completed_at).toBeTruthy();
    expect(recent['JOSI-CANCELLED']).toMatchObject({ status: 'cancelled', source: 'josi', external_id: null, completed_at: null });
    for (const row of [...res.body.upcoming, ...res.body.recent]) {
      expect(Object.keys(row).sort()).toEqual([
        'body', 'completed_at', 'created_at', 'delivered_at', 'due_at', 'external_id', 'id', 'notes',
        'owner_user_id', 'revision', 'source', 'status', 'thread_id', 'timezone', 'updated_at',
      ]);
    }
    expect(JSON.stringify(res.body)).not.toContain('BOB-PRIVATE');
    // The page the web app already reads sees the same thing.
    expect((await call('/api/assistant/reminders', { jar: cookies.alice })).body.recent).toHaveLength(2);
  });
});

describe('the core functions', () => {
  it('reject an unsupported source and a control character in the identifier', async () => {
    const args = { ownerUserId: ids.alice, title: 't', dueAt: inMinutes(5), timezone: 'UTC' };
    await expect(upsertExternalReminder(db, { ...args, source: 'josi', externalId: 'a' })).rejects.toThrow(ReminderError);
    await expect(upsertExternalReminder(db, { ...args, source: 'ios', externalId: 'a\nb' })).rejects.toThrow(ReminderError);
    expect(await completeReminder(db, { ownerUserId: ids.bob, reminderId: 'nope' })).toBeNull();
  });
});
