// The assistant over the wire.
//
// Written from the attacker's side, like the Phase 1 authorization suite: a
// signed-in colleague who knows a thread id, and a super admin who is curious
// about what someone has been asking Josi. Both are legitimate users of the
// installation, which is exactly why hiding the navigation would not stop them.
//
// The Phase 5 schema added three owner-scoped resource types. If the spine were
// going to be bypassed anywhere, it would be in the new routes, so these run
// against the real router stack and a real migrated database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { seal, MasterKey } from '@josi-ce/core';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-assistant-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 4);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

let replies: Array<{ content?: string | null; tool_calls?: unknown[] }> = [];
const llmFetch = (async () => {
  const next = replies.shift() ?? { content: 'ok' };
  return new Response(
    JSON.stringify({ choices: [{ message: next }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;
const llmResolve = async () => ['203.0.113.5'];

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
  let jar = mergeJar(undefined, pre.setCookie);
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier, password }, jar });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.setCookie);
}

const PW = { admin: 'admin-password-123', alice: 'alice-password-123', bob: 'bob-password-123' };

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW.bob })).id;

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost:3000',
    masterKeyCheck: { path: keyPath }, llmFetch, llmResolve,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin', PW.admin);
  cookies.alice = await signIn('alice', PW.alice);
  cookies.bob = await signIn('bob', PW.bob);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  replies = [];
  await db.query(`delete from approvals`);
  await db.query(`delete from tasks`);
  await db.query(`delete from messages`);
  await db.query(`delete from threads`);
  await db.query(`delete from contacts`);
  await db.query(`delete from resource_shares`);
  await db.query(`delete from step_up_verifications`);
  await db.query(`delete from user_approval_prefs`);
  await db.query(`delete from admin_approval_policy`);
  await db.query(`delete from llm_providers`);
  await db.query(`delete from llm_usage`);
  await db.query(`update security_policy set local_only = false where id = true`);
});

async function configureModel(): Promise<void> {
  await db.query(
    `insert into llm_providers
       (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
        cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
     values ('primary','openai','gpt-test',$1,true,now(),now(),true,true,true,8000)`,
    [seal(new MasterKey(KEY_BYTES), { apiKey: 'k' })],
  );
}

/** A thread with one exchange in it, owned by whoever is named. */
async function threadWith(owner: 'alice' | 'bob', text = 'PRIVATE-CONVERSATION-TEXT') {
  const created = await call('/api/assistant/threads', {
    method: 'POST', jar: cookies[owner], body: { title: 'mine' },
  });
  const id = created.body.thread.id;
  await db.query(`insert into messages (thread_id, direction, body) values ($1, 'in', $2)`, [id, text]);
  return id;
}

describe('anonymous callers', () => {
  it('are refused every assistant surface', async () => {
    const anonJar = mergeJar(undefined, (await call('/api/auth/csrf')).setCookie);
    for (const [method, path] of [
      ['GET', '/api/assistant/threads'],
      ['POST', '/api/assistant/threads'],
      ['GET', '/api/assistant/tasks'],
      ['GET', '/api/assistant/approvals'],
      ['GET', '/api/assistant/contacts'],
      ['GET', '/api/assistant/metrics'],
      ['POST', '/api/assistant/step-up'],
    ] as Array<[string, string]>) {
      const body = method === 'GET' ? undefined : {};
      expect((await call(path, { method, body, jar: anonJar })).status, path).toBe(401);
    }
  });
});

describe('one member cannot reach another member conversation', () => {
  it('answers 404, not 403, for a thread that exists', async () => {
    const aliceThread = await threadWith('alice');
    const res = await call(`/api/assistant/threads/${aliceThread}`, { jar: cookies.bob });
    // 403 would confirm the thread exists, which is the fact it is private to
    // protect.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE-CONVERSATION-TEXT');
  });

  it('answers the same 404 for a thread that does not exist', async () => {
    const real = await call(`/api/assistant/threads/${await threadWith('alice')}`, { jar: cookies.bob });
    const fake = await call('/api/assistant/threads/00000000-0000-0000-0000-000000000000', { jar: cookies.bob });
    expect(fake.status).toBe(real.status);
    expect(fake.body).toEqual(real.body);
  });

  it('cannot speak into it', async () => {
    const aliceThread = await threadWith('alice');
    await configureModel();
    const res = await call(`/api/assistant/threads/${aliceThread}/talk`, {
      method: 'POST', jar: cookies.bob, body: { message: 'hello' },
    });
    expect(res.status).toBe(404);
  });

  it('does not see it in their own list', async () => {
    await threadWith('alice');
    const res = await call('/api/assistant/threads', { jar: cookies.bob });
    expect(res.body.threads).toHaveLength(0);
  });
});

describe('one member cannot reach another member tasks or contacts', () => {
  it('404s a colleague task and refuses to change it', async () => {
    const [task] = await db.query<{ id: string }>(
      `insert into tasks (owner_user_id, template_key, slots) values ($1,'follow_up','{"what":"PRIVATE-TASK-DETAIL"}') returning id`,
      [ids.alice],
    );
    expect((await call(`/api/assistant/tasks/${task.id}`, { jar: cookies.bob })).status).toBe(404);
    const patch = await call(`/api/assistant/tasks/${task.id}`, {
      method: 'PATCH', jar: cookies.bob, body: { state: 'cancelled' },
    });
    expect(patch.status).toBe(404);
    const [row] = await db.query<{ state: string }>(`select state from tasks where id = $1`, [task.id]);
    expect(row.state).toBe('drafting');
  });

  it('404s a colleague contact', async () => {
    const created = await call('/api/assistant/contacts', {
      method: 'POST', jar: cookies.alice, body: { name: 'PRIVATE-CONTACT', email: 'p@x.test' },
    });
    const res = await call(`/api/assistant/contacts/${created.body.contact.id}`, { jar: cookies.bob });
    expect(res.status).toBe(404);
    expect((await call('/api/assistant/contacts', { jar: cookies.bob })).body.contacts).toHaveLength(0);
  });
});

describe('the super admin administers plumbing, not content', () => {
  it('is refused a member thread exactly like any other non-owner', async () => {
    const aliceThread = await threadWith('alice');
    const res = await call(`/api/assistant/threads/${aliceThread}`, { jar: cookies.admin });
    expect(res.status).toBe(404);
  });

  it('is refused a member task', async () => {
    const [task] = await db.query<{ id: string }>(
      `insert into tasks (owner_user_id, template_key) values ($1,'follow_up') returning id`,
      [ids.alice],
    );
    expect((await call(`/api/assistant/tasks/${task.id}`, { jar: cookies.admin })).status).toBe(404);
  });

  it('gets counts and health, and no content at all', async () => {
    await threadWith('alice', 'ADMIN-MUST-NOT-SEE-THIS');
    await db.query(
      `insert into tasks (owner_user_id, template_key, slots) values ($1,'follow_up','{"what":"ADMIN-MUST-NOT-SEE-SLOT"}')`,
      [ids.alice],
    );
    await call('/api/assistant/contacts', {
      method: 'POST', jar: cookies.alice, body: { name: 'ADMIN-MUST-NOT-SEE-NAME' },
    });

    const res = await call('/api/admin/assistant', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.counts.threads).toBe(1);
    expect(res.body.counts.tasks).toBe(1);
    expect(res.body.counts.contacts).toBe(1);

    const dump = JSON.stringify(res.body);
    for (const secret of ['ADMIN-MUST-NOT-SEE-THIS', 'ADMIN-MUST-NOT-SEE-SLOT', 'ADMIN-MUST-NOT-SEE-NAME']) {
      expect(dump, secret).not.toContain(secret);
    }
    // Whose work it is, and how much of it, is administration.
    expect(res.body.perUser.find((u: any) => u.username === 'alice').tasks).toBe(1);
  });

  it('cannot be reached by a member', async () => {
    expect((await call('/api/admin/assistant', { jar: cookies.alice })).status).toBe(403);
  });
});

describe('sharing is explicit, and read is not write', () => {
  async function share(threadId: string, canWrite: boolean) {
    await db.query(
      `insert into resource_shares (resource_type, resource_id, owner_user_id, shared_with_user_id, can_write)
       values ('thread', $1, $2, $3, $4)`,
      [threadId, ids.alice, ids.bob, canWrite],
    );
  }

  it('lets a named colleague read once shared', async () => {
    const t = await threadWith('alice', 'SHARED-TEXT');
    expect((await call(`/api/assistant/threads/${t}`, { jar: cookies.bob })).status).toBe(404);
    await share(t, false);
    const res = await call(`/api/assistant/threads/${t}`, { jar: cookies.bob });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('SHARED-TEXT');
  });

  it('does not let a read-only share speak into the conversation', async () => {
    await configureModel();
    const t = await threadWith('alice');
    await share(t, false);
    // Following a conversation is not the same as speaking in it as its owner.
    expect((await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.bob, body: { message: 'hi' },
    })).status).toBe(404);
  });

  it('runs a write-shared turn as the OWNER, so nothing is created under the wrong name', async () => {
    await configureModel();
    const t = await threadWith('alice');
    await share(t, true);
    replies = [{ content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'create_task', arguments: JSON.stringify({ template_key: 'follow_up', slots: { what: 'x', when: 'y' } }) } }] }, { content: 'done' }];

    const res = await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.bob, body: { message: 'make me a task' },
    });
    expect(res.status).toBe(200);
    const [task] = await db.query<{ owner_user_id: string }>(`select owner_user_id from tasks`);
    // Bob spoke; the task belongs to Alice, whose thread it is. A share must
    // not be a way to make Josi act under someone else's name.
    expect(task.owner_user_id).toBe(ids.alice);
  });
});

describe('talking to Josi', () => {
  it('refuses honestly when no model is configured, and invents no reply', async () => {
    const t = await threadWith('alice');
    const res = await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.alice, body: { message: 'hello' },
    });
    expect(res.status).toBe(503);
    expect(res.body.refusal.reason).toBe('no_model');
    expect(res.body).not.toHaveProperty('reply');
    // What the person said is kept; nothing is fabricated as an answer. The
    // claim that matters is the absence of an outbound message — a refusal
    // dressed up as a reply is the failure this guards against.
    const messages = await db.query<{ direction: string; body: string }>(
      `select direction, body from messages where thread_id = $1 order by created_at`, [t],
    );
    expect(messages.filter((m) => m.direction === 'out')).toHaveLength(0);
    expect(messages.map((m) => m.body)).toContain('hello');
  });

  it('records both sides of a real exchange', async () => {
    await configureModel();
    const t = await threadWith('alice');
    replies = [{ content: 'Hello Alice.' }];
    const res = await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.alice, body: { message: 'hi there' },
    });
    expect(res.body.reply).toBe('Hello Alice.');
    const messages = await db.query<{ direction: string; body: string }>(
      `select direction, body from messages where thread_id = $1 order by created_at`, [t],
    );
    expect(messages.map((m) => m.body)).toContain('hi there');
    expect(messages.map((m) => m.body)).toContain('Hello Alice.');
  });

  it('never writes the conversation into the audit log', async () => {
    await configureModel();
    const t = await threadWith('alice');
    replies = [{ content: 'REPLY-CONTENT-SECRET' }];
    await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.alice, body: { message: 'INBOUND-CONTENT-SECRET' },
    });
    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain('INBOUND-CONTENT-SECRET');
    expect(events).not.toContain('REPLY-CONTENT-SECRET');
  });
});

describe('step-up over the wire', () => {
  it('refuses a wrong password without saying anything about it', async () => {
    const res = await call('/api/assistant/step-up', {
      method: 'POST', jar: cookies.alice, body: { password: 'not-the-password' },
    });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('not-the-password');
  });

  it('accepts the right one and unlocks the session', async () => {
    const res = await call('/api/assistant/step-up', {
      method: 'POST', jar: cookies.alice, body: { password: PW.alice },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const rows = await db.query<{ user_id: string }>(`select user_id from step_up_verifications`);
    expect(rows[0].user_id).toBe(ids.alice);
  });

  it('unlocks nobody else', async () => {
    await call('/api/assistant/step-up', { method: 'POST', jar: cookies.alice, body: { password: PW.alice } });
    const rows = await db.query<{ user_id: string }>(`select user_id from step_up_verifications`);
    expect(rows.every((r) => r.user_id === ids.alice)).toBe(true);
  });

  it('cannot be cleared by another member password', async () => {
    const res = await call('/api/assistant/step-up', {
      method: 'POST', jar: cookies.alice, body: { password: PW.bob },
    });
    expect(res.status).toBe(401);
  });
});

describe('approval levels over the wire', () => {
  it('defaults to always ask', async () => {
    const res = await call('/api/assistant/approval-levels/email_send', { jar: cookies.alice });
    expect(res.body.level).toBe('always_ask');
  });

  it('reports the EFFECTIVE level, not the wish, when the admin is stricter', async () => {
    await call('/api/assistant/approval-levels/email_send', {
      method: 'PUT', jar: cookies.alice, body: { level: 'automatic' },
    });
    expect((await call('/api/assistant/approval-levels/email_send', { jar: cookies.alice })).body.level)
      .toBe('automatic');

    const admin = await call('/api/admin/assistant/approval-policy/email_send', {
      method: 'PUT', jar: cookies.admin, body: { maxLevel: 'always_ask' },
    });
    expect(admin.status).toBe(200);

    const after = await call('/api/assistant/approval-levels/email_send', { jar: cookies.alice });
    expect(after.body.level).toBe('always_ask');
    expect(after.body.userChoice).toBe('automatic');
  });

  it('does not let the admin loosen a member choice', async () => {
    await call('/api/assistant/approval-levels/email_send', {
      method: 'PUT', jar: cookies.alice, body: { level: 'always_ask' },
    });
    await call('/api/admin/assistant/approval-policy/email_send', {
      method: 'PUT', jar: cookies.admin, body: { maxLevel: 'automatic' },
    });
    expect((await call('/api/assistant/approval-levels/email_send', { jar: cookies.alice })).body.level)
      .toBe('always_ask');
  });

  it('does not let a member set the installation policy', async () => {
    const res = await call('/api/admin/assistant/approval-policy/email_send', {
      method: 'PUT', jar: cookies.alice, body: { maxLevel: 'automatic' },
    });
    expect(res.status).toBe(403);
  });
});

describe('approvals over the wire', () => {
  it('shows a member only their own pending approvals, and lets nobody else decide', async () => {
    const [task] = await db.query<{ id: string }>(
      `insert into tasks (owner_user_id, template_key) values ($1,'follow_up') returning id`,
      [ids.alice],
    );
    const [approval] = await db.query<{ id: string }>(
      `insert into approvals (subject_type, subject_id, owner_user_id, action_class, action, summary, payload_hash)
       values ('task', $1, $2, 'email_send', 'send_email', 'SEND-SUMMARY-PRIVATE', 'h') returning id`,
      [task.id, ids.alice],
    );

    expect((await call('/api/assistant/approvals', { jar: cookies.bob })).body.approvals).toHaveLength(0);
    const mine = await call('/api/assistant/approvals', { jar: cookies.alice });
    expect(mine.body.approvals).toHaveLength(1);

    // Neither a colleague nor the administrator may agree on Alice's behalf.
    for (const who of ['bob', 'admin'] as const) {
      const res = await call(`/api/assistant/approvals/${approval.id}/decide`, {
        method: 'POST', jar: cookies[who], body: { approve: true },
      });
      expect(res.status, who).toBe(404);
    }
    const [row] = await db.query<{ status: string }>(`select status from approvals where id = $1`, [approval.id]);
    expect(row.status).toBe('pending');
  });
});

describe('metrics', () => {
  it('are scoped to the person asking', async () => {
    await db.query(`insert into tasks (owner_user_id, template_key) values ($1,'follow_up')`, [ids.alice]);
    expect((await call('/api/assistant/metrics', { jar: cookies.alice })).body.metrics.tasks).toBe(1);
    expect((await call('/api/assistant/metrics', { jar: cookies.bob })).body.metrics.tasks).toBe(0);
  });
});
