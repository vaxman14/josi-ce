// Parental Controls over the wire.
//
// The claims this file attacks, one describe block each:
//
//   1. Nothing is present until somebody bought it. Every parental route is
//      404 on an unentitled installation — for a member, for a parent, for the
//      super admin — and the schedule enforces nothing.
//   2. Buying is an administrator's act and only an administrator's. An
//      unsigned, edited, expired or foreign licence is refused; a revoked one
//      makes the whole feature disappear again.
//   3. Changing who looks after whom costs a password AND a code, in one
//      request, spent once. No second factor enrolled means no relationship.
//   4. Authority is the relationship and nothing else. A stranger, another
//      parent, another child and the SUPER ADMIN all get 404 on a family's
//      conversations, schedule, limits and usage.
//   5. Child Mode. A managed account cannot look after anybody, is told exactly
//      what its guardian can see, and can see every time they looked.
//   6. The timetable and the limit are enforced by the server, on the route a
//      child would actually use, and changing either costs the password again.
//   7. The trail records the acts and never the words.
//   8. The administrator surface has no query into a family — asserted against
//      the source, not the comment.
//   9. (block 6b) The child's phone reads one rules object; topics and apps
//      cost the password again; a child can ask, only the linked parent can
//      answer, an approval really does reopen the day, and the notification
//      never carries the child's note.
//
// No suite here contacts a model provider: `llmFetch` is injected and no test
// needs a reply, only whether the door was open.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { generate as generateTotp } from 'otplib';
import { testDb, testVault, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { MasterKey } from '@josi-ce/core';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-parental-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 7).toString('base64'));

const publisher = generateKeyPairSync('ed25519');
const PUBLISHER_KEY = publisher.publicKey.export({ type: 'spki', format: 'der' })
  .subarray(12).toString('base64');

function license(claim: Record<string, unknown>, signWith = publisher.privateKey): string {
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const signature = sign(null, Buffer.from(`josi-lic.1.${payload}`, 'utf8'), signWith).toString('base64url');
  return `josi-lic.1.${payload}.${signature}`;
}

const GOOD_LICENSE = (over: Record<string, unknown> = {}) => license({
  v: 1,
  licenseId: 'JOSI-PC-0007',
  module: 'parental_controls',
  issuedTo: 'The Example Household',
  installId: null,
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  ...over,
});

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};
let parentTotpSecret = '';

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
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.getSetCookie?.() ?? [] };
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

/** Signs in, including through the second factor when the account has one. */
async function signIn(identifier: string, password: string, secret?: string): Promise<string> {
  const pre = await call('/api/auth/csrf');
  const jar = mergeJar(undefined, pre.setCookie);
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier, password }, jar });
  if (res.status === 202 && res.body?.mfaRequired) {
    const code = await generateTotp({ secret: secret ?? parentTotpSecret });
    const done = await call('/api/auth/mfa/verify-login', {
      method: 'POST', body: { challenge: res.body.challenge, code }, jar,
    });
    expect(done.status, `mfa ${identifier}`).toBe(200);
    return mergeJar(jar, done.setCookie);
  }
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.setCookie);
}

const PW = {
  admin: 'admin-password-123',
  parent: 'parent-password-123',
  stranger: 'stranger-password-123',
  child: 'child-password-1234',
  second: 'second-password-1234',
};

/** Turns the module on, as the super admin does. */
async function entitle(over: Record<string, unknown> = {}): Promise<Res> {
  return call('/api/admin/parental-controls/license', {
    method: 'POST', jar: cookies.admin, body: { license: GOOD_LICENSE(over) },
  });
}

async function revokeLicense(): Promise<void> {
  const res = await call('/api/admin/parental-controls/license', { method: 'DELETE', jar: cookies.admin });
  expect(res.status).toBe(200);
}

/** A password and a code in one request, which is what a relationship costs. */
async function proveAuthority(): Promise<Res> {
  const code = await generateTotp({ secret: parentTotpSecret });
  return call('/api/parental/authority', {
    method: 'POST', jar: cookies.parent, body: { password: PW.parent, code },
  });
}

/** The parent's password again, which is what a limit costs. */
async function confirmPassword(): Promise<void> {
  const res = await call('/api/assistant/step-up', {
    method: 'POST', jar: cookies.parent, body: { password: PW.parent },
  });
  expect(res.status).toBe(200);
}

async function createChild(username: string, email: string): Promise<Res> {
  expect((await proveAuthority()).status).toBe(200);
  return call('/api/parental/children', {
    method: 'POST', jar: cookies.parent, body: { username, email, displayName: username, timezone: 'UTC' },
  });
}

/** Redeems an invite link and returns the new account's cookie jar. */
async function claimAccount(inviteLink: string, password: string): Promise<string> {
  const token = new URL(inviteLink).searchParams.get('token');
  const pre = await call('/api/auth/csrf');
  const jar = mergeJar(undefined, pre.setCookie);
  const res = await call('/api/auth/set-password', { method: 'POST', body: { token, password }, jar });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return mergeJar(jar, res.setCookie);
}

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'pc-admin@ce.test', username: 'pcadmin', role: 'super_admin', password: PW.admin })).id;
  ids.parent = (await createUser(db, { email: 'pc-parent@ce.test', username: 'pcparent', role: 'member', password: PW.parent })).id;
  ids.stranger = (await createUser(db, { email: 'pc-stranger@ce.test', username: 'pcstranger', role: 'member', password: PW.stranger })).id;

  await testVault(db, new MasterKey(Buffer.alloc(32, 7)));
  const app = createApp(db, {
    cookieSecure: false,
    appUrl: 'http://localhost:3000',
    masterKeyCheck: { path: keyPath },
    entitlementPublicKey: PUBLISHER_KEY,
    llmFetch: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('pcadmin', PW.admin);
  cookies.parent = await signIn('pcparent', PW.parent);
  cookies.stranger = await signIn('pcstranger', PW.stranger);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

// ------------------------------------------------- 1. absent unless entitled

describe('an installation that has not bought it does not have it', () => {
  it('answers 404 on every parental route, for everybody', async () => {
    for (const who of ['parent', 'stranger', 'admin'] as const) {
      const overview = await call('/api/parental/overview', { jar: cookies[who] });
      expect(overview.status, who).toBe(404);
      expect(overview.body.error).toBe('no such endpoint');
    }
    // Not a 403 anywhere: an unentitled installation should be
    // indistinguishable from one where these routes were never written.
    const authority = await call('/api/parental/authority', {
      method: 'POST', jar: cookies.parent, body: { password: PW.parent, code: '000000' },
    });
    expect(authority.status).toBe(404);
  });

  it('answers 404 on the rules and the request routes too, for everybody', async () => {
    const someRequest = '00000000-0000-4000-8000-000000000001';
    for (const who of ['parent', 'stranger', 'admin'] as const) {
      const attempts: Array<[string, Res]> = [
        ['GET rules', await call('/api/parental/rules', { jar: cookies[who] })],
        ['GET requests', await call('/api/parental/requests', { jar: cookies[who] })],
        ['POST requests', await call('/api/parental/requests', {
          method: 'POST', jar: cookies[who], body: { kind: 'more_time', minutes: 15 },
        })],
        ['POST decide', await call(`/api/parental/requests/${someRequest}/decide`, {
          method: 'POST', jar: cookies[who], body: { decision: 'approve' },
        })],
      ];
      for (const [what, res] of attempts) {
        expect(res.status, `${who} ${what}`).toBe(404);
        expect(res.body.error, `${who} ${what}`).toBe('no such endpoint');
      }
    }
  });

  it('is signed out before it is anything else', async () => {
    expect((await call('/api/parental/overview')).status).toBe(401);
  });

  it('tells the administrator plainly that nothing is active', async () => {
    const res = await call('/api/admin/parental-controls', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('absent');
    expect(res.body.entitled).toBe(false);
    expect(res.body.canVerifyLicenses).toBe(true);
    // The honest paragraph is part of the response, not decoration on one page.
    expect(res.body.honesty.notDevice).toMatch(/not device controls/i);
  });

  it('keeps the licence screen away from members', async () => {
    expect((await call('/api/admin/parental-controls', { jar: cookies.parent })).status).toBe(403);
    expect((await call('/api/admin/parental-controls/license', {
      method: 'POST', jar: cookies.parent, body: { license: GOOD_LICENSE() },
    })).status).toBe(403);
  });
});

// ------------------------------------------------------------- 2. the licence

describe('the licence is what makes the module exist', () => {
  it('refuses one nobody signed, one that was edited, and one already expired', async () => {
    const impostor = generateKeyPairSync('ed25519').privateKey;
    const forged = await call('/api/admin/parental-controls/license', {
      method: 'POST', jar: cookies.admin,
      body: { license: license({ v: 1, licenseId: 'X', module: 'parental_controls', issuedTo: 'Me', issuedAt: '2026-01-01T00:00:00.000Z' }, impostor) },
    });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toMatch(/not signed by the publisher/i);

    expect((await call('/api/admin/parental-controls/license', {
      method: 'POST', jar: cookies.admin, body: { license: 'josi-lic.1.abc.def' },
    })).body.error).toMatch(/not signed|damaged/i);

    expect((await entitle({ expiresAt: '2020-01-01T00:00:00.000Z' })).body.error)
      .toMatch(/already expired/i);

    // Nothing was stored by any of the three.
    expect((await call('/api/admin/parental-controls', { jar: cookies.admin })).body.state).toBe('absent');
  });

  it('refuses one issued to a different installation', async () => {
    const res = await entitle({ installId: '11111111-1111-1111-1111-111111111111' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/different installation/i);
  });

  it('activates a real one, and the module appears', async () => {
    const res = await entitle();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'active', entitled: true, issuedTo: 'The Example Household' });
    expect((await call('/api/parental/overview', { jar: cookies.parent })).status).toBe(200);
  });

  it('disappears again when the licence is revoked', async () => {
    await revokeLicense();
    expect((await call('/api/parental/overview', { jar: cookies.parent })).status).toBe(404);
    const status = await call('/api/admin/parental-controls', { jar: cookies.admin });
    expect(status.body.state).toBe('revoked');
    // Revoking does not forget who bought it.
    expect(status.body.issuedTo).toBe('The Example Household');
    expect((await entitle()).status).toBe(200);
  });
});

// ------------------------------------------- 3. fresh authentication and 2FA

describe('changing who looks after whom costs a password and a code', () => {
  it('refuses to start at all until the adult has a second factor', async () => {
    const res = await call('/api/parental/authority', {
      method: 'POST', jar: cookies.parent, body: { password: PW.parent, code: '000000' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/two-factor/i);
    // And the relationship route is closed behind it, not merely the prompt.
    const attempted = await call('/api/parental/children', {
      method: 'POST', jar: cookies.parent, body: { username: 'nope', email: 'nope@ce.test' },
    });
    expect(attempted.status).toBe(401);
  });

  it('takes the adult through enrolling one', async () => {
    const setup = await call('/api/auth/mfa/setup', { method: 'POST', jar: cookies.parent });
    expect(setup.status).toBe(200);
    parentTotpSecret = setup.body.secret;
    const enabled = await call('/api/auth/mfa/enable', {
      method: 'POST', jar: cookies.parent, body: { code: await generateTotp({ secret: parentTotpSecret }) },
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.recoveryCodes).toHaveLength(10);
    expect((await call('/api/parental/overview', { jar: cookies.parent })).body.secondFactorReady).toBe(true);
  });

  it('refuses a wrong password and a wrong code with the same sentence', async () => {
    const wrongPassword = await call('/api/parental/authority', {
      method: 'POST', jar: cookies.parent,
      body: { password: 'not-the-password', code: await generateTotp({ secret: parentTotpSecret }) },
    });
    const wrongCode = await call('/api/parental/authority', {
      method: 'POST', jar: cookies.parent, body: { password: PW.parent, code: '000000' },
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongCode.status).toBe(401);
    // Which of the two was wrong is exactly what an attacker holding one of
    // them would like to learn.
    expect(wrongCode.body.error).toBe(wrongPassword.body.error);
  });

  it('records every stopped attempt', async () => {
    const rows = await db.query<{ payload: { stage: string } }>(
      `select payload from events where kind = 'parental.authority_failed' order by id`,
    );
    expect(rows.map((r) => r.payload.stage)).toContain('password');
    expect(rows.map((r) => r.payload.stage)).toContain('code');
  });

  it('grants against both together, and the grant is spent once', async () => {
    expect((await proveAuthority()).status).toBe(200);
    const first = await call('/api/parental/children', {
      method: 'POST', jar: cookies.parent,
      body: { username: 'kidone', email: 'kidone@ce.test', displayName: 'Kid One', timezone: 'UTC' },
    });
    expect(first.status).toBe(201);
    ids.child = first.body.child.childUserId;
    ids.childInvite = first.body.inviteLink;

    // The same grant again buys nothing.
    const replay = await call('/api/parental/children', {
      method: 'POST', jar: cookies.parent, body: { username: 'kidtwo', email: 'kidtwo@ce.test' },
    });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/password and a code/i);
  });

  it('will not spend one session’s grant from another session', async () => {
    expect((await proveAuthority()).status).toBe(200);
    // A second sign-in is a second session; the grant is bound to the one that
    // proved itself.
    const otherSession = await signIn('pcparent', PW.parent);
    const attempt = await call('/api/parental/children', {
      method: 'POST', jar: otherSession, body: { username: 'kidx', email: 'kidx@ce.test' },
    });
    expect(attempt.status).toBe(401);
  });

  it('refuses an expired grant', async () => {
    expect((await proveAuthority()).status).toBe(200);
    await db.query(`update parental_authority_grants set expires_at = now() - interval '1 minute' where used_at is null`);
    const attempt = await call('/api/parental/children', {
      method: 'POST', jar: cookies.parent, body: { username: 'kidy', email: 'kidy@ce.test' },
    });
    expect(attempt.status).toBe(401);
  });
});

// ------------------------------------------------------------- 4. authority

describe('authority is the relationship and nothing else', () => {
  beforeAll(async () => {
    // A second family, so "another parent" is a real person rather than a
    // hypothetical. The stranger enrols a factor of their own.
    const setup = await call('/api/auth/mfa/setup', { method: 'POST', jar: cookies.stranger });
    const secret = setup.body.secret;
    await call('/api/auth/mfa/enable', {
      method: 'POST', jar: cookies.stranger, body: { code: await generateTotp({ secret }) },
    });
    const proved = await call('/api/parental/authority', {
      method: 'POST', jar: cookies.stranger,
      body: { password: PW.stranger, code: await generateTotp({ secret }) },
    });
    expect(proved.status).toBe(200);
    const second = await call('/api/parental/children', {
      method: 'POST', jar: cookies.stranger,
      body: { username: 'kidtwo', email: 'kidtwo@ce.test', displayName: 'Kid Two', timezone: 'UTC' },
    });
    expect(second.status).toBe(201);
    ids.secondChild = second.body.child.childUserId;
    cookies.secondChild = await claimAccount(second.body.inviteLink, PW.second);
    cookies.child = await claimAccount(ids.childInvite, PW.child);

    // Something to be private about.
    const thread = await call('/api/assistant/threads', {
      method: 'POST', jar: cookies.child, body: { title: 'About my homework' },
    });
    ids.childThread = thread.body.thread.id;
    await db.query(
      `insert into messages (thread_id, direction, channel, body) values ($1,'in','web',$2)`,
      [ids.childThread, 'I am worried about the maths test on Friday.'],
    );
  });

  it('shows the parent their own child, and only their own', async () => {
    const overview = await call('/api/parental/overview', { jar: cookies.parent });
    expect(overview.body.role).toBe('parent');
    expect(overview.body.children.map((c: any) => c.childUserId)).toEqual([ids.child]);
  });

  it('lets the parent read the conversation', async () => {
    const list = await call(`/api/parental/children/${ids.child}/conversations`, { jar: cookies.parent });
    expect(list.status).toBe(200);
    expect(list.body.conversations[0]).toMatchObject({ id: ids.childThread, messages: 1 });
    const read = await call(
      `/api/parental/children/${ids.child}/conversations/${ids.childThread}`, { jar: cookies.parent },
    );
    expect(read.status).toBe(200);
    expect(read.body.messages[0].body).toMatch(/maths test/);
  });

  it('refuses everybody else, with 404 rather than 403', async () => {
    // A stranger, the other parent, the other child, the child themselves
    // (through the parental route), and the super admin.
    const outsiders: Array<[string, string]> = [
      ['stranger', cookies.stranger],
      ['secondChild', cookies.secondChild],
      ['child', cookies.child],
      ['admin', cookies.admin],
    ];
    for (const [who, jar] of outsiders) {
      for (const path of [
        `/api/parental/children/${ids.child}/conversations`,
        `/api/parental/children/${ids.child}/conversations/${ids.childThread}`,
        `/api/parental/children/${ids.child}/controls`,
        `/api/parental/children/${ids.child}/usage`,
      ]) {
        const res = await call(path, { jar });
        expect(res.status, `${who} ${path}`).toBe(404);
      }
      const write = await call(`/api/parental/children/${ids.child}/controls`, {
        method: 'PUT', jar, body: { dailyLimitMinutes: 600 },
      });
      expect(write.status, `${who} writes controls`).toBe(404);
      const end = await call(`/api/parental/children/${ids.child}`, { method: 'DELETE', jar });
      expect(end.status, `${who} ends the link`).toBe(404);
    }
  });

  it('does not let one parent name another parent’s child', async () => {
    const res = await call(`/api/parental/children/${ids.secondChild}/conversations`, { jar: cookies.parent });
    expect(res.status).toBe(404);
  });

  it('does not let a parent read a thread that is not their child’s', async () => {
    // The child id is theirs; the thread id is somebody else's. The route
    // re-resolves ownership rather than trusting the pair in the URL.
    const other = await call('/api/assistant/threads', {
      method: 'POST', jar: cookies.stranger, body: { title: 'Mine' },
    });
    const res = await call(
      `/api/parental/children/${ids.child}/conversations/${other.body.thread.id}`, { jar: cookies.parent },
    );
    expect(res.status).toBe(404);
  });

  it('gives the super admin no way in through their own surface either', async () => {
    const admin = await call('/api/admin/parental-controls', { jar: cookies.admin });
    const serialised = JSON.stringify(admin.body);
    expect(serialised).not.toContain(ids.child);
    expect(serialised).not.toContain('kidone');
    expect(serialised).not.toContain('maths test');
    // And the ordinary admin surfaces do not learn the relationship either.
    const users = await call('/api/admin/users', { jar: cookies.admin });
    expect(JSON.stringify(users.body)).not.toMatch(/parental|guardian|child_user_id/i);
  });
});

// ------------------------------------------------------------ 5. Child Mode

describe('a managed account is told the truth and holds no authority', () => {
  it('tells the child who can see what, and what they cannot see', async () => {
    const res = await call('/api/parental/overview', { jar: cookies.child });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('child');
    expect(res.body.child.guardian).toBe('pcparent');
    expect(res.body.child.canSee.join(' ')).toMatch(/read your conversations/i);
    expect(res.body.child.cannotSee.join(' ')).toMatch(/cannot see your password/i);
  });

  it('shows the child every time their guardian looked', async () => {
    const res = await call('/api/parental/overview', { jar: cookies.child });
    const kinds = res.body.child.activity.map((a: any) => a.kind);
    expect(kinds).toContain('parental.conversation_read');
    expect(kinds).toContain('parental.conversations_listed');
  });

  it('refuses to let a managed account look after anybody', async () => {
    const res = await call('/api/parental/children', {
      method: 'POST', jar: cookies.child, body: { username: 'kidthree', email: 'kid3@ce.test' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cannot look after/i);
    expect((await call('/api/parental/authority', {
      method: 'POST', jar: cookies.child, body: { password: PW.child, code: '000000' },
    })).status).toBe(403);
  });

  it('does not let a child change their own limits', async () => {
    const res = await call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: cookies.child, body: { dailyLimitMinutes: 1440 },
    });
    expect(res.status).toBe(404);
  });

  it('leaves the child an ordinary member everywhere else', async () => {
    // Child Mode is a limit on time and a disclosure about visibility. It is
    // not a demotion: their own conversations are still theirs.
    const own = await call('/api/assistant/threads', { jar: cookies.child });
    expect(own.status).toBe(200);
    expect(own.body.threads.map((t: any) => t.id)).toContain(ids.childThread);
    expect((await call('/api/admin/users', { jar: cookies.child })).status).toBe(403);
  });
});

// ------------------------------------------------- 6. the timetable and limit

describe('the hours and the limit are enforced by the server', () => {
  it('asks for the password again before a limit changes', async () => {
    const first = await call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: cookies.parent, body: { dailyLimitMinutes: 45 },
    });
    expect(first.status).toBe(401);
    expect(first.body.error).toMatch(/password/i);
    await confirmPassword();
    const second = await call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: cookies.parent, body: { dailyLimitMinutes: 45 },
    });
    expect(second.status).toBe(200);
    expect(second.body.controls.dailyLimitMinutes).toBe(45);
  });

  it('refuses a timetable that cannot mean anything', async () => {
    const res = await call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: cookies.parent,
      body: { scheduleEnabled: true, windows: [{ weekday: 1, startMinute: 1200, endMinute: 60 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/one window on each day/);
  });

  it('closes the door outside the agreed hours, on the route a child uses', async () => {
    // A timetable with one window, on a day that is not today, closes today.
    const today = new Date().getUTCDay();
    const elsewhere = (today + 3) % 7;
    const saved = await call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: cookies.parent,
      body: {
        timezone: 'UTC', scheduleEnabled: true,
        windows: [{ weekday: elsewhere, startMinute: 9 * 60, endMinute: 10 * 60 }],
      },
    });
    expect(saved.status).toBe(200);

    const blocked = await call(`/api/assistant/threads/${ids.childThread}/talk`, {
      method: 'POST', jar: cookies.child, body: { message: 'are you there?' },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/agreed hours/i);
    expect(blocked.body.error).toMatch(/back at \d\d:\d\d/);

    // The adult is not caught by their child's timetable.
    const parentThread = await call('/api/assistant/threads', {
      method: 'POST', jar: cookies.parent, body: { title: 'Mine' },
    });
    const parentTalk = await call(`/api/assistant/threads/${parentThread.body.thread.id}/talk`, {
      method: 'POST', jar: cookies.parent, body: { message: 'hello' },
    });
    expect(parentTalk.status).not.toBe(403);
  });

  it('opens again inside them', async () => {
    const saved = await call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: cookies.parent,
      body: {
        timezone: 'UTC', scheduleEnabled: true,
        windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
      },
    });
    expect(saved.status).toBe(200);
    const allowed = await call(`/api/assistant/threads/${ids.childThread}/talk`, {
      method: 'POST', jar: cookies.child, body: { message: 'are you there?' },
    });
    // No model is configured in this suite, so the honest answer is a refusal
    // about the model — which is exactly the proof that the door was open.
    expect(allowed.status).toBe(503);
    expect(allowed.body.refusal.reason).toBe('no_model');
  });

  it('counts the minute that was spent', async () => {
    const [row] = await db.query<{ n: string }>(
      `select count(*) as n from child_activity_minutes where child_user_id = $1`, [ids.child],
    );
    expect(Number(row.n)).toBeGreaterThan(0);
  });

  it('stops at the daily limit and says so', async () => {
    await confirmPassword();
    const saved = await call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: cookies.parent, body: { dailyLimitMinutes: 5 },
    });
    expect(saved.status).toBe(200);
    // Five minutes, already spent.
    for (let i = 0; i < 5; i += 1) {
      await db.query(
        `insert into child_activity_minutes (child_user_id, minute, channel)
         values ($1, date_trunc('minute', now()) - make_interval(mins => $2), 'web')
         on conflict do nothing`,
        [ids.child, i + 1],
      );
    }
    const blocked = await call(`/api/assistant/threads/${ids.childThread}/talk`, {
      method: 'POST', jar: cookies.child, body: { message: 'one more thing' },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/used today/i);

    // The child's own page says the same thing rather than leaving them to
    // guess why Josi went quiet.
    const overview = await call('/api/parental/overview', { jar: cookies.child });
    expect(overview.body.child.access.allowed).toBe(false);
    expect(overview.body.child.access.reason).toBe('daily_limit');
  });

  it('shows the parent counts and days rather than a transcript', async () => {
    const res = await call(`/api/parental/children/${ids.child}/usage?days=7`, { jar: cookies.parent });
    expect(res.status).toBe(200);
    expect(res.body.usage.totalMinutes).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/maths test/);
    expect(res.body.honesty.minutes).toMatch(/reading a reply is not counted/i);
  });

  it('stops enforcing anything the moment the licence goes', async () => {
    await revokeLicense();
    const allowed = await call(`/api/assistant/threads/${ids.childThread}/talk`, {
      method: 'POST', jar: cookies.child, body: { message: 'hello?' },
    });
    // Inert means inert in both directions: no visibility for the adult, and
    // no rule against the child that nobody may see or change.
    expect(allowed.status).toBe(503);
    expect((await call('/api/parental/overview', { jar: cookies.child })).status).toBe(404);
    expect((await entitle()).status).toBe(200);
  });
});

// ------------------------------------- 6b. rules for the phone, and asking

describe('the phone reads its rules, and a child can ask', () => {
  const NOTE = 'please please, the zebra documentary is not finished';
  const TOPICS = ['gambling', 'horror films'];
  const APPS = ['com.example.game', 'com.example.video-app'];

  const pushesFor = (userId: string) => db.query<{
    event_key: string; category: string; route_type: string; route_id: string; title: string; body: string;
  }>(
    `select event_key, category, route_type, route_id, title, body
     from push_deliveries where owner_user_id = $1 order by created_at, event_key`,
    [userId],
  );

  beforeAll(async () => {
    // One phone each, so there is a device for a notification to be queued to.
    for (const who of ['parent', 'child', 'stranger', 'admin'] as const) {
      await db.query(
        `insert into mobile_devices (owner_user_id, device_identity, platform, expo_token_enc, token_fingerprint)
         values ($1, $2, 'ios', 'not-a-real-token', $3)`,
        [ids[who], `phone-${who}`, `fingerprint-${who}`],
      );
    }
  });

  it('tells somebody who is not a managed child exactly that, and nothing else', async () => {
    for (const who of ['parent', 'stranger', 'admin'] as const) {
      const res = await call('/api/parental/rules', { jar: cookies[who] });
      expect(res.status, who).toBe(200);
      expect(res.body, who).toEqual({ version: 1, managed: false });
    }
    expect((await call('/api/parental/rules')).status).toBe(401);
  });

  it('gives the child one versioned object, in the shape the phone caches', async () => {
    const res = await call('/api/parental/rules', { jar: cookies.child });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'access', 'blocked_apps', 'blocked_topics', 'daily_limit_minutes', 'extra_minutes_today',
      'guardian', 'managed', 'minutes_used_today', 'schedule_enabled', 'timezone', 'updated_at',
      'version', 'windows',
    ]);
    expect(res.body).toMatchObject({
      version: 1, managed: true, guardian: { name: 'pcparent' }, timezone: 'UTC',
      daily_limit_minutes: 5, extra_minutes_today: 0, schedule_enabled: true,
      blocked_topics: [], blocked_apps: [],
      // Section 6 left this child over the limit, and the rules say so.
      access: { allowed: false, reason: 'daily_limit', opens_again: null },
    });
    expect(res.body.minutes_used_today).toBeGreaterThanOrEqual(5);
    expect(res.body.windows).toHaveLength(7);
    expect(res.body.windows[0]).toEqual({ weekday: 0, start_minute: 0, end_minute: 1440 });
    expect(typeof res.body.updated_at).toBe('string');
  });

  it('asks for the password again before topics or apps change', async () => {
    // A fresh sign-in is a session that has not confirmed anything.
    const fresh = await signIn('pcparent', PW.parent);
    const refused = await call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: fresh, body: { blocked_topics: TOPICS, blocked_apps: APPS },
    });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toMatch(/password/i);
    const before = await call(`/api/parental/children/${ids.child}/controls`, { jar: fresh });
    expect(before.body.controls.blockedTopics).toEqual([]);

    expect((await call('/api/assistant/step-up', {
      method: 'POST', jar: fresh, body: { password: PW.parent },
    })).status).toBe(200);
    const saved = await call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: fresh, body: { blocked_topics: TOPICS, blocked_apps: APPS },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.controls.blockedTopics).toEqual(TOPICS);
    expect(saved.body.controls.blockedApps).toEqual(APPS);
    // Nothing else moved.
    expect(saved.body.controls.dailyLimitMinutes).toBe(5);
    expect(saved.body.controls.windows).toHaveLength(7);

    const read = await call(`/api/parental/children/${ids.child}/controls`, { jar: cookies.parent });
    expect(read.body.controls.blockedTopics).toEqual(TOPICS);
    expect(read.body.honesty.topics).toMatch(/not a filter/i);
    expect(read.body.honesty.apps).toMatch(/blocks no app/i);

    const rules = await call('/api/parental/rules', { jar: cookies.child });
    expect(rules.body.blocked_topics).toEqual(TOPICS);
    expect(rules.body.blocked_apps).toEqual(APPS);
  });

  it('does not let the child, another parent or the super admin change them', async () => {
    for (const who of ['child', 'stranger', 'admin', 'secondChild'] as const) {
      const res = await call(`/api/parental/children/${ids.child}/controls`, {
        method: 'PUT', jar: cookies[who], body: { blocked_topics: [], blocked_apps: [] },
      });
      expect(res.status, who).toBe(404);
    }
    const rules = await call('/api/parental/rules', { jar: cookies.child });
    expect(rules.body.blocked_topics).toEqual(TOPICS);
  });

  it('refuses lists that are too long or are not what they claim to be', async () => {
    await confirmPassword();
    const put = (body: unknown) => call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: cookies.parent, body,
    });
    expect((await put({ blocked_topics: Array.from({ length: 21 }, (_, i) => `topic ${i}`) })).status).toBe(400);
    expect((await put({ blocked_topics: ['x'.repeat(61)] })).status).toBe(400);
    expect((await put({ blocked_topics: ['   '] })).status).toBe(400);
    expect((await put({ blocked_topics: 'gambling' })).status).toBe(400);
    expect((await put({ blocked_apps: ['not a bundle id'] })).status).toBe(400);
    expect((await put({ blocked_apps: ['nodots'] })).status).toBe(400);
    expect((await put({ blocked_apps: Array.from({ length: 101 }, (_, i) => `com.example.app${i}`) })).status).toBe(400);
    const rules = await call('/api/parental/rules', { jar: cookies.child });
    expect(rules.body.blocked_topics).toEqual(TOPICS);
    expect(rules.body.blocked_apps).toEqual(APPS);
  });

  it('lets a child ask for more time, once, and tells the parent’s phone without the note', async () => {
    // Nobody to ask, for somebody who is not a managed child.
    for (const who of ['parent', 'stranger', 'admin'] as const) {
      const res = await call('/api/parental/requests', {
        method: 'POST', jar: cookies[who], body: { kind: 'more_time', minutes: 30 },
      });
      expect(res.status, who).toBe(404);
    }
    const ask = (body: unknown) => call('/api/parental/requests', { method: 'POST', jar: cookies.child, body });
    expect((await ask({ kind: 'bedtime' })).status).toBe(400);
    expect((await ask({ kind: 'more_time', minutes: 3 })).status).toBe(400);
    expect((await ask({ kind: 'more_time', minutes: 241 })).status).toBe(400);
    expect((await ask({ kind: 'access', minutes: 30 })).status).toBe(400);
    expect((await ask({ kind: 'access', note: 'n'.repeat(301) })).status).toBe(400);

    const filed = await ask({ kind: 'more_time', minutes: 30, note: NOTE });
    expect(filed.status).toBe(201);
    expect(filed.body.request).toMatchObject({
      kind: 'more_time', status: 'open', minutes: 30, note: NOTE, minutesGranted: null, decidedAt: null,
    });
    ids.timeRequest = filed.body.request.id;

    // The same question again is the same question.
    const again = await ask({ kind: 'more_time', minutes: 60 });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already asked/i);

    // A different kind is a different question.
    const access = await ask({ kind: 'access', note: NOTE });
    expect(access.status).toBe(201);
    ids.accessRequest = access.body.request.id;

    const pushes = await pushesFor(ids.parent);
    expect(pushes).toHaveLength(2);
    const time = pushes.find((p) => p.route_id === ids.timeRequest)!;
    expect(time).toMatchObject({
      event_key: `family:${ids.timeRequest}:open`, category: 'family', route_type: 'family',
      title: 'Josi', body: 'Kid One is asking for more time.',
    });
    expect(pushes.find((p) => p.route_id === ids.accessRequest)!.body).toBe('Kid One is asking for access.');
    expect(JSON.stringify(pushes)).not.toContain('zebra');
    // Nobody else's phone heard about it.
    for (const who of ['child', 'stranger', 'admin'] as const) {
      expect(await pushesFor(ids[who]), who).toHaveLength(0);
    }
    // Asking changed nothing.
    expect((await call('/api/parental/rules', { jar: cookies.child })).body.access.allowed).toBe(false);
  });

  it('shows the request to the child and to the linked parent, and to nobody else', async () => {
    const own = await call('/api/parental/requests', { jar: cookies.child });
    expect(own.status).toBe(200);
    expect(own.body.role).toBe('child');
    expect(own.body.requests.map((r: any) => r.id).sort()).toEqual([ids.timeRequest, ids.accessRequest].sort());
    expect(own.body.requests[0].child).toBeUndefined();

    const parent = await call('/api/parental/requests', { jar: cookies.parent });
    expect(parent.body.role).toBe('parent');
    expect(parent.body.requests).toHaveLength(2);
    const seen = parent.body.requests.find((r: any) => r.id === ids.timeRequest);
    expect(seen).toMatchObject({
      kind: 'more_time', status: 'open', minutes: 30, note: NOTE,
      child: { childUserId: ids.child, name: 'Kid One' },
    });

    // Another parent sees their own family's list, which is empty.
    const other = await call('/api/parental/requests', { jar: cookies.stranger });
    expect(other.body).toEqual({ role: 'parent', requests: [] });
    // The other child sees their own, which is empty.
    expect((await call('/api/parental/requests', { jar: cookies.secondChild })).body)
      .toEqual({ role: 'child', requests: [] });
    // And the super admin is nobody here.
    const admin = await call('/api/parental/requests', { jar: cookies.admin });
    expect(admin.body).toEqual({ role: 'none', requests: [] });
  });

  it('lets only the linked parent answer, with 404 for everybody else', async () => {
    for (const who of ['stranger', 'admin', 'child', 'secondChild'] as const) {
      for (const decision of ['approve', 'deny']) {
        const res = await call(`/api/parental/requests/${ids.timeRequest}/decide`, {
          method: 'POST', jar: cookies[who], body: { decision, minutes: 60 },
        });
        expect(res.status, `${who} ${decision}`).toBe(404);
      }
    }
    // A request that does not exist is the same answer as one that is not yours.
    const missing = await call('/api/parental/requests/00000000-0000-4000-8000-000000000009/decide', {
      method: 'POST', jar: cookies.parent, body: { decision: 'approve' },
    });
    expect(missing.status).toBe(404);
    expect((await call('/api/parental/requests/not-an-id/decide', {
      method: 'POST', jar: cookies.parent, body: { decision: 'approve' },
    })).status).toBe(404);

    // Nothing was decided and nothing was granted by any of that.
    const own = await call('/api/parental/requests', { jar: cookies.child });
    expect(own.body.requests.every((r: any) => r.status === 'open')).toBe(true);
    expect((await call('/api/parental/rules', { jar: cookies.child })).body.extra_minutes_today).toBe(0);
    expect(await pushesFor(ids.child)).toHaveLength(0);
  });

  it('reopens the day when the parent approves more time', async () => {
    // Over the limit, and refused, before.
    const before = await call(`/api/assistant/threads/${ids.childThread}/talk`, {
      method: 'POST', jar: cookies.child, body: { message: 'still there?' },
    });
    expect(before.status).toBe(403);
    expect(before.body.error).toMatch(/used today/i);

    expect((await call(`/api/parental/requests/${ids.timeRequest}/decide`, {
      method: 'POST', jar: cookies.parent, body: { decision: 'maybe' },
    })).status).toBe(400);
    expect((await call(`/api/parental/requests/${ids.timeRequest}/decide`, {
      method: 'POST', jar: cookies.parent, body: { decision: 'approve', minutes: 500 },
    })).status).toBe(400);

    // A plain signed-in session: a new sign-in that has confirmed no password.
    const fresh = await signIn('pcparent', PW.parent);
    const decided = await call(`/api/parental/requests/${ids.timeRequest}/decide`, {
      method: 'POST', jar: fresh, body: { decision: 'approve', minutes: 20 },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.request).toMatchObject({ id: ids.timeRequest, status: 'approved', minutes: 30, minutesGranted: 20 });
    expect(decided.body.extraMinutesToday).toBe(20);

    // Answered once.
    const twice = await call(`/api/parental/requests/${ids.timeRequest}/decide`, {
      method: 'POST', jar: cookies.parent, body: { decision: 'approve', minutes: 20 },
    });
    expect(twice.status).toBe(409);

    const rules = await call('/api/parental/rules', { jar: cookies.child });
    expect(rules.body).toMatchObject({
      daily_limit_minutes: 5, extra_minutes_today: 20, access: { allowed: true, reason: 'allowed' },
    });

    // The door is open: no model is configured, so the refusal is about that.
    const after = await call(`/api/assistant/threads/${ids.childThread}/talk`, {
      method: 'POST', jar: cookies.child, body: { message: 'thank you' },
    });
    expect(after.status).toBe(503);
    expect(after.body.refusal.reason).toBe('no_model');

    // The standing rules did not move.
    const controls = await call(`/api/parental/children/${ids.child}/controls`, { jar: cookies.parent });
    expect(controls.body.controls.dailyLimitMinutes).toBe(5);
  });

  it('tells the child’s phone the answer, again without the note', async () => {
    const pushes = await pushesFor(ids.child);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      event_key: `family:${ids.timeRequest}:approved`, category: 'family', route_type: 'family',
      route_id: ids.timeRequest, title: 'Josi', body: 'Your parent said yes: 20 more minutes today.',
    });

    const denied = await call(`/api/parental/requests/${ids.accessRequest}/decide`, {
      method: 'POST', jar: cookies.parent, body: { decision: 'deny' },
    });
    expect(denied.status).toBe(200);
    expect(denied.body.request).toMatchObject({ status: 'denied', minutesGranted: null });
    // Denying, and an `access` answer, grant no time.
    expect(denied.body.extraMinutesToday).toBe(20);

    const all = await pushesFor(ids.child);
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.event_key)).toContain(`family:${ids.accessRequest}:denied`);
    expect(JSON.stringify(all)).not.toContain('zebra');
    expect(JSON.stringify(await pushesFor(ids.parent))).not.toContain('zebra');
  });

  it('does not let extra minutes open a closed timetable', async () => {
    const elsewhere = (new Date().getUTCDay() + 3) % 7;
    await confirmPassword();
    const saved = await call(`/api/parental/children/${ids.child}/controls`, {
      method: 'PUT', jar: cookies.parent,
      body: { windows: [{ weekday: elsewhere, startMinute: 9 * 60, endMinute: 10 * 60 }] },
    });
    expect(saved.status).toBe(200);
    const rules = await call('/api/parental/rules', { jar: cookies.child });
    expect(rules.body.extra_minutes_today).toBe(20);
    expect(rules.body.access).toMatchObject({ allowed: false, reason: 'outside_schedule' });
    expect(rules.body.access.opens_again).toMatch(/^09:00 /);
    const blocked = await call(`/api/assistant/threads/${ids.childThread}/talk`, {
      method: 'POST', jar: cookies.child, body: { message: 'but I have extra time' },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/agreed hours/i);
  });

  it('caps what one day can be given, and how often a child can ask', async () => {
    const ask = () => call('/api/parental/requests', {
      method: 'POST', jar: cookies.child, body: { kind: 'more_time', minutes: 240 },
    });
    const approve = (id: string) => call(`/api/parental/requests/${id}/decide`, {
      method: 'POST', jar: cookies.parent, body: { decision: 'approve' },
    });
    // 20 already given today; a 240-minute approval tops the day up to 240.
    const first = await ask();
    expect(first.status).toBe(201);
    const topped = await approve(first.body.request.id);
    expect(topped.status).toBe(200);
    expect(topped.body.request.minutesGranted).toBe(220);
    expect(topped.body.extraMinutesToday).toBe(240);

    // After that an approval is refused, and the request stays open to deny.
    const second = await ask();
    expect(second.status).toBe(201);
    const full = await approve(second.body.request.id);
    expect(full.status).toBe(409);
    expect(full.body.error).toMatch(/daily limit/i);
    expect((await call(`/api/parental/requests/${second.body.request.id}/decide`, {
      method: 'POST', jar: cookies.parent, body: { decision: 'deny' },
    })).status).toBe(200);

    // Four asked so far this hour; six is the allowance.
    for (let i = 0; i < 2; i += 1) {
      const more = await ask();
      expect(more.status, `request ${i + 5}`).toBe(201);
      await call(`/api/parental/requests/${more.body.request.id}/decide`, {
        method: 'POST', jar: cookies.parent, body: { decision: 'deny' },
      });
    }
    const tooMany = await ask();
    expect(tooMany.status).toBe(429);
  });
});

// --------------------------------------------------------------- 7. the trail

describe('the trail records the acts and never the words', () => {
  it('has an entry for every security-sensitive step', async () => {
    const rows = await db.query<{ kind: string }>(`select distinct kind from events where kind like 'parental.%' or kind like 'entitlement.%'`);
    const kinds = rows.map((r) => r.kind);
    for (const kind of [
      'entitlement.activated', 'entitlement.revoked', 'entitlement.refused',
      'parental.authority_granted', 'parental.authority_failed',
      'parental.link_created', 'parental.controls_updated',
      'parental.conversations_listed', 'parental.conversation_read', 'parental.usage_viewed',
      'parental.request_filed', 'parental.request_decided',
    ]) {
      expect(kinds, kind).toContain(kind);
    }
  });

  it('carries no conversation, no schedule value and no secret', async () => {
    const rows = await db.query<{ payload: unknown }>(
      `select payload from events where kind like 'parental.%' or kind like 'entitlement.%'`,
    );
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toMatch(/maths test/);
    // Not the child's note, not a blocked topic and not a blocked app either.
    expect(serialised).not.toContain('zebra');
    expect(serialised).not.toContain('gambling');
    expect(serialised).not.toContain('com.example.game');
    expect(serialised).not.toContain('josi-lic');
    expect(serialised).not.toContain(parentTotpSecret);
    expect(serialised).not.toContain(PW.parent);
  });

  it('lets the administrator read the trail without learning the family', async () => {
    const res = await call('/api/admin/events?kind=parental&limit=200', { jar: cookies.admin });
    expect(res.status).toBe(200);
    // The trail is metadata: kinds and ids. That is the same bargain every
    // other feature in CE makes with the audit log, and it is why an
    // administrator can answer "was something changed" without reading a word.
    expect(JSON.stringify(res.body)).not.toMatch(/maths test/);
  });
});

// ------------------------------------------- 8. the administrator has no path

describe('the administrator surface cannot grow one', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/http/parentalRoutes.ts'), 'utf8');
  const adminHalf = source.slice(source.indexOf('export function adminParentalRoutes'));

  it('queries no table that holds a family', () => {
    for (const table of [
      'parental_links', 'child_controls', 'child_schedule_windows',
      'child_activity_minutes', 'threads', 'messages',
      'family_requests', 'child_extra_minutes', 'push_deliveries',
    ]) {
      expect(adminHalf, `the admin router reads ${table}`).not.toContain(table);
    }
  });

  it('reaches no function that resolves parental authority', () => {
    for (const fn of [
      'parentalAuthority', 'controllerOf', 'childrenOf', 'getControls', 'usageSummary', 'listMessages',
      'listFamilyRequestsForParent', 'listOwnFamilyRequests', 'decideFamilyRequest', 'fileFamilyRequest',
      'extraMinutesToday',
    ]) {
      expect(adminHalf, `the admin router calls ${fn}`).not.toContain(`${fn}(`);
    }
  });
});
