// What an account has paid for, worked out from Stripe's latest word each time it
// matters, so there's no second copy of "plan" to drift out of step.
import type { HostedUsage } from '@josi-ce/tunnel';
import type { Db } from '@josi-ce/core';
import type { Ctx } from './context.js';
import { iso } from './db.js';

export type Plan = HostedUsage['plan'];

export const PLANS: Record<Plan, { label: string; monthlyUsd: number; relay: boolean; ai: boolean }> = {
  free: { label: 'Free', monthlyUsd: 0, relay: false, ai: false },
  connect: { label: 'Connect', monthlyUsd: 8, relay: true, ai: false },
  connect_ai: { label: 'Connect + AI', monthlyUsd: 20, relay: true, ai: true },
};

/** Stripe can run a little behind a period's end, and a webhook can be late. Past
 * this, an "active" row is stale, and a lost cancellation mustn't give service
 * forever. */
const STALE_AFTER_MS = 3 * 86_400_000;

export interface PlanState { plan: Plan; status: string | null; periodEnd: string | null; cancelAtPeriodEnd: boolean }

export async function planOf(ctx: Ctx, accountId: string, db: Db = ctx.db): Promise<PlanState> {
  const [row] = await db.query<{ plan: Plan; status: string; current_period_end: unknown; cancel_at_period_end: boolean }>(
    `select s.plan, s.status, s.current_period_end, s.cancel_at_period_end
       from heyjosi.subscriptions s join heyjosi.accounts a on a.id = s.account_id
      where s.account_id = $1 and a.status = 'active' and s.status in ('active', 'trialing') and s.current_period_end > $2::timestamptz
      order by (s.plan = 'connect_ai') desc limit 1`, [accountId, ctx.at(-STALE_AFTER_MS)]);
  if (!row) return { plan: 'free', status: null, periodEnd: null, cancelAtPeriodEnd: false };
  return { plan: row.plan, status: row.status, periodEnd: iso(row.current_period_end), cancelAtPeriodEnd: row.cancel_at_period_end };
}

export interface Pool { householdId: string; ownerId: string; role: 'owner' | 'member' }

/** The pool this account may draw on, if any. A member has one only while the
 * household's owner is paying for AI. */
export async function aiPool(ctx: Ctx, accountId: string, db: Db = ctx.db): Promise<Pool | null> {
  const [row] = await db.query<{ household_id: string; owner_account_id: string; role: Pool['role']; status: string }>(
    `select m.household_id, h.owner_account_id, m.role, a.status from heyjosi.household_members m
       join heyjosi.households h on h.id = m.household_id
       join heyjosi.accounts a on a.id = m.account_id
      where m.account_id = $1`, [accountId]);
  if (!row || row.status !== 'active') return null;
  const owner = await planOf(ctx, row.owner_account_id, db);
  return owner.plan === 'connect_ai' ? { householdId: row.household_id, ownerId: row.owner_account_id, role: row.role } : null;
}
