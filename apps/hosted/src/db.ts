import { json, type Db } from '@josi-ce/core';
import type { Ctx } from './context.js';
import { hmacHex } from './crypto.js';

export function inTx<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error('This needs a database with transactions');
  return db.transaction(work);
}

/** bigint comes back as a string from postgres.js and a number from PGlite. */
export const num = (value: unknown): number => Number(value ?? 0);

export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

export async function audit(db: Db, accountId: string | null, kind: string, detail: Record<string, string | number | boolean | null> = {}): Promise<void> {
  await db.query('insert into heyjosi.audit_events (account_id, kind, detail) values ($1, $2, $3)', [accountId, kind, json(detail)]);
}

/** Counts this try before deciding, so parallel attempts can't all slip in under
 * the limit. Returns false once the bucket is over. */
export async function hit(ctx: Ctx, bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  const key = hmacHex(ctx.rateKey, bucket);
  await ctx.db.query('insert into heyjosi.rate_hits (bucket, at) values ($1, $2::timestamptz)', [key, ctx.at()]);
  const [row] = await ctx.db.query<{ n: unknown }>('select count(*) as n from heyjosi.rate_hits where bucket = $1 and at > $2::timestamptz', [key, ctx.at(-windowSeconds * 1000)]);
  return num(row?.n) <= max;
}

export async function clearHits(ctx: Ctx, bucket: string): Promise<void> {
  await ctx.db.query('delete from heyjosi.rate_hits where bucket = $1', [hmacHex(ctx.rateKey, bucket)]);
}
