// Daily Brief + Memory over HTTP: each person sees and changes only their own
// notes, tasks and settings; only the person marks a task done.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, SESSION_TTL_SECONDS } from '@josi-ce/auth';
import { initializeVault, MasterKey } from '@josi-ce/core';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const keyBytes = Buffer.alloc(32, 77);
const keyPath = join(mkdtempSync(join(tmpdir(), 'josi-brief-')), 'master.key');
writeFileSync(keyPath, keyBytes.toString('base64'));

let db: TestDb, server: Server, base: string, aliceId: string, aliceToken: string, bobToken: string;
const session = async (userId: string) => (await createSession(db, { userId, ip: '127.0.0.1', userAgent: 'test', ttlSeconds: SESSION_TTL_SECONDS })).token;
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/brief${path}`, { method, headers: { 'x-josi-client': 'native', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

beforeEach(async () => {
  db = await testDb(); await ensureWorkspace(db);
  aliceId = (await createUser(db, { email: 'alice@fixture.test', username: 'alice', role: 'super_admin', password: 'synthetic-alice-password' })).id;
  const bobId = (await createUser(db, { email: 'bob@fixture.test', username: 'bob', role: 'member', password: 'synthetic-bob-password' })).id;
  await initializeVault(db, new MasterKey(keyBytes), aliceId);
  aliceToken = await session(aliceId); bobToken = await session(bobId);
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath } });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('the settings', () => {
  it('start off, change, and are refused when wrong', async () => {
    const first = await call(aliceToken, 'GET', '/settings');
    expect(first.body).toMatchObject({ briefEnabled: false, checkinsEnabled: false, quietStart: '22:00', quietEnd: '07:00' });
    const saved = await call(aliceToken, 'PUT', '/settings', { briefEnabled: true, quietStart: '23:00', timezone: 'America/Los_Angeles' });
    expect(saved.body).toMatchObject({ briefEnabled: true, quietStart: '23:00', timezone: 'America/Los_Angeles' });
    expect((await call(aliceToken, 'PUT', '/settings', { quietEnd: 'morning' })).status).toBe(400);
    expect((await call(bobToken, 'GET', '/settings')).body.briefEnabled).toBe(false);
  });
  it('need a signed-in person', async () => {
    const res = await fetch(`${base}/api/brief/settings`, { headers: { 'x-josi-client': 'native' } });
    expect(res.status).toBe(401);
  });
});

describe('the notes', () => {
  it('the person adds, reads, edits and deletes their own lines, and nobody else sees them', async () => {
    const added = await call(aliceToken, 'POST', '/notes', { section: 'goals', text: 'Run a half marathon in spring' });
    expect(added.status).toBe(201);
    const read = await call(aliceToken, 'GET', '/notes');
    expect(read.body.sections.map((s: any) => s.label)).toEqual(['Goals', 'Rules', 'People', 'Open loops', 'Task status', 'Talked through']);
    expect(read.body.sections[0].lines.map((l: any) => l.text)).toEqual(['Run a half marathon in spring']);
    expect((await call(bobToken, 'GET', '/notes')).body.sections.flatMap((s: any) => s.lines)).toEqual([]);
    const edit = await call(aliceToken, 'PUT', `/notes/${added.body.id}`, { text: 'Run a half marathon in April' });
    expect(edit.body.text).toBe('Run a half marathon in April');
    expect((await call(bobToken, 'DELETE', `/notes/${added.body.id}`)).status).toBe(404);
    expect((await call(aliceToken, 'DELETE', `/notes/${added.body.id}`)).status).toBe(200);
    expect((await call(aliceToken, 'DELETE', `/notes/${added.body.id}`)).status).toBe(404);
    expect((await call(aliceToken, 'GET', '/notes')).body.sections[0].lines).toEqual([]);
  });
  it('refuse a secret and a bad section', async () => {
    expect((await call(aliceToken, 'POST', '/notes', { section: 'goals', text: 'card 4111 1111 1111 1111' })).status).toBe(400);
    expect((await call(aliceToken, 'POST', '/notes', { section: 'nope', text: 'x' })).status).toBe(400);
  });
});

describe('the tasks', () => {
  it('belong to the person, and only they mark one done', async () => {
    const made = await call(aliceToken, 'POST', '/tasks', { title: 'Renew the passport', state: 'waiting_on_user' });
    expect(made.status).toBe(201);
    expect(made.body.state).toBe('waiting_on_user');
    expect((await call(aliceToken, 'GET', '/tasks')).body.tasks).toHaveLength(1);
    expect((await call(bobToken, 'GET', '/tasks')).body.tasks).toEqual([]);
    expect((await call(bobToken, 'PUT', `/tasks/${made.body.id}`, { state: 'done' })).status).toBe(404);
    const done = await call(aliceToken, 'PUT', `/tasks/${made.body.id}`, { state: 'done' });
    expect(done.body).toMatchObject({ state: 'done' });
    expect((await call(aliceToken, 'GET', '/tasks')).body.tasks).toEqual([]);
    expect((await call(aliceToken, 'GET', '/tasks?done=1')).body.tasks).toHaveLength(1);
    expect((await call(aliceToken, 'DELETE', `/tasks/${made.body.id}`)).status).toBe(200);
  });
});

describe('a brief now', () => {
  it('queues one run, and a second within a minute waits', async () => {
    const first = await call(aliceToken, 'POST', '/run');
    expect(first.status).toBe(202);
    const [job] = await db.query<{ kind: string }>(`select kind from job_queue where kind = 'brief.run'`);
    expect(job.kind).toBe('brief.run');
    expect((await call(aliceToken, 'POST', '/run')).status).toBe(429);
  });
});
