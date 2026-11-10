// Signing in for Josi (docs/LIVE_SIGN_IN.md): who may, how a card becomes a live
// session, what is relayed, and what is never kept.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSession, SESSION_TTL_SECONDS } from '@josi-ce/auth';
import { createThread, LiveSignInBroker, listMessages } from '@josi-ce/core';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { executeSignInTool } from '../../../packages/agent/src/signInTools.js';

const PC = 'linux-' + 'a'.repeat(32);
let db: TestDb, server: Server, base: string, live: LiveSignInBroker;
let ownerId: string, ownerToken: string, memberId: string, memberToken: string, threadId: string;

const session = async (userId: string) => (await createSession(db, { userId, ip: '127.0.0.1', userAgent: 'test', ttlSeconds: SESSION_TTL_SECONDS })).token;
const auth = (token: string) => ({ 'x-josi-client': 'native', authorization: `Bearer ${token}`, 'content-type': 'application/json' });
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: auth(token), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
}
const json = (r: { buffer: Buffer }) => JSON.parse(r.buffer.toString('utf8') || 'null');

async function pcOnline(enabled = true) {
  await db.query(`insert into pc_control_settings(owner_user_id, pc_id, enabled) values ($1, $2, $3) on conflict do nothing`, [ownerId, PC, enabled]);
  await db.query(`insert into pc_control_presence(owner_user_id, pc_id, presence_enc, expires_at) values ($1, $2, 'x', now() + interval '1 minute')
    on conflict (owner_user_id, pc_id) do update set expires_at = excluded.expires_at`, [ownerId, PC]);
}
async function openCard(userId: string, token: string, input: Record<string, unknown>) {
  const out = await executeSignInTool(db, userId, 'request_sign_in', input, threadId) as { ok: boolean; cardId?: string; code?: string };
  expect(out.ok, JSON.stringify(out)).toBe(true);
  return out.cardId!;
}

beforeEach(async () => {
  db = await testDb(); await ensureWorkspace(db);
  ownerId = (await createUser(db, { email: 'owner@fixture.test', username: 'owner', role: 'super_admin', password: 'synthetic-owner-password' })).id;
  memberId = (await createUser(db, { email: 'member@fixture.test', username: 'member', role: 'member', password: 'synthetic-member-password' })).id;
  ownerToken = await session(ownerId); memberToken = await session(memberId);
  threadId = (await createThread(db, { ownerUserId: ownerId, title: 'sign-in test' })).id;
  live = new LiveSignInBroker();
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: false, liveSignIn: live });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('the sign-in card tool', () => {
  it('needs a connected computer with PC control on, and says so plainly', async () => {
    const out = await executeSignInTool(db, ownerId, 'request_sign_in', { mode: 'browser', title: 'GitHub', why: 'to read your issues' }, threadId) as { ok: boolean; code: string };
    expect(out).toMatchObject({ ok: false, code: 'no_computer' });
  });
  it('builds a terminal card from plain fields and shows the exact command', async () => {
    await pcOnline();
    const id = await openCard(ownerId, ownerToken, { mode: 'terminal', title: 'GitHub CLI', why: 'so I can open pull requests', command: 'gh auth login' });
    const [row] = await db.query<{ area: string; body: any }>(`select area, body from settings_change_proposals where id = $1`, [id]);
    expect(row.area).toBe('sign_in_card');
    const card = typeof row.body === 'string' ? JSON.parse(row.body).card : row.body.card;
    expect(card).toMatchObject({ kind: 'sign_in', mode: 'terminal', pcId: PC, command: 'gh auth login', title: 'GitHub CLI' });
  });
  it('refuses a command with a line break and a site address that carries a password', async () => {
    await pcOnline();
    expect(await executeSignInTool(db, ownerId, 'request_sign_in', { mode: 'terminal', title: 'x', why: 'y', command: 'a\nb' }, threadId)).toMatchObject({ ok: false, code: 'bad_command' });
    expect(await executeSignInTool(db, ownerId, 'request_sign_in', { mode: 'browser', title: 'x', why: 'y', url: 'https://u:p@example.com/' }, threadId)).toMatchObject({ ok: false, code: 'bad_url' });
    expect(await executeSignInTool(db, ownerId, 'request_sign_in', { mode: 'browser', title: 'x', why: 'y', url: 'http://example.com/' }, threadId)).toMatchObject({ ok: false, code: 'bad_url' });
  });
});

describe('who may sign in for Josi', () => {
  it('is the owner by default, anyone else only once the owner grants it', async () => {
    await pcOnline();
    expect(json(await call(ownerToken, 'GET', '/live-signin/access'))).toEqual({ allowed: true, owner: true });
    expect(json(await call(memberToken, 'GET', '/live-signin/access'))).toEqual({ allowed: false, owner: false });
    expect(await executeSignInTool(db, memberId, 'request_sign_in', { mode: 'browser', title: 'x', why: 'y' }, null)).toMatchObject({ ok: false, code: 'not_allowed' });
    expect((await call(memberToken, 'PUT', `/admin/live-signin/grants/${memberId}`, { granted: true })).status).toBe(403);
    expect((await call(ownerToken, 'PUT', `/admin/live-signin/grants/${memberId}`, { granted: true })).status).toBe(200);
    expect(json(await call(ownerToken, 'GET', '/admin/live-signin/grants')).users).toMatchObject([{ id: memberId, granted: true }]);
    expect(json(await call(memberToken, 'GET', '/live-signin/access'))).toEqual({ allowed: true, owner: false });
    expect((await call(ownerToken, 'PUT', `/admin/live-signin/grants/${memberId}`, { granted: false })).status).toBe(200);
    expect(json(await call(memberToken, 'GET', '/live-signin/access')).allowed).toBe(false);
  });
});

describe('a browser sign-in session', () => {
  it('relays frames and keystrokes, settles the card and writes one note, and is gone afterwards', async () => {
    await pcOnline();
    const cardId = await openCard(ownerId, ownerToken, { mode: 'browser', title: 'Amazon', why: 'to check an order', url: 'https://www.amazon.com/ap/signin' });
    const opened = json(await call(ownerToken, 'POST', '/live-signin/sessions', { cardId }));
    expect(opened).toMatchObject({ kind: 'browser', pcId: PC, state: 'starting', title: 'Amazon' });
    // Opening the same card again returns the same session.
    expect(json(await call(ownerToken, 'POST', '/live-signin/sessions', { cardId })).id).toBe(opened.id);
    // The PC service sends a picture; the person sees it.
    expect(live.pushFrame(opened.id, 1280, 800, Buffer.from('JPEGBYTES'))).toBe(true);
    const frame = await call(ownerToken, 'GET', `/live-signin/sessions/${opened.id}/frame?after=0&wait=500`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-type')).toBe('image/jpeg');
    expect(frame.headers.get('x-frame-seq')).toBe('1');
    expect(frame.headers.get('x-frame-width')).toBe('1280');
    expect(frame.buffer.toString()).toBe('JPEGBYTES');
    expect((await call(ownerToken, 'GET', `/live-signin/sessions/${opened.id}/frame?after=1&wait=100`)).status).toBe(204);
    expect(json(await call(ownerToken, 'GET', `/live-signin/sessions/${opened.id}`))).toMatchObject({ state: 'ready', width: 1280, height: 800 });
    // The person's clicks and typing reach the PC service; junk is dropped.
    const sent = json(await call(ownerToken, 'POST', `/live-signin/sessions/${opened.id}/input`, { events: [
      { t: 'click', x: 100, y: 200 }, { t: 'text', text: 'hunter2' }, { t: 'key', key: 'Return' }, { t: 'key', key: 'rm -rf' }, { t: 'data', data: 'nope' }, { t: 'click', x: -5, y: 1 },
    ] }));
    expect(sent.queued).toBe(3);
    expect(live.takeInput(opened.id)).toEqual([{ t: 'click', x: 100, y: 200, button: 1, count: 1 }, { t: 'text', text: 'hunter2' }, { t: 'key', key: 'Return' }]);
    // Another person cannot look.
    expect((await call(memberToken, 'GET', `/live-signin/sessions/${opened.id}`)).status).toBe(404);
    // Done: the card settles and the thread gets one note that says nothing of what was typed.
    expect(json(await call(ownerToken, 'POST', `/live-signin/sessions/${opened.id}/end`, { outcome: 'done' }))).toEqual({ ok: true, outcome: 'done' });
    const [card] = await db.query<{ state: string }>(`select state from settings_change_proposals where id = $1`, [cardId]);
    expect(card.state).toBe('applied');
    const notes = (await listMessages(db, { threadId })).filter(m => m.direction === 'out');
    expect(notes.at(-1)!.body).toMatch(/you finished the sign-in "Amazon"/);
    expect(JSON.stringify(notes)).not.toMatch(/hunter2/);
    expect((await call(ownerToken, 'GET', `/live-signin/sessions/${opened.id}/frame?after=0&wait=0`)).status).toBe(410);
    expect(live.get(opened.id)!.frame).toBeNull();
  });

  it('says a second sign-in on the same computer must wait for the first', async () => {
    await pcOnline();
    const first = await openCard(ownerId, ownerToken, { mode: 'browser', title: 'One', why: 'a' });
    expect((await call(ownerToken, 'POST', '/live-signin/sessions', { cardId: first })).status).toBe(200);
    const second = await openCard(ownerId, ownerToken, { mode: 'browser', title: 'Two', why: 'b' });
    const res = await call(ownerToken, 'POST', '/live-signin/sessions', { cardId: second });
    expect(res.status).toBe(409);
    expect(json(res).error).toMatch(/already signing in/);
  });

  it('refuses to open when the computer went offline after the card was made', async () => {
    await pcOnline();
    const cardId = await openCard(ownerId, ownerToken, { mode: 'browser', title: 'Late', why: 'a' });
    await db.query(`update pc_control_presence set expires_at = now() - interval '1 minute' where pc_id = $1`, [PC]);
    const res = await call(ownerToken, 'POST', '/live-signin/sessions', { cardId });
    expect(res.status).toBe(409);
    expect(json(res).error).toMatch(/not connected/);
  });
});

describe('a terminal sign-in session', () => {
  it('relays output with a cursor, takes raw input, and cancelling denies the card', async () => {
    await pcOnline();
    const cardId = await openCard(ownerId, ownerToken, { mode: 'terminal', title: 'AWS', why: 'to deploy', command: 'aws sso login' });
    const opened = json(await call(ownerToken, 'POST', '/live-signin/sessions', { cardId }));
    live.pushOutput(opened.id, 'Open https://device.example/ and enter ABCD-1234\r\n', true, null);
    const first = json(await call(ownerToken, 'GET', `/live-signin/sessions/${opened.id}/output?after=0&wait=300`));
    expect(first).toMatchObject({ data: 'Open https://device.example/ and enter ABCD-1234\r\n', running: true, exitCode: null });
    live.pushOutput(opened.id, 'Done\r\n', false, 0);
    const second = json(await call(ownerToken, 'GET', `/live-signin/sessions/${opened.id}/output?after=${first.cursor}&wait=300`));
    expect(second).toMatchObject({ data: 'Done\r\n', running: false, exitCode: 0 });
    expect(json(await call(ownerToken, 'POST', `/live-signin/sessions/${opened.id}/input`, { events: [{ t: 'data', data: 'secret-code\r' }, { t: 'resize', cols: 100, rows: 30 }, { t: 'click', x: 1, y: 1 }] })).queued).toBe(2);
    await call(ownerToken, 'POST', `/live-signin/sessions/${opened.id}/end`, { outcome: 'cancelled' });
    const [card] = await db.query<{ state: string }>(`select state from settings_change_proposals where id = $1`, [cardId]);
    expect(card.state).toBe('denied');
    expect((await listMessages(db, { threadId })).filter(m => m.direction === 'out').at(-1)!.body).toMatch(/closed the sign-in "AWS" without finishing/);
  });
});

describe('the broker', () => {
  it('ends an idle session on its own and forgets the picture', () => {
    let now = 1_000_000;
    const broker = new LiveSignInBroker(() => now);
    const s = broker.create({ kind: 'browser', pcId: PC, userId: ownerId, title: 'T' });
    if (s === 'busy') throw new Error('unexpected');
    broker.pushFrame(s.id, 640, 480, Buffer.from('x'));
    now += 11 * 60_000;
    expect(broker.get(s.id)!.state).toBe('ended');
    expect(broker.get(s.id)!.frame).toBeNull();
    now += 2 * 60_000;
    expect(broker.get(s.id)).toBeNull();
  });
});
