// What the relay trusts: short signed statements from this service. A grant says
// a site may hold a name until a time; a revocation takes a name back.
import { ed25519 } from '@noble/curves/ed25519.js';
import type { Db } from '@josi-ce/core';
import { toB64url, utf8 } from '@josi-ce/tunnel';
import type { Ctx } from './context.js';

export const GRANT_DAYS = 7;
const REVOKE_SECONDS = 600;   // the relay refuses more than 900

function sign(ctx: Ctx, claims: Record<string, unknown>): string {
  const body = toB64url(utf8(JSON.stringify(claims)));
  return `${body}.${toB64url(ed25519.sign(utf8(body), ctx.config.grantPrivateKey))}`;
}

export function signGrant(ctx: Ctx, site: string, name: string): string {
  const iat = Math.floor(ctx.now() / 1000);
  return sign(ctx, { typ: 'relay-grant', site, name, iat, exp: iat + GRANT_DAYS * 86_400 });
}

export function signRevocation(ctx: Ctx, name: string): string {
  const iat = Math.floor(ctx.now() / 1000);
  return sign(ctx, { typ: 'relay-revoke', name, iat, exp: iat + REVOKE_SECONDS });
}

export async function queueRevocation(ctx: Ctx, db: Db, name: string): Promise<void> {
  await db.query('insert into heyjosi.relay_revocations (name, requested_at) values ($1, $2::timestamptz) on conflict (name) do nothing', [name, ctx.at()]);
}

/** Tried at once and then by the sweep, until the relay says yes. A fresh
 * signature each time, since a revocation is only good for minutes. */
export async function flushRevocations(ctx: Ctx): Promise<void> {
  for (const { name } of await ctx.db.query<{ name: string }>('select name from heyjosi.relay_revocations order by requested_at limit 50')) {
    let done = false;
    try {
      const res = await ctx.fetch(`${ctx.config.relayUrl.replace(/^ws/, 'http')}/v1/names/revoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revoke: signRevocation(ctx, name) }), signal: AbortSignal.timeout(15_000),
      });
      done = res.ok;
      if (!done) ctx.log('relay_revoke_refused', { status: res.status });
    } catch { ctx.log('relay_revoke_failed'); }
    if (done) await ctx.db.query('delete from heyjosi.relay_revocations where name = $1', [name]);
    else await ctx.db.query('update heyjosi.relay_revocations set attempts = attempts + 1 where name = $1', [name]);
  }
}
