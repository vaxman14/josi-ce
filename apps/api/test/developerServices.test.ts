// Developer services over the wire: GitHub, Netlify, Vercel, Supabase.
//
// The claims this file attacks, one describe block each:
//
//   1. Nothing is preset. A fresh installation lists four services and connects
//      none of them, and no environment variable or seeded row can change that.
//   2. Authentication and authorization. Signed out is 401; a member reaching
//      an admin route is 403; another member's connection is 404, not 403.
//   3. Encrypted storage. What lands in PostgreSQL is ciphertext, and the
//      plaintext token appears nowhere in the row.
//   4. Masked readback. Every response an owner can get shows a constant mask,
//      never the token, a prefix, or its length.
//   5. Connection tests, both ways, and what a failure does to the stored
//      status.
//   6. Disconnect and reconnect, including that disconnecting says the part CE
//      cannot do.
//   7. Malformed input and an SSRF-shaped answer from DNS.
//   8. Secret redaction: the audit log, the admin surface and the diagnostics
//      redactor.
//
// No suite here contacts GitHub, Netlify, Vercel or Supabase, and none performs
// DNS: `devServiceFetch` and `outboundResolve` are both injected.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { MasterKey, looksSealed, openSealed } from '@josi-ce/core';
import { redact } from '@josi-ce/ops';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-dev-services-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 23);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const masterKey = new MasterKey(KEY_BYTES);

/** Deliberately not shaped like a real credential: scripts/scan-secrets.sh
 * refuses `ghp_` followed by 36 characters anywhere in the tree, and it is
 * right to. These are long enough to be recognisable and short enough not to
 * look like the real thing. */
const TOKENS = {
  github: 'fixture-github-token-value',
  netlify: 'fixture-netlify-token-value',
  vercel: 'fixture-vercel-token-value',
  supabase: 'fixture-supabase-token-value',
  refused: 'fixture-token-the-provider-refuses',
};

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

/** How DNS answers. The SSRF block flips this to something hostile; every
 * other test leaves it public. */
let resolveAnswer: string[] = ['140.82.121.6'];
const outboundResolve = async () => resolveAnswer;

/** The four providers, stubbed. A request carrying `TOKENS.refused` is
 * answered 401 so the failure paths have something real to fail against. */
const devServiceFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const href = String(url);
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json', ...headers },
    });

  if (auth === `Bearer ${TOKENS.refused}`) {
    // A provider body that quotes the request back — the shape CE must never
    // pass through to a screen or a log.
    return new Response(JSON.stringify({ message: `Bad credentials for ${TOKENS.refused}` }), { status: 401 });
  }

  if (href === 'https://api.github.com/user') {
    return json({ login: 'octocat-fixture', id: 4242 }, { 'x-oauth-scopes': '' });
  }
  if (href === 'https://api.netlify.com/api/v1/user') {
    return json({ id: 'nl-fixture', slug: 'fixture-team', email: 'someone@example.test' });
  }
  if (href === 'https://api.vercel.com/v2/user') {
    return json({ user: { id: 'vc-fixture', username: 'fixture-user' } });
  }
  if (href === 'https://api.supabase.com/v1/projects') {
    return json([{ id: 'abcdefghijklmnopqrst', name: 'Fixture project' }]);
  }
  return new Response('{}', { status: 404 });
}) as unknown as typeof fetch;

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
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    setCookie: res.headers.getSetCookie?.() ?? [],
  };
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

const PW = {
  admin: 'admin-password-123',
  alice: 'alice-password-123',
  bob: 'bob-password-123',
};

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'ds-admin@ce.test', username: 'dsadmin', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'ds-alice@ce.test', username: 'dsalice', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'ds-bob@ce.test', username: 'dsbob', role: 'member', password: PW.bob })).id;

  const app = createApp(db, {
    cookieSecure: false,
    appUrl: 'http://localhost:3000',
    masterKeyCheck: { path: keyPath },
    devServiceFetch,
    outboundResolve,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('dsadmin', PW.admin);
  cookies.alice = await signIn('dsalice', PW.alice);
  cookies.bob = await signIn('dsbob', PW.bob);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  resolveAnswer = ['140.82.121.6'];
  await db.query(`delete from developer_service_connections`);
  await db.query(`update developer_service_policy set allowed = true, note = null`);
  // `events` is append-only at the database level (a trigger refuses deletes
  // outside the retention window), which is the audit guarantee working. The
  // assertions below scope by subject id instead of clearing the table.
});

async function connect(
  who: 'alice' | 'bob',
  service: keyof typeof TOKENS,
  body: Record<string, unknown> = {},
): Promise<Res> {
  return call(`/api/developer-services/${service}`, {
    method: 'POST', jar: cookies[who],
    body: { token: TOKENS[service as keyof typeof TOKENS], ...body },
  });
}

// ---------------------------------------------------------------- not preset

describe('nothing is connected until somebody connects it', () => {
  it('lists all four as disconnected on a fresh installation', async () => {
    const res = await call('/api/developer-services', { jar: cookies.alice });
    expect(res.status).toBe(200);
    expect(res.body.services.map((s: any) => s.service).sort())
      .toEqual(['github', 'netlify', 'supabase', 'vercel']);
    for (const service of res.body.services) {
      expect(service.connection, service.service).toBeNull();
      // Not forbidden is not the same as switched on.
      expect(service.allowedByAdmin).toBe(true);
    }
  });

  it('explains what each one needs before anything is connected', async () => {
    const res = await call('/api/developer-services', { jar: cookies.alice });
    for (const service of res.body.services) {
      expect(service.steps.length, service.service).toBeGreaterThan(2);
      expect(service.minimumPermissions.length, service.service).toBeGreaterThan(0);
      expect(service.tokenUrl, service.service).toMatch(/^https:\/\//);
    }
  });

  it('has no route that connects a service on somebody else\'s behalf', async () => {
    // The admin surface can forbid and can disconnect. It cannot connect.
    const res = await call('/api/admin/developer-services/github', {
      method: 'POST', jar: cookies.admin, body: { token: TOKENS.github, ownerUserId: ids.alice },
    });
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------- authentication and access

describe('authentication and authorization', () => {
  it('refuses every route without a session', async () => {
    expect((await call('/api/developer-services')).status).toBe(401);
    expect((await call('/api/admin/developer-services')).status).toBe(401);

    // A state-changing request needs the CSRF pair as well, and CSRF is
    // checked before the session is — so a bare POST is 403 for a reason that
    // is not authorization. Carry a valid CSRF pair and no session, which is
    // the request that actually tests the auth guard.
    const pre = await call('/api/auth/csrf');
    const anonymous = mergeJar(undefined, pre.setCookie);
    expect((await call('/api/developer-services/github', {
      method: 'POST', jar: anonymous, body: { token: 'x' },
    })).status).toBe(401);
    expect((await call('/api/admin/developer-services/policy/github', {
      method: 'PUT', jar: anonymous, body: { allowed: false },
    })).status).toBe(401);
  });

  it('refuses the admin surface to a member', async () => {
    expect((await call('/api/admin/developer-services', { jar: cookies.alice })).status).toBe(403);
    expect((await call('/api/admin/developer-services/policy/github', {
      method: 'PUT', jar: cookies.alice, body: { allowed: false },
    })).status).toBe(403);
  });

  it('answers 404, not 403, for another member\'s connection', async () => {
    const created = await connect('alice', 'github');
    expect(created.status).toBe(201);
    const id = created.body.connection.id;

    // 403 would confirm that a colleague has a connection with that id.
    expect((await call(`/api/developer-services/${id}/test`, { method: 'POST', jar: cookies.bob })).status)
      .toBe(404);
    expect((await call(`/api/developer-services/${id}`, { method: 'DELETE', jar: cookies.bob })).status)
      .toBe(404);

    // And it is still there.
    const rows = await db.query(`select id from developer_service_connections where id = $1`, [id]);
    expect(rows.length).toBe(1);
  });

  it('shows a member only their own connections', async () => {
    await connect('alice', 'github');
    const mine = await call('/api/developer-services', { jar: cookies.bob });
    for (const service of mine.body.services) expect(service.connection).toBeNull();
  });

  it('refuses a service that does not exist', async () => {
    expect((await call('/api/developer-services/gitlab', {
      method: 'POST', jar: cookies.alice, body: { token: 'x' },
    })).status).toBe(404);
  });
});

// ------------------------------------------------------------ stored sealed

describe('the token reaches PostgreSQL as ciphertext', () => {
  it('seals it, and the row contains no plaintext anywhere', async () => {
    const created = await connect('alice', 'github');
    expect(created.status).toBe(201);

    const [row] = await db.query<Record<string, unknown>>(
      `select * from developer_service_connections where owner_user_id = $1`, [ids.alice],
    );
    expect(looksSealed(row.credentials_enc)).toBe(true);
    // The whole row, not just the credential column: a token copied into
    // `account_label` by a careless probe would be just as bad.
    expect(JSON.stringify(row)).not.toContain(TOKENS.github);
    // And it really is the token, not the redaction marker (the Phase 0
    // sealing defect, which shipped for months).
    expect(openSealed<{ token: string }>(masterKey, String(row.credentials_enc)).token)
      .toBe(TOKENS.github);
  });

  it('stores one connection per person per service, replacing rather than duplicating', async () => {
    await connect('alice', 'github');
    await connect('alice', 'github');
    const rows = await db.query(
      `select id from developer_service_connections where owner_user_id = $1 and service = 'github'`,
      [ids.alice],
    );
    expect(rows.length).toBe(1);
  });

  it('keeps two people\'s tokens apart', async () => {
    await connect('alice', 'github');
    await connect('bob', 'netlify');
    const rows = await db.query<{ owner_user_id: string; service: string }>(
      `select owner_user_id, service from developer_service_connections order by service`,
    );
    expect(rows).toEqual([
      { owner_user_id: ids.alice, service: 'github' },
      { owner_user_id: ids.bob, service: 'netlify' },
    ]);
  });
});

// ---------------------------------------------------------- masked readback

describe('readback is masked', () => {
  it('returns a constant mask and never the token', async () => {
    const created = await connect('alice', 'github');
    const listed = await call('/api/developer-services', { jar: cookies.alice });
    const github = listed.body.services.find((s: any) => s.service === 'github');

    expect(github.connection.tokenMask).toMatch(/^[^A-Za-z0-9]+$/);
    expect(JSON.stringify(listed.body)).not.toContain(TOKENS.github);
    expect(JSON.stringify(created.body)).not.toContain(TOKENS.github);
    // Not a prefix or a suffix of it either.
    expect(JSON.stringify(listed.body)).not.toContain(TOKENS.github.slice(-4));
    // Nor the ciphertext, which is still a credential to work on offline.
    expect(JSON.stringify(listed.body)).not.toMatch(/"v1\./);
  });

  it('identifies the connection by the account the provider named, not by the token', async () => {
    await connect('alice', 'github');
    const listed = await call('/api/developer-services', { jar: cookies.alice });
    const github = listed.body.services.find((s: any) => s.service === 'github');
    expect(github.connection.account).toBe('octocat-fixture');
    // A fine-grained token reports no scopes; null lets the page say that,
    // where an empty list would read as "no access".
    expect(github.connection.reportedScopes).toBeNull();
  });
});

// -------------------------------------------------------- testing a connection

describe('testing a connection', () => {
  it('reports success and records the check', async () => {
    const created = await connect('alice', 'vercel');
    const id = created.body.connection.id;
    const tested = await call(`/api/developer-services/${id}/test`, { method: 'POST', jar: cookies.alice });
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(tested.body.connection.lastCheckOk).toBe(true);
    expect(tested.body.connection.status).toBe('active');
  });

  it('never stores a token the provider refused', async () => {
    const refused = await call('/api/developer-services/github', {
      method: 'POST', jar: cookies.alice, body: { token: TOKENS.refused },
    });
    expect(refused.status).toBe(502);
    expect(refused.body.category).toBe('revoked');
    // The provider's body quoted the token back. Ours must not.
    expect(JSON.stringify(refused.body)).not.toContain(TOKENS.refused);

    const rows = await db.query(`select id from developer_service_connections`);
    expect(rows.length).toBe(0);
  });

  it('marks a working connection as needing reconnection once the provider refuses it', async () => {
    const created = await connect('alice', 'github');
    const id = created.body.connection.id;

    // The person revoked the token in their own GitHub settings. Replace the
    // sealed value with the one the stub refuses, which is exactly what that
    // looks like from here.
    await db.query(
      `update developer_service_connections set credentials_enc = $2 where id = $1`,
      [id, (await import('@josi-ce/core')).seal(masterKey, { token: TOKENS.refused })],
    );

    const tested = await call(`/api/developer-services/${id}/test`, { method: 'POST', jar: cookies.alice });
    expect(tested.status).toBe(502);
    expect(tested.body.category).toBe('revoked');

    const [row] = await db.query<{ status: string; last_check_ok: boolean; last_error_category: string }>(
      `select status, last_check_ok, last_error_category from developer_service_connections where id = $1`,
      [id],
    );
    expect(row.status).toBe('needs_reconnect');
    expect(row.last_check_ok).toBe(false);
    expect(row.last_error_category).toBe('revoked');
  });
});

// ------------------------------------------------------ disconnect/reconnect

describe('disconnect and reconnect', () => {
  it('deletes our copy and says the part Josi cannot do', async () => {
    const created = await connect('alice', 'netlify');
    const id = created.body.connection.id;

    const removed = await call(`/api/developer-services/${id}`, { method: 'DELETE', jar: cookies.alice });
    expect(removed.status).toBe(200);
    // Saying "disconnected" while a live token sits in somebody's Netlify
    // account would be a half-truth.
    expect(removed.body.note).toMatch(/revoke it yourself/i);

    expect((await db.query(`select id from developer_service_connections where id = $1`, [id])).length).toBe(0);
    const listed = await call('/api/developer-services', { jar: cookies.alice });
    expect(listed.body.services.find((s: any) => s.service === 'netlify').connection).toBeNull();
  });

  it('reconnects afterwards, from scratch', async () => {
    const first = await connect('alice', 'supabase');
    await call(`/api/developer-services/${first.body.connection.id}`, { method: 'DELETE', jar: cookies.alice });
    const again = await connect('alice', 'supabase');
    expect(again.status).toBe(201);
    expect(again.body.connection.id).not.toBe(first.body.connection.id);
    expect(again.body.connection.status).toBe('active');
  });

  it('replaces the token on an existing connection without losing the connection', async () => {
    const first = await connect('alice', 'github');
    const replaced = await connect('alice', 'github');
    expect(replaced.status).toBe(201);
    expect(replaced.body.connection.id).toBe(first.body.connection.id);
  });
});

// -------------------------------------------------------- malformed and SSRF

describe('malformed input and hostile answers', () => {
  it('refuses an empty, whitespace-carrying or oversized token', async () => {
    for (const token of ['', '   ', 'has a space', 'x'.repeat(5000)]) {
      const res = await call('/api/developer-services/github', {
        method: 'POST', jar: cookies.alice, body: { token },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
    expect((await db.query(`select id from developer_service_connections`)).length).toBe(0);
  });

  it('refuses a Supabase project API key where a personal access token belongs', async () => {
    const res = await call('/api/developer-services/supabase', {
      method: 'POST', jar: cookies.alice, body: { token: 'eyJhbGciOiJI.eyJyb2xlIjo.sig' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service_role|project API key/);
  });

  it('refuses a project reference that is a URL or a path', async () => {
    for (const projectRef of ['https://evil.test', '../../admin', 'abcdefghijklmnopqrst/..']) {
      const res = await call('/api/developer-services/supabase', {
        method: 'POST', jar: cookies.alice, body: { token: TOKENS.supabase, projectRef },
      });
      expect(res.status, projectRef).toBe(400);
    }
  });

  it('refuses the request when DNS answers with a cloud-metadata address', async () => {
    // The hostnames are pinned and nobody can change them, so the attack is
    // the ANSWER: a poisoned resolver, or DNS rebinding between the check and
    // the request. Addresses are therefore checked at request time.
    resolveAnswer = ['169.254.169.254'];
    const res = await call('/api/developer-services/github', {
      method: 'POST', jar: cookies.alice, body: { token: TOKENS.github },
    });
    expect(res.status).toBe(502);
    expect(res.body.category).toBe('network');
    expect(res.body.error).toMatch(/metadata|link-local/);
    expect((await db.query(`select id from developer_service_connections`)).length).toBe(0);
  });

  it('refuses when one of several answers is a private address', async () => {
    resolveAnswer = ['140.82.121.6', '10.1.2.3'];
    const res = await call('/api/developer-services/vercel', {
      method: 'POST', jar: cookies.alice, body: { token: TOKENS.vercel },
    });
    expect(res.status).toBe(502);
  });
});

// ------------------------------------------------------------- admin ceiling

describe('the administrator ceiling can only deny', () => {
  it('stops a service being connected once it is switched off', async () => {
    const set = await call('/api/admin/developer-services/policy/github', {
      method: 'PUT', jar: cookies.admin, body: { allowed: false, note: 'Use the read-only mirror instead.' },
    });
    expect(set.status).toBe(200);

    const refused = await connect('alice', 'github');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/administrator/i);
    expect(refused.body.error).toMatch(/read-only mirror/);

    const listed = await call('/api/developer-services', { jar: cookies.alice });
    const github = listed.body.services.find((s: any) => s.service === 'github');
    expect(github.allowedByAdmin).toBe(false);
    expect(github.adminNote).toMatch(/read-only mirror/);
  });

  it('stops Josi using a connection that already exists', async () => {
    // The ceiling has to reach the credential, not only the form. A service
    // switched off after somebody connected it would otherwise carry on being
    // exercised, and "switched off for this installation" would mean "switched
    // off for people who had not got round to it yet".
    const created = await connect('alice', 'github');
    const id = created.body.connection.id;

    await call('/api/admin/developer-services/policy/github', {
      method: 'PUT', jar: cookies.admin, body: { allowed: false },
    });

    const tested = await call(`/api/developer-services/${id}/test`, { method: 'POST', jar: cookies.alice });
    expect(tested.status).toBe(403);
    expect(tested.body.error).toMatch(/administrator/i);
  });

  it('never traps somebody\'s token behind a switched-off service', async () => {
    // A ceiling stops a credential being used. Taking your own back is not a
    // use, and refusing it would leave a live token in Josi with no way out.
    const created = await connect('alice', 'netlify');
    const id = created.body.connection.id;
    await call('/api/admin/developer-services/policy/netlify', {
      method: 'PUT', jar: cookies.admin, body: { allowed: false },
    });

    const removed = await call(`/api/developer-services/${id}`, { method: 'DELETE', jar: cookies.alice });
    expect(removed.status).toBe(200);
    expect((await db.query(`select id from developer_service_connections where id = $1`, [id])).length).toBe(0);
  });

  it('switching a service back on connects nothing', async () => {
    await call('/api/admin/developer-services/policy/github', {
      method: 'PUT', jar: cookies.admin, body: { allowed: false },
    });
    await call('/api/admin/developer-services/policy/github', {
      method: 'PUT', jar: cookies.admin, body: { allowed: true },
    });
    const listed = await call('/api/developer-services', { jar: cookies.alice });
    expect(listed.body.services.find((s: any) => s.service === 'github').connection).toBeNull();
  });

  it('shows an administrator health and ownership, never the account or the token', async () => {
    await connect('alice', 'github');
    const view = await call('/api/admin/developer-services', { jar: cookies.admin });
    expect(view.status).toBe(200);
    expect(view.body.connections.length).toBe(1);

    const row = view.body.connections[0];
    expect(row.username).toBe('dsalice');
    expect(row.service).toBe('github');
    expect(row.status).toBe('active');
    // The account handle is a fact about somebody's own account.
    expect(Object.keys(row)).not.toContain('account_label');
    expect(Object.keys(row)).not.toContain('credentials_enc');
    expect(JSON.stringify(view.body)).not.toContain('octocat-fixture');
    expect(JSON.stringify(view.body)).not.toContain(TOKENS.github);
  });

  it('lets an administrator cut a connection off without reading it', async () => {
    const created = await connect('alice', 'github');
    const id = created.body.connection.id;
    const revoked = await call(`/api/admin/developer-services/connections/${id}`, {
      method: 'DELETE', jar: cookies.admin,
    });
    expect(revoked.status).toBe(200);
    // The response says nothing about what was inside it.
    expect(JSON.stringify(revoked.body)).not.toContain('octocat-fixture');
    expect((await db.query(`select id from developer_service_connections where id = $1`, [id])).length).toBe(0);
  });

  it('refuses an administrator disconnect of a connection that does not exist', async () => {
    const res = await call('/api/admin/developer-services/connections/not-a-uuid', {
      method: 'DELETE', jar: cookies.admin,
    });
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------- no leakage

describe('secret redaction', () => {
  it('writes an audit trail that names the service and nothing else', async () => {
    const created = await connect('alice', 'github');
    await call(`/api/developer-services/${created.body.connection.id}/test`, {
      method: 'POST', jar: cookies.alice,
    });
    await call(`/api/developer-services/${created.body.connection.id}`, {
      method: 'DELETE', jar: cookies.alice,
    });

    const events = await db.query<{ kind: string; payload: unknown }>(
      `select kind, payload from events where subject_id = $1 order by id`,
      [created.body.connection.id],
    );
    expect(events.map((e) => e.kind)).toEqual([
      'developer_service.connected',
      'developer_service.tested',
      'developer_service.disconnected',
    ]);
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(TOKENS.github);
    // Not the account either: an audit record says who did what to which
    // resource, not what the resource pointed at.
    expect(serialised).not.toContain('octocat-fixture');
  });

  it('records a failed test as a category, never the provider\'s words', async () => {
    const created = await connect('alice', 'github');
    await db.query(
      `update developer_service_connections set credentials_enc = $2 where id = $1`,
      [created.body.connection.id, (await import('@josi-ce/core')).seal(masterKey, { token: TOKENS.refused })],
    );
    await call(`/api/developer-services/${created.body.connection.id}/test`, {
      method: 'POST', jar: cookies.alice,
    });

    const [event] = await db.query<{ payload: any }>(
      `select payload from events where kind = 'developer_service.tested' and subject_id = $1
       order by id desc limit 1`,
      [created.body.connection.id],
    );
    expect(event.payload.ok).toBe(false);
    expect(event.payload.category).toBe('revoked');
    expect(JSON.stringify(event.payload)).not.toContain('Bad credentials');
  });

  it('redacts developer-service token shapes out of a diagnostics bundle', async () => {
    // The prefixes the four providers document. Split so this file does not
    // itself contain a string the secret scanner would refuse.
    const line = `error: token ${'ghp'}_abcdefghijklmnop failed, and ${'sbp'}_abcdefghijklmnop too`;
    const { text, redactions } = redact(line);
    expect(text).not.toContain('abcdefghijklmnop');
    expect(redactions.some((r) => r.pattern === 'dev_service_token')).toBe(true);
  });
});
