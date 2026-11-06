// The server's side of the account: every call is one sealed Noise exchange, and
// the caller is whoever the handshake proved. Nothing in a call's body can claim
// to be another server.
import { RPC_SKEW_MS, checkedDh, fromB64url, isPairingCode, normalizeCode, codeHash, rpcAnswer, toB64url, toHex, randomBytes, type HostedCall, type HostedDevice, type RpcEnvelope } from '@josi-ce/tunnel';
import type { Db } from '@josi-ce/core';
import { usageFor } from './ai/allowance.js';
import type { Ctx } from './context.js';
import { randomToken, sha256 } from './crypto.js';
import { audit, inTx } from './db.js';
import { googleAuthorize, googleRefresh } from './google.js';
import { signGrant } from './grants.js';
import { aiPool, planOf } from './plans.js';

/** How long a rotated-away key still works. It covers a reply lost on the way
 * back, and no more: a rotation may be because the old key leaked. */
const KEY_OVERLAP_MS = 86_400_000;
const MAX_DEVICES = 500;

export interface ServerRow {
  id: string; account_id: string; noise_public: string; noise_previous: string | null; previous_until: unknown; site: string; name: string;
  ai_token_hash: string | null;
}

async function seen(ctx: Ctx, nonce: string): Promise<boolean> {
  if (nonce.length > 64) return true;
  // Held a little past both ends of the window a message can arrive in.
  const added = await ctx.db.query('insert into heyjosi.rpc_nonces (nonce, expires_at) values ($1, $2::timestamptz) on conflict (nonce) do nothing returning nonce', [nonce, ctx.at(RPC_SKEW_MS * 2 + 60_000)]);
  return added.length === 0;
}

export function answerRpc(ctx: Ctx, message: Uint8Array): Promise<Uint8Array> {
  return rpcAnswer({
    key: ctx.noiseKey, message, seen: nonce => seen(ctx, nonce),
    handle: async (call, caller) => {
      try { return await dispatch(ctx, call, toB64url(caller)); } catch (error) {
        ctx.log('rpc_failed', { op: String(call.op), kind: (error as Error).name });
        return { ok: false, error: 'internal', message: 'Something went wrong at heyjosi.com. Try again in a minute.' };
      }
    },
  });
}

async function serverForKey(ctx: Ctx, key: string, db: Db = ctx.db): Promise<ServerRow | null> {
  const [row] = await db.query<ServerRow>(
    `select * from heyjosi.servers where noise_public = $1 or (noise_previous = $1 and previous_until > $2::timestamptz)
      order by (noise_public = $1) desc limit 1`, [key, ctx.at()]);
  return row ?? null;
}

async function dispatch(ctx: Ctx, call: HostedCall & RpcEnvelope, caller: string): Promise<Record<string, unknown>> {
  if (call.op === 'link') return link(ctx, call, caller);
  // The refresh key belongs to a server's background worker. It's good for this
  // one call, so nothing it can reach is worth more than the tokens it refreshes.
  const [byRefreshKey] = call.op === 'google.refresh' ? await ctx.db.query<ServerRow>('select * from heyjosi.servers where refresh_public = $1', [caller]) : [];
  const server = byRefreshKey ?? await serverForKey(ctx, caller);
  if (!server) return { ok: false, error: 'unknown_server', message: 'This server isn\'t linked to an account.' };
  switch (call.op) {
    case 'sync': return sync(ctx, server, call);
    case 'rotate-key': return rotateKey(ctx, server, caller, call);
    case 'unlink': return unlink(ctx, server);
    case 'google.authorize': return googleAuthorize(ctx, server, call);
    case 'google.refresh': return googleRefresh(ctx, server, call);
    default: return { ok: false, error: 'unknown_op' };
  }
}

const BAD_CODE = { ok: false, error: 'bad_code', message: 'That code was wrong, used, or expired. Make a new one on your account page.' };

async function link(ctx: Ctx, call: Extract<HostedCall, { op: 'link' }>, caller: string): Promise<Record<string, unknown>> {
  const code = normalizeCode(String(call.code ?? ''));
  if (!isPairingCode(code)) return BAD_CODE;
  const version = String(call.version ?? '').slice(0, 40);
  const linked = await inTx(ctx.db, async tx => {
    const [used] = await tx.query<{ account_id: string }>(
      `update heyjosi.link_codes set used_at = $2::timestamptz where code_hash = $1 and used_at is null and expires_at > $2::timestamptz returning account_id`, [codeHash(code), ctx.at()]);
    if (!used) return null;
    const [account] = await tx.query<{ handle: string }>(`select handle from heyjosi.accounts where id = $1 and status = 'active'`, [used.account_id]);
    if (!account) return null;
    const existing = await serverForKey(ctx, caller, tx);
    if (existing && existing.account_id !== used.account_id) return 'key_in_use' as const;
    if (existing) return { server: existing, name: account.handle, accountId: used.account_id };
    // A new key for this account is a new machine. It gets its own site, and the
    // relay moves the name across on its first, newer grant.
    await tx.query('delete from heyjosi.servers where account_id = $1', [used.account_id]);
    const [server] = await tx.query<ServerRow>(
      `insert into heyjosi.servers (account_id, noise_public, site, name, version) values ($1, $2, $3, $4, $5) returning *`,
      [used.account_id, caller, toHex(randomBytes(16)), account.handle, version]);
    await audit(tx, used.account_id, 'server.linked');
    return { server: server!, name: account.handle, accountId: used.account_id };
  });
  if (!linked) return BAD_CODE;
  if (linked === 'key_in_use') return { ok: false, error: 'key_in_use', message: 'This server is linked to another account. Unlink it there first.' };
  const { plan } = await planOf(ctx, linked.accountId);
  return { ok: true, serverId: linked.server.id, site: linked.server.site, name: linked.name, hostedPublic: ctx.hostedPublic, relayUrl: ctx.config.relayUrl, plan };
}

const text = (value: unknown, max: number): string => String(value ?? '').slice(0, max);
function when(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

async function recordDevices(ctx: Ctx, tx: Db, serverId: string, devices: HostedDevice[]): Promise<void> {
  for (const device of devices) {
    await tx.query(
      `insert into heyjosi.devices (server_id, device_id, name, platform, paired_at, last_seen_at, revoked_at)
       values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz)
       on conflict (server_id, device_id) do update set name = excluded.name, platform = excluded.platform,
         paired_at = excluded.paired_at, last_seen_at = excluded.last_seen_at, revoked_at = excluded.revoked_at`,
      [serverId, text(device.id, 80), text(device.name, 80), text(device.platform, 24), when(device.pairedAt), when(device.lastSeenAt), when(device.revokedAt)]);
  }
  // The server's list is the truth. A device it no longer has is gone.
  const ids = devices.map(device => text(device.id, 80));
  const known = await tx.query<{ device_id: string }>('select device_id from heyjosi.devices where server_id = $1', [serverId]);
  for (const { device_id: id } of known) if (!ids.includes(id)) await tx.query('delete from heyjosi.devices where server_id = $1 and device_id = $2', [serverId, id]);
}

async function sync(ctx: Ctx, server: ServerRow, call: Extract<HostedCall, { op: 'sync' }>): Promise<Record<string, unknown>> {
  const devices = Array.isArray(call.devices) ? call.devices.slice(0, MAX_DEVICES) : [];
  await inTx(ctx.db, async tx => {
    await recordDevices(ctx, tx, server.id, devices);
    if (typeof call.refreshKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(call.refreshKey)) await tx.query('update heyjosi.servers set refresh_public = $2 where id = $1', [server.id, call.refreshKey]);
    await tx.query('update heyjosi.servers set version = $2, lan = $3, last_sync_at = $4::timestamptz where id = $1', [server.id, text(call.version, 40), !!call.lan, ctx.at()]);
  });
  const { plan } = await planOf(ctx, server.account_id);
  const pool = await aiPool(ctx, server.account_id);
  const grant = plan === 'free' ? null : signGrant(ctx, server.site, server.name);
  let aiToken: string | null = null;
  if (pool && !server.ai_token_hash) {
    const candidate = `hj_ai_${randomToken()}`;
    // Conditional, so two syncs at once can't each hand out a token.
    const issued = await ctx.db.query(
      'update heyjosi.servers set ai_token_hash = $2, ai_token_issued_at = $3::timestamptz where id = $1 and ai_token_hash is null returning id', [server.id, sha256(candidate), ctx.at()]);
    if (issued.length) { aiToken = candidate; await audit(ctx.db, server.account_id, 'ai_token.issued'); }
  } else if (!pool && server.ai_token_hash) {
    // Dropped when AI ends, so gaining it again hands out a fresh one.
    await ctx.db.query('update heyjosi.servers set ai_token_hash = null, ai_token_issued_at = null where id = $1', [server.id]);
  }
  const pending = await ctx.db.query<{ device_id: string }>(
    'select device_id from heyjosi.devices where server_id = $1 and revoke_requested_at is not null and revoked_at is null', [server.id]);
  return {
    ok: true, plan, name: server.name, grant, aiToken, aiBaseUrl: pool ? `${ctx.config.publicOrigin}/ai/v1` : null,
    usage: await usageFor(ctx, server.account_id), revoke: pending.map(row => row.device_id),
  };
}

async function rotateKey(ctx: Ctx, server: ServerRow, caller: string, call: Extract<HostedCall, { op: 'rotate-key' }>): Promise<Record<string, unknown>> {
  const next = String(call.publicKey ?? '');
  // The old key asking for the key we already moved to: its first reply got lost.
  if (next === server.noise_public) return { ok: true };
  if (caller !== server.noise_public) return { ok: false, error: 'stale_key', message: 'This key has been replaced.' };
  try {
    const bytes = fromB64url(next);
    if (bytes.length !== 32) throw new Error('short');
    checkedDh(ctx.config.noisePrivateKey, bytes);
  } catch { return { ok: false, error: 'bad_key', message: 'That key can\'t be used.' }; }
  const [taken] = await ctx.db.query('select 1 from heyjosi.servers where noise_public = $1 or noise_previous = $1', [next]);
  if (taken) return { ok: false, error: 'key_in_use', message: 'That key belongs to another server.' };
  await ctx.db.query('update heyjosi.servers set noise_previous = noise_public, noise_public = $2, previous_until = $3::timestamptz where id = $1', [server.id, next, ctx.at(KEY_OVERLAP_MS)]);
  await audit(ctx.db, server.account_id, 'server.key_rotated');
  return { ok: true };
}

async function unlink(ctx: Ctx, server: ServerRow): Promise<Record<string, unknown>> {
  await inTx(ctx.db, async tx => {
    await tx.query('delete from heyjosi.servers where id = $1', [server.id]);
    await audit(tx, server.account_id, 'server.unlinked');
  });
  return { ok: true };
}
