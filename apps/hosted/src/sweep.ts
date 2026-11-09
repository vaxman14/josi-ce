import { sweepReservations } from './ai/allowance.js';
import type { Ctx } from './context.js';
import { flushRevocations } from './grants.js';

const UNVERIFIED_MS = 3 * 86_400_000;

/** Runs on a timer. Each step stands alone, so one failing doesn't stop the rest. */
export async function sweep(ctx: Ctx): Promise<void> {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['reservations', () => sweepReservations(ctx)],
    ['revocations', () => flushRevocations(ctx)],
    ['nonces', () => ctx.db.query('delete from heyjosi.rpc_nonces where expires_at < $1::timestamptz', [ctx.at()])],
    ['sessions', () => ctx.db.query('delete from heyjosi.sessions where expires_at < $1::timestamptz', [ctx.at()])],
    ['tokens', () => ctx.db.query('delete from heyjosi.email_tokens where expires_at < $1::timestamptz', [ctx.at()])],
    ['codes', () => ctx.db.query('delete from heyjosi.link_codes where expires_at < $1::timestamptz', [ctx.at()])],
    ['rate', () => ctx.db.query('delete from heyjosi.rate_hits where at < $1::timestamptz', [ctx.at(-86_400_000)])],
    // Someone who never confirmed shouldn't hold a name forever.
    ['unverified', () => ctx.db.query('delete from heyjosi.accounts where email_verified_at is null and created_at < $1::timestamptz', [ctx.at(-UNVERIFIED_MS)])],
  ];
  for (const [name, step] of steps) await step().catch(() => ctx.log('sweep_failed', { step: name }));
}
