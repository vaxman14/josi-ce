// Crash reports and feedback over HTTP: the owner reads, edits and sends or refuses; the browser reports its own crashes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSession, SESSION_TTL_SECONDS } from '@josi-ce/auth';
import { recordReport, scrubReport } from '@josi-ce/core';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const TOKEN = 'k'.repeat(43);
let db: TestDb, server: Server, base: string, ownerToken: string, memberToken: string;
let posts: Array<{ url: string; body: any }>, answer: { status: number } = { status: 200 }, prefs: unknown = { auto_reports: true };
const session = async (userId: string) => (await createSession(db, { userId, ip: '127.0.0.1', userAgent: 'test', ttlSeconds: SESSION_TTL_SECONDS })).token;
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/crash-reports${path}`, { method, headers: { 'x-josi-client': 'native', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const reportFetch = (async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  posts.push({ url, body });
  if (url.endsWith('/tester-prefs')) return new Response(JSON.stringify(prefs), { status: 200 });
  return new Response('{}', { status: answer.status });
}) as unknown as typeof fetch;

beforeEach(async () => {
  posts = []; answer = { status: 200 }; prefs = { auto_reports: true };
  process.env.JOSI_TESTER_TOKEN = TOKEN; process.env.JOSI_REPORT_URL = 'https://reports.example.test/api/report';
  db = await testDb(); await ensureWorkspace(db);
  const ownerId = (await createUser(db, { email: 'owner@fixture.test', username: 'owner', role: 'super_admin', password: 'synthetic-owner-password' })).id;
  const memberId = (await createUser(db, { email: 'member@fixture.test', username: 'member', role: 'member', password: 'synthetic-member-password' })).id;
  ownerToken = await session(ownerId); memberToken = await session(memberId);
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: false, reportFetch });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); delete process.env.JOSI_TESTER_TOKEN; delete process.env.JOSI_REPORT_URL; });

const waiting = (error = 'TypeError: boom') => recordReport(db, 'api', scrubReport({ type: 'crash', error, stack_trace: 'at x (/app/a.js:1:1)', app_version: '1.2.8-beta.31' }));

describe('who may see and change what', () => {
  it('is the owner only, apart from the browser reporting its own crash', async () => {
    for (const [method, path] of [['GET', ''], ['PUT', '/settings'], ['POST', '/feedback'], ['POST', '/00000000-0000-4000-8000-000000000001/send'], ['POST', '/00000000-0000-4000-8000-000000000001/dismiss']]) {
      expect((await call(memberToken, method, path, method === 'GET' ? undefined : {})).status, `${method} ${path}`).toBe(403);
    }
    expect((await call(memberToken, 'POST', '/client', { message: 'x' })).status).toBe(202);
    const res = await fetch(`${base}/api/crash-reports`, { headers: { 'x-josi-client': 'native' } });
    expect(res.status).toBe(401);
  });
});

describe('the owner\'s choice', () => {
  it('starts unchosen, offers what the tester picked when signing up, and remembers the answer', async () => {
    const first = await call(ownerToken, 'GET', '');
    expect(first.body.settings).toEqual({ auto: null, tokenPresent: true, defaultAuto: true });
    expect(posts[0].url).toBe('https://reports.example.test/api/tester-prefs');
    expect(posts[0].body).toEqual({ token: TOKEN });
    expect((await call(ownerToken, 'PUT', '/settings', { auto: false })).body.settings).toMatchObject({ auto: false });
    expect((await call(ownerToken, 'GET', '')).body.settings).toEqual({ auto: false, tokenPresent: true, defaultAuto: null });
    expect((await call(ownerToken, 'PUT', '/settings', { auto: 'yes' })).status).toBe(400);
  });

  it('is dormant without a tester token: nothing to ask, nothing waiting, nothing stored', async () => {
    delete process.env.JOSI_TESTER_TOKEN;
    await waiting();
    expect((await call(ownerToken, 'GET', '')).body).toEqual({ settings: { auto: null, tokenPresent: false, defaultAuto: null }, pending: [] });
    expect((await call(ownerToken, 'POST', '/feedback', { note: 'hello' })).status).toBe(409);
    expect((await call(ownerToken, 'POST', '/client', { message: 'x' })).status).toBe(204);
  });
});

describe('a crash waiting for the owner', () => {
  it('is shown, can be edited, and what was edited is what is sent, scrubbed again', async () => {
    const id = await waiting();
    const list = (await call(ownerToken, 'GET', '')).body;
    expect(list.pending).toHaveLength(1);
    expect(list.pending[0]).toMatchObject({ id, kind: 'crash', service: 'api', report: { error: 'TypeError: boom', app_version: '1.2.8-beta.31' } });
    const sent = await call(ownerToken, 'POST', `/${id}/send`, { report: { ...list.pending[0].report, error: 'TypeError: boom for me@home.org', user_note: 'happened after I clicked save', chat: 'SECRET' } });
    expect(sent.status).toBe(200);
    const crashPost = posts.find(post => post.url.endsWith('/report'))!;
    expect(crashPost.body).toMatchObject({ token: TOKEN, type: 'crash', error: 'TypeError: boom for [email removed]', user_note: 'happened after I clicked save' });
    expect(JSON.stringify(crashPost.body)).not.toMatch(/SECRET|me@home/);
    expect((await call(ownerToken, 'GET', '')).body.pending).toEqual([]);
    expect((await call(ownerToken, 'POST', `/${id}/send`, {})).status).toBe(404);
  });

  it('stays waiting when the report address cannot be reached, and says so', async () => {
    const id = await waiting();
    answer = { status: 503 };
    const result = await call(ownerToken, 'POST', `/${id}/send`, {});
    expect(result.status).toBe(502);
    expect(result.body.ok).toBe(false);
    expect((await call(ownerToken, 'GET', '')).body.pending).toHaveLength(1);
    answer = { status: 403 };
    const refused = await call(ownerToken, 'POST', `/${id}/send`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.message).toBe('The tester token was refused.');
    expect((await call(ownerToken, 'GET', '')).body.pending).toEqual([]);
  });

  it('is dropped when the owner says not to send it', async () => {
    const id = await waiting();
    expect((await call(ownerToken, 'POST', `/${id}/dismiss`, {})).status).toBe(200);
    expect((await call(ownerToken, 'GET', '')).body.pending).toEqual([]);
    expect(posts.filter(post => post.url.endsWith('/report'))).toEqual([]);
  });
});

describe('the browser and feedback', () => {
  it('stores a browser crash scrubbed, a few at a time', async () => {
    for (let i = 0; i < 5; i++) expect((await call(memberToken, 'POST', '/client', { message: `Cannot read x ${i} for me@home.org`, stack: 'at http://10.1.2.3:8080/assets/a.js:1:2' })).status).toBe(202);
    expect((await call(memberToken, 'POST', '/client', { message: 'again' })).status).toBe(429);
    const { pending } = (await call(ownerToken, 'GET', '')).body;
    expect(pending).toHaveLength(5);
    expect(pending[0]).toMatchObject({ service: 'web-client', kind: 'crash' });
    expect(JSON.stringify(pending)).not.toMatch(/me@home|10\.1\.2\.3/);
  });

  it('writes feedback as a report the owner can read first, then sends it', async () => {
    const made = await call(ownerToken, 'POST', '/feedback', { note: 'The ghost is great. Call me on me@home.org' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ kind: 'feedback', service: 'feedback', report: { type: 'feedback', user_note: 'The ghost is great. Call me on [email removed]' } });
    const sent = await call(ownerToken, 'POST', `/${made.body.id}/send`, { report: { ...made.body.report, user_note: 'The ghost is great.' } });
    expect(sent.status).toBe(200);
    expect(posts.find(post => post.url.endsWith('/report'))!.body).toMatchObject({ token: TOKEN, type: 'feedback', user_note: 'The ghost is great.' });
  });
});
