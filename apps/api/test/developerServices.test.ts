// Developer services: permission and connection are two different facts.
//
// GitHub, Netlify, Vercel and Supabase are each person's own account. What an
// administrator governs is who may connect one — not the credential, which is
// the connecting person's and which the admin surface must never ask for.
//
// The failure these guard against is conflating the two. A service permitted
// for everyone that nobody has connected, and a service nobody may connect,
// look identical if you only count connections; an administrator reading the
// second as the first concludes the team does not want a tool they were never
// able to use.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isVaultCredentialReference, MasterKey, setVaultLock } from '@josi-ce/core';
import { testDb, testVault, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-devsvc-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 13).toString('base64'));

let server: Server;
let base: string;
let db: TestDb;

// Not credential-shaped: the pre-commit scanner rejects anything that looks
// real, and what matters is only that it round-trips and never comes back out.
const TOKEN = 'not-a-real-developer-token-value';

let serviceReply: { status: number; body: unknown } | 'throw' = {
  status: 200, body: { login: 'octocat' },
};
const seen: string[] = [];
let beforeServiceReply: (() => Promise<void>) | undefined;
/** Per-address replies for the services that take more than one request. */
let replyFor: ((url: string) => { status: number; body: unknown } | undefined) | undefined;
const developerServiceFetch: typeof fetch = async (url) => {
  seen.push(String(url));
  if (beforeServiceReply) { const work = beforeServiceReply; beforeServiceReply = undefined; await work(); }
  const routed = replyFor?.(String(url));
  if (routed) return new Response(JSON.stringify(routed.body), { status: routed.status, headers: { 'content-type': 'application/json' } });
  if (serviceReply === 'throw') throw new Error('ECONNREFUSED');
  return new Response(JSON.stringify(serviceReply.body), {
    status: serviceReply.status,
    headers: { 'content-type': 'application/json' },
  });
};

interface Res { status: number; body: any }
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

async function call(path: string, opts: { method?: string; body?: unknown; jar?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const jar = opts.jar ?? jars.admin;
  if (jar) headers.cookie = jar;
  const token = /josi_csrf=([^;]+)/.exec(jar)?.[1];
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const method = opts.method ?? 'GET';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: method !== 'GET' && opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function signIn(identifier: string, password: string): Promise<string> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const jar = mergeJar(undefined, pre.headers.getSetCookie?.() ?? []);
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', cookie: jar,
      'x-josi-csrf': decodeURIComponent(/josi_csrf=([^;]+)/.exec(jar)?.[1] ?? ''),
    },
    body: JSON.stringify({ identifier, password }),
  });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.headers.getSetCookie?.() ?? []);
}

const PW = 'a-long-enough-password-123';

beforeEach(async () => {
  db = await testDb();
  seen.length = 0;
  serviceReply = { status: 200, body: { login: 'octocat' } };
  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath },
    developerServiceFetch,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW })).id;
  await testVault(db, new MasterKey(Buffer.alloc(32, 13)));
  beforeServiceReply = undefined;
  replyFor = undefined;
  jars.admin = await signIn('admin', PW);
  jars.alice = await signIn('alice', PW);
  jars.bob = await signIn('bob', PW);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Omitting `userIds` leaves the stored list alone, which is what the admin
 * screen sends when it is only changing the mode. Passing one replaces it. */
async function permit(service: string, mode: string, userIds?: string[]) {
  const res = await call(`/api/admin/developer-services/${service}`, {
    method: 'PUT', body: userIds === undefined ? { mode } : { mode, userIds },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe('every service starts refused', () => {
  it('permits nobody until an administrator says otherwise', async () => {
    const res = await call('/api/connections/developer', { jar: jars.alice });
    expect(res.status).toBe(200);
    const services = res.body.services as Array<{ service: string; allowed: boolean }>;
    expect(services.map((s) => s.service)).toEqual([
      'github', 'netlify', 'vercel', 'supabase',
      'gitlab', 'cloudflare', 'sentry', 'render', 'railway', 'linear',
      'dockerhub', 'ghcr', 'jira', 'npm', 'neon', 'notion',
      'appstoreconnect', 'googleplay',
    ]);
    // A developer service reaches a third party with a person's own credential.
    // Defaulting to permitted would switch that on for every installation that
    // upgrades without anybody choosing it.
    expect(services.every((s) => !s.allowed)).toBe(true);
  });

  it('refuses the connection at the route, not by hiding a control', async () => {
    const res = await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });
    expect(res.status).toBe(403);
    expect(await db.query(`select * from developer_connections`)).toHaveLength(0);
    // Nothing was asked of GitHub either.
    expect(seen).toHaveLength(0);
  });
});

describe('the three scopes', () => {
  it('allows everyone', async () => {
    await permit('github', 'everyone');
    for (const who of ['alice', 'bob']) {
      const res = await call('/api/connections/developer', { jar: jars[who] });
      const github = (res.body.services as any[]).find((s) => s.service === 'github');
      expect(github.allowed, who).toBe(true);
    }
  });

  it('allows only the people named', async () => {
    await permit('github', 'specific_users', [ids.alice]);

    const forAlice = await call('/api/connections/developer', { jar: jars.alice });
    expect((forAlice.body.services as any[]).find((s) => s.service === 'github').allowed).toBe(true);

    const forBob = await call('/api/connections/developer', { jar: jars.bob });
    expect((forBob.body.services as any[]).find((s) => s.service === 'github').allowed).toBe(false);

    // And the refusal is enforced, not merely displayed.
    const attempt = await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.bob, body: { token: TOKEN },
    });
    expect(attempt.status).toBe(403);
  });

  it('treats an empty named list as nobody, and says so', async () => {
    await permit('github', 'specific_users', []);
    const admin = await call('/api/admin/developer-services');
    const github = (admin.body.services as any[]).find((s) => s.service === 'github');
    // A real state — an administrator part-way through choosing — rather than
    // an error, but it must not read as "allowed".
    expect(github.summary).toMatch(/no one has been chosen/i);

    const attempt = await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });
    expect(attempt.status).toBe(403);
  });

  it('keeps a named list across a change of mode', async () => {
    await permit('github', 'specific_users', [ids.alice]);
    await permit('github', 'everyone');
    await permit('github', 'specific_users');

    // Switching to "everyone" and back must not silently empty the list the
    // administrator built.
    const admin = await call('/api/admin/developer-services');
    const github = (admin.body.services as any[]).find((s) => s.service === 'github');
    expect(github.allowedUserIds).toEqual([ids.alice]);
  });

  it('shows the administrator\'s reason to whoever is refused', async () => {
    await call('/api/admin/developer-services/github', {
      method: 'PUT',
      body: { mode: 'not_allowed', note: 'Ask the platform team if you need this.' },
    });
    const res = await call('/api/connections/developer', { jar: jars.alice });
    const github = (res.body.services as any[]).find((s) => s.service === 'github');
    expect(github.note).toMatch(/platform team/i);

    const attempt = await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });
    expect(attempt.body.error).toMatch(/platform team/i);
  });

  it('is administrator-only to change', async () => {
    const res = await call('/api/admin/developer-services/github', {
      method: 'PUT', jar: jars.alice, body: { mode: 'everyone' },
    });
    expect(res.status).toBe(403);
    expect((await call('/api/admin/developer-services', { jar: jars.alice })).status).toBe(403);
  });
});

describe('the credential belongs to the person, not the installation', () => {
  it('checks the token before storing it', async () => {
    await permit('github', 'everyone');
    serviceReply = { status: 401, body: { message: 'Bad credentials' } };
    const res = await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rejected/i);
    // A token that does not work is never stored as though it did.
    expect(await db.query(`select * from developer_connections`)).toHaveLength(0);
  });

  it('seals the token and never returns it', async () => {
    await permit('github', 'everyone');
    const res = await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.accountLabel).toBe('octocat');

    const [row] = await db.query<{ credentials_enc: string }>(
      `select credentials_enc from developer_connections`,
    );
    expect(isVaultCredentialReference(row.credentials_enc)).toBe(true);
    expect(row.credentials_enc).not.toContain(TOKEN);

    const mine = await call('/api/connections/developer', { jar: jars.alice });
    expect(JSON.stringify(mine.body)).not.toContain(TOKEN);
  });

  it('never exposes it to an administrator, who cannot enter one either', async () => {
    await permit('github', 'everyone');
    await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });

    const admin = await call('/api/admin/developer-services');
    const serialised = JSON.stringify(admin.body);
    expect(serialised).not.toContain(TOKEN);
    // No credential entry is duplicated onto the admin surface: the admin PUT
    // takes a scope and ignores anything that looks like one.
    const attempt = await call('/api/admin/developer-services/github', {
      method: 'PUT', body: { mode: 'everyone', token: 'another-token-value-entirely' },
    });
    expect(attempt.status).toBe(200);
    const [row] = await db.query<{ credentials_enc: string }>(
      `select credentials_enc from developer_connections`,
    );
    expect(row.credentials_enc).not.toContain('another-token-value-entirely');
  });

  it('is one account per person per service, and mine to remove', async () => {
    await permit('github', 'everyone');
    await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });
    serviceReply = { status: 200, body: { login: 'octocat-two' } };
    await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });
    // Reconnecting replaces rather than accumulating rows nobody can tell apart.
    const rows = await db.query<{ account_label: string }>(
      `select account_label from developer_connections where owner_user_id = $1`, [ids.alice],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].account_label).toBe('octocat-two');

    const gone = await call('/api/connections/developer/github', {
      method: 'DELETE', jar: jars.alice,
    });
    expect(gone.status).toBe(204);
    expect(await db.query(`select * from developer_connections`)).toHaveLength(0);
  });

  it('lets me re-check my own connection and records what it found', async () => {
    await permit('github', 'everyone');
    await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });
    serviceReply = { status: 401, body: {} };
    const res = await call('/api/connections/developer/github/check', {
      method: 'POST', jar: jars.alice, body: {},
    });
    expect(res.body.ok).toBe(false);
    const [row] = await db.query<{ status: string; last_check_ok: boolean; last_error: string }>(
      `select status, last_check_ok, last_error from developer_connections`,
    );
    expect(row.last_check_ok).toBe(false);
    expect(row.status).toBe('needs_reconnect');
    expect(row.last_error).toMatch(/rejected/i);
  });
});

describe('permission and connection are reported separately', () => {
  it('distinguishes "nobody may" from "nobody has"', async () => {
    // Permitted for everyone, connected by nobody.
    await permit('netlify', 'everyone');
    // Permitted for nobody at all.
    await permit('vercel', 'not_allowed');

    const admin = await call('/api/admin/developer-services');
    const byService = new Map((admin.body.services as any[]).map((s) => [s.service, s]));

    expect(byService.get('netlify').mode).toBe('everyone');
    expect(byService.get('netlify').connections).toEqual([]);
    expect(byService.get('vercel').mode).toBe('not_allowed');
    expect(byService.get('vercel').connections).toEqual([]);

    // Same connection count, different permission — the two facts are carried
    // in different fields so a screen cannot read one off the other.
    expect(byService.get('netlify').summary).not.toBe(byService.get('vercel').summary);
  });

  it('shows health per person without showing anything from inside the account', async () => {
    await permit('github', 'everyone');
    await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });

    const admin = await call('/api/admin/developer-services');
    const github = (admin.body.services as any[]).find((s) => s.service === 'github');
    expect(github.connections).toHaveLength(1);
    expect(github.connections[0].username).toBe('alice');
    expect(github.connections[0].status).toBe('active');
    // The account's own name is what the owner already sees. Nothing else from
    // the account is carried.
    expect(Object.keys(github.connections[0]).sort()).toEqual([
      'accountLabel', 'lastCheckAt', 'lastCheckOk', 'lastError', 'lastUsedAt', 'status', 'userId', 'username',
    ]);
  });

  it('un-naming somebody stops them using it without deleting what they connected', async () => {
    await permit('github', 'specific_users', [ids.alice]);
    await call('/api/connections/developer/github', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    });
    await permit('github', 'specific_users', [ids.bob]);

    const mine = await call('/api/connections/developer', { jar: jars.alice });
    const github = (mine.body.services as any[]).find((s) => s.service === 'github');
    expect(github.allowed).toBe(false);
    // Their credential is theirs to delete. Revoking permission is not a
    // reason for the product to throw it away behind their back.
    expect(github.connection).not.toBeNull();
    expect(await db.query(`select * from developer_connections`)).toHaveLength(1);
  });
});

describe('only catalogued native services are accepted', () => {
  it('refuses anything else', async () => {
    expect((await call('/api/admin/developer-services/bitbucket', {
      method: 'PUT', body: { mode: 'everyone' },
    })).status).toBe(404);
    await permit('github', 'everyone');
    expect((await call('/api/connections/developer/bitbucket', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN },
    })).status).toBe(404);
  });

  it('refuses a mode it does not know', async () => {
    const res = await call('/api/admin/developer-services/github', {
      method: 'PUT', body: { mode: 'sometimes' },
    });
    expect(res.status).toBe(400);
  });
});


describe('developer credential Vault boundaries', () => {
  it('refuses a locked credential test before any provider request', async () => {
    await permit('github', 'everyone');
    await setVaultLock(db, { master: true, locked: true, actorUserId: ids.admin });
    const res = await call('/api/connections/developer/github', { method: 'PUT', jar: jars.alice, body: { token: TOKEN } });
    expect(res.status).toBe(423); expect(seen).toHaveLength(0);
  });

  it('does not commit a token if permission is removed during its identity check', async () => {
    await permit('github', 'everyone');
    beforeServiceReply = async () => { await permit('github', 'not_allowed'); };
    const res = await call('/api/connections/developer/github', { method: 'PUT', jar: jars.alice, body: { token: TOKEN } });
    expect(res.status).toBe(403);
    expect(await db.query('select id from developer_connections')).toHaveLength(0);
    expect(await db.query("select id from vault_items where service='developer.github'")).toHaveLength(0);
  });

  it('refuses a saved-credential recheck after policy revocation without contacting the provider', async () => {
    await permit('github', 'everyone');
    expect((await call('/api/connections/developer/github', { method: 'PUT', jar: jars.alice, body: { token: TOKEN } })).status).toBe(200);
    await permit('github', 'not_allowed'); seen.length = 0;
    expect((await call('/api/connections/developer/github/check', { method: 'POST', jar: jars.alice, body: {} })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('commits policy and named-user changes atomically with their audit', async () => {
    await permit('github', 'specific_users', [ids.alice]);
    await db.exec("create function reject_policy() returns trigger as $$ begin if new.kind='developer_service.policy_set' then raise exception 'synthetic policy failure'; end if; return new; end; $$ language plpgsql; create trigger reject_policy before insert on events for each row execute function reject_policy();");
    const res = await call('/api/admin/developer-services/github', { method: 'PUT', body: { mode: 'specific_users', userIds: [ids.bob] } });
    expect(res.status).toBe(500);
    expect(await db.query("select user_id from developer_service_allowed_users where service='github'")).toEqual([{ user_id: ids.alice }]);
  });
});


// Store keys are several fields, one of them a pasted file. They are generated
// here so nothing credential-shaped is committed.
const P8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const RSA_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const keyBody = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
const ISSUER = '57246542-96fe-1a63-e053-0824d011072a';
const KEY_ID = 'ABC123DEFG';
const PACKAGE = 'com.example.app';
const SERVICE_EMAIL = 'josi-reader@fixture-project.iam.gserviceaccount.com';
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', private_key_id: 'fixture-key-id', private_key: RSA_PEM, client_email: SERVICE_EMAIL }, null, 2);
const APPLE_BODY = { issuerId: ISSUER, keyId: KEY_ID, privateKey: P8.replace(/\n/g, '\r\n') };
const GOOGLE_BODY = { serviceAccountJson: SERVICE_ACCOUNT, packageName: PACKAGE };
/** Every secret a store connection carries, in the forms it could leak in. */
const STORE_SECRETS = [keyBody(P8).slice(0, 32), keyBody(RSA_PEM).slice(0, 32), '-----BEGIN', SERVICE_EMAIL, 'short-lived-access', ISSUER];

const googleHappy = (url: string) => (url.includes('oauth2.googleapis.com')
  ? { status: 200, body: { access_token: 'short-lived-access', expires_in: 3600 } }
  : { status: 200, body: { reviews: [] } });

async function everythingTheServerSays(): Promise<string> {
  return JSON.stringify([
    (await call('/api/connections/developer', { jar: jars.alice })).body,
    (await call('/api/admin/developer-services')).body,
    await db.query('select * from developer_connections'),
    await db.query('select * from events'),
  ]);
}

describe('every form is described by its fields', () => {
  it('lists fields for the original token services and keeps every key they already had', async () => {
    const res = await call('/api/connections/developer', { jar: jars.alice });
    const by = new Map((res.body.services as any[]).map((s) => [s.service, s]));
    expect(by.size).toBe(18);
    for (const [service, row] of by) {
      // Nothing an existing client reads has gone away.
      for (const kept of ['service', 'label', 'tokenLabel', 'tokenHelp', 'tokenUrl', 'capability', 'usernameLabel', 'emailLabel', 'baseUrlLabel', 'allowed', 'note', 'connection']) {
        expect(row, `${service}.${kept}`).toHaveProperty(kept);
      }
      expect(row.fields.length, service).toBeGreaterThan(0);
      for (const field of row.fields) expect(Object.keys(field).sort(), service).toEqual(['help', 'key', 'label', 'multiline', 'secret']);
    }
    expect(by.get('github').fields).toEqual([{ key: 'token', label: 'Personal access token', secret: true, multiline: false, help: by.get('github').tokenHelp }]);
    expect(by.get('dockerhub').fields.map((f: any) => f.key)).toEqual(['username', 'token']);
    expect(by.get('jira').fields.map((f: any) => f.key)).toEqual(['email', 'baseUrl', 'token']);
  });

  it('lists the parts of each store key', async () => {
    const res = await call('/api/connections/developer', { jar: jars.alice });
    const by = new Map((res.body.services as any[]).map((s) => [s.service, s]));
    const shape = (service: string) => by.get(service).fields.map(({ key, label, secret, multiline }: any) => ({ key, label, secret, multiline }));
    expect(by.get('appstoreconnect').label).toBe('App Store Connect');
    expect(shape('appstoreconnect')).toEqual([
      { key: 'issuerId', label: 'Issuer ID', secret: false, multiline: false },
      { key: 'keyId', label: 'Key ID', secret: false, multiline: false },
      { key: 'privateKey', label: 'Private key (.p8)', secret: true, multiline: true },
    ]);
    expect(by.get('googleplay').label).toBe('Google Play');
    expect(shape('googleplay')).toEqual([
      { key: 'serviceAccountJson', label: 'Service account JSON', secret: true, multiline: true },
      { key: 'packageName', label: 'Package name', secret: false, multiline: false },
    ]);
    // And, like every service, they start refused.
    expect(by.get('appstoreconnect').allowed).toBe(false);
    expect(by.get('googleplay').allowed).toBe(false);
  });
});

describe('App Store Connect is connected with a key, checked before it is kept', () => {
  it('refuses it at the route until an administrator permits it', async () => {
    const res = await call('/api/connections/developer/appstoreconnect', { method: 'PUT', jar: jars.alice, body: APPLE_BODY });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('verifies the key with Apple, seals every part as one payload and returns none of it', async () => {
    await permit('appstoreconnect', 'everyone');
    serviceReply = { status: 200, body: { data: [{ id: '1', attributes: { name: 'Fixture App' } }] } };
    const res = await call('/api/connections/developer/appstoreconnect', { method: 'PUT', jar: jars.alice, body: APPLE_BODY });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, accountLabel: `Key ${KEY_ID}` });
    expect(seen).toEqual(['https://api.appstoreconnect.apple.com/v1/apps?limit=1']);

    const rows = await db.query<{ credentials_enc: string; account_label: string; status: string }>('select credentials_enc, account_label, status from developer_connections');
    expect(rows).toHaveLength(1);
    expect(isVaultCredentialReference(rows[0].credentials_enc)).toBe(true);
    expect(rows[0]).toMatchObject({ account_label: `Key ${KEY_ID}`, status: 'active' });
    // One Vault item holds the whole key; nothing sits in a column.
    expect(await db.query("select id from vault_items where service='developer.appstoreconnect'")).toHaveLength(1);

    const said = `${JSON.stringify(res.body)}${await everythingTheServerSays()}`;
    for (const secret of STORE_SECRETS) expect(said, secret).not.toContain(secret);
    const mine = (await call('/api/connections/developer', { jar: jars.alice })).body.services.find((s: any) => s.service === 'appstoreconnect');
    expect(mine.connection).toMatchObject({ accountLabel: `Key ${KEY_ID}`, status: 'active', lastCheckOk: true });
  });

  it('does not save a key Apple rejects, and says what to look at without quoting it', async () => {
    await permit('appstoreconnect', 'everyone');
    serviceReply = { status: 401, body: { errors: [{ code: 'NOT_AUTHORIZED' }] } };
    const res = await call('/api/connections/developer/appstoreconnect', { method: 'PUT', jar: jars.alice, body: APPLE_BODY });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rejected that key.*Issuer ID.*Key ID/);
    expect(await db.query('select id from developer_connections')).toHaveLength(0);
    expect(await db.query("select id from vault_items where service='developer.appstoreconnect'")).toHaveLength(0);
    for (const secret of STORE_SECRETS) expect(JSON.stringify(res.body), secret).not.toContain(secret);
  });

  it('refuses a key that cannot be read, or a missing part, before asking Apple anything', async () => {
    await permit('appstoreconnect', 'everyone');
    const bad = await call('/api/connections/developer/appstoreconnect', { method: 'PUT', jar: jars.alice, body: { ...APPLE_BODY, privateKey: 'not a key' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/could not be read/);
    const missing = await call('/api/connections/developer/appstoreconnect', { method: 'PUT', jar: jars.alice, body: { privateKey: P8, keyId: KEY_ID } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/Issuer ID is required/);
    // A token-shaped body is not a store key.
    const token = await call('/api/connections/developer/appstoreconnect', { method: 'PUT', jar: jars.alice, body: { token: TOKEN } });
    expect(token.status).toBe(400);
    expect(seen).toHaveLength(0);
    expect(await db.query('select id from developer_connections')).toHaveLength(0);
  });

  it('re-checks from the sealed key and is mine to remove', async () => {
    await permit('appstoreconnect', 'everyone');
    serviceReply = { status: 200, body: { data: [] } };
    expect((await call('/api/connections/developer/appstoreconnect', { method: 'PUT', jar: jars.alice, body: APPLE_BODY })).status).toBe(200);
    serviceReply = { status: 403, body: {} };
    const check = await call('/api/connections/developer/appstoreconnect/check', { method: 'POST', jar: jars.alice, body: {} });
    expect(check.body).toMatchObject({ ok: false, detail: expect.stringMatching(/role is not allowed/) });
    expect((await db.query<{ status: string }>('select status from developer_connections'))[0].status).toBe('needs_reconnect');
    expect((await call('/api/connections/developer/appstoreconnect', { method: 'DELETE', jar: jars.alice })).status).toBe(204);
    expect(await db.query("select id from vault_items where service='developer.appstoreconnect'")).toHaveLength(0);
  });
});

describe('Google Play is connected with a service account, checked before it is kept', () => {
  it('exchanges the key, reads the package\'s reviews, seals everything and returns none of it', async () => {
    await permit('googleplay', 'everyone');
    replyFor = googleHappy;
    const res = await call('/api/connections/developer/googleplay', { method: 'PUT', jar: jars.alice, body: GOOGLE_BODY });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, accountLabel: PACKAGE });
    expect(seen).toEqual([
      'https://oauth2.googleapis.com/token',
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/reviews?maxResults=1`,
    ]);
    const rows = await db.query<{ credentials_enc: string }>('select credentials_enc from developer_connections');
    expect(rows).toHaveLength(1);
    expect(isVaultCredentialReference(rows[0].credentials_enc)).toBe(true);
    expect(await db.query("select id from vault_items where service='developer.googleplay'")).toHaveLength(1);
    const said = `${JSON.stringify(res.body)}${await everythingTheServerSays()}`;
    for (const secret of STORE_SECRETS) expect(said, secret).not.toContain(secret);
  });

  it.each([
    ['a key Google rejects', (url: string) => (url.includes('oauth2') ? { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } : { status: 200, body: {} }), /private key does not match the account/],
    ['no access to that app', (url: string) => (url.includes('oauth2') ? { status: 200, body: { access_token: 'short-lived-access' } } : { status: 403, body: { error: { errors: [{ reason: 'permissionDenied' }] } } }), /has no access to com\.example\.app/],
    ['an unknown package', (url: string) => (url.includes('oauth2') ? { status: 200, body: { access_token: 'short-lived-access' } } : { status: 404, body: {} }), /no app called com\.example\.app/],
  ])('does not save %s, and says so plainly', async (_name, route, message) => {
    await permit('googleplay', 'everyone');
    replyFor = route;
    const res = await call('/api/connections/developer/googleplay', { method: 'PUT', jar: jars.alice, body: GOOGLE_BODY });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(await db.query('select id from developer_connections')).toHaveLength(0);
    expect(await db.query("select id from vault_items where service='developer.googleplay'")).toHaveLength(0);
    for (const secret of STORE_SECRETS) expect(JSON.stringify(res.body), secret).not.toContain(secret);
  });

  it('refuses a file that is not a service account before asking Google anything', async () => {
    await permit('googleplay', 'everyone');
    const res = await call('/api/connections/developer/googleplay', { method: 'PUT', jar: jars.alice, body: { ...GOOGLE_BODY, serviceAccountJson: '{"type":"authorized_user"}' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a service account key/);
    expect(seen).toHaveLength(0);
  });
});

describe('the original single-token body still works', () => {
  it('connects GitHub with only a token, and Jira with its extra fields', async () => {
    await permit('github', 'everyone');
    await permit('jira', 'everyone');
    const github = await call('/api/connections/developer/github', { method: 'PUT', jar: jars.alice, body: { token: TOKEN } });
    expect(github.status, JSON.stringify(github.body)).toBe(200);
    expect(github.body).toEqual({ ok: true, accountLabel: 'octocat' });
    serviceReply = { status: 200, body: { displayName: 'Jira Owner' } };
    const jira = await call('/api/connections/developer/jira', {
      method: 'PUT', jar: jars.alice, body: { token: TOKEN, email: 'owner@example.test', baseUrl: 'https://acme.atlassian.net' },
    });
    expect(jira.status, JSON.stringify(jira.body)).toBe(200);
    expect(jira.body.accountLabel).toBe('Jira Owner · acme.atlassian.net');
    const missing = await call('/api/connections/developer/github', { method: 'PUT', jar: jars.alice, body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('a personal access token is required');
  });
});
