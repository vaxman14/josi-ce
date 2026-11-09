// The hard cap. The rule that makes it hold: money is promised before OpenAI is
// called, and every promise is either settled or expires as spent. All of it runs
// under a row lock on the household, so two calls can never both see the same
// room. This is the code to read twice before changing.
import type { HostedUsage } from '@josi-ce/tunnel';
import type { Ctx } from '../context.js';
import { audit, inTx, iso, num } from '../db.js';
import { planOf, aiPool, type Pool } from '../plans.js';

export interface ModelRow {
  id: string; label: string; upstream_id: string | null; enabled: boolean; is_default: boolean; multiplier: unknown;
  input_micros_per_million: unknown; output_micros_per_million: unknown;
}

export const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

const multiplierMilli = (model: ModelRow): number => Math.max(1000, Math.round(Number(model.multiplier) * 1000));

/** Integer maths, rounded up: a fraction of a micro-dollar never goes unpaid.
 * BigInt because tokens x price x multiplier can pass 2^53. */
export function costMicros(model: ModelRow, inputTokens: number, outputTokens: number, milli = 1000): number {
  const raw = BigInt(inputTokens) * BigInt(num(model.input_micros_per_million)) + BigInt(outputTokens) * BigInt(num(model.output_micros_per_million));
  const scale = 1_000_000n * 1000n;
  return Number((raw * BigInt(milli) + scale - 1n) / scale);
}

export const chargeMicros = (model: ModelRow, inputTokens: number, outputTokens: number): number => costMicros(model, inputTokens, outputTokens, multiplierMilli(model));

interface PeriodRow { id: string; period_end: unknown; included_micros: unknown; included_spent_micros: unknown; topup_spent_micros: unknown }

const latestPeriod = `select id, period_end, included_micros, included_spent_micros, topup_spent_micros from heyjosi.allowance_periods
  where household_id = $1 order by period_start desc limit 1`;

export type Reservation = { ok: true; id: string } | { ok: false; message: string };

export async function reserve(ctx: Ctx, args: { pool: Pool; accountId: string; serverId: string; model: ModelRow; amount: number }): Promise<Reservation> {
  const { pool, accountId, amount } = args;
  return inTx(ctx.db, async tx => {
    // Household first, member second, everywhere: one lock order, no deadlocks.
    const [household] = await tx.query<{ topup_micros: unknown }>('select topup_micros from heyjosi.households where id = $1 for update', [pool.householdId]);
    const [member] = await tx.query<{ cap_micros: unknown }>('select cap_micros from heyjosi.household_members where household_id = $1 and account_id = $2 for update', [pool.householdId, accountId]);
    if (!household || !member) return { ok: false, message: 'This account is no longer part of a Hey Josi AI plan. Check your account page.' };
    const [period] = await tx.query<PeriodRow>(latestPeriod, [pool.householdId]);
    const [open] = await tx.query<{ all_open: unknown; mine: unknown }>(
      `select coalesce(sum(amount_micros), 0) as all_open, coalesce(sum(amount_micros) filter (where account_id = $2), 0) as mine
         from heyjosi.reservations where household_id = $1 and state = 'open'`, [pool.householdId, accountId]);
    const left = period ? Math.max(0, num(period.included_micros) - num(period.included_spent_micros)) : 0;
    const available = left + num(household.topup_micros) - num(open?.all_open);
    if (amount > available) {
      const until = period ? ` or wait until your allowance renews on ${iso(period.period_end)!.slice(0, 10)}` : '';
      return { ok: false, message: `This request could cost up to ${usd(amount)}, and your household has ${usd(Math.max(0, available))} left, counting calls still running. Buy a top-up on your account page${until}, or ask for a shorter answer or a cheaper model.` };
    }
    if (member.cap_micros !== null) {
      const cap = num(member.cap_micros);
      const [spent] = period ? await tx.query<{ total: unknown }>('select coalesce(sum(charged_micros), 0) as total from heyjosi.usage_rows where period_id = $1 and account_id = $2', [period.id, accountId]) : [];
      const room = cap - num(spent?.total) - num(open?.mine);
      if (amount > room) return { ok: false, message: `This request could cost up to ${usd(amount)}, and this account has ${usd(Math.max(0, room))} left under its ${usd(cap)} cap. The household owner can raise the cap on the account page.` };
    }
    const [made] = await tx.query<{ id: string }>(
      `insert into heyjosi.reservations (household_id, account_id, server_id, model_id, amount_micros, expires_at) values ($1, $2, $3, $4, $5, $6::timestamptz) returning id`,
      [pool.householdId, accountId, args.serverId, args.model.id, amount, ctx.at(ctx.config.ai.reservationTtlMs)]);
    return { ok: true, id: made!.id };
  });
}

export type Outcome =
  | { kind: 'settled'; model: ModelRow; inputTokens: number; outputTokens: number }
  /** Nothing tells us what it cost, so it cost everything we set aside. */
  | { kind: 'unknown' } | { kind: 'expired' }
  /** OpenAI turned the call down or it never left, so it cost nothing. */
  | { kind: 'released' };

/** Safe to call twice or to race the sweep: a reservation closes exactly once. */
export async function settle(ctx: Ctx, reservationId: string, outcome: Outcome): Promise<void> {
  await inTx(ctx.db, async tx => {
    const [found] = await tx.query<{ household_id: string }>('select household_id from heyjosi.reservations where id = $1', [reservationId]);
    if (!found) return;
    const [household] = await tx.query<{ topup_micros: unknown }>('select topup_micros from heyjosi.households where id = $1 for update', [found.household_id]);
    const [row] = await tx.query<{ household_id: string; account_id: string; server_id: string | null; model_id: string; amount_micros: unknown }>(
      `update heyjosi.reservations set state = 'settled', settled_at = $2::timestamptz where id = $1 and state = 'open' returning household_id, account_id, server_id, model_id, amount_micros`, [reservationId, ctx.at()]);
    if (!row || !household) return;
    const reserved = num(row.amount_micros);
    let cost = reserved, wanted = reserved;
    if (outcome.kind === 'settled') {
      cost = costMicros(outcome.model, outcome.inputTokens, outcome.outputTokens);
      wanted = chargeMicros(outcome.model, outcome.inputTokens, outcome.outputTokens);
    } else if (outcome.kind === 'released') cost = wanted = 0;
    if (wanted > reserved) {
      // The bound was wrong, which it shouldn't be able to be. The customer's cap
      // still holds: the difference is ours, and the log says so.
      ctx.log('ai_over_reservation', { reserved, wanted, model: row.model_id });
      await audit(tx, row.account_id, 'ai.over_reservation', { reserved, wanted });
      wanted = reserved;
    }
    // The current period, even for a call that began in the last one. That can
    // only ever cost a few seconds' spending, and a period that's over has no room
    // of its own to keep accounting for.
    const [period] = await tx.query<PeriodRow>(`${latestPeriod} for update`, [row.household_id]);
    const left = period ? Math.max(0, num(period.included_micros) - num(period.included_spent_micros)) : 0;
    const fromIncluded = Math.min(wanted, left), fromTopUp = Math.min(wanted - fromIncluded, num(household.topup_micros));
    if (period) await tx.query('update heyjosi.allowance_periods set included_spent_micros = included_spent_micros + $2, topup_spent_micros = topup_spent_micros + $3 where id = $1', [period.id, fromIncluded, fromTopUp]);
    if (fromTopUp) await tx.query('update heyjosi.households set topup_micros = topup_micros - $2 where id = $1', [row.household_id, fromTopUp]);
    await tx.query(
      `insert into heyjosi.usage_rows (household_id, period_id, account_id, server_id, model_id, input_tokens, output_tokens, cost_micros, charged_micros, outcome)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [row.household_id, period?.id ?? null, row.account_id, row.server_id, row.model_id, outcome.kind === 'settled' ? outcome.inputTokens : null, outcome.kind === 'settled' ? outcome.outputTokens : null,
        cost, fromIncluded + fromTopUp, outcome.kind]);
  });
}

/** A call that never came back, most likely a crash here. It's charged in full,
 * because OpenAI may well have done the work. */
export async function sweepReservations(ctx: Ctx): Promise<number> {
  const stale = await ctx.db.query<{ id: string }>(`select id from heyjosi.reservations where state = 'open' and expires_at <= $1::timestamptz limit 500`, [ctx.at()]);
  for (const { id } of stale) await settle(ctx, id, { kind: 'expired' });
  return stale.length;
}

export async function enabledModels(ctx: Ctx): Promise<ModelRow[]> {
  return ctx.db.query<ModelRow>('select * from heyjosi.models where enabled order by is_default desc, id');
}

export async function usageFor(ctx: Ctx, accountId: string): Promise<HostedUsage> {
  const [{ plan, periodEnd }, pool, models] = [await planOf(ctx, accountId), await aiPool(ctx, accountId), await enabledModels(ctx)];
  const usage: HostedUsage = {
    plan, periodEnd, allowance: 0, topUps: 0, spent: 0, reserved: 0, remaining: 0, accountCap: null, accountSpent: 0,
    models: models.map(model => ({ id: model.id, label: model.label, multiplier: Number(model.multiplier), default: model.is_default })),
  };
  const [member] = await ctx.db.query<{ household_id: string; cap_micros: unknown; topup_micros: unknown }>(
    `select m.household_id, m.cap_micros, h.topup_micros from heyjosi.household_members m join heyjosi.households h on h.id = m.household_id where m.account_id = $1`, [accountId]);
  if (!member) return usage;
  const [period] = await ctx.db.query<PeriodRow>(latestPeriod, [member.household_id]);
  const [open] = await ctx.db.query<{ total: unknown }>(`select coalesce(sum(amount_micros), 0) as total from heyjosi.reservations where household_id = $1 and state = 'open'`, [member.household_id]);
  const [mine] = period ? await ctx.db.query<{ total: unknown }>('select coalesce(sum(charged_micros), 0) as total from heyjosi.usage_rows where period_id = $1 and account_id = $2', [period.id, accountId]) : [];
  const included = num(period?.included_micros), includedSpent = num(period?.included_spent_micros), topUpSpent = num(period?.topup_spent_micros);
  // `topUps` counts what this period already drew, so allowance + topUps - spent
  // - reserved adds up to `remaining` for anyone reading the numbers.
  usage.allowance = included;
  usage.topUps = num(member.topup_micros) + topUpSpent;
  usage.spent = includedSpent + topUpSpent;
  usage.reserved = num(open?.total);
  usage.remaining = pool ? Math.max(0, included - includedSpent + num(member.topup_micros) - usage.reserved) : 0;
  usage.accountCap = member.cap_micros === null ? null : num(member.cap_micros);
  usage.accountSpent = num(mine?.total);
  if (period) usage.periodEnd = iso(period.period_end);
  return usage;
}
