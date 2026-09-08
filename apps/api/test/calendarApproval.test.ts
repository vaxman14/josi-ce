// Round-3 item 26: one authorisation, and an event that actually exists.
//
// WHAT THIS SUITE IS DEFENDING AGAINST
//
// Roman asked Josi, in plain words, to create a named event at an exact time.
// Josi said it was awaiting approval. The Approvals page was empty. The Tasks
// page wanted his account password, and once he typed it the task said "Ready
// to go" — and Google Calendar never received anything at all. Three gates
// (direct authorisation, approval policy, re-authentication), none of which
// knew about the others, and no event.
//
// So every test below is written from the outside: sign in, say the thing,
// press the one button there is, and then ask THE PROVIDER STUB what it
// received. A task state is never accepted as evidence that something
// happened — the only proof of a calendar event is a request having been made
// for one, which is as close to a Calendar readback as a suite that contacts
// nobody can get.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import {
  MasterKey, createTask, enqueue, seal, setAdminApprovalCeiling, setUserApprovalLevel, transition,
  type ApprovalLevel,
} from '@josi-ce/core';
import { saveClient, setCapability, upsertConnection } from '@josi-ce/connectors';
import { processQueue } from '../../worker/src/jobs.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-cal-approval-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 21);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const key = new MasterKey(KEY_BYTES);

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const PW = { admin: 'admin-password-123', alice: 'alice-password-123' };

// ------------------------------------------------------------- the provider

/** Every write the stub was asked to make. This is the readback. */
let calendarWrites: Array<{ url: string; method: string; body: any }> = [];
/** What Google says next. Set to a failure to prove the failure is reported. */
let providerStatus = 200;

const connectorFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const href = String(url);
  if (href.includes('oauth2') || href.includes('token')) {
    return new Response(
      JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  calendarWrites.push({
    url: href,
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  return new Response(JSON.stringify(providerStatus === 200 ? { id: 'evt-1' } : { error: 'nope' }), {
    status: providerStatus, headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;

// ------------------------------------------------------------------ the model

let replies: Array<{ content?: string | null; tool_calls?: unknown[] }> = [];
const llmFetch = (async () => {
  const next = replies.shift() ?? { content: 'ok' };
  return new Response(
    JSON.stringify({ choices: [{ message: next }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;
const llmResolve = async () => ['203.0.113.5'];

const toolCall = (name: string, args: unknown) => ({
  id: `t-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
});

// -------------------------------------------------------------------- client

interface Res { status: number; body: any; setCookie: string[] }

async function call(
  path: string,
  opts: { method?: string; body?: unknown; jar?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.getSetCookie?.() ?? [] };
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

/** A real Google connection with calendar writing genuinely switched on. */
async function connectCalendar(userId: string): Promise<void> {
  await saveClient(db, key, {
    provider: 'google', clientId: 'cid', clientSecret: 'SECRET',
    redirectUri: 'http://localhost:3000/api/connections/google/callback',
    actorUserId: userId,
  });
  const connection = await upsertConnection(db, key, {
    ownerUserId: userId,
    provider: 'google',
    tokens: {
      accessToken: 'at', refreshToken: 'rt', expiresIn: 3600,
      grantedScopes: 'https://www.googleapis.com/auth/calendar',
    },
    accountEmail: 'alice@google.test',
    providerAccountId: 'acct-alice',
    requestedCapabilities: ['google.calendar.write'],
  });
  await setCapability(db, {
    connection, capability: 'google.calendar.write', enabled: true, actorUserId: userId,
  });
}

/** Set the effective policy for one action class to exactly `level`.
 *
 * Both halves, because either one alone is a floor: the admin ceiling is
 * seeded `always_ask` by migration 0016, so a user's `automatic` means nothing
 * until an administrator has deliberately opened it. */
async function policy(actionClass: string, level: ApprovalLevel): Promise<void> {
  await setAdminApprovalCeiling(db, {
    actorUserId: ids.admin, actionClass, maxLevel: level, confirmRelaxation: true,
  });
  await setUserApprovalLevel(db, { userId: ids.alice, actionClass, level });
}

const EVENT = { title: 'Calendar Test', start: '2026-09-09T09:00:00-07:00', end: '2026-09-09T09:30:00-07:00' };

/** Say the thing Roman said. One turn, one tool call, one reply. */
async function askForTheEvent(args: Record<string, unknown> = EVENT): Promise<Res> {
  const thread = await call('/api/assistant/threads', {
    method: 'POST', jar: cookies.alice, body: { title: 'Talk' },
  });
  replies = [
    { content: null, tool_calls: [toolCall('draft_calendar_event', args)] },
    { content: 'ok' },
  ];
  return call(`/api/assistant/threads/${thread.body.thread.id}/talk`, {
    method: 'POST', jar: cookies.alice, body: { message: 'Create an event tomorrow at 9 AM called Calendar Test for 30 minutes' },
  });
}

async function taskRow(id: string) {
  const [row] = await db.query<{ state: string; fail_reason: string | null }>(
    `select state, fail_reason from tasks where id = $1`, [id],
  );
  return row;
}

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice })).id;

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost:3000',
    masterKeyCheck: { path: keyPath }, llmFetch, llmResolve, connectorFetch,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin', PW.admin);
  cookies.alice = await signIn('alice', PW.alice);
  await connectCalendar(ids.alice);
  // A model that can call tools, or every turn below is a 503 refusal about
  // there being no model rather than a test of anything.
  await db.query(
    `insert into llm_providers
       (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
        cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
     values ('primary','openai','gpt-test',$1,true,now(),now(),true,true,true,8000)`,
    [seal(key, { apiKey: 'k' })],
  );
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  replies = [];
  calendarWrites = [];
  providerStatus = 200;
  await db.query(`delete from approvals`);
  await db.query(`delete from tasks`);
  await db.query(`delete from step_up_verifications`);
  await db.query(`delete from job_queue`);
  // Back to the hardened default before each test states its own policy.
  await db.query(`delete from user_approval_prefs where user_id = $1`, [ids.alice]);
  await db.query(`update admin_approval_policy set max_level = 'always_ask'`);
});

// ---------------------------------------------------------------- always_ask

describe('always_ask — one approval, where the person can actually see it', () => {
  it('raises an approval that the Approvals page shows, and creates nothing yet', async () => {
    await policy('calendar_write', 'always_ask');
    const turn = await askForTheEvent();
    expect(turn.status).toBe(200);

    // THE BUG, DIRECTLY. `draft_calendar_event` used to create no approvals row
    // at all, so this list was empty while the reply said it was awaiting
    // approval.
    const pending = await call('/api/assistant/approvals', { jar: cookies.alice });
    expect(pending.body.approvals).toHaveLength(1);
    expect(pending.body.approvals[0].summary).toMatch(/Calendar Test/);
    expect(pending.body.approvals[0].action_class).toBe('calendar_write');

    // And the same card came back with the reply, so it is in the conversation
    // rather than only on a page nobody was sent to.
    expect(turn.body.approvals).toHaveLength(1);
    expect(turn.body.approvals[0].id).toBe(pending.body.approvals[0].id);

    // Nothing has happened.
    expect(calendarWrites).toHaveLength(0);
    const [task] = await db.query<{ state: string }>(`select state from tasks`);
    expect(task.state).toBe('awaiting_approval');
  });

  it('approving is the last thing asked, and the event is really created', async () => {
    await policy('calendar_write', 'always_ask');
    const turn = await askForTheEvent();
    const approvalId = turn.body.approvals[0].id;

    // ONE action. No password, no second page, no worker tick.
    const decided = await call(`/api/assistant/approvals/${approvalId}/decide`, {
      method: 'POST', jar: cookies.alice, body: { approve: true },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.carriedOut).toBe(true);
    expect(decided.body.task.state).toBe('confirmed');

    // And the outcome is in the conversation, not only in the tab that
    // pressed the button — it must survive a reload.
    const thread = (await db.query<{ id: string }>(`select id from threads order by created_at desc limit 1`))[0];
    const messages = await db.query<{ body: string }>(
      `select body from messages where thread_id = $1 order by created_at`, [thread.id],
    );
    expect(messages.some((m) => m.body === 'Done.')).toBe(true);

    // The readback: the provider was asked for this exact event.
    expect(calendarWrites).toHaveLength(1);
    expect(calendarWrites[0].method).toBe('POST');
    expect(calendarWrites[0].url).toContain('calendar/v3/calendars/primary/events');
    expect(calendarWrites[0].body.summary).toBe('Calendar Test');
    expect(calendarWrites[0].body.start.dateTime).toBe(EVENT.start);
  });

  it('refuses to carry out something other than what the card described', async () => {
    // An approval that does not pin the action is a rubber stamp: agree to
    // lunch, edit the slots, and the agreement rides along to whatever they
    // became. The slots stay editable while the card is pending, so the pin is
    // checked at the moment of spending it.
    await policy('calendar_write', 'always_ask');
    const turn = await askForTheEvent();
    const [task] = await db.query<{ id: string }>(`select id from tasks`);

    await call(`/api/assistant/tasks/${task.id}`, {
      method: 'PATCH', jar: cookies.alice, body: { slots: { ...EVENT, title: 'SOMETHING ELSE ENTIRELY' } },
    });

    const decided = await call(`/api/assistant/approvals/${turn.body.approvals[0].id}/decide`, {
      method: 'POST', jar: cookies.alice, body: { approve: true },
    });
    expect(decided.body.carriedOut).toBe(false);
    expect(decided.body.message).toMatch(/has changed since it was described/);
    expect(calendarWrites).toHaveLength(0);
  });

  it('declining creates nothing and leaves nothing pretending to be in flight', async () => {
    await policy('calendar_write', 'always_ask');
    const turn = await askForTheEvent();
    await call(`/api/assistant/approvals/${turn.body.approvals[0].id}/decide`, {
      method: 'POST', jar: cookies.alice, body: { approve: false },
    });
    expect(calendarWrites).toHaveLength(0);
    expect((await call('/api/assistant/approvals', { jar: cookies.alice })).body.approvals).toHaveLength(0);
  });
});

// ----------------------------------------------------------------- automatic

describe('automatic — the instruction was the authorisation', () => {
  it('creates the event during the turn and reports it as done', async () => {
    await policy('calendar_write', 'automatic');
    const turn = await askForTheEvent();

    expect(turn.body.approvals ?? []).toHaveLength(0);
    expect(calendarWrites).toHaveLength(1);
    expect(calendarWrites[0].body.summary).toBe('Calendar Test');

    const [task] = await db.query<{ state: string }>(`select state from tasks`);
    expect(task.state).toBe('confirmed');

    // And the model was told the truth about it, so it cannot report a
    // creation that did not happen or a wait that is not happening.
    const result = turn.body.actions.find((a: any) => a.tool === 'draft_calendar_event').result;
    expect(result.state).toBe('confirmed');
    expect(result.message).toMatch(/Done/);
  });

  it('still asks when the event would put an invitation in front of somebody else', async () => {
    // `invite_external` is always risky. "Automatic" is a decision about the
    // person's own diary, never about other people's inboxes.
    await policy('calendar_write', 'automatic');
    const turn = await askForTheEvent({ ...EVENT, attendees: ['stranger@example.test'] });

    expect(turn.body.approvals).toHaveLength(1);
    expect(turn.body.approvals[0].action).toBe('invite_external');
    expect(turn.body.approvals[0].summary).toMatch(/invite stranger@example.test/);
    expect(calendarWrites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- risky_only

describe('risky_only — the middle setting means what the Settings page says', () => {
  it('carries out an ordinary self-only event without asking', async () => {
    // This setting used to be indistinguishable from `always_ask`, which made
    // the label "Ask only for risky or destructive actions" untrue.
    await policy('calendar_write', 'risky_only');
    const turn = await askForTheEvent();
    expect(turn.body.approvals ?? []).toHaveLength(0);
    expect(calendarWrites).toHaveLength(1);
  });

  it('still asks about the risky one', async () => {
    await policy('calendar_write', 'risky_only');
    const turn = await askForTheEvent({ ...EVENT, attendees: ['stranger@example.test'] });
    expect(turn.body.approvals).toHaveLength(1);
    expect(calendarWrites).toHaveLength(0);
  });
});

// -------------------------------------------------------------- provider says no

describe('a provider that refuses is reported as a refusal', () => {
  it('does not say created, and shows the real reason', async () => {
    await policy('calendar_write', 'always_ask');
    const turn = await askForTheEvent();
    providerStatus = 403;

    const decided = await call(`/api/assistant/approvals/${turn.body.approvals[0].id}/decide`, {
      method: 'POST', jar: cookies.alice, body: { approve: true },
    });
    expect(decided.body.carriedOut).toBe(false);
    expect(decided.body.message).toMatch(/refused the write \(403\)/);
    expect(decided.body.task.state).toBe('failed');
    expect(decided.body.task.fail_reason).toMatch(/403/);
  });

  it('reports a failure during the turn too, rather than an optimistic state', async () => {
    await policy('calendar_write', 'automatic');
    providerStatus = 500;
    const turn = await askForTheEvent();
    const result = turn.body.actions.find((a: any) => a.tool === 'draft_calendar_event').result;
    expect(result.ok).toBe(false);
    expect(result.state).toBe('failed');
    expect(result.message).toMatch(/did NOT happen/);
  });
});

// ------------------------------------------------------------ step-up boundary

describe('step-up is for the consequential, not for your own diary', () => {
  it('does not demand a password to carry out a self-only calendar event', async () => {
    // Item 26(3). This is the prompt Roman met and cleared, only to be shown
    // "Ready to go" and no event.
    const task = await createTask(db, {
      ownerUserId: ids.alice, templateKey: 'schedule_appointment', slots: EVENT,
    });
    await transition(db, task.id, 'awaiting_approval', { actor: 'agent', actorUserId: ids.alice });

    const res = await call(`/api/assistant/tasks/${task.id}`, {
      method: 'PATCH', jar: cookies.alice, body: { state: 'ready' },
    });
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('ready');
  });

  it('still demands one before sending mail as the person', async () => {
    // An email always has a recipient, so it always involves somebody else.
    const task = await createTask(db, {
      ownerUserId: ids.alice, templateKey: 'send_message',
      slots: { recipient: 'someone@example.test', subject: 's', body_brief: 'b' },
    });
    await transition(db, task.id, 'awaiting_approval', { actor: 'agent', actorUserId: ids.alice });

    const res = await call(`/api/assistant/tasks/${task.id}`, {
      method: 'PATCH', jar: cookies.alice, body: { state: 'ready' },
    });
    expect(res.status).toBe(401);
  });

  it('still demands one for a calendar event other people are invited to', async () => {
    const task = await createTask(db, {
      ownerUserId: ids.alice, templateKey: 'schedule_appointment',
      slots: { ...EVENT, attendees: ['stranger@example.test'] },
    });
    await transition(db, task.id, 'awaiting_approval', { actor: 'agent', actorUserId: ids.alice });

    const res = await call(`/api/assistant/tasks/${task.id}`, {
      method: 'PATCH', jar: cookies.alice, body: { state: 'ready' },
    });
    expect(res.status).toBe(401);
  });
});

// ------------------------------------------------------------ worker execution

describe('the worker carries out what was queued, and says when it cannot', () => {
  it('creates the event from a queued wake', async () => {
    const task = await createTask(db, {
      ownerUserId: ids.alice, templateKey: 'schedule_appointment', slots: EVENT,
    });
    await transition(db, task.id, 'ready', { actor: 'user', actorUserId: ids.alice });
    await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });

    await processQueue(db, 'w1', 5, { masterKey: key, connectorFetch });
    expect(calendarWrites).toHaveLength(1);
    expect((await taskRow(task.id)).state).toBe('confirmed');
  });

  it('fails a task whose capability was switched off, instead of parking it at ready forever', async () => {
    // ITEM 26(6). `ready` rendered as "Ready to go" — the wording of the last
    // step before success, on a task that was never going to move again.
    await setCapability(db, {
      connection: (await db.query<any>(`select * from connections where owner_user_id = $1`, [ids.alice]))[0],
      capability: 'google.calendar.write', enabled: false, actorUserId: ids.alice,
    });
    try {
      const task = await createTask(db, {
        ownerUserId: ids.alice, templateKey: 'schedule_appointment', slots: EVENT,
      });
      await transition(db, task.id, 'ready', { actor: 'user', actorUserId: ids.alice });
      await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });

      await processQueue(db, 'w1', 5, { masterKey: key, connectorFetch });
      const row = await taskRow(task.id);
      expect(row.state).toBe('failed');
      expect(row.fail_reason).toMatch(/calendar writing is not switched on/);
      expect(calendarWrites).toHaveLength(0);
    } finally {
      await setCapability(db, {
        connection: (await db.query<any>(`select * from connections where owner_user_id = $1`, [ids.alice]))[0],
        capability: 'google.calendar.write', enabled: true, actorUserId: ids.alice,
      });
    }
  });
});
