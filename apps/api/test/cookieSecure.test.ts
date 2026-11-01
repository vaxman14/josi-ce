// The Secure flag on Josi's cookies is decided per request on an https
// installation: Secure for the public address, never for a loopback one. A
// cookie for localhost never leaves the machine, and the Josi app on the same
// PC (a .NET cookie jar over http://localhost) drops Secure cookies, which is
// what used to need a hand edit of runtime.json after a public address was set.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ensureWorkspace } from './fixtures.js';
import { testDb } from '../../../packages/core/test/helpers.js';
import type { Db } from '@josi-ce/core';
import { createApp } from '../src/app.js';
import { cookieSecureFor, isLoopbackHost } from '../src/http/cookies.js';

let db: Db;
const servers: Server[] = [];

async function listen(cookieSecure: boolean | 'auto'): Promise<string> {
  const app = createApp(db, { cookieSecure, appUrl: 'https://josi.example', masterKeyCheck: false });
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** fetch() silently drops a Host header, so plain node:http sets it. */
function csrfCookie(base: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(base + '/api/auth/csrf', { headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => {
        expect(res.statusCode).toBe(200);
        const cookie = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('josi_csrf='));
        expect(cookie).toBeDefined();
        resolve(cookie as string);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => { db = await testDb(); await ensureWorkspace(db); });
afterAll(async () => { for (const s of servers) await new Promise<void>((r) => s.close(() => r())); });

describe('cookie Secure policy', () => {
  it('knows the loopback hosts', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['josi.example', '192.168.1.20', 'nas.local', '', undefined]) expect(isLoopbackHost(host)).toBe(false);
    expect(cookieSecureFor({ hostname: 'localhost' } as never, 'auto')).toBe(false);
    expect(cookieSecureFor({ hostname: 'josi.example' } as never, 'auto')).toBe(true);
    expect(cookieSecureFor({ hostname: 'localhost' } as never, true)).toBe(true);
    expect(cookieSecureFor({ hostname: 'josi.example' } as never, false)).toBe(false);
  });

  it("'auto' marks cookies Secure for the public address and not for localhost", async () => {
    const base = await listen('auto');
    expect(await csrfCookie(base, 'josi.example')).toMatch(/; Secure/i);
    expect(await csrfCookie(base, 'localhost:8080')).not.toMatch(/; Secure/i);
    expect(await csrfCookie(base, '127.0.0.1:8080')).not.toMatch(/; Secure/i);
  });

  it('an explicit true or false is not overridden by the address', async () => {
    const strict = await listen(true);
    expect(await csrfCookie(strict, 'localhost:8080')).toMatch(/; Secure/i);
    const plain = await listen(false);
    expect(await csrfCookie(plain, 'josi.example')).not.toMatch(/; Secure/i);
  });
});
