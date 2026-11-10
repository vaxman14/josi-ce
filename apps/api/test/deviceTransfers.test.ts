// "Send to my devices": a file reaches the person's own other device without
// asking, another person only after they accept, and nobody else at all.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSession, SESSION_TTL_SECONDS } from '@josi-ce/auth';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { transferName } from '../src/http/deviceTransferRoutes.js';

const pc = 'win-00000000000000000000000000000001', laptop = 'win-00000000000000000000000000000002', theirs = 'win-00000000000000000000000000000003';
let db: TestDb, server: Server, base: string, ownerId: string, ownerToken: string, memberId: string, memberToken: string;

const session = async (userId: string) => (await createSession(db, { userId, ip: '127.0.0.1', userAgent: 'test', ttlSeconds: SESSION_TTL_SECONDS })).token;
const headers = (token: string) => ({ 'x-josi-client': 'native', authorization: `Bearer ${token}` });
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/device-transfers${path}`, { method, headers: { ...headers(token), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
async function send(token: string, query: string, name = 'notes.txt', text = 'hello from the other room') {
  const form = new FormData();
  form.append('file', new Blob([text]), name);
  const res = await fetch(`${base}/api/device-transfers?${query}`, { method: 'POST', headers: headers(token), body: form });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const fetchContent = (token: string, id: string, deviceId: string) => fetch(`${base}/api/device-transfers/${id}/content?deviceId=${deviceId}`, { headers: headers(token) });
const stored = async (id: string) => (await db.query<{ state: string; has: boolean }>(`select state, content is not null as has from device_transfers where id = $1`, [id]))[0]!;

beforeEach(async () => {
  db = await testDb(); await ensureWorkspace(db);
  ownerId = (await createUser(db, { email: 'owner@fixture.test', username: 'owner', role: 'super_admin', password: 'synthetic-owner-password' })).id;
  memberId = (await createUser(db, { email: 'member@fixture.test', username: 'member', role: 'member', password: 'synthetic-member-password' })).id;
  ownerToken = await session(ownerId); memberToken = await session(memberId);
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: false });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect((await call(ownerToken, 'PUT', `/devices/${pc}`, { name: 'Office PC', platform: 'windows' })).status).toBe(200);
  expect((await call(ownerToken, 'PUT', `/devices/${laptop}`, { name: 'Laptop', platform: 'windows' })).status).toBe(200);
  expect((await call(memberToken, 'PUT', `/devices/${theirs}`, { name: 'Front desk', platform: 'windows' })).status).toBe(200);
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('send to my devices', () => {
  it('lists my other devices and the other people, never this device or myself', async () => {
    const res = await call(ownerToken, 'GET', `/devices?deviceId=${pc}`);
    expect(res.body.devices.map((d: any) => d.name)).toEqual(['Laptop']);
    expect(res.body.people.map((p: any) => p.id)).toEqual([memberId]);
  });

  it('delivers to my own device without asking, then clears the server copy', async () => {
    const sent = await send(ownerToken, `toDevice=${laptop}&fromDevice=${pc}`);
    expect(sent).toMatchObject({ status: 201, body: { state: 'accepted' } });
    expect((await call(ownerToken, 'GET', `/inbox?deviceId=${pc}`)).body.transfers).toEqual([]);
    const inbox = (await call(ownerToken, 'GET', `/inbox?deviceId=${laptop}`)).body.transfers;
    expect(inbox).toMatchObject([{ id: sent.body.id, name: 'notes.txt', state: 'accepted', own: true, fromDevice: 'Office PC' }]);
    expect((await fetchContent(ownerToken, sent.body.id, pc)).status).toBe(404);
    expect((await fetchContent(memberToken, sent.body.id, laptop)).status).toBe(404);
    const got = await fetchContent(ownerToken, sent.body.id, laptop);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('hello from the other room');
    expect((await call(ownerToken, 'POST', `/${sent.body.id}/received`, { deviceId: laptop })).status).toBe(200);
    expect(await stored(sent.body.id)).toEqual({ state: 'delivered', has: false });
    expect((await call(ownerToken, 'GET', `/inbox?deviceId=${pc}`)).body.sent).toMatchObject([{ state: 'delivered', toDevice: 'Laptop' }]);
    expect((await fetchContent(ownerToken, sent.body.id, laptop)).status).toBe(404);
  });

  it('gives another person nothing until they accept on a device', async () => {
    const sent = await send(ownerToken, `toUser=${memberId}&fromDevice=${pc}`, 'plan.pdf');
    expect(sent).toMatchObject({ status: 201, body: { state: 'offered' } });
    expect((await call(memberToken, 'GET', `/inbox?deviceId=${theirs}`)).body.transfers).toMatchObject([{ state: 'offered', from: 'owner', own: false }]);
    expect((await fetchContent(memberToken, sent.body.id, theirs)).status).toBe(404);
    expect((await call(ownerToken, 'POST', `/${sent.body.id}/accept`, { deviceId: pc })).status).toBe(409);
    expect((await call(memberToken, 'POST', `/${sent.body.id}/accept`, { deviceId: theirs })).status).toBe(200);
    expect((await fetchContent(memberToken, sent.body.id, theirs)).status).toBe(200);
  });

  it('clears a declined file and refuses bad targets', async () => {
    const sent = await send(ownerToken, `toUser=${memberId}&fromDevice=${pc}`);
    expect((await call(memberToken, 'POST', `/${sent.body.id}/decline`)).status).toBe(200);
    expect(await stored(sent.body.id)).toEqual({ state: 'declined', has: false });
    expect((await call(memberToken, 'POST', `/${sent.body.id}/accept`, { deviceId: theirs })).status).toBe(409);
    expect((await send(ownerToken, `toDevice=${theirs}&fromDevice=${pc}`)).status).toBe(404);
    expect((await send(ownerToken, `toDevice=${pc}&fromDevice=${pc}`)).status).toBe(400);
    expect((await send(ownerToken, `toUser=${ownerId}`)).status).toBe(404);
    expect((await send(ownerToken, `fromDevice=${pc}`)).status).toBe(400);
  });

  it('keeps only a plain file name', () => {
    expect(transferName('..\\..\\Windows\\evil.exe')).toBe('evil.exe');
    expect(transferName('a/b/c:d?.txt')).toBe('c_d_.txt');
    expect(transferName('...')).toBe('file');
  });
});
