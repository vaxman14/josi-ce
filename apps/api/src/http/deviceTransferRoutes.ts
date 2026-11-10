// "Send to my devices": a file goes from one Josi app to another of the same
// person's devices, or is offered to another person on this server.
//
// The app names its own device (its install id); a file sent to one's own
// device is fetched by that device on its next check, and a file sent to
// another person waits until they accept it on one of their devices. The
// bytes are held only until they are fetched, declined or a week has passed.
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import type { Db } from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { requireAuth } from './authz.js';

export const TRANSFER_MAX_BYTES = 25 * 1024 * 1024;
/** How many unfinished transfers one person may have waiting at a time. */
export const TRANSFER_MAX_WAITING = 20;
const DEVICE = /^[a-z]{2,8}-[0-9a-f]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// 'linux' is a Josi server's own PC service, which receives into the Linux user's Downloads folder.
const PLATFORMS = new Set(['windows', 'macos', 'android', 'ios', 'web', 'linux']);

class RouteError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
  try { return await fn(req, res); } catch (e) {
    if (e instanceof RouteError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});
function device(value: unknown): string {
  if (typeof value !== 'string' || !DEVICE.test(value)) throw new RouteError(400, 'This app did not name its device.');
  return value;
}
function transferId(req: Request): string {
  const id = param(req, 'id');
  if (!UUID.test(id)) throw new RouteError(404, 'That file is not waiting any more.');
  return id;
}
/** A file name safe to show and to save: no folders, no control characters. */
export function transferName(raw: string): string {
  let name = raw;
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'latin1')); } catch { /* keep the supplied name */ }
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()!.replace(/[<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 200);
  return name.length > 0 ? name : 'file';
}

interface Row { id: string; name: string; media_type: string; size: string | number; state: string; created_at: string; sender_user_id: string;
  recipient_user_id: string; from_device: string | null; to_device: string | null; sender: string; recipient: string; from_name: string | null; to_name: string | null }
const COLUMNS = `t.id, t.name, t.media_type, t.size, t.state, t.created_at, t.sender_user_id, t.recipient_user_id, t.from_device, t.to_device,
  coalesce(nullif(s.display_name, ''), s.username) as sender, coalesce(nullif(r.display_name, ''), r.username) as recipient,
  (select d.name from transfer_devices d where d.user_id = t.sender_user_id and d.id = t.from_device) as from_name,
  (select d.name from transfer_devices d where d.user_id = t.recipient_user_id and d.id = t.to_device) as to_name`;
const FROM = `device_transfers t join users s on s.id = t.sender_user_id join users r on r.id = t.recipient_user_id`;
const view = (row: Row, me: string) => ({ id: row.id, name: row.name, mediaType: row.media_type, size: Number(row.size), state: row.state, createdAt: row.created_at,
  own: row.sender_user_id === row.recipient_user_id, mine: row.sender_user_id === me, from: row.sender, fromDevice: row.from_name, to: row.recipient, toDevice: row.to_name });

export function deviceTransferRoutes(ctx: { db: Db }): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);
  r.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const receive = multer({ storage: multer.memoryStorage(), limits: { fileSize: TRANSFER_MAX_BYTES, files: 1, fields: 0, parts: 2 } });

  async function expire() {
    await db.query(`update device_transfers set state = 'expired', content = null, finished_at = now() where state in ('offered', 'accepted') and expires_at <= now()`);
    await db.query(`delete from device_transfers where state in ('delivered', 'declined', 'expired') and finished_at < now() - interval '30 days'`);
  }

  /** The app says which device it is. Called when it signs in and now and then. */
  r.put('/devices/:deviceId', handle(async (req, res) => {
    const id = device(param(req, 'deviceId'));
    const name = typeof req.body?.name === 'string' ? req.body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
    const platform = typeof req.body?.platform === 'string' ? req.body.platform : '';
    if (name.length === 0 || !PLATFORMS.has(platform)) throw new RouteError(400, 'A device needs a name and a platform.');
    await db.query(`insert into transfer_devices (user_id, id, name, platform) values ($1, $2, $3, $4)
      on conflict (user_id, id) do update set name = excluded.name, platform = excluded.platform, last_seen_at = now()`, [req.user!.id, id, name, platform]);
    return res.json({ ok: true });
  }));
  r.delete('/devices/:deviceId', handle(async (req, res) => {
    await db.query(`delete from transfer_devices where user_id = $1 and id = $2`, [req.user!.id, device(param(req, 'deviceId'))]);
    return res.status(204).end();
  }));

  /** Where a file can go: my other devices, and the other people here. */
  r.get('/devices', handle(async (req, res) => {
    const here = typeof req.query.deviceId === 'string' ? req.query.deviceId : '';
    const devices = await db.query<{ id: string; name: string; platform: string; last_seen_at: string }>(
      `select id, name, platform, last_seen_at from transfer_devices where user_id = $1 and id <> $2 order by last_seen_at desc`, [req.user!.id, here]);
    const people = await db.query<{ id: string; name: string }>(
      `select id, coalesce(nullif(display_name, ''), username) as name from users where status = 'active' and id <> $1 order by 2`, [req.user!.id]);
    return res.json({ devices: devices.map(d => ({ id: d.id, name: d.name, platform: d.platform, lastSeenAt: d.last_seen_at })), people, maxBytes: TRANSFER_MAX_BYTES });
  }));

  /** Send one file: ?toDevice= one of my devices, or ?toUser= another person. */
  r.post('/', (req, res, next) => receive.single('file')(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 25 MB, the most Josi sends between devices.' : 'Send one file at a time.' });
    return next(error);
  }), handle(async (req, res) => {
    const me = req.user!.id;
    const file = req.file;
    if (!file) throw new RouteError(400, 'Choose a file to send.');
    const from = typeof req.query.fromDevice === 'string' && DEVICE.test(req.query.fromDevice) ? req.query.fromDevice : null;
    const toDevice = typeof req.query.toDevice === 'string' ? req.query.toDevice : '';
    const toUser = typeof req.query.toUser === 'string' ? req.query.toUser : '';
    if ((toDevice.length > 0) === (toUser.length > 0)) throw new RouteError(400, 'Say which device or which person the file is for.');
    await expire();
    const [waiting] = await db.query<{ n: string | number }>(`select count(*) as n from device_transfers where sender_user_id = $1 and state in ('offered', 'accepted')`, [me]);
    if (Number(waiting?.n ?? 0) >= TRANSFER_MAX_WAITING) throw new RouteError(429, 'Too many files are still waiting to be received. Try again when some have arrived.');
    let recipient = me, target: string | null = null, state = 'accepted';
    if (toDevice.length > 0) {
      const [known] = await db.query(`select 1 from transfer_devices where user_id = $1 and id = $2`, [me, device(toDevice)]);
      if (!known) throw new RouteError(404, 'That device is not signed in to Josi as you.');
      if (toDevice === from) throw new RouteError(400, 'That is this device.');
      target = toDevice;
    } else {
      if (!UUID.test(toUser) || toUser === me) throw new RouteError(404, 'That person is not on this Josi.');
      const [person] = await db.query(`select 1 from users where id = $1 and status = 'active'`, [toUser]);
      if (!person) throw new RouteError(404, 'That person is not on this Josi.');
      recipient = toUser; state = 'offered';
    }
    const [row] = await db.query<{ id: string }>(`insert into device_transfers (sender_user_id, from_device, recipient_user_id, to_device, name, media_type, size, content, state)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [me, from, recipient, target, transferName(file.originalname), 'application/octet-stream', file.size, file.buffer, state]);
    return res.status(201).json({ id: row!.id, state });
  }));

  /** What waits for this device, and how the files it sent are doing. */
  r.get('/inbox', handle(async (req, res) => {
    const me = req.user!.id, here = device(req.query.deviceId);
    await expire();
    await db.query(`update transfer_devices set last_seen_at = now() where user_id = $1 and id = $2`, [me, here]);
    const waiting = await db.query<Row>(`select ${COLUMNS} from ${FROM} where t.recipient_user_id = $1 and t.expires_at > now()
      and ((t.state = 'accepted' and t.to_device = $2) or (t.state = 'offered' and t.sender_user_id <> $1)) order by t.created_at`, [me, here]);
    const sent = await db.query<Row>(`select ${COLUMNS} from ${FROM} where t.sender_user_id = $1 and t.from_device = $2
      and t.created_at > now() - interval '2 days' order by t.created_at desc limit 20`, [me, here]);
    return res.json({ transfers: waiting.map(row => view(row, me)), sent: sent.map(row => view(row, me)) });
  }));

  /** Another person's offer, accepted on this device: it is now this device's to fetch. */
  r.post('/:id/accept', handle(async (req, res) => {
    const [row] = await db.query<{ id: string }>(`update device_transfers set state = 'accepted', to_device = $3
      where id = $1 and recipient_user_id = $2 and state = 'offered' and expires_at > now() returning id`, [transferId(req), req.user!.id, device(req.body?.deviceId)]);
    if (!row) throw new RouteError(409, 'That file is not waiting any more.');
    return res.json({ ok: true, state: 'accepted' });
  }));
  /** Declined by the person it was for, or withdrawn by the person who sent it. */
  r.post('/:id/decline', handle(async (req, res) => {
    const [row] = await db.query<{ id: string }>(`update device_transfers set state = 'declined', content = null, finished_at = now()
      where id = $1 and (recipient_user_id = $2 or sender_user_id = $2) and state in ('offered', 'accepted') returning id`, [transferId(req), req.user!.id]);
    if (!row) throw new RouteError(409, 'That file is not waiting any more.');
    return res.json({ ok: true, state: 'declined' });
  }));
  r.get('/:id/content', handle(async (req, res) => {
    const [row] = await db.query<{ name: string; content: Uint8Array | null }>(`select name, content from device_transfers
      where id = $1 and recipient_user_id = $2 and state = 'accepted' and to_device = $3 and expires_at > now()`, [transferId(req), req.user!.id, device(req.query.deviceId)]);
    if (!row || !row.content) throw new RouteError(404, 'That file is not waiting any more.');
    const bytes = Buffer.from(row.content);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}` });
    return res.end(bytes);
  }));
  /** The device has the file: the server's copy is cleared. */
  r.post('/:id/received', handle(async (req, res) => {
    const [row] = await db.query<{ id: string }>(`update device_transfers set state = 'delivered', content = null, finished_at = now()
      where id = $1 and recipient_user_id = $2 and state = 'accepted' and to_device = $3 returning id`, [transferId(req), req.user!.id, device(req.body?.deviceId)]);
    if (!row) throw new RouteError(409, 'That file is not waiting any more.');
    return res.json({ ok: true, state: 'delivered' });
  }));
  return r;
}
