// Plans and top-ups. Stripe is the record of who has paid: webhooks only tell us
// to go and read a subscription's current state, which makes events arriving late
// or out of order harmless.
import type { Db } from '@josi-ce/core';
import type { Ctx } from './context.js';
import { audit, inTx, iso, num } from './db.js';
import { HttpError } from './errors.js';
import { ensureHousehold } from './household.js';
import { aiPool, type Plan } from './plans.js';
import { verifyWebhook, type StripeEvent } from './stripe.js';

interface Subscription {
  id: string; status: string; customer: string; livemode?: boolean; cancel_at_period_end?: boolean; metadata?: Record<string, string>;
  current_period_start?: number; current_period_end?: number;
  items?: { data?: Array<{ price?: { id?: string }; current_period_start?: number; current_period_end?: number }> };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOP_UPS = [10, 20] as const;

const planForPrice = (ctx: Ctx, price: string | undefined): Exclude<Plan, 'free'> | null => {
  const { connect, connectAi } = ctx.config.stripe.prices;
  return price === connect ? 'connect' : price === connectAi ? 'connect_ai' : null;
};

async function customerFor(ctx: Ctx, account: { id: string; email: string; stripe_customer_id: string | null }): Promise<string> {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  const customer = await ctx.stripe.post<{ id: string }>('/customers', { email: account.email, metadata: { account_id: account.id } });
  await ctx.db.query('update heyjosi.accounts set stripe_customer_id = $2 where id = $1', [account.id, customer.id]);
  return customer.id;
}

async function portalUrl(ctx: Ctx, customer: string): Promise<string> {
  return (await ctx.stripe.post<{ url: string }>('/billing_portal/sessions', { customer, return_url: `${ctx.config.publicOrigin}/account` })).url;
}

export async function startCheckout(ctx: Ctx, account: { id: string; email: string; stripe_customer_id: string | null }, plan: unknown): Promise<string> {
  const { connect, connectAi } = ctx.config.stripe.prices;
  const price = plan === 'connect' ? connect : plan === 'connect_ai' ? connectAi : null;
  if (!price) throw new HttpError(400, 'Pick Connect or Connect + AI.');
  const customer = await customerFor(ctx, account);
  // A second subscription would bill twice. Changing plan happens in the portal.
  const [existing] = await ctx.db.query(`select 1 from heyjosi.subscriptions where account_id = $1 and status not in ('canceled', 'incomplete_expired')`, [account.id]);
  if (existing) return portalUrl(ctx, customer);
  const session = await ctx.stripe.post<{ url: string }>('/checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: account.id, line_items: [{ price, quantity: 1 }],
    success_url: `${ctx.config.publicOrigin}/account?paid=1`, cancel_url: `${ctx.config.publicOrigin}/account`,
    metadata: { account_id: account.id }, subscription_data: { metadata: { account_id: account.id } },
  });
  return session.url;
}

export async function openPortal(ctx: Ctx, account: { stripe_customer_id: string | null }): Promise<string> {
  if (!account.stripe_customer_id) throw new HttpError(409, 'There\'s no billing on this account yet.');
  return portalUrl(ctx, account.stripe_customer_id);
}

export async function startTopUp(ctx: Ctx, account: { id: string; email: string; stripe_customer_id: string | null }, usd: unknown): Promise<string> {
  const amount = TOP_UPS.find(option => option === Number(usd));
  if (!amount) throw new HttpError(400, 'Top-ups are $10 or $20.');
  const pool = await aiPool(ctx, account.id);
  if (!pool) throw new HttpError(409, 'Top-ups need Connect + AI.');
  const { topUp10, topUp20 } = ctx.config.stripe.prices;
  const session = await ctx.stripe.post<{ url: string }>('/checkout/sessions', {
    mode: 'payment', customer: await customerFor(ctx, account), client_reference_id: account.id, line_items: [{ price: amount === 10 ? topUp10 : topUp20, quantity: 1 }],
    payment_method_types: ['card'], success_url: `${ctx.config.publicOrigin}/account?paid=1`, cancel_url: `${ctx.config.publicOrigin}/account`,
    metadata: { kind: 'top_up', account_id: account.id, household_id: pool.householdId, usd: amount },
  });
  return session.url;
}

export async function topUpHistory(ctx: Ctx, accountId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await ctx.db.query<{ amount_micros: unknown; created_at: unknown }>(
    `select t.amount_micros, t.created_at from heyjosi.top_ups t join heyjosi.household_members m on m.household_id = t.household_id
      where m.account_id = $1 order by t.created_at desc limit 20`, [accountId]);
  return rows.map(row => ({ amountMicros: num(row.amount_micros), at: iso(row.created_at) }));
}

async function applySubscription(ctx: Ctx, tx: Db, sub: Subscription, hint: string | null): Promise<void> {
  const item = sub.items?.data?.[0];
  const plan = planForPrice(ctx, item?.price?.id);
  // Newer API versions moved the period from the subscription onto its items.
  const start = sub.current_period_start ?? item?.current_period_start, end = sub.current_period_end ?? item?.current_period_end;
  const claimed = sub.metadata?.account_id ?? hint ?? '';
  const [account] = UUID.test(claimed)
    ? await tx.query<{ id: string }>('select id from heyjosi.accounts where id = $1', [claimed])
    : await tx.query<{ id: string }>('select id from heyjosi.accounts where stripe_customer_id = $1', [sub.customer]);
  if (!account || !plan || !start || !end) { await audit(tx, account?.id ?? null, 'stripe.subscription_ignored', { known_account: !!account, known_price: !!plan }); return; }
  const from = new Date(start * 1000).toISOString(), to = new Date(end * 1000).toISOString();
  await tx.query(
    `insert into heyjosi.subscriptions (id, account_id, plan, status, price_id, current_period_start, current_period_end, cancel_at_period_end, updated_at)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9::timestamptz)
     on conflict (id) do update set plan = excluded.plan, status = excluded.status, price_id = excluded.price_id, current_period_start = excluded.current_period_start,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
    [sub.id, account.id, plan, sub.status, item!.price!.id, from, to, !!sub.cancel_at_period_end, ctx.at()]);
  await audit(tx, account.id, 'plan.changed', { plan, status: sub.status });
  if (plan === 'connect_ai' && ['active', 'trialing'].includes(sub.status)) {
    const household = await ensureHousehold(tx, account.id);
    await tx.query(
      `insert into heyjosi.allowance_periods (household_id, period_start, period_end, included_micros) values ($1, $2::timestamptz, $3::timestamptz, $4)
       on conflict (household_id, period_start) do update set period_end = excluded.period_end`, [household, from, to, ctx.config.ai.includedMicros]);
  }
}

async function creditTopUp(ctx: Ctx, tx: Db, session: Record<string, unknown>): Promise<void> {
  const metadata = (session.metadata ?? {}) as Record<string, string>;
  if (metadata.kind !== 'top_up') return;
  if (session.payment_status !== 'paid') { await audit(tx, null, 'stripe.top_up_unpaid'); return; }
  const account = UUID.test(metadata.account_id ?? '') ? metadata.account_id! : null;
  const household = UUID.test(metadata.household_id ?? '') ? metadata.household_id! : null;
  const [row] = household ? await tx.query('select id from heyjosi.households where id = $1 for update', [household]) : [];
  if (!row) { await audit(tx, null, 'stripe.top_up_orphaned', { session: String(session.id) }); return; }
  // What was promised, unless less was actually paid. A wrong price id in the
  // config mustn't turn a $1 payment into $20 of allowance.
  const cents = Math.min(Number(metadata.usd) * 100 || 0, Number(session.amount_total) || 0);
  if (cents <= 0) { await audit(tx, account, 'stripe.top_up_ignored'); return; }
  const micros = cents * 10_000;
  const added = await tx.query(
    `insert into heyjosi.top_ups (household_id, account_id, amount_micros, stripe_session_id) values ($1, (select id from heyjosi.accounts where id = $2), $3, $4)
     on conflict (stripe_session_id) do nothing returning id`, [household, account, micros, String(session.id)]);
  if (!added.length) return;
  await tx.query('update heyjosi.households set topup_micros = topup_micros + $2 where id = $1', [household, micros]);
  await audit(tx, account, 'top_up.added', { micros });
}

function subscriptionIdOf(event: StripeEvent): string | null {
  const object = event.data.object as Record<string, unknown> & {
    parent?: { subscription_details?: { subscription?: string } }; lines?: { data?: Array<{ subscription?: string }> };
  };
  switch (event.type) {
    case 'checkout.session.completed': return object.mode === 'subscription' ? String(object.subscription ?? '') || null : null;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': return String(object.id);
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const id = object.subscription ?? object.parent?.subscription_details?.subscription ?? object.lines?.data?.[0]?.subscription;
      return typeof id === 'string' ? id : null;
    }
    default: return null;
  }
}

/** Throwing leaves the event unrecorded, so Stripe sends it again. */
export async function handleWebhook(ctx: Ctx, raw: Buffer, signature: string | undefined): Promise<void> {
  const event = verifyWebhook(raw, signature, ctx.config.stripe.webhookSecret, ctx.now());
  const [done] = await ctx.db.query('select 1 from heyjosi.stripe_events where id = $1', [event.id]);
  if (done) return;
  const subscriptionId = subscriptionIdOf(event);
  // Read before the transaction: no row locks held across a network call.
  const sub = subscriptionId ? await ctx.stripe.get<Subscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`) : null;
  const object = event.data.object;
  await inTx(ctx.db, async tx => {
    const first = await tx.query('insert into heyjosi.stripe_events (id, type) values ($1, $2) on conflict (id) do nothing returning id', [event.id, event.type]);
    if (!first.length) return;
    if (sub) await applySubscription(ctx, tx, sub, event.type === 'checkout.session.completed' ? String(object.client_reference_id ?? '') : null);
    if (event.type === 'checkout.session.completed' && object.mode === 'payment') await creditTopUp(ctx, tx, object);
  });
}
