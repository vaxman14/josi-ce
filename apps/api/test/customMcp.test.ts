// Custom MCP servers over HTTP: a person's own outside tool servers.
//
// What these guard:
//   * the owner always may; a member only as the policy says, and the refusal
//     is on the write, not in a hidden button;
//   * a server is contacted and asked for its tools BEFORE it is saved;
//   * the sign-in is sealed in the person's Vault and never comes back out —
//     not in a response, an audit record or a log line;
//   * one person's server and pending calls are invisible to everybody else,
//     the installation's owner included;
//   * browser sign-in: discovery, registration, PKCE, a single-use state bound
//     to the person and the connection, refresh when a token runs out or is
//     refused;
//   * approving runs exactly the approved call, once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isVaultCredentialReference, MasterKey } from '@josi-ce/core';
import { testDb, testVault, type TestDb } from '../../../packages/core/test/helpers.js';
import { executeAssistantTool } from '../../../packages/agent/src/execute.js';
import { fakeMcp, readOnly, tool, type FakeMcp } from '../../../packages/connectors/test/mcpFake.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-mcp-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 14).toString('base64'));
const key = new MasterKey(Buffer.alloc(32, 14));

// Not credential-shaped; what matters is that they round-trip and never come back out.
const TOKEN = 'not-a-real-mcp-token-value';
const HEADER_VALUE = 'not-a-real-header-value';
const CLIENT_SECRET = 'not-a-real-client-secret';

let server: Server;
let base: string;
let db: TestDb;
let mcp: FakeMcp;
/** Every response body any test received, for the "no secret anywhere" check. */
let bodies: string[] = [];
let logs: string[] = [];

interface Res { status: number; body: any; location: string | null }
const jars: Record<string, string> = {};
const ids: Record<string, string> = {};

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

async function call(path: string, opts: { method?: string; body?: unknown; jar?: string | null } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const jar = opts.jar === null ? '' : (opts.jar ?? jars.alice);
  if (jar) headers.cookie = jar;
  const token = /josi_csrf=([^;]+)/.exec(jar)?.[1];
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const method = opts.method ?? 'GET';
  const res = await fetch(`${base}${path}`, {
    method, headers, redirect: 'manual',
    body: method !== 'GET' && opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  bodies.push(text, res.headers.get('location') ?? '');
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, location: res.headers.get('location') };
}

async function signIn(identifier: string, password: string): Promise<string> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const jar = mergeJar(undefined, pre.headers.getSetCookie?.() ?? []);
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: jar, 'x-josi-csrf': decodeURIComponent(/josi_csrf=([^;]+)/.exec(jar)?.[1] ?? '') },
    body: JSON.stringify({ identifier, password }),
  });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.headers.getSetCookie?.() ?? []);
}

const PW = 'a-long-enough-password-123';

beforeEach(async () => {
  db = await testDb();
  bodies = [];
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); });
  }
  mcp = fakeMcp({
    auth: (h) => h.authorization === `Bearer ${TOKEN}`,
    tools: [tool('search', readOnly), tool('send.message')],
  });
  const app = createApp(db, {
    cookieSecure: false, appUrl: 'https://josi.example.test', masterKeyCheck: { path: keyPath },
    // A stable function that forwards to whichever pretend server the test set up.
    customApiFetch: ((input: RequestInfo | URL, init?: RequestInit) => mcp.fetch(input, init)) as typeof fetch,
    outboundResolve: (host: string) => mcp.resolve(host),
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW })).id;
  await testVault(db, key);
  jars.admin = await signIn('admin', PW);
  jars.alice = await signIn('alice', PW);
  jars.bob = await signIn('bob', PW);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function permit(mode: string, userIds?: string[]) {
  const res = await call('/api/admin/mcp/policy', { method: 'PUT', jar: jars.admin, body: userIds === undefined ? { mode } : { mode, userIds } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const bearer = (extra: Record<string, unknown> = {}) => ({ name: 'Notes', url: mcp.url, auth: 'bearer', token: TOKEN, ...extra });

async function addBearer(jar = jars.alice, extra: Record<string, unknown> = {}) {
  const res = await call('/api/connections/mcp', { method: 'POST', jar, body: bearer(extra) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.connection as { id: string; slug: string; tools: Array<{ name: string; readOnly: boolean; asksFirst: boolean; enabled: boolean }>; status: string };
}

/** Everything that could have leaked: responses, redirects, audit records, logs. */
async function everythingVisible(): Promise<string> {
  const events = await db.query('select * from events');
  return [...bodies, JSON.stringify(events), ...logs].join('\n');
}

// ------------------------------------------------------------------ policy

describe('who may add an MCP server', () => {
  it('refuses members until the owner says otherwise, and never the owner', async () => {
    const view = await call('/api/connections/mcp');
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ allowed: false, connections: [], maxConnections: 20 });
    expect(view.body.redirectUri).toBe('https://josi.example.test/api/connections/mcp/oauth/callback');

    const refused = await call('/api/connections/mcp', { method: 'POST', body: bearer() });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/has not allowed MCP servers/);
    // Refused before anything was asked of the server, and nothing was stored.
    expect(mcp.seen).toEqual([]);
    expect(await db.query('select id from mcp_connections')).toEqual([]);

    // The owner of the installation is always allowed, with no policy change.
    const own = await call('/api/connections/mcp', { jar: jars.admin });
    expect(own.body.allowed).toBe(true);
    await addBearer(jars.admin);
  });

  it('lets everyone in, or only the people named', async () => {
    await permit('everyone');
    expect((await call('/api/connections/mcp', { jar: jars.bob })).body.allowed).toBe(true);

    await permit('specific_users', [ids.alice]);
    expect((await call('/api/connections/mcp')).body.allowed).toBe(true);
    expect((await call('/api/connections/mcp', { jar: jars.bob })).body.allowed).toBe(false);
    expect((await call('/api/connections/mcp', { method: 'POST', jar: jars.bob, body: bearer() })).status).toBe(403);
    await addBearer(jars.alice);

    const admin = await call('/api/admin/mcp/policy', { jar: jars.admin });
    expect(admin.body.mode).toBe('specific_users');
    expect(admin.body.allowedUserIds).toEqual([ids.alice]);
    expect(admin.body.summary).toContain('alice');
    // The owner sees that a server exists and whether it works: no address path, no tools, no sign-in.
    expect(admin.body.connections).toEqual([expect.objectContaining({ username: 'alice', name: 'Notes', host: 'mcp.example.test', status: 'active' })]);
    expect(JSON.stringify(admin.body)).not.toContain('send.message');
  });

  it('shows the owner\'s reason to a member who is refused', async () => {
    await call('/api/admin/mcp/policy', { method: 'PUT', jar: jars.admin, body: { mode: 'not_allowed', note: 'Ask Roman first.' } });
    expect((await call('/api/connections/mcp')).body.note).toBe('Ask Roman first.');
    expect((await call('/api/connections/mcp', { method: 'POST', body: bearer() })).body.error).toContain('Ask Roman first.');
  });

  it('keeps an account a parent manages out unless the owner switches that on', async () => {
    // Bob is a managed child of Alice. Everybody is allowed, and still not Bob.
    await db.query(
      `insert into parental_links (parent_user_id, child_user_id, created_by_user_id) values ($1, $2, $1)`,
      [ids.alice, ids.bob],
    );
    await call('/api/admin/mcp/policy', { method: 'PUT', jar: jars.admin, body: { mode: 'everyone' } });
    expect((await call('/api/admin/mcp/policy', { jar: jars.admin })).body.allowManagedChildren).toBe(false);
    expect((await call('/api/connections/mcp', { jar: jars.alice })).body.allowed).toBe(true);
    expect((await call('/api/connections/mcp', { jar: jars.bob })).body.allowed).toBe(false);
    const refused = await call('/api/connections/mcp', { method: 'POST', jar: jars.bob, body: bearer() });
    expect(refused.status).toBe(403);
    expect(mcp.seen).toEqual([]);

    // The owner's switch. One setting for the installation; it names nobody.
    const on = await call('/api/admin/mcp/policy', { method: 'PUT', jar: jars.admin, body: { mode: 'everyone', allowManagedChildren: true } });
    expect(on.body).toMatchObject({ ok: true, allowManagedChildren: true });
    expect((await call('/api/connections/mcp', { jar: jars.bob })).body.allowed).toBe(true);
    // Saving the policy without the switch leaves it where it was.
    await call('/api/admin/mcp/policy', { method: 'PUT', jar: jars.admin, body: { mode: 'everyone' } });
    expect((await call('/api/admin/mcp/policy', { jar: jars.admin })).body.allowManagedChildren).toBe(true);
    await call('/api/admin/mcp/policy', { method: 'PUT', jar: jars.admin, body: { mode: 'everyone', allowManagedChildren: false } });
    expect((await call('/api/connections/mcp', { jar: jars.bob })).body.allowed).toBe(false);
  });

  it('keeps the policy routes for the owner alone, and refuses a mode that is not one', async () => {
    expect((await call('/api/admin/mcp/policy')).status).toBe(403);
    expect((await call('/api/admin/mcp/policy', { method: 'PUT', body: { mode: 'everyone' } })).status).toBe(403);
    expect((await call('/api/admin/mcp/policy', { jar: null })).status).toBe(401);
    expect((await call('/api/admin/mcp/policy', { method: 'PUT', jar: jars.admin, body: { mode: 'sometimes' } })).status).toBe(400);
    expect((await call('/api/connections/mcp', { jar: null })).status).toBe(401);
  });

  it('stops a member using what they added once the permission is withdrawn, but lets them remove it', async () => {
    await permit('everyone');
    const added = await addBearer();
    await permit('not_allowed');
    expect((await call(`/api/connections/mcp/${added.id}/check`, { method: 'POST' })).status).toBe(403);
    expect((await call(`/api/connections/mcp/${added.id}`, { method: 'PATCH', body: { name: 'Renamed' } })).status).toBe(403);
    // Switching off and removing are always theirs to do.
    expect((await call(`/api/connections/mcp/${added.id}`, { method: 'PATCH', body: { enabled: false } })).status).toBe(200);
    expect((await call(`/api/connections/mcp/${added.id}`, { method: 'DELETE' })).status).toBe(204);
  });
});

// ------------------------------------------------------------ add and list

describe('adding a server', () => {
  beforeEach(() => permit('everyone'));

  it('connects and lists the tools before saving, and seals the token', async () => {
    const added = await addBearer();
    expect(added.slug).toBe('notes');
    expect(added.status).toBe('active');
    expect(added.tools).toEqual([
      { name: 'search', description: 'Does search.', readOnly: true, asksFirst: false, enabled: true },
      { name: 'send.message', description: 'Does send.message.', readOnly: false, asksFirst: true, enabled: true },
    ]);
    // The server was really asked, with the token, before the row existed.
    expect(mcp.seen.filter((r) => r.rpc?.method).map((r) => r.rpc!.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(mcp.seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);

    const [row] = await db.query<{ credentials_enc: string; owner_user_id: string }>('select credentials_enc, owner_user_id from mcp_connections');
    expect(row.owner_user_id).toBe(ids.alice);
    expect(isVaultCredentialReference(row.credentials_enc)).toBe(true);
    expect(row.credentials_enc).not.toContain(TOKEN);
    // In the person's own Vault box, under this connection.
    const items = await db.query<{ owner_user_id: string; service: string; slot: string }>(`select owner_user_id, service, slot from vault_items where service = 'mcp'`);
    expect(items).toEqual([{ owner_user_id: ids.alice, service: 'mcp', slot: added.id }]);

    const list = await call('/api/connections/mcp');
    expect(list.body.connections).toHaveLength(1);
    expect(list.body.connections[0]).toMatchObject({ id: added.id, name: 'Notes', host: 'mcp.example.test', auth: 'bearer', credentialSet: true, enabled: true });
  });

  it('saves nothing when the server does not answer, or refuses the sign-in', async () => {
    const wrong = await call('/api/connections/mcp', { method: 'POST', body: bearer({ token: 'wrong-token-value' }) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/did not accept that sign-in/);

    const none = await call('/api/connections/mcp', { method: 'POST', body: { name: 'Open', url: mcp.url, auth: 'none' } });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/asked for a sign-in/);

    mcp.options.override = () => new Response('<html>not mcp</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const notMcp = await call('/api/connections/mcp', { method: 'POST', body: bearer() });
    expect(notMcp.status).toBe(502);
    expect(notMcp.body.error).not.toContain('html');

    expect(await db.query('select id from mcp_connections')).toEqual([]);
    expect(await db.query(`select id from vault_items where service = 'mcp'`)).toEqual([]);
  });

  it('refuses an address that is not https, has a password in it, or is not on the public internet', async () => {
    for (const url of ['http://mcp.example.test/mcp', 'https://user:pw@mcp.example.test/mcp', 'stdio:///usr/bin/thing', 'not a url']) {
      const res = await call('/api/connections/mcp', { method: 'POST', body: bearer({ url }) });
      expect(res.status, url).toBe(400);
    }
    mcp.seen.length = 0;
    mcp.resolve = async () => ['10.0.0.9'];
    const privateHost = await call('/api/connections/mcp', { method: 'POST', body: bearer() });
    expect(privateHost.status).toBe(502);
    expect(privateHost.body.error).toMatch(/public internet/);
    const literal = await call('/api/connections/mcp', { method: 'POST', body: bearer({ url: 'https://169.254.169.254/mcp' }) });
    expect(literal.status).toBe(502);
    // Nothing was sent anywhere, and nothing was saved.
    expect(mcp.seen).toEqual([]);
    expect(await db.query('select id from mcp_connections')).toEqual([]);
  });

  it('sends a pasted value in the header the person named', async () => {
    mcp.options.auth = (h) => h['x-api-key'] === HEADER_VALUE;
    const res = await call('/api/connections/mcp', { method: 'POST', body: { name: 'Keyed', url: mcp.url, auth: 'header', headerName: 'X-API-Key', headerValue: HEADER_VALUE } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.connection).toMatchObject({ auth: 'header', headerName: 'X-API-Key', credentialSet: true });
    expect(mcp.seen[0].headers['x-api-key']).toBe(HEADER_VALUE);
    expect(mcp.seen[0].headers.authorization).toBeUndefined();

    // A header the connection itself needs cannot be taken over.
    for (const headerName of ['Content-Type', 'Mcp-Session-Id', 'Host', 'bad header']) {
      const bad = await call('/api/connections/mcp', { method: 'POST', body: { name: 'Bad', url: mcp.url, auth: 'header', headerName, headerValue: 'x' } });
      expect(bad.status, headerName).toBe(400);
    }
  });

  it('gives each of a person\'s servers its own short name', async () => {
    const first = await addBearer();
    const second = await addBearer(jars.alice, { name: 'Notes' });
    expect([first.slug, second.slug]).toEqual(['notes', 'notes_2']);
    const clash = await call('/api/connections/mcp', { method: 'POST', body: bearer({ slug: 'notes' }) });
    expect(clash.status).toBe(409);
    // Another person may use the same short name.
    expect((await addBearer(jars.bob)).slug).toBe('notes');
    const bad = await call('/api/connections/mcp', { method: 'POST', body: bearer({ slug: 'Bad Slug!' }) });
    expect(bad.status).toBe(400);
  });

  it('checks again, switches a tool off, renames and switches off', async () => {
    const added = await addBearer();
    mcp.options.tools = [tool('search', readOnly), tool('send.message'), tool('extra', readOnly)];
    const checked = await call(`/api/connections/mcp/${added.id}/check`, { method: 'POST' });
    expect(checked.body.ok).toBe(true);
    expect(checked.body.detail).toBe('Notes answered and offers 3 tools.');
    expect(checked.body.connection.tools.map((t: any) => t.name)).toEqual(['search', 'send.message', 'extra']);

    const patched = await call(`/api/connections/mcp/${added.id}`, { method: 'PATCH', body: { name: 'My notes', disabledTools: ['extra', 'no-such-tool'] } });
    expect(patched.status).toBe(200);
    expect(patched.body.connection.name).toBe('My notes');
    expect(patched.body.connection.tools.find((t: any) => t.name === 'extra').enabled).toBe(false);

    const off = await call(`/api/connections/mcp/${added.id}`, { method: 'PATCH', body: { enabled: false } });
    expect(off.body.connection.enabled).toBe(false);

    // A check that fails is an answer, not an error, and says what is wrong in Josi's words.
    mcp.options.auth = () => false;
    const failed = await call(`/api/connections/mcp/${added.id}/check`, { method: 'POST' });
    expect(failed.status).toBe(200);
    expect(failed.body.ok).toBe(false);
    expect(failed.body.connection.status).toBe('needs_attention');
    expect(failed.body.connection.lastError).toBe('mcp.example.test asked for a sign-in');
  });

  it('accepts a relabelled tool only when the person checks, and shows the difference until then', async () => {
    const added = await addBearer();
    mcp.options.tools = [tool('search', readOnly), tool('send.message', readOnly)];
    // Josi refreshing on its own (the assistant's list tool), not the person.
    await executeAssistantTool(db, { userId: ids.alice, threadId: null, connectors: { masterKey: () => key, customApiFetch: mcp.fetch, resolve: mcp.resolve } }, 'list_mcp_servers', { refresh: true });
    const before = (await call('/api/connections/mcp')).body.connections[0].tools.find((t: any) => t.name === 'send.message');
    expect(before).toMatchObject({ readOnly: true, asksFirst: true });
    const after = (await call(`/api/connections/mcp/${added.id}/check`, { method: 'POST' })).body.connection.tools.find((t: any) => t.name === 'send.message');
    expect(after).toMatchObject({ readOnly: true, asksFirst: false });
  });
});

// --------------------------------------------------------------- isolation

describe('one person\'s server is nobody else\'s', () => {
  beforeEach(() => permit('everyone'));

  it('is invisible to another member and to the owner of the installation', async () => {
    const added = await addBearer(jars.alice);
    for (const jar of [jars.bob, jars.admin]) {
      expect((await call('/api/connections/mcp', { jar })).body.connections).toEqual([]);
      expect((await call(`/api/connections/mcp/${added.id}`, { method: 'PATCH', jar, body: { name: 'Mine now' } })).status).toBe(404);
      expect((await call(`/api/connections/mcp/${added.id}/check`, { method: 'POST', jar })).status).toBe(404);
      expect((await call(`/api/connections/mcp/${added.id}/oauth/start`, { method: 'POST', jar })).status).toBe(404);
      expect((await call(`/api/connections/mcp/${added.id}`, { method: 'DELETE', jar })).status).toBe(404);
    }
    expect((await call('/api/connections/mcp')).body.connections[0].name).toBe('Notes');
    expect((await call('/api/connections/mcp/not-an-id', { method: 'DELETE' })).status).toBe(404);
  });

  it('removes the sealed sign-in with the server, and only that one', async () => {
    const mine = await addBearer(jars.alice);
    const theirs = await addBearer(jars.bob);
    expect((await call(`/api/connections/mcp/${mine.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await db.query<{ id: string }>('select id from mcp_connections')).toEqual([{ id: theirs.id }]);
    expect(await db.query<{ slot: string }>(`select slot from vault_items where service = 'mcp'`)).toEqual([{ slot: theirs.id }]);
    expect((await call('/api/connections/mcp')).body.connections).toEqual([]);
  });

  it('limits how many one person can add', async () => {
    await db.query(
      `insert into mcp_connections (owner_user_id, name, slug, url, host, auth_kind)
       select $1, 'S' || n, 's' || n || 'x', 'https://mcp.example.test/mcp', 'mcp.example.test', 'none' from generate_series(1, 20) n`, [ids.alice]);
    const res = await call('/api/connections/mcp', { method: 'POST', body: bearer() });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/At most 20/);
  });
});

// -------------------------------------------------------------------- OAuth

describe('signing in with the browser', () => {
  beforeEach(async () => {
    await permit('everyone');
    mcp = fakeMcp({
      oauth: { expiresIn: 3600 },
      tools: [tool('search', readOnly), tool('send.message')],
    });
    mcp.options.auth = (h) => mcp.validTokens.has((h.authorization ?? '').replace(/^Bearer /, ''));
  });

  const addOAuth = (jar = jars.alice, extra: Record<string, unknown> = {}) =>
    call('/api/connections/mcp', { method: 'POST', jar, body: { name: 'Docs', url: mcp.url, auth: 'oauth', ...extra } });

  async function start(id: string, jar = jars.alice, body: Record<string, unknown> = {}) {
    const res = await call(`/api/connections/mcp/${id}/oauth/start`, { method: 'POST', jar, body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const url = new URL(res.body.authorizationUrl);
    return { url, state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')! };
  }

  it('finds the sign-in server, registers itself and says a sign-in is needed', async () => {
    const added = await addOAuth();
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.signInNeeded).toBe(true);
    expect(added.body.connection).toMatchObject({
      auth: 'oauth', status: 'needs_sign_in', credentialSet: false, tools: [],
      oauth: { signInServer: 'login.example.test', signedIn: false, expiresAt: null },
    });
    // The 401 was followed to the resource document, the sign-in server and its registration address.
    expect(mcp.seen.map((r) => r.url)).toEqual([
      mcp.url,
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
      'https://login.example.test/.well-known/oauth-authorization-server',
      'https://login.example.test/register',
    ]);
    expect(JSON.parse(mcp.oauthLog[0].params.body).redirect_uris).toEqual(['https://josi.example.test/api/connections/mcp/oauth/callback']);
    const [row] = await db.query<{ oauth: Record<string, unknown> }>('select oauth from mcp_connections');
    expect(row.oauth).toMatchObject({ clientId: 'registered-client', tokenEndpoint: 'https://login.example.test/token', resource: mcp.url });
  });

  it('completes the whole sign-in: PKCE, a single-use state, sealed tokens, then the tool list', async () => {
    const id = (await addOAuth()).body.connection.id;
    const { url, state, challenge } = await start(id);
    expect(url.origin + url.pathname).toBe('https://login.example.test/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: 'registered-client', code_challenge_method: 'S256',
      redirect_uri: 'https://josi.example.test/api/connections/mcp/oauth/callback', resource: mcp.url,
    });
    // The state is stored as a hash, and the verifier is sealed, not a column.
    const [stored] = await db.query<{ state_hash: string; verifier_enc: string; user_id: string; connection_id: string }>('select * from mcp_oauth_states');
    expect(stored.state_hash).not.toBe(state);
    expect(stored).toMatchObject({ user_id: ids.alice, connection_id: id });
    expect(isVaultCredentialReference(stored.verifier_enc)).toBe(true);

    const code = mcp.issueCode(challenge);
    const back = await call(`/api/connections/mcp/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(302);
    expect(back.location).toBe('/app/connections?mcp=connected');

    // The code was exchanged with a verifier that matches the challenge the browser carried.
    const exchange = mcp.oauthLog.find((entry) => entry.what === 'token:authorization_code')!;
    expect(exchange.params).toMatchObject({ code, client_id: 'registered-client', resource: mcp.url });
    expect(exchange.params.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    const view = (await call('/api/connections/mcp')).body.connections[0];
    expect(view).toMatchObject({ status: 'active', credentialSet: true, oauth: { signedIn: true } });
    expect(view.tools.map((t: any) => [t.name, t.asksFirst])).toEqual([['search', false], ['send.message', true]]);
    expect(new Date(view.oauth.expiresAt).getTime()).toBeGreaterThan(Date.now() + 3_000_000);

    // The tokens are sealed in the person's Vault; the temporary verifier is gone.
    const [row] = await db.query<{ credentials_enc: string }>('select credentials_enc from mcp_connections');
    expect(isVaultCredentialReference(row.credentials_enc)).toBe(true);
    expect((await db.query<{ service: string }>(`select service from vault_items where service like 'mcp%' order by service`)).map((r) => r.service)).toEqual(['mcp']);
    expect((await db.query<{ verifier_enc: string | null }>('select verifier_enc from mcp_oauth_states'))[0].verifier_enc).toBeNull();

    // Used once: the same link again connects nothing and spends no code.
    const exchanges = mcp.oauthLog.length;
    const replay = await call(`/api/connections/mcp/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`);
    expect(replay.location).toBe('/app/connections?mcp_error=expired');
    expect(mcp.oauthLog).toHaveLength(exchanges);

    const visible = await everythingVisible();
    for (const secret of ['access-1', 'refresh-1', exchange.params.code_verifier]) expect(visible).not.toContain(secret);
  });

  it('binds the state to the person who started it', async () => {
    const id = (await addOAuth()).body.connection.id;
    const { state, challenge } = await start(id);
    const code = mcp.issueCode(challenge);
    const query = `code=${code}&state=${encodeURIComponent(state)}`;

    // Another signed-in person, and nobody at all, finish nothing.
    expect((await call(`/api/connections/mcp/oauth/callback?${query}`, { jar: jars.bob })).location).toBe('/app/connections?mcp_error=wrong_person');
    expect((await call(`/api/connections/mcp/oauth/callback?${query}`, { jar: null })).location).toBe('/app/connections?mcp_error=session');
    expect((await call('/api/connections/mcp/oauth/complete', { method: 'POST', jar: jars.bob, body: { state, code } })).status).toBe(404);
    expect(mcp.oauthLog.some((entry) => entry.what.startsWith('token:'))).toBe(false);
    expect((await call('/api/connections/mcp')).body.connections[0].status).toBe('needs_sign_in');

    // Their attempt did not use the state up: its owner can still finish.
    expect((await call(`/api/connections/mcp/oauth/callback?${query}`)).location).toBe('/app/connections?mcp=connected');

    // A made-up state is nothing.
    expect((await call('/api/connections/mcp/oauth/callback?code=x&state=made-up')).location).toBe('/app/connections?mcp_error=expired');
  });

  it('connects nothing when the person cancels, or when the state has expired', async () => {
    const id = (await addOAuth()).body.connection.id;
    const first = await start(id);
    const cancelled = await call(`/api/connections/mcp/oauth/callback?error=access_denied&state=${encodeURIComponent(first.state)}`);
    expect(cancelled.location).toBe('/app/connections?mcp_error=declined');

    const second = await start(id);
    await db.query(`update mcp_oauth_states set expires_at = now() - interval '1 minute'`);
    const late = await call(`/api/connections/mcp/oauth/callback?code=${mcp.issueCode(second.challenge)}&state=${encodeURIComponent(second.state)}`);
    expect(late.location).toBe('/app/connections?mcp_error=expired');
    expect(mcp.oauthLog.some((entry) => entry.what.startsWith('token:'))).toBe(false);
    expect((await call('/api/connections/mcp')).body.connections[0].status).toBe('needs_sign_in');
  });

  it('hands a phone app\'s sign-in back to the app, which finishes it with its own session', async () => {
    const id = (await addOAuth()).body.connection.id;
    const { state, challenge } = await start(id, jars.alice, { native: true });
    const code = mcp.issueCode(challenge);
    // The phone's browser sheet has no Josi session.
    const handed = await call(`/api/connections/mcp/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`, { jar: null });
    expect(handed.status).toBe(302);
    const app = new URL(handed.location!);
    expect(app.protocol).toBe('josi:');
    expect(app.searchParams.get('state')).toBe(state);
    expect(app.searchParams.get('code')).toBe(code);
    // Nothing was redeemed by that redirect.
    expect(mcp.oauthLog.some((entry) => entry.what.startsWith('token:'))).toBe(false);

    const done = await call('/api/connections/mcp/oauth/complete', { method: 'POST', body: { state, code } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.connection).toMatchObject({ status: 'active', oauth: { signedIn: true } });
    expect((await call('/api/connections/mcp/oauth/complete', { method: 'POST', body: { state, code } })).status).toBe(409);
  });

  async function signedIn(): Promise<string> {
    const id = (await addOAuth()).body.connection.id;
    const { state, challenge } = await start(id);
    await call(`/api/connections/mcp/oauth/callback?code=${mcp.issueCode(challenge)}&state=${encodeURIComponent(state)}`);
    return id;
  }

  it('refreshes a token that has run out before using it', async () => {
    const id = await signedIn();
    await db.query(`update mcp_connections set oauth = oauth || jsonb_build_object('expiresAt', $1::bigint)`, [Date.now() - 1000]);
    mcp.seen.length = 0;
    const checked = await call(`/api/connections/mcp/${id}/check`, { method: 'POST' });
    expect(checked.body.ok).toBe(true);
    expect(mcp.oauthLog.at(-1)).toMatchObject({ what: 'token:refresh_token', params: { refresh_token: 'refresh-1', client_id: 'registered-client' } });
    // The server was only ever shown the new token.
    expect(mcp.seen.filter((r) => r.url === mcp.url).every((r) => r.headers.authorization === 'Bearer access-2')).toBe(true);
    expect(new Date(checked.body.connection.oauth.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refreshes once and tries again when the server refuses a token that looked fine', async () => {
    const id = await signedIn();
    mcp.validTokens.clear();
    const checked = await call(`/api/connections/mcp/${id}/check`, { method: 'POST' });
    expect(checked.body.ok).toBe(true);
    expect(mcp.oauthLog.filter((entry) => entry.what === 'token:refresh_token')).toHaveLength(1);
    expect(checked.body.connection.status).toBe('active');
  });

  it('asks the person to sign in again when the refresh is refused too', async () => {
    const id = await signedIn();
    mcp.validTokens.clear();
    await call(`/api/connections/mcp/${id}/check`, { method: 'POST' });
    // Spend the stored refresh token behind Josi's back, and revoke the access token.
    mcp.options.oauth!.rotateRefresh = true;
    mcp.validTokens.clear();
    const [row] = await db.query<{ id: string }>('select id from mcp_connections');
    await mcp.fetch('https://login.example.test/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'refresh-2' }).toString() });
    mcp.validTokens.clear();
    const failed = await call(`/api/connections/mcp/${row.id}/check`, { method: 'POST' });
    expect(failed.body.ok).toBe(false);
    expect(failed.body.connection.status).toBe('needs_sign_in');
    expect(failed.body.connection.oauth.signedIn).toBe(false);
  });

  it('asks for a client id when the sign-in server will not register Josi, and uses the one pasted', async () => {
    mcp.options.oauth = { registration: false };
    const refused = await addOAuth();
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('client_id_required');
    expect(await db.query('select id from mcp_connections')).toEqual([]);

    const added = await addOAuth(jars.alice, { clientId: 'pasted-client', clientSecret: CLIENT_SECRET });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.connection.credentialSet).toBe(true);
    const { url, state, challenge } = await start(added.body.connection.id);
    expect(url.searchParams.get('client_id')).toBe('pasted-client');
    await call(`/api/connections/mcp/oauth/callback?code=${mcp.issueCode(challenge)}&state=${encodeURIComponent(state)}`);
    const exchange = mcp.oauthLog.find((entry) => entry.what === 'token:authorization_code')!;
    expect(exchange.params).toMatchObject({ client_id: 'pasted-client', client_secret: CLIENT_SECRET });
    expect(await everythingVisible()).not.toContain(CLIENT_SECRET);
  });

  it('says so when a server that needs no sign-in is added as browser sign-in', async () => {
    mcp.options.auth = undefined;
    const res = await addOAuth();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/without asking for a sign-in/);
  });

  it('does not start a browser sign-in for a server that uses a token', async () => {
    mcp = fakeMcp({ auth: (h) => h.authorization === `Bearer ${TOKEN}`, tools: [tool('search', readOnly)] });
    const added = await addBearer();
    expect((await call(`/api/connections/mcp/${added.id}/oauth/start`, { method: 'POST' })).status).toBe(400);
  });
});

// ---------------------------------------------------------------- approvals

describe('a tool that is not read-only waits for its owner', () => {
  beforeEach(() => permit('everyone'));

  const asAssistant = (userId: string, name: string, input: Record<string, unknown>) =>
    executeAssistantTool(db, { userId, threadId: null, connectors: { masterKey: () => key, customApiFetch: mcp.fetch, resolve: mcp.resolve } }, name, input) as Promise<any>;

  it('shows the request only to its owner, and runs exactly the approved arguments once', async () => {
    await addBearer();
    const asked = await asAssistant(ids.alice, 'mcp_notes__send_message', { q: 'hello there' });
    expect(asked.error).toBe('needs_approval');
    expect(mcp.toolCalls).toEqual([]);

    const pending = await call('/api/connections/mcp/pending');
    expect(pending.body.pending).toHaveLength(1);
    expect(pending.body.pending[0]).toMatchObject({ id: asked.approval_id, connectionName: 'Notes', tool: 'send.message', host: 'mcp.example.test' });
    expect(pending.body.pending[0].summary).toContain('q: hello there');

    // Nobody else can see it or decide it: 404, the same as one that never existed.
    for (const jar of [jars.bob, jars.admin]) {
      expect((await call('/api/connections/mcp/pending', { jar })).body.pending).toEqual([]);
      expect((await call(`/api/connections/mcp/pending/${asked.approval_id}/approve`, { method: 'POST', jar })).status).toBe(404);
      expect((await call(`/api/connections/mcp/pending/${asked.approval_id}/deny`, { method: 'POST', jar })).status).toBe(404);
    }
    expect(mcp.toolCalls).toEqual([]);

    const approved = await call(`/api/connections/mcp/pending/${asked.approval_id}/approve`, { method: 'POST' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toEqual({ ok: true, result: { text: 'ran send.message with {"q":"hello there"}', toolReportedError: false, truncated: false, leftOut: [] } });
    expect(mcp.toolCalls).toEqual([{ name: 'send.message', arguments: { q: 'hello there' } }]);

    // Pressed twice: one call, one refusal.
    expect((await call(`/api/connections/mcp/pending/${asked.approval_id}/approve`, { method: 'POST' })).status).toBe(409);
    expect(mcp.toolCalls).toHaveLength(1);
    expect((await call('/api/connections/mcp/pending')).body.pending).toEqual([]);

    // The conversation that asked is given the answer, once.
    const collected = await asAssistant(ids.alice, 'mcp_notes__send_message', { q: 'hello there' });
    expect(collected.outside_server_result).toBe('ran send.message with {"q":"hello there"}');
    expect(mcp.toolCalls).toHaveLength(1);
  });

  it('runs nothing when declined', async () => {
    await addBearer();
    const asked = await asAssistant(ids.alice, 'mcp_notes__send_message', { q: 'x' });
    const denied = await call(`/api/connections/mcp/pending/${asked.approval_id}/deny`, { method: 'POST' });
    expect(denied.body).toEqual({ ok: true, status: 'denied' });
    expect((await call(`/api/connections/mcp/pending/${asked.approval_id}/approve`, { method: 'POST' })).status).toBe(409);
    expect(mcp.toolCalls).toEqual([]);
  });

  it('does not run an approved call if the server was switched off, the tool removed, or the permission withdrawn meanwhile', async () => {
    const added = await addBearer();
    const first = await asAssistant(ids.alice, 'mcp_notes__send_message', { q: '1' });
    await call(`/api/connections/mcp/${added.id}`, { method: 'PATCH', body: { enabled: false } });
    const off = await call(`/api/connections/mcp/pending/${first.approval_id}/approve`, { method: 'POST' });
    expect(off.status).toBe(409);
    expect(off.body.error).toMatch(/switched off/);

    await call(`/api/connections/mcp/${added.id}`, { method: 'PATCH', body: { enabled: true } });
    const second = await asAssistant(ids.alice, 'mcp_notes__send_message', { q: '2' });
    await call(`/api/connections/mcp/${added.id}`, { method: 'PATCH', body: { disabledTools: ['send.message'] } });
    expect((await call(`/api/connections/mcp/pending/${second.approval_id}/approve`, { method: 'POST' })).body.error).toMatch(/no longer available/);

    await call(`/api/connections/mcp/${added.id}`, { method: 'PATCH', body: { disabledTools: [] } });
    const third = await asAssistant(ids.alice, 'mcp_notes__send_message', { q: '3' });
    await permit('not_allowed');
    const withdrawn = await call(`/api/connections/mcp/pending/${third.approval_id}/approve`, { method: 'POST' });
    expect(withdrawn.status).toBe(403);
    expect(mcp.toolCalls).toEqual([]);
  });

  it('takes its pending requests with it when the server is removed', async () => {
    const added = await addBearer();
    const asked = await asAssistant(ids.alice, 'mcp_notes__send_message', { q: 'x' });
    await call(`/api/connections/mcp/${added.id}`, { method: 'DELETE' });
    expect((await call(`/api/connections/mcp/pending/${asked.approval_id}/approve`, { method: 'POST' })).status).toBe(404);
    expect(await db.query('select id from mcp_pending_calls')).toEqual([]);
  });

  it('tells the phone an approval is waiting, without saying what it is', async () => {
    await addBearer();
    // One phone in the background, one that has switched approval notices off.
    // Positional: id, owner, device name, platform, sealed push address, its fingerprint.
    await db.query(`insert into mobile_devices values (gen_random_uuid(), $1, 'device-one', 'ios', 'sealed-fixture-one', 'fingerprint-one')`, [ids.alice]);
    await db.query(`insert into mobile_devices values (gen_random_uuid(), $1, 'device-two', 'ios', 'sealed-fixture-two', 'fingerprint-two')`, [ids.alice]);
    await db.query(`update mobile_devices set categories = categories || '{"approval": false}'::jsonb where device_identity = 'device-two'`);
    await db.query(`insert into mobile_devices values (gen_random_uuid(), $1, 'device-bob', 'ios', 'sealed-fixture-bob', 'fingerprint-bob')`, [ids.bob]);
    const asked = await asAssistant(ids.alice, 'mcp_notes__send_message', { q: 'private words' });
    // Asking again for the same call does not notify twice.
    await asAssistant(ids.alice, 'mcp_notes__send_message', { q: 'private words' });
    const pushes = await db.query<{ category: string; route_type: string; route_id: string; body: string; event_key: string }>(
      'select category, route_type, route_id, body, event_key from push_deliveries');
    expect(pushes).toEqual([{ category: 'approval', route_type: 'approval', route_id: asked.approval_id, body: 'Your approval is needed.', event_key: `mcp_call:${asked.approval_id}` }]);
    expect(JSON.stringify(pushes)).not.toContain('private words');
  });
});

// ------------------------------------------------------------------ secrets

describe('no response, audit record or log line contains a sign-in', () => {
  it('through adding, listing, checking, failing, calling, approving and removing', async () => {
    await permit('everyone');
    const added = await addBearer();
    mcp.options.auth = (h) => h.authorization === `Bearer ${TOKEN}` || h['x-api-key'] === HEADER_VALUE;
    const keyed = await call('/api/connections/mcp', { method: 'POST', body: { name: 'Keyed', url: mcp.url, auth: 'header', headerName: 'X-API-Key', headerValue: HEADER_VALUE } });
    expect(keyed.status).toBe(201);

    await call('/api/connections/mcp');
    await call(`/api/connections/mcp/${added.id}/check`, { method: 'POST' });
    await call('/api/admin/mcp/policy', { jar: jars.admin });
    const connectors = { masterKey: () => key, customApiFetch: mcp.fetch, resolve: mcp.resolve };
    const read = await executeAssistantTool(db, { userId: ids.alice, threadId: null, connectors }, 'mcp_notes__search', { q: 'x' });
    const asked = await executeAssistantTool(db, { userId: ids.alice, threadId: null, connectors }, 'mcp_notes__send_message', { q: 'x' }) as any;
    const listed = await executeAssistantTool(db, { userId: ids.alice, threadId: null, connectors }, 'list_mcp_servers', { refresh: true });
    await call(`/api/connections/mcp/pending/${asked.approval_id}/approve`, { method: 'POST' });

    // A server that echoes the sign-in back in an error, and one that throws it.
    mcp.options.override = (rpc, req) => (rpc.method === 'tools/call'
      ? new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: `rejected ${req.headers.authorization}` } }), { headers: { 'content-type': 'application/json' } })
      : undefined);
    const echoed = await executeAssistantTool(db, { userId: ids.alice, threadId: null, connectors }, 'mcp_notes__search', { q: 'x' });
    mcp.options.override = () => new Response(`upstream said ${TOKEN}`, { status: 500 });
    await call(`/api/connections/mcp/${added.id}/check`, { method: 'POST' });
    mcp.options.override = undefined;
    await call('/api/connections/mcp', { method: 'POST', body: bearer({ token: 'another-wrong-token-value' }) });
    await call(`/api/connections/mcp/${added.id}`, { method: 'DELETE' });

    const events = await db.query<{ kind: string }>(`select kind from events where kind like 'mcp.%' order by created_at`);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining([
      'mcp.policy_set', 'mcp.connection_added', 'mcp.call_requested', 'mcp.call_approved', 'mcp.call_executed', 'mcp.connection_removed',
    ]));

    const rows = JSON.stringify([
      await db.query('select * from mcp_connections'), await db.query('select * from mcp_pending_calls'),
      await db.query('select * from mcp_oauth_states'), await db.query('select * from push_deliveries'),
    ]);
    const visible = [await everythingVisible(), rows, JSON.stringify([read, asked, listed])].join('\n');
    for (const secret of [TOKEN, HEADER_VALUE, 'another-wrong-token-value']) expect(visible, secret).not.toContain(secret);

    // A server that echoes the sign-in back does not get it into the
    // conversation either: it is cut out of what the assistant is given.
    expect((echoed as any).error).toBe('tool_refused');
    expect((echoed as any).notice).toMatch(/outside server/);
    expect((echoed as any).outside_server_said).toBe('rejected [sign-in removed]');
    expect(JSON.stringify(echoed)).not.toContain(TOKEN);
  });
});
