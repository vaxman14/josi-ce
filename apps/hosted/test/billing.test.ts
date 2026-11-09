import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { StripeClient, assertTestKey, formEncode } from '../src/stripe.js';
import { Harness, testEnv } from './helpers.js';

let h: Harness;
beforeAll(async () => { h = await new Harness().start(); });
afterAll(() => h.stop());

const planOf = async (id: string) => (await h.db.query<{ plan: string; status: string }>('select plan, status from heyjosi.subscriptions where account_id = $1', [id]))[0];

describe('live mode stays out', () => {
  it('won\'t build a client on a live key, or start with one', () => {
    for (const key of ['sk_live_abc', 'rk_live_abc', 'pk_test_abc', 'whatever', '']) {
      expect(() => assertTestKey(key)).toThrow();
      expect(() => new StripeClient(key, fetch)).toThrow();
    }
    expect(() => loadConfig(testEnv({ STRIPE_SECRET_KEY: 'sk_live_abc' }))).toThrow(/test key|sk_test_/);
    expect(() => assertTestKey('sk_test_abc')).not.toThrow();
    expect(() => assertTestKey('rk_test_abc')).not.toThrow();
  });

  it('refuses a correctly signed live event and records nothing', async () => {
    const id = h.id('evt_live_');
    const res = await h.webhook({ id, type: 'invoice.paid', livemode: true, data: { object: {} } });
    expect(res.status).toBe(400);
    expect(await h.db.query('select 1 from heyjosi.stripe_events where id = $1', [id])).toEqual([]);
  });

  it('refuses an event that doesn\'t say which mode it\'s from', async () => {
    const payload = JSON.stringify({ id: h.id('evt_'), type: 'invoice.paid', data: { object: {} } });
    const res = await fetch(`${h.base}/stripe/webhook`, { method: 'POST', body: payload, headers: { 'stripe-signature': h.signed(payload) } });
    expect(res.status).toBe(400);
  });

  it('refuses a live object from the API', async () => {
    const client = new StripeClient('sk_test_x', (async () => Response.json({ id: 'sub_1', livemode: true })) as typeof fetch);
    await expect(client.get('/subscriptions/sub_1')).rejects.toThrow(/live/);
  });

  it('applies nothing from a webhook whose subscription turns out live', async () => {
    const account = await h.account();
    const sub = await h.subscribe(account.id, 'connect');
    await h.db.query('delete from heyjosi.subscriptions where id = $1', [sub]);
    h.subs.get(sub)!.livemode = true;
    const res = await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.updated', data: { object: { id: sub } } });
    expect(res.status).toBe(500);
    expect(await planOf(account.id)).toBeUndefined();
  });
});

describe('webhook signatures', () => {
  const event = () => ({ id: h.id('evt_'), type: 'invoice.paid', data: { object: {} } });

  it('takes a good one', async () => { expect((await h.webhook(event())).status).toBe(200); });

  it('refuses a wrong secret, tampering, a missing header and junk', async () => {
    const payload = JSON.stringify({ livemode: false, ...event() });
    expect((await h.webhook(event(), h.signed('{}', undefined, 'whsec_other'))).status).toBe(400);
    const post = (headers: Record<string, string>) => fetch(`${h.base}/stripe/webhook`, { method: 'POST', body: payload, headers });
    expect((await post({ 'stripe-signature': h.signed(`${payload} `) })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ 'stripe-signature': 'nonsense' })).status).toBe(400);
  });

  it('refuses an old signature', async () => {
    const payload = JSON.stringify({ livemode: false, ...event() });
    const old = Math.floor(h.ctx.now() / 1000) - 301;
    const res = await fetch(`${h.base}/stripe/webhook`, { method: 'POST', body: payload, headers: { 'stripe-signature': h.signed(payload, old) } });
    expect(res.status).toBe(400);
  });

  it('accepts any of several v1 values, for a secret roll', async () => {
    const payload = JSON.stringify({ livemode: false, ...event() });
    const good = h.signed(payload);
    const header = good.replace(',v1=', `,v1=${'0'.repeat(64)},v1=`);
    expect((await fetch(`${h.base}/stripe/webhook`, { method: 'POST', body: payload, headers: { 'stripe-signature': header } })).status).toBe(200);
  });
});

describe('webhook idempotency', () => {
  it('applies an event once however often it arrives', async () => {
    const { account } = await h.aiCustomer();
    const [household] = await h.db.query<{ household_id: string }>('select household_id from heyjosi.household_members where account_id = $1', [account.id]);
    const event = { id: h.id('evt_'), type: 'checkout.session.completed', data: { object: { id: h.id('cs_'), mode: 'payment', payment_status: 'paid', amount_total: 1000, metadata: { kind: 'top_up', account_id: account.id, household_id: household!.household_id, usd: '10' } } } };
    for (let i = 0; i < 3; i++) expect((await h.webhook(event)).status).toBe(200);
    const [row] = await h.db.query<{ topup_micros: unknown }>('select topup_micros from heyjosi.households where id = $1', [household!.household_id]);
    expect(Number(row!.topup_micros)).toBe(10_000_000);
  });

  it('won\'t credit one Checkout Session twice under two event ids', async () => {
    const { account } = await h.aiCustomer();
    const [household] = await h.db.query<{ household_id: string }>('select household_id from heyjosi.household_members where account_id = $1', [account.id]);
    const object = { id: h.id('cs_'), mode: 'payment', payment_status: 'paid', amount_total: 2000, metadata: { kind: 'top_up', account_id: account.id, household_id: household!.household_id, usd: '20' } };
    await h.webhook({ id: h.id('evt_'), type: 'checkout.session.completed', data: { object } });
    await h.webhook({ id: h.id('evt_'), type: 'checkout.session.completed', data: { object } });
    const [row] = await h.db.query<{ topup_micros: unknown }>('select topup_micros from heyjosi.households where id = $1', [household!.household_id]);
    expect(Number(row!.topup_micros)).toBe(20_000_000);
  });

  it('lets Stripe retry after a failure, because nothing was recorded', async () => {
    const account = await h.account();
    const sub = await h.subscribe(account.id, 'connect');
    const held = h.subs.get(sub)!;
    h.subs.delete(sub);
    const event = { id: h.id('evt_'), type: 'customer.subscription.updated', data: { object: { id: sub } } };
    held.status = 'past_due';
    expect((await h.webhook(event)).status).toBe(502);
    h.subs.set(sub, held);
    expect((await h.webhook(event)).status).toBe(200);
    expect((await planOf(account.id))!.status).toBe('past_due');
  });
});

describe('subscriptions', () => {
  it('starts from Checkout with the right price and the account attached', async () => {
    const account = await h.account();
    const res = await account.browser.post('/api/billing/checkout', { plan: 'connect_ai' });
    expect(res.body.url).toBe('https://checkout.stripe.test/session');
    const form = h.checkouts.at(-1)!;
    expect(form.get('mode')).toBe('subscription');
    expect(form.get('line_items[0][price]')).toBe('price_ai');
    expect(form.get('client_reference_id')).toBe(account.id);
    expect(form.get('subscription_data[metadata][account_id]')).toBe(account.id);
    expect((await account.browser.post('/api/billing/checkout', { plan: 'enterprise' })).status).toBe(400);
  });

  it('sends a subscriber to the portal rather than billing them twice', async () => {
    const account = await h.account();
    await account.browser.post('/api/billing/checkout', { plan: 'connect' });
    await h.subscribe(account.id, 'connect');
    const before = h.checkouts.length;
    const res = await account.browser.post('/api/billing/checkout', { plan: 'connect_ai' });
    expect(res.body.url).toBe('https://billing.stripe.test/session');
    expect(h.checkouts).toHaveLength(before);
  });

  it('follows checkout.session.completed and creates the AI allowance', async () => {
    const account = await h.account();
    const id = h.id('sub_');
    await h.subscribe(account.id, 'connect_ai', 'incomplete', id);
    expect(await h.db.query('select 1 from heyjosi.household_members where account_id = $1', [account.id])).toEqual([]);
    h.subs.get(id)!.status = 'active';
    const res = await h.webhook({ id: h.id('evt_'), type: 'checkout.session.completed', data: { object: { id: h.id('cs_'), mode: 'subscription', subscription: id, client_reference_id: account.id } } });
    expect(res.status).toBe(200);
    expect(await planOf(account.id)).toEqual({ plan: 'connect_ai', status: 'active' });
    const [period] = await h.db.query<{ included_micros: unknown }>(
      `select p.included_micros from heyjosi.allowance_periods p join heyjosi.household_members m on m.household_id = p.household_id where m.account_id = $1`, [account.id]);
    expect(Number(period!.included_micros)).toBe(12_000_000);
  });

  it('starts a fresh allowance on invoice.paid, and only once per period', async () => {
    const account = await h.account();
    const id = await h.subscribe(account.id, 'connect_ai');
    const sub = h.subs.get(id)!;
    const paid = () => h.webhook({ id: h.id('evt_'), type: 'invoice.paid', data: { object: { parent: { subscription_details: { subscription: id } } } } });
    await paid();
    sub.current_period_start += 30 * 86_400; sub.current_period_end += 30 * 86_400;
    await paid(); await paid();
    const periods = await h.db.query(`select 1 from heyjosi.allowance_periods p join heyjosi.household_members m on m.household_id = p.household_id where m.account_id = $1`, [account.id]);
    expect(periods).toHaveLength(2);
  });

  it('reads the period off the item on newer API versions', async () => {
    const account = await h.account();
    const id = await h.subscribe(account.id, 'connect');
    const sub = h.subs.get(id)! as unknown as Record<string, unknown> & { items: { data: Array<Record<string, unknown>> } };
    sub.items.data[0]!.current_period_start = sub.current_period_start;
    sub.items.data[0]!.current_period_end = (sub.current_period_end as number) + 86_400;
    delete sub.current_period_start; delete sub.current_period_end;
    expect((await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.updated', data: { object: { id } } })).status).toBe(200);
    const [row] = await h.db.query<{ current_period_end: Date }>('select current_period_end from heyjosi.subscriptions where id = $1', [id]);
    expect(row!.current_period_end.getTime()).toBeGreaterThan(Date.now() + 30 * 86_400_000);
  });

  it('ignores a price it doesn\'t know', async () => {
    const account = await h.account();
    const id = await h.subscribe(account.id, 'connect');
    await h.db.query('delete from heyjosi.subscriptions where id = $1', [id]);
    h.subs.get(id)!.items.data[0]!.price.id = 'price_mystery';
    expect((await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.updated', data: { object: { id } } })).status).toBe(200);
    expect(await planOf(account.id)).toBeUndefined();
  });

  it('encodes nested params the way Stripe wants', () => {
    expect(formEncode({ a: 1, b: { c: 'x' }, d: [{ e: 'y' }], f: null }).toString()).toBe('a=1&b%5Bc%5D=x&d%5B0%5D%5Be%5D=y');
  });
});

describe('top-ups', () => {
  it('takes $10 or $20 as a one-off payment, on AI plans only', async () => {
    const free = await h.account();
    expect((await free.browser.post('/api/billing/topup', { usd: 10 })).status).toBe(409);
    const { account } = await h.aiCustomer();
    expect((await account.browser.post('/api/billing/topup', { usd: 15 })).status).toBe(400);
    expect((await account.browser.post('/api/billing/topup', { usd: 20 })).status).toBe(200);
    const form = h.checkouts.at(-1)!;
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price]')).toBe('price_top20');
    expect(form.get('metadata[usd]')).toBe('20');
  });

  it('credits no more than was paid, and nothing unpaid', async () => {
    const { account } = await h.aiCustomer();
    const [household] = await h.db.query<{ household_id: string }>('select household_id from heyjosi.household_members where account_id = $1', [account.id]);
    const object = (overrides: Record<string, unknown>) => ({ id: h.id('cs_'), mode: 'payment', payment_status: 'paid', amount_total: 2000, metadata: { kind: 'top_up', account_id: account.id, household_id: household!.household_id, usd: '20' }, ...overrides });
    await h.webhook({ id: h.id('evt_'), type: 'checkout.session.completed', data: { object: object({ payment_status: 'unpaid' }) } });
    await h.webhook({ id: h.id('evt_'), type: 'checkout.session.completed', data: { object: object({ amount_total: 100 }) } });
    const [row] = await h.db.query<{ topup_micros: unknown }>('select topup_micros from heyjosi.households where id = $1', [household!.household_id]);
    expect(Number(row!.topup_micros)).toBe(1_000_000);
  });
});
