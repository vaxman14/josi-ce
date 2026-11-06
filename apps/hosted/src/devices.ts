import type { Ctx } from './context.js';
import { audit, iso } from './db.js';
import { HttpError } from './errors.js';
import { askServer } from './peer.js';

interface ServerRow { id: string; site: string; noise_public: string }

export async function listDevices(ctx: Ctx, accountId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await ctx.db.query<{ device_id: string; name: string; platform: string; paired_at: unknown; last_seen_at: unknown; revoked_at: unknown; revoke_requested_at: unknown }>(
    `select d.* from heyjosi.devices d join heyjosi.servers s on s.id = d.server_id where s.account_id = $1 order by d.paired_at desc nulls last`, [accountId]);
  return rows.map(row => ({ id: row.device_id, name: row.name, platform: row.platform, pairedAt: iso(row.paired_at), lastSeenAt: iso(row.last_seen_at),
    revokedAt: iso(row.revoked_at), revokePending: !!row.revoke_requested_at && !row.revoked_at }));
}

/** Marked first, so the next sync carries it whatever happens here. The direct
 * attempt only makes it sooner, and a server that's off simply hears at sync. */
export async function revokeDevice(ctx: Ctx, accountId: string, deviceId: string): Promise<{ delivered: boolean }> {
  const [server] = await ctx.db.query<ServerRow>('select id, site, noise_public from heyjosi.servers where account_id = $1', [accountId]);
  if (!server) throw new HttpError(404, 'No such device.');
  const marked = await ctx.db.query(
    `update heyjosi.devices set revoke_requested_at = coalesce(revoke_requested_at, $3::timestamptz) where server_id = $1 and device_id = $2 returning device_id`, [server.id, deviceId, ctx.at()]);
  if (!marked.length) throw new HttpError(404, 'No such device.');
  await audit(ctx.db, accountId, 'device.revoke_requested');
  try {
    const reply = await askServer(ctx, server, { v: 1, op: 'revoke-device', device: deviceId, ts: ctx.now() });
    if (reply.ok !== true) return { delivered: false };
    await ctx.db.query('update heyjosi.devices set revoke_delivered_at = $3::timestamptz where server_id = $1 and device_id = $2', [server.id, deviceId, ctx.at()]);
    return { delivered: true };
  } catch { return { delivered: false }; }
}
