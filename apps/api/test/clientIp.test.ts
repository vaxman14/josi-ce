// X-Forwarded-For is a claim anyone can make. Per-address sign-in limits only mean
// something if the address comes from a connection, or from a proxy trusted to
// report one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { parse } from 'yaml';
import { MAX_ATTEMPTS_PER_IP, MAX_CODES_PER_IP_PER_HOUR } from '@josi-ce/auth';
import { MasterKey, initializeVault } from '@josi-ce/core';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { clientIp, trustedProxyList } from '../src/http/cookies.js';

const root = join(import.meta.dirname, '../../..');
const composeProxies = (file: string): string => (parse(readFileSync(join(root, file), 'utf8')) as any).services.web.environment.JOSI_TRUSTED_PROXIES;

const seen = (peer: string | undefined, forwarded?: string, list?: string) => clientIp({
  socket: { remoteAddress: peer },
  headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  app: { locals: { trustedProxies: trustedProxyList(list) } },
} as unknown as Request);

describe('clientIp', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('ignores the header from a peer nobody trusts', () => {
    expect(seen('203.0.113.9', '198.51.100.1')).toBe('203.0.113.9');
    expect(seen('::ffff:203.0.113.9', '198.51.100.1')).toBe('203.0.113.9');
    expect(seen('203.0.113.9', '198.51.100.1', '10.0.0.5')).toBe('203.0.113.9');
  });

  it('native: believes the Caddy on loopback, and the device tunnel', () => {
    expect(seen('127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    expect(seen('::1', '203.0.113.9')).toBe('203.0.113.9');
    expect(seen('::ffff:127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    expect(seen('127.0.0.1', 'fd4a:6f73:6900:1:2:3:4:5')).toBe('fd4a:6f73:6900:1:2:3:4:5');
  });

  it('bundled Docker: believes Caddy on any Docker network, whatever it reports', () => {
    const list = composeProxies('docker-compose.yml');
    expect(composeProxies('docker-compose.release.yml')).toBe(list);
    for (const caddy of ['172.18.0.4', '::ffff:172.18.0.4', '192.168.16.3', '10.200.0.7', 'fd00:dead::3']) {
      expect(seen(caddy, '203.0.113.9', list)).toBe('203.0.113.9');
      // A visitor on the LAN is private too. Caddy replaced the header, so it is
      // the only entry and is still that visitor.
      expect(seen(caddy, '192.168.1.50', list)).toBe('192.168.1.50');
    }
  });

  it('own proxy: believes only the operator\'s proxy, and only the entry it appended', () => {
    expect(seen('10.0.0.5', '198.51.100.1, 203.0.113.9', '10.0.0.5')).toBe('203.0.113.9');
    expect(seen('10.0.0.6', '203.0.113.9', '10.0.0.5')).toBe('10.0.0.6');
    expect(seen('10.0.0.6', '203.0.113.9', '10.0.0.0/24')).toBe('203.0.113.9');
  });

  it('walks back through a chain of proxies it trusts, and no further', () => {
    const list = '10.0.0.0/24,2001:db8::/32';
    expect(seen('10.0.0.5', '198.51.100.1, 203.0.113.9, 10.0.0.7, 2001:db8::1', list)).toBe('203.0.113.9');
    expect(seen('10.0.0.5', '10.0.0.8, 10.0.0.7', list)).toBe('10.0.0.8');
  });

  it('never returns what is not an address, which auth_mfa_challenges would refuse', () => {
    expect(seen('127.0.0.1', 'unknown')).toBe('127.0.0.1');
    expect(seen('127.0.0.1', "1.2.3.4'; drop table users")).toBe('127.0.0.1');
    expect(seen('10.0.0.5', '203.0.113.9, garbage, 10.0.0.7', '10.0.0.0/24')).toBe('10.0.0.7');
    expect(seen('127.0.0.1', '')).toBe('127.0.0.1');
    expect(seen('127.0.0.1')).toBe('127.0.0.1');
    expect(seen(undefined, '203.0.113.9')).toBe(null);
  });

  it('refuses a bad JOSI_TRUSTED_PROXIES at startup', () => {
    for (const bad of ['caddy', '10.0.0.5/33', '10.0.0.0/x', 'fd00::/129', '10.0.0.0/8/8']) {
      expect(() => trustedProxyList(bad), bad).toThrow(/JOSI_TRUSTED_PROXIES/);
    }
    expect(() => trustedProxyList(' 10.0.0.5 , fd00::/8 ,')).not.toThrow();
  });

  it('says once in the log when a proxy is not being believed', async () => {
    vi.resetModules();
    const fresh = await import('../src/http/cookies.js');
    const warn = vi.mocked(console.warn);
    const request = { socket: { remoteAddress: '10.0.0.5' }, headers: { 'x-forwarded-for': '203.0.113.9' }, app: { locals: {} } } as unknown as Request;
    fresh.clientIp(request); fresh.clientIp(request);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('JOSI_TRUSTED_PROXIES');
  });
});

describe('sign-in limits on a published port with nothing in front', () => {
  const keyBytes = Buffer.alloc(32, 73), key = new MasterKey(keyBytes);
  const keyPath = join(mkdtempSync(join(tmpdir(), 'josi-client-ip-')), 'master.key');
  writeFileSync(keyPath, keyBytes.toString('base64'));
  let db: TestDb, server: Server, base: string, sends = 0;
  let peer = '203.0.113.9', turn = 0;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db = await testDb(); await ensureWorkspace(db);
    const { id } = await createUser(db, { email: 'owner@fixture.test', username: 'owner', role: 'super_admin', password: 'synthetic-password-1' });
    await initializeVault(db, key, id);
    await db.query(`insert into smtp_profiles (kind, host, port, from_name, from_address) values ('system', 'mail.fixture.test', 587, 'Josi', 'josi@fixture.test')`);
    const app = createApp(db, {
      cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath },
      mailTransport: { send: async () => { sends += 1; return { messageId: 'm' }; } } as never,
    });
    // The socket is what a real connection from `peer` would present.
    server = createServer((req, res) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: peer, configurable: true });
      app(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    peer = '203.0.113.9';
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  /** Every call claims a brand-new address, the way the bypass did. */
  async function rotating(path: string, body: unknown) {
    turn += 1;
    return fetch(`${base}/api${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-josi-client': 'native', 'x-forwarded-for': `198.51.100.${turn % 250}, 192.0.2.${turn % 250}` },
    });
  }

  it('holds the login limit against a rotating header', async () => {
    for (let i = 0; i < MAX_ATTEMPTS_PER_IP; i++) {
      expect((await rotating('/auth/login', { identifier: `nobody${i}`, password: 'wrong' })).status).toBe(401);
    }
    expect((await rotating('/auth/login', { identifier: 'someone-else', password: 'wrong' })).status).toBe(429);
    const [row] = await db.query<{ ip: string; n: number }>(`select ip, count(*)::int n from login_attempts group by ip`);
    expect(row).toEqual({ ip: '203.0.113.9', n: MAX_ATTEMPTS_PER_IP });
  });

  it('holds the email-code limit against a rotating header', async () => {
    const csrf = await fetch(`${base}/api/auth/csrf`);
    const token = (await csrf.json() as { csrfToken: string }).csrfToken;
    const request = (email: string) => {
      turn += 1;
      return fetch(`${base}/api/auth/email-code/request`, {
        method: 'POST', body: JSON.stringify({ email }),
        headers: { 'content-type': 'application/json', cookie: `josi_csrf=${token}`, 'x-josi-csrf': token, 'x-forwarded-for': `198.51.100.${turn % 250}` },
      });
    };
    for (let i = 0; i < MAX_CODES_PER_IP_PER_HOUR; i++) expect((await request(`person${i}@fixture.test`)).status).toBe(200);
    expect((await request('one-more@fixture.test')).status).toBe(429);
  });

  it('still counts two real visitors apart', async () => {
    for (let i = 0; i < MAX_ATTEMPTS_PER_IP; i++) await rotating('/auth/login', { identifier: `nobody${i}`, password: 'wrong' });
    peer = '203.0.113.10';
    expect((await rotating('/auth/login', { identifier: 'someone-else', password: 'wrong' })).status).toBe(401);
  });

  it('reaches the authenticator step with a header that is not an address', async () => {
    peer = '127.0.0.1';
    await db.query(`update users set mfa_enabled_at = now() where username = 'owner'`);
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ identifier: 'owner', password: 'synthetic-password-1' }),
      headers: { 'content-type': 'application/json', 'x-josi-client': 'native', 'x-forwarded-for': 'unknown' },
    });
    expect(res.status).toBe(202);
  });
});

describe('the noproxy override', () => {
  it('publishes web, so it trusts nobody until the operator says who', () => {
    const override = parse(readFileSync(join(root, 'docker-compose.noproxy.yml'), 'utf8')) as any;
    expect(override.services.web.ports).toBeDefined();
    expect(override.services.web.environment.JOSI_TRUSTED_PROXIES).toBe('${JOSI_TRUSTED_PROXIES:-}');
  });

  it('the bundled stack publishes no web port, which is what makes its list safe', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.release.yml']) {
      expect((parse(readFileSync(join(root, file), 'utf8')) as any).services.web.ports, file).toBeUndefined();
    }
  });
});
