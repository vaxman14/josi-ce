import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOWED_SCOPES, wrapState } from '../src/google.js';
import { Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => { h = await new Harness().start(); });
afterAll(() => h.stop());

const API = 'https://www.googleapis.com/auth/';
const CHALLENGE = randomBytes(32).toString('base64url');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const callback = (query: string) => fetch(`${h.base}/oauth/google/callback?${query}`, { redirect: 'manual' });

async function authorize(server: Awaited<ReturnType<Harness['aiCustomer']>>['server'], state = 'server-opaque-state', scopes = `openid ${API}userinfo.email ${API}gmail.readonly`) {
  return await server.call<{ url: string }>({ op: 'google.authorize', state, codeChallenge: CHALLENGE, scopes }) as { ok: true; url: string };
}

describe('google.authorize', () => {
  it('builds the URL for the shared client, with PKCE and offline access', async () => {
    const { server } = await h.aiCustomer('connect');
    const reply = await authorize(server);
    const url = new URL(reply.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'fixture-client', redirect_uri: 'https://heyjosi.test/oauth/google/callback', response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256',
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', scope: `openid ${API}userinfo.email ${API}gmail.readonly`,
    });
    expect(url.searchParams.get('state')).not.toBe('server-opaque-state');
    expect(reply.url).not.toContain('fixture-google-secret');
  });

  it('needs Connect or above', async () => {
    const account = await h.account();
    const { FakeServerKey } = await import('./helpers.js');
    const server = new FakeServerKey(h);
    await server.link(account.browser);
    const reply = await server.call({ op: 'google.authorize', state: 's', codeChallenge: CHALLENGE, scopes: 'openid' });
    expect(reply).toMatchObject({ ok: false, error: 'plan_required' });
    expect((reply as { message: string }).message).toBeTruthy();
  });

  it('takes exactly the agreed scopes', async () => {
    const { server } = await h.aiCustomer('connect');
    expect([...ALLOWED_SCOPES].sort()).toEqual(['openid', `${API}userinfo.email`, `${API}gmail.readonly`, `${API}gmail.send`, `${API}calendar.readonly`, `${API}calendar`, `${API}contacts.readonly`, `${API}contacts`, `${API}drive.readonly`].sort());
    expect((await authorize(server, 's', [...ALLOWED_SCOPES].join(' '))).ok).toBe(true);
    for (const scopes of [`${API}drive`, `openid ${API}gmail.modify`, 'email', 'https://mail.google.com/', '']) {
      expect(await server.call({ op: 'google.authorize', state: 's', codeChallenge: CHALLENGE, scopes })).toMatchObject({ ok: false, error: 'bad_scope' });
    }
  });

  it('refuses a malformed challenge', async () => {
    const { server } = await h.aiCustomer('connect');
    expect(await server.call({ op: 'google.authorize', state: 's', codeChallenge: 'short', scopes: 'openid' })).toMatchObject({ ok: false, error: 'bad_request' });
  });
});

describe('the callback', () => {
  it('runs the whole flow and keeps nothing: no table or log holds a token, code or verifier', async () => {
    const { account, server } = await h.aiCustomer('connect');
    const CODE = 'fixture-google-code-4f1a', VERIFIER = 'fixture-pkce-verifier-92bd', ACCESS = 'fixture-access-token-77c0', REFRESH = 'fixture-refresh-token-1e2d';
    const hellos: Array<Record<string, unknown>> = [], remotes: string[] = [];
    h.fakeServer(server.site, server.key, async (hello, remote) => {
      hellos.push(hello); remotes.push(Buffer.from(remote).toString('base64url'));
      if (hello.op === 'google-begin') return { ok: true, verifier: VERIFIER };
      if (hello.op === 'google-tokens') return { ok: true, returnPath: '/settings/connections?done=1' };
      return null;
    });
    let exchange = new URLSearchParams();
    h.google = form => { exchange = form; return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: 'openid', token_type: 'Bearer' }); };
    const state = new URL((await authorize(server)).url).searchParams.get('state')!;
    const before = h.logs.length;
    h.calls = [];

    const res = await callback(new URLSearchParams({ state, code: CODE }).toString());

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://${account.handle}.heyjosi.test/settings/connections?done=1`);
    expect(hellos.map(hello => hello.op)).toEqual(['google-begin', 'google-tokens']);
    expect(hellos[0]).toMatchObject({ v: 1, state: 'server-opaque-state' });
    expect(hellos[1]).toMatchObject({ v: 1, state: 'server-opaque-state', accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3599, scope: 'openid' });
    expect(remotes).toEqual([h.ctx.hostedPublic, h.ctx.hostedPublic]);
    expect(Object.fromEntries(exchange)).toMatchObject({ grant_type: 'authorization_code', code: CODE, code_verifier: VERIFIER, client_id: 'fixture-client', client_secret: 'fixture-google-secret', redirect_uri: 'https://heyjosi.test/oauth/google/callback' });

    const everything = (await h.dump()) + h.logs.join('\n');
    for (const secret of [CODE, VERIFIER, ACCESS, REFRESH]) expect(everything).not.toContain(secret);
    expect(h.logs.slice(before)).toEqual([]);
  });

  it('says plainly when the server is offline, before Google is even asked, and stores nothing', async () => {
    const { server } = await h.aiCustomer('connect');
    h.servers.delete(server.site);
    const state = new URL((await authorize(server)).url).searchParams.get('state')!;
    h.calls = [];
    const before = await h.dump();
    const res = await callback(new URLSearchParams({ state, code: 'fixture-offline-code' }).toString());
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/isn(&#39;|')t connected right now, so nothing was saved/);
    expect(h.calls).toEqual([]);
    expect(await h.dump()).toBe(before);
  });

  it('says so when the server goes away between the two steps, and keeps the tokens nowhere', async () => {
    const { server } = await h.aiCustomer('connect');
    const ACCESS = 'fixture-orphan-access-3b9a';
    h.fakeServer(server.site, server.key, async hello => {
      if (hello.op === 'google-begin') { queueMicrotask(() => h.servers.delete(server.site)); return { ok: true, verifier: 'v' }; }
      return null;
    });
    h.google = () => json({ access_token: ACCESS, expires_in: 3599, scope: 'openid' });
    const state = new URL((await authorize(server)).url).searchParams.get('state')!;
    const res = await callback(new URLSearchParams({ state, code: 'c' }).toString());
    expect(res.status).toBe(503);
    expect((await h.dump()) + h.logs.join()).not.toContain(ACCESS);
  });

  it('refuses a tampered, foreign or expired wrapper without touching anything', async () => {
    const { server } = await h.aiCustomer('connect');
    h.fakeServer(server.site, server.key, async () => { throw new Error('must not be reached'); });
    h.calls = [];
    const state = new URL((await authorize(server)).url).searchParams.get('state')!;
    const [body, signature] = state.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ s: server.serverId, t: 'attacker', e: Date.now() + 60_000 })).toString('base64url');
    for (const bad of [`${forged}.${signature}`, `${body}.${'0'.repeat(64)}`, 'junk', '']) {
      expect((await callback(new URLSearchParams({ state: bad, code: 'c' }).toString())).status).toBe(400);
    }
    h.advance(11 * 60_000);
    const late = await callback(new URLSearchParams({ state, code: 'c' }).toString());
    h.advance(-11 * 60_000);
    expect(late.status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('won\'t redirect off the person\'s own address', async () => {
    const { account, server } = await h.aiCustomer('connect');
    h.google = () => json({ access_token: 'a', expires_in: 1, scope: 'openid' });
    for (const returnPath of ['//evil.example', 'https://evil.example/', '/\\evil.example', 7]) {
      h.fakeServer(server.site, server.key, async hello => hello.op === 'google-begin' ? { ok: true, verifier: 'v' } : { ok: true, returnPath });
      const res = await callback(new URLSearchParams({ state: wrapState(h.ctx, server.serverId, 's'), code: 'c' }).toString());
      expect(res.headers.get('location')).toBe(`https://${account.handle}.heyjosi.test/`);
    }
  });

  it('stops when the server doesn\'t recognise the state', async () => {
    const { server } = await h.aiCustomer('connect');
    h.fakeServer(server.site, server.key, async () => ({ ok: false, error: 'expired' }));
    h.calls = [];
    const res = await callback(new URLSearchParams({ state: wrapState(h.ctx, server.serverId, 's'), code: 'c' }).toString());
    expect(res.status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('stops at a server that refuses the hosted key', async () => {
    const { server } = await h.aiCustomer('connect');
    h.fakeServer(server.site, server.key, async () => null);
    h.calls = [];
    const res = await callback(new URLSearchParams({ state: wrapState(h.ctx, server.serverId, 's'), code: 'c' }).toString());
    expect(res.status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('handles the person saying no at Google', async () => {
    const { account, server } = await h.aiCustomer('connect');
    const res = await callback(new URLSearchParams({ state: wrapState(h.ctx, server.serverId, 's'), error: 'access_denied' }).toString());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`https://${account.handle}.heyjosi.test`);
  });

  it('doesn\'t leak Google\'s refusal', async () => {
    const { server } = await h.aiCustomer('connect');
    h.fakeServer(server.site, server.key, async () => ({ ok: true, verifier: 'v' }));
    h.google = () => json({ error: 'invalid_grant', error_description: 'fixture-secret-detail' }, 400);
    const before = h.logs.length;
    const res = await callback(new URLSearchParams({ state: wrapState(h.ctx, server.serverId, 's'), code: 'c' }).toString());
    expect(res.status).toBe(502);
    expect(await res.text() + h.logs.slice(before).join()).not.toContain('fixture-secret-detail');
  });
});

describe('google.refresh', () => {
  it('brokers it statelessly, with the reply shape the server reads', async () => {
    const { server } = await h.aiCustomer('connect');
    const REFRESH = 'fixture-stateless-refresh-a01', ACCESS = 'fixture-stateless-access-b02';
    let form = new URLSearchParams();
    h.google = sent => { form = sent; return json({ access_token: ACCESS, expires_in: 3599, scope: 'openid' }); };
    const reply = await server.call({ op: 'google.refresh', refreshToken: REFRESH, scopes: 'openid' });
    expect(reply).toEqual({ ok: true, accessToken: ACCESS, expiresIn: 3599, scope: 'openid' });
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'refresh_token', refresh_token: REFRESH, client_secret: 'fixture-google-secret' });
    const everything = (await h.dump()) + h.logs.join();
    expect(everything).not.toContain(REFRESH);
    expect(everything).not.toContain(ACCESS);
  });

  it('passes on invalid_grant, and hides anything else', async () => {
    const { server } = await h.aiCustomer('connect');
    h.google = () => json({ error: 'invalid_grant' }, 400);
    expect(await server.call({ op: 'google.refresh', refreshToken: 'r', scopes: 'openid' })).toEqual({ ok: false, error: 'invalid_grant' });
    h.google = () => json({ error: 'server_error', error_description: 'detail' }, 500);
    expect(await server.call({ op: 'google.refresh', refreshToken: 'r', scopes: 'openid' })).toEqual({ ok: false, error: 'google_error' });
  });

  it('needs a plan and allowed scopes', async () => {
    const account = await h.account();
    const { FakeServerKey } = await import('./helpers.js');
    const free = new FakeServerKey(h);
    await free.link(account.browser);
    expect(await free.call({ op: 'google.refresh', refreshToken: 'r', scopes: 'openid' })).toMatchObject({ error: 'plan_required' });
    const { server } = await h.aiCustomer('connect');
    expect(await server.call({ op: 'google.refresh', refreshToken: 'r', scopes: `${API}drive` })).toMatchObject({ error: 'bad_scope' });
  });
});

describe('google.revoke', () => {
  it('isn\'t an operation here: the server calls Google itself', async () => {
    const { server } = await h.aiCustomer('connect');
    expect(await server.call({ op: 'google.revoke', token: 't' } as never)).toEqual({ ok: false, error: 'unknown_op' });
  });
});
