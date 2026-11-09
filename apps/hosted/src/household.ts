// A household is one paying account's AI pool and the accounts that share it.
// Sharing covers AI only: the relay and an address stay with each account's own
// plan. Joining takes the member's own yes, since the owner can see their usage.
import type { Db } from '@josi-ce/core';
import { mail, normalizeEmail, useToken, type Session } from './accounts.js';
import type { Ctx } from './context.js';
import { randomToken, sha256 } from './crypto.js';
import { audit, hit, inTx, iso, num } from './db.js';
import { HttpError } from './errors.js';
import { aiPool } from './plans.js';

const MAX_MEMBERS = 6;
const INVITE_TTL_MS = 7 * 86_400_000;

export async function ensureHousehold(db: Db, accountId: string): Promise<string> {
  const [owned] = await db.query<{ id: string }>('select id from heyjosi.households where owner_account_id = $1', [accountId]);
  if (owned) return owned.id;
  // Paying for AI themselves takes them out of anyone else's pool.
  await db.query('delete from heyjosi.household_members where account_id = $1', [accountId]);
  const [made] = await db.query<{ id: string }>('insert into heyjosi.households (owner_account_id) values ($1) returning id', [accountId]);
  await db.query(`insert into heyjosi.household_members (household_id, account_id, role) values ($1, $2, 'owner')`, [made!.id, accountId]);
  return made!.id;
}

async function ownedPool(ctx: Ctx, accountId: string): Promise<string> {
  const pool = await aiPool(ctx, accountId);
  if (!pool || pool.role !== 'owner') throw new HttpError(403, 'Only the person paying for Connect + AI can change the household.');
  return pool.householdId;
}

export async function inviteMember(ctx: Ctx, accountId: string, email: unknown): Promise<void> {
  const householdId = await ownedPool(ctx, accountId), to = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, 'Enter a valid email address.');
  if (!await hit(ctx, `invite:${accountId}`, 20, 86_400)) throw new HttpError(429, 'Too many invites today. Try again tomorrow.');
  const [row] = await ctx.db.query<{ n: unknown }>('select count(*) as n from heyjosi.household_members where household_id = $1', [householdId]);
  if (num(row?.n) >= MAX_MEMBERS) throw new HttpError(409, `A household can have ${MAX_MEMBERS} people.`);
  const token = randomToken();
  await ctx.db.query(`insert into heyjosi.email_tokens (account_id, kind, token_hash, email, household_id, expires_at) values ($1, 'household', $2, $3, $4, $5::timestamptz)`,
    [accountId, sha256(token), to, householdId, ctx.at(INVITE_TTL_MS)]);
  await audit(ctx.db, accountId, 'household.invited');
  await mail(ctx, to, 'Join a Hey Josi household', `You've been invited to share a Hey Josi AI allowance. The person paying can see how much you use, but not what you ask.\n\nLog in or sign up with this email, then open:\n\n${ctx.config.publicOrigin}/join#token=${token}\n\nThis link works for 7 days.`);
}

export async function acceptInvite(ctx: Ctx, session: Session, token: unknown): Promise<void> {
  const accountId = session.account.id;
  await inTx(ctx.db, async tx => {
    const invite = await useToken(ctx, tx, token, 'household');
    if (!invite?.household_id || invite.email !== session.account.email) throw new HttpError(400, 'That invite is wrong, used or expired, or it was sent to another email.');
    const [household] = await tx.query<{ id: string }>('select id from heyjosi.households where id = $1 for update', [invite.household_id]);
    if (!household) throw new HttpError(400, 'That household no longer exists.');
    const [own] = await tx.query<{ id: string; topup_micros: unknown }>('select id, topup_micros from heyjosi.households where owner_account_id = $1', [accountId]);
    if (own && await aiPool(ctx, accountId, tx)) throw new HttpError(409, 'You pay for your own AI plan. Cancel it before joining a household.');
    if (own && num(own.topup_micros) > 0) throw new HttpError(409, 'You have top-up credit in your own household, and joining this one would lose it.');
    if (own) await tx.query('delete from heyjosi.households where id = $1', [own.id]);
    const [count] = await tx.query<{ n: unknown }>('select count(*) as n from heyjosi.household_members where household_id = $1', [household.id]);
    if (num(count?.n) >= MAX_MEMBERS) throw new HttpError(409, 'That household is full.');
    await tx.query('delete from heyjosi.household_members where account_id = $1', [accountId]);
    await tx.query(`insert into heyjosi.household_members (household_id, account_id, role) values ($1, $2, 'member')`, [household.id, accountId]);
    await audit(tx, accountId, 'household.joined');
  });
}

export async function setMemberCap(ctx: Ctx, ownerId: string, memberId: string, capUsd: unknown): Promise<void> {
  const householdId = await ownedPool(ctx, ownerId);
  const cap = capUsd === null || capUsd === '' || capUsd === undefined ? null : Number(capUsd);
  if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 100_000)) throw new HttpError(400, 'Enter a dollar amount, or leave it empty for no cap.');
  const changed = await ctx.db.query('update heyjosi.household_members set cap_micros = $3 where household_id = $1 and account_id = $2 returning account_id',
    [householdId, memberId, cap === null ? null : Math.round(cap * 1_000_000)]);
  if (!changed.length) throw new HttpError(404, 'That person isn\'t in your household.');
  await audit(ctx.db, ownerId, 'household.cap_set');
}

/** The owner can remove anyone else, and a member can always leave. */
export async function removeMember(ctx: Ctx, actorId: string, memberId: string): Promise<void> {
  const [target] = await ctx.db.query<{ household_id: string; role: string; owner_account_id: string }>(
    `select m.household_id, m.role, h.owner_account_id from heyjosi.household_members m join heyjosi.households h on h.id = m.household_id where m.account_id = $1`, [memberId]);
  if (!target || (actorId !== memberId && actorId !== target.owner_account_id)) throw new HttpError(404, 'That person isn\'t in your household.');
  if (target.role === 'owner') throw new HttpError(409, 'The person paying can\'t leave their own household.');
  await ctx.db.query('delete from heyjosi.household_members where account_id = $1', [memberId]);
  await audit(ctx.db, actorId, 'household.member_removed');
}

export async function householdView(ctx: Ctx, accountId: string): Promise<Record<string, unknown> | null> {
  const [own] = await ctx.db.query<{ household_id: string; role: string }>('select household_id, role from heyjosi.household_members where account_id = $1', [accountId]);
  if (!own) return null;
  const rows = await ctx.db.query<{ account_id: string; handle: string; role: string; cap_micros: unknown; joined_at: unknown; spent: unknown }>(
    `select m.account_id, a.handle, m.role, m.cap_micros, m.joined_at,
            coalesce((select sum(u.charged_micros) from heyjosi.usage_rows u where u.account_id = m.account_id and u.period_id = (
              select p.id from heyjosi.allowance_periods p where p.household_id = m.household_id order by p.period_start desc limit 1)), 0) as spent
       from heyjosi.household_members m join heyjosi.accounts a on a.id = m.account_id
      where m.household_id = $1 order by m.role desc, m.joined_at`, [own.household_id]);
  return {
    role: own.role,
    members: rows.map(row => ({ id: row.account_id, handle: row.handle, role: row.role, capMicros: row.cap_micros === null ? null : num(row.cap_micros), spentMicros: num(row.spent), joinedAt: iso(row.joined_at), you: row.account_id === accountId })),
  };
}
