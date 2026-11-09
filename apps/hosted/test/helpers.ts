// A whole hosted service in a test: PGlite, a real HTTP listener on localhost, and
// a fake fetch standing in for Stripe, OpenAI, Google and the relay, so nothing
// here can reach the network. The fake server peer is a real TunnelHost.
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { connectFromEnv, pgliteDb, type Db } from '@josi-ce/core';
import { TunnelError, TunnelHost, generateKeyPair, rpcCall, staticKeyFrom, toB64url, fromB64url, type HostedCall, type HostedReply, type StaticKey, type Transport } from '@josi-ce/tunnel';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createContext, type Ctx } from '../src/context.js';
import type { Mail } from '../src/mailer.js';
import { runMigrations } from '../src/migrate.js';

export const ACCOUNT_DATA_KEY = randomBytes(32).toString('base64url');

export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const key = () => randomBytes(32).toString('base64url');
  return {
    DATABASE_URL: 'postgres://fixture.invalid/none', PUBLIC_ORIGIN: 'https://heyjosi.test', PUBLIC_DOMAIN: 'heyjosi.test', CLIENT_IP_HEADER: 'x-test-ip',
    ACCOUNT_DATA_KEY: key(), STATE_SIGNING_KEY: key(), HOSTED_NOISE_PRIVATE_KEY: key(), RELAY_GRANT_PRIVATE_KEY: key(), RELAY_URL: 'https://relay.heyjosi.test',
    STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_PRICE_CONNECT: 'price_connect', STRIPE_PRICE_CONNECT_AI: 'price_ai',
    STRIPE_PRICE_TOPUP_10: 'price_top10', STRIPE_PRICE_TOPUP_20: 'price_top20', OPENAI_API_KEY: 'fixture-openai-key', GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
    ...extra,
  };
}

/** It drops the schema it's given, so it only ever accepts a local test database. */
export function realDatabaseUrl(): string | null {
  const url = process.env.HOSTED_TEST_DATABASE_URL;
  if (!url) return null;
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !parsed.pathname.includes('test')) throw new Error('HOSTED_TEST_DATABASE_URL must be a local database with "test" in its name.');
  return url;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export interface StripeSub { id: string; status: string; customer: string; livemode: boolean; cancel_at_period_end: boolean; metadata: Record<string, string>; current_period_start: number; current_period_end: number; items: { data: Array<{ price: { id: string } }> } }

export class Harness {
  mail: Mail[] = [];
  logs: string[] = [];
  /** Every call to the outside world, in order. */
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  offset = 0;
  subs = new Map<string, StripeSub>();
  checkouts: URLSearchParams[] = [];
  relayRevoke: () => Response = () => json({ ok: true });
  /** What OpenAI does. Replaced per test. */
  openai: (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response> = body => json(completion(body, 10, 5));
  google: (form: URLSearchParams) => Response = () => json({ error: 'unset' }, 400);
  servers = new Map<string, TunnelHost>();
  peerNext = 0;
  ctx!: Ctx;
  db!: Db;
  pg!: PGlite;
  config!: Config;
  base = '';
  private listener!: Server;
  private closeDb: () => Promise<void> = async () => undefined;
  private nextId = 0;

  /** Set HOSTED_TEST_DATABASE_URL to run on a real Postgres through the production
   * driver. PGlite has one connection, so only that run exercises real row locks,
   * and only that run goes through postgres.js and its type handling. */
  async start(env: Record<string, string> = {}): Promise<this> {
    const url = realDatabaseUrl();
    if (url) {
      const connection = await connectFromEnv({ DATABASE_URL: url }, { max: 20 });
      this.closeDb = connection.close;
      this.db = connection.db;
      await this.db.query('drop schema if exists heyjosi cascade');
    } else {
      this.pg = new PGlite();
      this.db = pgliteDb(this.pg as never);
      this.closeDb = () => this.pg.close();
    }
    await runMigrations(this.db);
    return this.boot(this.db, env);
  }

  async boot(db: Db, env: Record<string, string> = {}): Promise<this> {
    this.db = db;
    this.config = loadConfig(testEnv(env));
    this.ctx = createContext({
      db, config: this.config, fetch: this.fetch as typeof fetch, now: () => Date.now() + this.offset,
      mailer: { send: async mail => { this.mail.push(mail); } }, log: (event, fields) => { this.logs.push(JSON.stringify({ event, ...fields })); },
      peerTransport: url => this.connectPeer(url),
    });
    await new Promise<void>(resolve => { this.listener = createApp(this.ctx).listen(0, '127.0.0.1', () => resolve()); });
    this.base = `http://127.0.0.1:${(this.listener.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.listener.closeAllConnections();
    await new Promise(resolve => this.listener.close(resolve));
    await this.closeDb();
  }

  advance(ms: number): void { this.offset += ms; }
  id(prefix = 'x'): string { return `${prefix}${++this.nextId}${randomBytes(3).toString('hex')}`; }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input), method = init.method ?? 'GET', body = typeof init.body === 'string' ? init.body : '';
    this.calls.push({ url, method, headers: Object.fromEntries(new Headers(init.headers)), body });
    if (url.startsWith('https://api.stripe.com/')) return this.stripe(url.slice('https://api.stripe.com/v1'.length), method, body);
    if (url.startsWith(`${this.config.openai.baseUrl}/`)) return this.openai(JSON.parse(body) as Record<string, unknown>, init);
    if (url === 'https://oauth2.googleapis.com/token') return this.google(new URLSearchParams(body));
    if (url === `${this.config.relayUrl}/v1/names/revoke`) return this.relayRevoke();
    throw new Error(`A test tried to reach ${url}`);
  };

  private stripe(path: string, method: string, body: string): Response {
    const form = new URLSearchParams(body);
    if (path === '/customers' && method === 'POST') return json({ id: this.id('cus_'), livemode: false });
    if (path.startsWith('/customers/') && method === 'DELETE') return json({ id: path.slice(11), deleted: true, livemode: false });
    if (path === '/checkout/sessions') { this.checkouts.push(form); return json({ id: this.id('cs_'), url: 'https://checkout.stripe.test/session', livemode: false }); }
    if (path === '/billing_portal/sessions') return json({ url: 'https://billing.stripe.test/session', livemode: false });
    if (path.startsWith('/subscriptions/')) {
      const sub = this.subs.get(path.slice(15));
      return sub ? json(sub) : json({ error: { message: 'no such subscription' } }, 404);
    }
    return json({ error: { message: `unhandled ${path}` } }, 404);
  }

  /** Stripe's own signing, as a test would receive it. */
  signed(payload: string, at = Math.floor((Date.now() + this.offset) / 1000), secret = this.config.stripe.webhookSecret): string {
    return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex')}`;
  }

  async webhook(event: Record<string, unknown>, signature?: string): Promise<globalThis.Response> {
    const payload = JSON.stringify({ livemode: false, created: 1, ...event });
    return fetch(`${this.base}/stripe/webhook`, { method: 'POST', body: payload, headers: { 'stripe-signature': signature ?? this.signed(payload), 'content-type': 'application/json' } });
  }

  /** Puts an account on a plan the way real life does: a webhook, then a fetch. */
  async subscribe(accountId: string, plan: 'connect' | 'connect_ai', status = 'active', id = this.id('sub_')): Promise<string> {
    const now = Math.floor((Date.now() + this.offset) / 1000);
    this.subs.set(id, {
      id, status, customer: 'cus_fixture', livemode: false, cancel_at_period_end: false, metadata: { account_id: accountId }, current_period_start: now - 60, current_period_end: now + 30 * 86_400,
      items: { data: [{ price: { id: plan === 'connect' ? 'price_connect' : 'price_ai' } }] },
    });
    const res = await this.webhook({ id: this.id('evt_'), type: 'customer.subscription.updated', data: { object: { id } } });
    if (!res.ok) throw new Error(`webhook failed: ${res.status}`);
    return id;
  }

  /** A fake Josi server. `special` answers the hosted hellos. */
  fakeServer(site: string, key: StaticKey, special: (hello: Record<string, unknown>, remote: Uint8Array) => Promise<Record<string, unknown> | null>): TunnelHost {
    const host = new TunnelHost({ keys: () => [key], authorize: async () => ({ ok: false, error: 'unknown_device' }), special, onRequest: () => undefined });
    this.servers.set(site, host);
    return host;
  }

  private async connectPeer(url: string): Promise<Transport> {
    const site = /\/v1\/sites\/([0-9a-f]+)\/peer$/.exec(url)?.[1] ?? '';
    const host = this.servers.get(site);
    if (!host) throw new TunnelError('offline', 'Your Josi server is not connected right now.');
    const id = `peer-${++this.peerNext}`;
    const transport: Transport = {
      onMessage: null, onClose: null,
      send: data => host.data(id, data),
      close: () => host.gone(id),
    };
    host.open(id, { send: data => queueMicrotask(() => transport.onMessage?.(data)), close: reason => queueMicrotask(() => transport.onClose?.(reason ?? 'closed')) });
    return transport;
  }

  browser(): Browser { return new Browser(this); }

  /** Signs up and confirms by the emailed link, returning a logged-in browser. */
  async account(args: { handle?: string; email?: string; password?: string } = {}): Promise<{ browser: Browser; id: string; email: string; handle: string; password: string }> {
    const handle = args.handle ?? this.id('user'), email = args.email ?? `${handle}@example.test`, password = args.password ?? 'a long enough password';
    const browser = this.browser();
    const signup = await browser.post('/api/signup', { email, password, handle });
    if (signup.status !== 202) throw new Error(`signup: ${signup.status}`);
    const verified = await browser.post('/api/verify-email', { token: this.lastToken(email) });
    if (verified.status !== 200) throw new Error(`verify: ${verified.status}`);
    const login = await browser.post('/api/login', { email, password });
    if (login.status !== 200) throw new Error(`login: ${login.status}`);
    const [row] = await this.db.query<{ id: string }>('select id from heyjosi.accounts where email = $1', [email]);
    return { browser, id: row!.id, email, handle, password };
  }

  lastToken(to: string): string {
    const mail = this.mail.filter(item => item.to === to).at(-1);
    const token = /#token=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1];
    if (!token) throw new Error(`no token mailed to ${to}`);
    return token;
  }

  /** A paying account with a server linked and synced, holding its AI token. */
  async aiCustomer(plan: 'connect' | 'connect_ai' = 'connect_ai'): Promise<{ account: Awaited<ReturnType<Harness['account']>>; server: FakeServerKey; token: string }> {
    const account = await this.account();
    await this.subscribe(account.id, plan);
    const server = new FakeServerKey(this);
    const link = await server.link(account.browser);
    if (!link.ok) throw new Error('link failed');
    const sync = await server.sync();
    if (!sync.ok) throw new Error('sync failed');
    return { account, server, token: (sync as { aiToken: string }).aiToken };
  }

  async chat(token: string, body: Record<string, unknown>, extra: RequestInit = {}): Promise<globalThis.Response> {
    return fetch(`${this.base}/ai/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), ...extra });
  }

  /** Every value in every table, as one string, for proving what isn't there. */
  async dump(): Promise<string> {
    const tables = await this.db.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'heyjosi'`);
    let out = '';
    for (const { tablename } of tables) out += `${tablename}:${JSON.stringify(await this.db.query(`select * from heyjosi.${tablename}`), (_key, value) => typeof value === 'bigint' ? String(value) : value)}\n`;
    return out;
  }
}

export function completion(body: Record<string, unknown>, input: number, output: number): Record<string, unknown> {
  return { id: 'chatcmpl-1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'fixture answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
}

/** A pretend server's static key, and the RPC calls it makes. */
export class FakeServerKey {
  privateKey: Uint8Array;
  key: StaticKey;
  site = '';
  serverId = '';
  constructor(private readonly h: Harness) { this.privateKey = generateKeyPair().privateKey; this.key = staticKeyFrom(this.privateKey); }
  get publicKey(): string { return toB64url(this.key.publicKey); }

  call<T = Record<string, unknown>>(call: HostedCall, key: StaticKey = this.key): Promise<HostedReply<T>> {
    return rpcCall<T>({ url: this.h.base, key, hostedPublic: fromB64url(this.h.ctx.hostedPublic), call });
  }

  async link(browser: Browser): Promise<HostedReply<{ site: string; serverId: string; name: string; hostedPublic: string; relayUrl: string; plan: string }>> {
    const { body } = await browser.post('/api/link-code', {});
    const reply = await this.call<{ site: string; serverId: string; name: string; hostedPublic: string; relayUrl: string; plan: string }>({ op: 'link', code: (body as { code: string }).code, version: '1.2.3' });
    if (reply.ok) { this.site = reply.site; this.serverId = reply.serverId; }
    return reply;
  }

  /** Loosely typed: each test reads only the fields it's about. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sync(devices: Array<Record<string, unknown>> = []): Promise<any> {
    return this.call({ op: 'sync', devices: devices as never, version: '1.2.3', lan: true });
  }
}

/** A cookie jar and a CSRF token, as the pages would hold them. */
export class Browser {
  jar = new Map<string, string>();
  ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  lastHeaders = new Headers();
  constructor(private readonly h: Harness) {}

  private absorb(res: globalThis.Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';'), at = pair!.indexOf('=');
      const name = pair!.slice(0, at), value = pair!.slice(at + 1);
      if (value) this.jar.set(name, value); else this.jar.delete(name);
    }
  }

  private cookie(): string { return [...this.jar].map(([key, value]) => `${key}=${value}`).join('; '); }

  async get(path: string): Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Headers }> {
    const res = await fetch(`${this.h.base}${path}`, { redirect: 'manual', headers: { cookie: this.cookie(), 'x-test-ip': this.ip } });
    this.absorb(res);
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* a page */ }
    return { status: res.status, body, text, headers: res.headers };
  }

  async csrf(): Promise<string> { return (await this.get('/api/csrf')).body.token as string; }

  async post(path: string, value: unknown, opts: { csrf?: string | null; origin?: string | null } = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
    const token = opts.csrf === undefined ? await this.csrf() : opts.csrf;
    const origin = opts.origin === undefined ? this.h.config.publicOrigin : opts.origin;
    const res = await fetch(`${this.h.base}${path}`, {
      method: 'POST', body: JSON.stringify(value), redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie: this.cookie(), 'x-test-ip': this.ip, ...(token ? { 'x-csrf-token': token } : {}), ...(origin ? { origin } : {}) },
    });
    this.absorb(res);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: res.status, body, headers: res.headers };
  }
}
