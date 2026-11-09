import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { suspendAccount, unsuspendAccount } from '../src/accounts.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { unseal } from '../src/crypto.js';
import { RESERVED, validHandle } from '../src/handle.js';
import { splitStatements } from '../src/migrate.js';
import { Harness, testEnv } from './helpers.js';

let h: Harness;
beforeAll(async () => { h = await new Harness().start(); });
afterAll(() => h.stop());

const totpAt = (h: Harness, secret: string) => generate({ secret, epoch: Math.floor(h.ctx.now() / 1000) });

async function turnOn2fa(account: Awaited<ReturnType<Harness['account']>>) {
  const begin = await account.browser.post('/api/2fa/begin', { password: account.password });
  const secret = begin.body.secret as string;
  const enable = await account.browser.post('/api/2fa/enable', { code: await totpAt(h, secret) });
  expect(enable.status).toBe(200);
  return { secret, recoveryCodes: enable.body.recoveryCodes as string[] };
}

describe('handles', () => {
  it('reserves exactly what the relay reserves', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../services/relay/src/index.js', import.meta.url)), 'utf8');
    const list = /RESERVED = new Set\(\[([^\]]+)\]\)/.exec(source)![1]!;
    expect([...RESERVED].sort()).toEqual([...list.matchAll(/"([^"]+)"/g)].map(match => match[1]!).sort());
  });

  it('follows the relay name rules', () => {
    expect(validHandle('alice')).toBe(true);
    expect(validHandle('a-b-c')).toBe(true);
    for (const bad of ['ab', 'Alice', '1alice', 'alice-', 'al--ice', 'admin', 'a'.repeat(34)]) expect(validHandle(bad)).toBe(false);
  });

  it('refuses a reserved or taken name at signup', async () => {
    const browser = h.browser();
    expect((await browser.post('/api/signup', { email: 'r@example.test', password: 'a long enough password', handle: 'support' })).status).toBe(400);
    const first = await h.account();
    const taken = await browser.post('/api/signup', { email: 'other@example.test', password: 'a long enough password', handle: first.handle });
    expect(taken.status).toBe(409);
  });
});

describe('signing up', () => {
  it('needs a 12 character password', async () => {
    const res = await h.browser().post('/api/signup', { email: 'short@example.test', password: 'elevenchars', handle: h.id('short') });
    expect(res.status).toBe(400);
  });

  it('answers the same for an email that already has an account', async () => {
    const existing = await h.account();
    const res = await h.browser().post('/api/signup', { email: existing.email, password: 'a long enough password', handle: h.id('again') });
    expect(res.status).toBe(202);
    expect(h.mail.at(-1)!.subject).toBe('You already have a Hey Josi account');
    const [count] = await h.db.query<{ n: number }>('select count(*)::int as n from heyjosi.accounts where email = $1', [existing.email]);
    expect(count!.n).toBe(1);
  });

  it('keeps people out until the email is confirmed', async () => {
    const browser = h.browser(), handle = h.id('unverified'), email = `${handle}@example.test`;
    await browser.post('/api/signup', { email, password: 'a long enough password', handle });
    const refused = await browser.post('/api/login', { email, password: 'a long enough password' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('unverified');
    const token = h.lastToken(email);
    expect((await browser.post('/api/verify-email', { token })).status).toBe(200);
    expect((await browser.post('/api/verify-email', { token })).status).toBe(400);
    expect((await browser.post('/api/login', { email, password: 'a long enough password' })).status).toBe(200);
  });

  it('stores tokens and passwords only as hashes', async () => {
    const account = await h.account();
    const token = account.browser.jar.get('__Host-hj_session')!;
    const dump = await h.dump();
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(account.password);
    expect(dump).toContain('$argon2id$');
  });
});

describe('sessions and CSRF', () => {
  it('sets the cookie HttpOnly, Secure and SameSite=Lax', async () => {
    const account = await h.account();
    const res = await account.browser.post('/api/login', { email: account.email, password: account.password });
    const cookie = res.headers.getSetCookie().find(line => line.startsWith('__Host-hj_session='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/);
  });

  it('refuses a change without the token or from another origin', async () => {
    const account = await h.account();
    expect((await account.browser.post('/api/link-code', {}, { csrf: null })).status).toBe(403);
    expect((await account.browser.post('/api/link-code', {}, { csrf: 'nope' })).status).toBe(403);
    expect((await account.browser.post('/api/link-code', {}, { origin: 'https://alice.heyjosi.test' })).status).toBe(403);
    expect((await account.browser.post('/api/link-code', {}, { origin: null })).status).toBe(403);
    expect((await account.browser.post('/api/link-code', {})).status).toBe(200);
  });

  it('binds the token to the session', async () => {
    const one = await h.account(), two = await h.account();
    expect((await one.browser.post('/api/link-code', {}, { csrf: await two.browser.csrf() })).status).toBe(403);
  });

  it('gets the page headers right', async () => {
    const page = await h.browser().get('/login');
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('strict-transport-security')).toBeTruthy();
    expect(page.headers.get('x-powered-by')).toBeNull();
  });

  it('sends a signed-out visitor from /account to /login', async () => {
    const res = await h.browser().get('/account');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('login limits', () => {
  it('stops a run of wrong passwords on one email, right password included', async () => {
    const account = await h.account(), browser = h.browser();
    let last = 0;
    for (let i = 0; i < 9; i++) { browser.ip = h.id('ip'); last = (await browser.post('/api/login', { email: account.email, password: 'wrong password here' })).status; }
    expect(last).toBe(429);
    browser.ip = h.id('ip');
    expect((await browser.post('/api/login', { email: account.email, password: account.password })).status).toBe(429);
    h.advance(16 * 60_000);
    browser.ip = h.id('ip');
    expect((await browser.post('/api/login', { email: account.email, password: account.password })).status).toBe(200);
  });

  it('stops one address spraying many emails', async () => {
    const browser = h.browser();
    let last = 0;
    for (let i = 0; i < 26; i++) last = (await browser.post('/api/login', { email: `${h.id('spray')}@example.test`, password: 'wrong password here' })).status;
    expect(last).toBe(429);
  });

  it('gives the same answer for a wrong password and no such account', async () => {
    const account = await h.account();
    const wrong = await h.browser().post('/api/login', { email: account.email, password: 'not the password!' });
    const missing = await h.browser().post('/api/login', { email: `${h.id('none')}@example.test`, password: 'not the password!' });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body).toEqual(missing.body);
  });
});

describe('password reset', () => {
  it('works once, ends every session, and says nothing about unknown emails', async () => {
    const account = await h.account();
    expect((await h.browser().post('/api/forgot', { email: `${h.id('none')}@example.test` })).status).toBe(202);
    const browser = h.browser();
    expect((await browser.post('/api/forgot', { email: account.email })).status).toBe(202);
    const token = h.lastToken(account.email);
    expect((await browser.post('/api/reset', { token, password: 'a brand new password' })).status).toBe(200);
    expect((await browser.post('/api/reset', { token, password: 'another new password' })).status).toBe(400);
    expect((await account.browser.get('/api/account')).status).toBe(401);
    expect((await browser.post('/api/login', { email: account.email, password: account.password })).status).toBe(401);
    expect((await browser.post('/api/login', { email: account.email, password: 'a brand new password' })).status).toBe(200);
  });

  it('expires after an hour', async () => {
    const account = await h.account();
    await h.browser().post('/api/forgot', { email: account.email });
    const token = h.lastToken(account.email);
    h.advance(61 * 60_000);
    expect((await h.browser().post('/api/reset', { token, password: 'a brand new password' })).status).toBe(400);
  });
});

describe('two-step sign-in', () => {
  it('seals the secret under ACCOUNT_DATA_KEY', async () => {
    const account = await h.account();
    const { secret } = await turnOn2fa(account);
    const [row] = await h.db.query<{ secret_sealed: string }>('select secret_sealed from heyjosi.totp_secrets where account_id = $1', [account.id]);
    expect(row!.secret_sealed).not.toContain(secret);
    expect(unseal(h.config.accountDataKey, row!.secret_sealed, `totp:${account.id}`)).toBe(secret);
    expect(() => unseal(h.config.accountDataKey, row!.secret_sealed, 'totp:someone-else')).toThrow();
  });

  it('asks for a code after the password, and a pending login reaches nothing', async () => {
    const account = await h.account();
    const { secret } = await turnOn2fa(account);
    const browser = h.browser();
    const step = await browser.post('/api/login', { email: account.email, password: account.password });
    expect(step.body.mfa).toBe(true);
    expect(browser.jar.has('__Host-hj_session')).toBe(false);
    expect((await browser.get('/api/account')).status).toBe(401);
    expect((await browser.post('/api/login/2fa', { code: '000000' })).status).toBe(401);
    h.advance(31_000);
    expect((await browser.post('/api/login/2fa', { code: await totpAt(h, secret) })).status).toBe(200);
    expect((await browser.get('/api/account')).status).toBe(200);
  });

  it('refuses a code used a second time', async () => {
    const account = await h.account();
    const { secret } = await turnOn2fa(account);
    h.advance(31_000);
    const code = await totpAt(h, secret);
    const first = h.browser();
    await first.post('/api/login', { email: account.email, password: account.password });
    expect((await first.post('/api/login/2fa', { code })).status).toBe(200);
    const second = h.browser();
    await second.post('/api/login', { email: account.email, password: account.password });
    expect((await second.post('/api/login/2fa', { code })).status).toBe(401);
  });

  it('takes each recovery code once and keeps only hashes', async () => {
    const account = await h.account();
    const { recoveryCodes } = await turnOn2fa(account);
    expect(recoveryCodes).toHaveLength(10);
    const dump = await h.dump();
    for (const code of recoveryCodes) { expect(dump).not.toContain(code); expect(dump).not.toContain(code.replaceAll('-', '')); }
    const first = h.browser();
    await first.post('/api/login', { email: account.email, password: account.password });
    expect((await first.post('/api/login/2fa', { code: recoveryCodes[0] })).status).toBe(200);
    const second = h.browser();
    await second.post('/api/login', { email: account.email, password: account.password });
    expect((await second.post('/api/login/2fa', { code: recoveryCodes[0] })).status).toBe(401);
    expect((await second.post('/api/login/2fa', { code: recoveryCodes[1]!.toLowerCase() })).status).toBe(200);
    expect((await first.get('/api/account')).body.twoFactor).toEqual({ enabled: true, recoveryLeft: 8 });
  });

  it('limits guesses at the code', async () => {
    const account = await h.account();
    await turnOn2fa(account);
    const browser = h.browser();
    await browser.post('/api/login', { email: account.email, password: account.password });
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await browser.post('/api/login/2fa', { code: '123456' })).status;
    expect(last).toBe(429);
  });

  it('survives a password reset: the inbox alone is not enough', async () => {
    const account = await h.account();
    await turnOn2fa(account);
    const browser = h.browser();
    await browser.post('/api/forgot', { email: account.email });
    await browser.post('/api/reset', { token: h.lastToken(account.email), password: 'a brand new password' });
    expect((await browser.post('/api/login', { email: account.email, password: 'a brand new password' })).body.mfa).toBe(true);
  });

  it('needs password and code to turn off', async () => {
    const account = await h.account();
    const { secret } = await turnOn2fa(account);
    h.advance(31_000);
    expect((await account.browser.post('/api/2fa/disable', { password: 'wrong password!!', code: await totpAt(h, secret) })).status).toBe(401);
    expect((await account.browser.post('/api/2fa/disable', { password: account.password, code: '000000' })).status).toBe(401);
    expect((await account.browser.post('/api/2fa/disable', { password: account.password, code: await totpAt(h, secret) })).status).toBe(200);
    expect(((await account.browser.get('/api/account')).body.twoFactor as { enabled: boolean }).enabled).toBe(false);
  });
});

describe('deleting an account', () => {
  it('cancels billing, takes the name back at the relay and removes the data', async () => {
    const { account, server } = await h.aiCustomer();
    await h.db.query('update heyjosi.accounts set stripe_customer_id = $2 where id = $1', [account.id, 'cus_delete_me']);
    expect((await account.browser.post('/api/account/delete', { password: 'wrong password!!' })).status).toBe(401);
    h.calls = [];
    expect((await account.browser.post('/api/account/delete', { password: account.password })).status).toBe(200);
    expect(h.calls.some(call => call.method === 'DELETE' && call.url.endsWith('/customers/cus_delete_me'))).toBe(true);
    const revoke = h.calls.find(call => call.url.endsWith('/v1/names/revoke'))!;
    const claims = JSON.parse(Buffer.from((JSON.parse(revoke.body) as { revoke: string }).revoke.split('.')[0]!, 'base64url').toString());
    expect(claims.typ).toBe('relay-revoke');
    expect(claims.name).toBe(account.handle);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(900);
    expect(await h.db.query('select 1 from heyjosi.accounts where id = $1', [account.id])).toHaveLength(0);
    expect(await h.db.query('select 1 from heyjosi.servers where noise_public = $1', [server.publicKey])).toHaveLength(0);
    expect((await h.db.query('select 1 from heyjosi.relay_revocations')).length).toBe(0);
    expect((await account.browser.get('/api/account')).status).toBe(401);
  });

  it('stops if billing can\'t be cancelled, so nobody is charged for a deleted account', async () => {
    const account = await h.account();
    await h.db.query('update heyjosi.accounts set stripe_customer_id = $2 where id = $1', [account.id, 'cus_stuck']);
    const realFetch = h.ctx.stripe;
    const stuck = Object.create(realFetch) as typeof realFetch;
    stuck.delete = async () => { throw new Error('stripe down'); };
    h.ctx.stripe = stuck;
    const res = await account.browser.post('/api/account/delete', { password: account.password });
    h.ctx.stripe = realFetch;
    expect(res.status).toBe(500);
    expect(await h.db.query('select 1 from heyjosi.accounts where id = $1', [account.id])).toHaveLength(1);
  });

  it('retries the relay until it answers, and holds the name meanwhile', async () => {
    const { account } = await h.aiCustomer();
    h.relayRevoke = () => new Response('', { status: 503 });
    await account.browser.post('/api/account/delete', { password: account.password });
    expect(await h.db.query('select name from heyjosi.relay_revocations')).toEqual([{ name: account.handle }]);
    expect((await h.browser().post('/api/signup', { email: 'n@example.test', password: 'a long enough password', handle: account.handle })).status).toBe(409);
    h.relayRevoke = () => Response.json({ ok: true });
    const { sweep } = await import('../src/sweep.js');
    await sweep(h.ctx);
    expect(await h.db.query('select name from heyjosi.relay_revocations')).toEqual([]);
  });
});

describe('suspension', () => {
  it('ends sessions, stops login and revokes the name, and can be undone', async () => {
    const { account, server } = await h.aiCustomer('connect');
    h.calls = [];
    await suspendAccount(h.ctx, account.id);
    expect(h.calls.filter(call => call.url.endsWith('/v1/names/revoke'))).toHaveLength(1);
    expect((await account.browser.get('/api/account')).status).toBe(401);
    expect((await h.browser().post('/api/login', { email: account.email, password: account.password })).status).toBe(403);
    const sync = await server.sync() as { ok: true; grant: string | null; plan: string };
    expect(sync.grant).toBeNull();
    expect(sync.plan).toBe('free');
    await unsuspendAccount(h.ctx, account.id);
    expect(((await server.sync()) as { grant: string | null }).grant).toBeTruthy();
  });
});

describe('schema', () => {
  it('keeps everything out of public, with RLS on every table', async () => {
    const inPublic = await h.db.query(`select tablename from pg_tables where schemaname = 'public'`);
    expect(inPublic).toEqual([]);
    const open = await h.db.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'heyjosi' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(open).toEqual([]);
    const policies = await h.db.query(`select 1 from pg_policies where schemaname = 'heyjosi'`);
    expect(policies).toEqual([]);
  });

  it('shows a role with table rights no rows, as PostgREST would get', async () => {
    await h.account();
    await h.db.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon_probe') then create role anon_probe; end if; end $$`);
    await h.db.query('grant usage on schema heyjosi to anon_probe');
    await h.db.query('grant select on all tables in schema heyjosi to anon_probe');
    const rows = await h.db.transaction!(async tx => {
      await tx.query('set local role anon_probe');
      return tx.query('select * from heyjosi.accounts');
    });
    expect(rows).toEqual([]);
    expect((await h.db.query('select * from heyjosi.accounts')).length).toBeGreaterThan(0);
  });

  it('splits statements without breaking a do block or a comment', () => {
    expect(splitStatements(`-- a; comment\nselect 'a;b';\ndo $$ begin perform 1; end $$;\n-- trailing\n`)).toHaveLength(2);
  });

  it('runs the migrations once', async () => {
    const { runMigrations } = await import('../src/migrate.js');
    expect(await runMigrations(h.db)).toEqual([]);
  });
});

describe('boot checks', () => {
  it('lists everything missing, by name only', () => {
    try { loadConfig({ NODE_ENV: 'production' }); expect.unreachable(); } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      for (const name of ['DATABASE_URL', 'ACCOUNT_DATA_KEY', 'HOSTED_NOISE_PRIVATE_KEY', 'RELAY_GRANT_PRIVATE_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'GOOGLE_CLIENT_SECRET', 'RELAY_URL']) expect(message).toContain(name);
    }
  });

  it('refuses a bad key and the console mailer in production', () => {
    expect(() => loadConfig(testEnv({ ACCOUNT_DATA_KEY: 'too-short' }))).toThrow(/ACCOUNT_DATA_KEY/);
    expect(() => loadConfig(testEnv({ NODE_ENV: 'production' }))).toThrow(/console/);
    expect(() => loadConfig(testEnv({ NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://mail.invalid' }))).not.toThrow();
  });
});
