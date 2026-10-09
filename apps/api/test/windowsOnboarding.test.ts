import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { setupGate } from '../src/http/setupGate.js';
import { HANDOFF_TTL, SETUP_SESSION_TTL, SetupHandoffs } from '../src/http/setupHandoffs.js';
import { requireCsrf } from '../src/http/cookies.js';
import { captureSetupHandoff } from '../../web/src/lib/setupHandoff.js';

let server: Server | undefined;
let db: TestDb | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined; db = undefined;
});

describe('Windows private browser handoff', () => {
  it('issues unpredictable single-use links with bounded link and session lifetimes', () => {
    let now = 0; const handoffs = new SetupHandoffs(() => now);
    const a = handoffs.issue(); const b = handoffs.issue();
    expect(a).toMatch(/^[a-f0-9]{64}$/); expect(a).not.toBe(b);
    const session = handoffs.consume(a)!;
    expect(handoffs.consume(a)).toBeNull(); expect(handoffs.authorized(session)).toBe(true);
    now = HANDOFF_TTL; expect(handoffs.consume(b)).toBeNull();
    now = SETUP_SESSION_TTL; expect(handoffs.authorized(session)).toBe(false);
    expect(new SetupHandoffs().authorized(session)).toBe(false);
  });
  it('bounds pending capabilities and revokes everything when setup closes', () => {
    const handoffs = new SetupHandoffs();
    for (let i = 0; i < 32; i++) handoffs.issue();
    expect(() => handoffs.issue()).toThrow(); handoffs.clear();
    const session = handoffs.consume(handoffs.issue())!;
    handoffs.clear(); expect(handoffs.authorized(session)).toBe(false);
  });
  it('scrubs launch fragments synchronously without persisting their capability', () => {
    const replaceState = vi.fn(); const setItem = vi.fn(); const getItem = vi.fn();
    const token = 'b'.repeat(64);
    expect(captureSetupHandoff({hash:`#handoff=${token}`,pathname:'/setup',search:''},
      {replaceState}, {setItem,getItem})).toBe(token);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/setup'); expect(setItem).not.toHaveBeenCalled();
    captureSetupHandoff({hash:'#handoff=malformed',pathname:'/setup',search:''}, {replaceState}, {setItem,getItem});
    expect(replaceState).toHaveBeenCalledTimes(2);
  });
  it('preserves the existing legacy browser entry while scrubbing it immediately', () => {
    const replaceState = vi.fn(); const setItem = vi.fn(); const getItem = vi.fn();
    captureSetupHandoff({hash:`#setup=${'c'.repeat(64)}`,pathname:'/setup',search:''}, {replaceState}, {setItem,getItem});
    expect(setItem).toHaveBeenCalledWith('josi_setup_handoff', 'c'.repeat(64));
    expect(replaceState).toHaveBeenCalledWith(null, '', '/setup');
  });
  it('requires bootstrap authorization and CSRF, consumes once, resumes persisted state, and closes after completion', async () => {
    db = await testDb(); const root = 'a'.repeat(64);
    const app = express(); app.use(express.json()); app.use(requireCsrf);
    app.use(setupGate(db, createHash('sha256').update(root).digest('hex')));
    app.get('/setup/state', async (_req, res) => res.json((await db!.query('select * from setup_state where id=true'))[0]));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, headers: Record<string,string> = {}, body = {}) => fetch(base+path, {method:'POST',
      headers:{'Content-Type':'application/json',cookie:'josi_csrf=fixture','x-josi-csrf':'fixture',...headers}, body:JSON.stringify(body)});
    expect((await post('/onboarding/launch', {'x-josi-csrf':'wrong','x-josi-setup-token':root})).status).toBe(403);
    expect((await post('/onboarding/launch')).status).toBe(404);
    const launch = await post('/onboarding/launch', {'x-josi-setup-token':root});
    expect(launch.headers.get('cache-control')).toBe('no-store');
    const {token} = await launch.json();
    const consumed = await post('/onboarding/consume', {}, {token}); expect(consumed.status).toBe(204);
    const cookie = consumed.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Path=/api/setup');
    expect((await post('/onboarding/consume', {}, {token})).status).toBe(410);
    await db.query("update setup_state set completed_steps=array['host_checks','owner'] where id=true");
    const before = await fetch(base+'/setup/state', {headers:{cookie:cookie.split(';')[0]}});
    expect((await before.json()).completed_steps).toEqual(['host_checks','owner']);
    expect((await fetch(base+'/setup/state')).status).toBe(404);
    await db.query('update setup_state set completed=true where id=true');
    expect((await post('/onboarding/launch', {'x-josi-setup-token':root})).status).toBe(404);
    expect((await fetch(base+'/setup/state', {headers:{cookie:cookie.split(';')[0]}})).status).toBe(404);
    expect(await (await fetch(base+'/onboarding/state')).json()).toEqual({completed:true});
  });
});
