// Hey Josi on the server's own API. An administrator links the account and
// handles keys; anyone signed in pairs and revokes their own devices.
import { Router, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { verifyPassword } from '@josi-ce/auth';
import { saveModelConfiguration } from '@josi-ce/llm';
import { loadMasterKey, type Db, type LoadOptions } from '@josi-ce/core';
import { asyncRoute, param } from '../http/async.js';
import { requireAuth, requireSuperAdmin } from '../http/authz.js';
import { RelayError, type DeviceRow, type RelayService } from './relayService.js';

export interface RelayRoutesCtx { db: Db; relay: RelayService; masterKey?: LoadOptions | false }

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
  try { return await fn(req, res); } catch (error) {
    if (error instanceof RelayError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

/** Never the key itself, though a public key isn't secret: nothing here needs it. */
const view = (d: DeviceRow) => ({ id: d.id, ownerUserId: d.owner_user_id, name: d.name, platform: d.platform, pairedAt: d.paired_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at });

async function confirmPassword(ctx: RelayRoutesCtx, req: Request): Promise<void> {
  const [user] = await ctx.db.query<{ password_hash: string | null }>('select password_hash from users where id = $1', [req.user!.id]);
  if (!await verifyPassword(user?.password_hash ?? null, typeof req.body?.password === 'string' ? req.body.password : '')) throw new RelayError(401, 'That password did not match.');
}

export function relayRoutes(ctx: RelayRoutesCtx): Router {
  const r = Router();
  const { relay } = ctx;
  r.use(requireAuth);
  r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  r.get('/', handle(async (_req, res) => {
    const status = await relay.status();
    return res.json({ address: status.address, plan: status.plan, relay: status.relay.state, usage: status.usage });
  }));

  r.get('/devices', handle(async (req, res) => {
    const everyone = req.query.all === '1' && req.user!.role === 'super_admin';
    return res.json({ devices: (await relay.devices(everyone ? null : req.user!.id)).map(view), connected: relay.tunnelHost.connected() });
  }));

  /** A code opens the transport for one device and nothing else, so any member
   * may make one. They still sign in as themselves afterwards. */
  r.post('/pairing', handle(async (req, res) => {
    const pairing = await relay.createPairing(req.user!.id);
    return res.status(201).json({ ...pairing, qr: pairing.link ? await QRCode.toDataURL(pairing.link, { margin: 1, width: 280 }) : null });
  }));

  r.delete('/devices/:id', handle(async (req, res) => {
    const id = param(req, 'id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: 'not found' });
    const [device] = (await relay.devices(null)).filter(d => d.id === id);
    if (!device || (device.owner_user_id !== req.user!.id && req.user!.role !== 'super_admin')) return res.status(404).json({ error: 'not found' });
    await relay.revoke(id, req.user!.id);
    return res.json({ ok: true });
  }));
  return r;
}

export function adminRelayRoutes(ctx: RelayRoutesCtx): Router {
  const r = Router();
  const { relay } = ctx;
  r.use(requireSuperAdmin);
  r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  r.get('/', handle(async (_req, res) => res.json(await relay.status())));

  r.post('/link', handle(async (req, res) => {
    await confirmPassword(ctx, req);
    const code = typeof req.body?.code === 'string' ? req.body.code.toUpperCase().replace(/[\s-]/g, '') : '';
    if (!code) return res.status(400).json({ error: 'Enter the code from your account page.' });
    await relay.linkAccount({ code, actorUserId: req.user!.id });
    return res.json(await relay.status());
  }));

  r.post('/own-relay', handle(async (req, res) => {
    await confirmPassword(ctx, req);
    const name = typeof req.body?.name === 'string' && req.body.name ? req.body.name : null;
    await relay.useOwnRelay({ relayUrl: String(req.body?.relayUrl ?? ''), name, actorUserId: req.user!.id });
    return res.json(await relay.status());
  }));

  r.post('/unlink', handle(async (req, res) => {
    await confirmPassword(ctx, req);
    await relay.unlink(req.user!.id);
    return res.json(await relay.status());
  }));

  r.post('/sync', handle(async (_req, res) => { await relay.sync(); return res.json(await relay.status()); }));

  r.put('/lan', handle(async (req, res) => { await relay.setLan(req.body?.enabled === true); return res.json(await relay.status()); }));

  r.post('/keys/rotate', handle(async (req, res) => {
    await confirmPassword(ctx, req);
    return res.json(await relay.rotateServerKey({ immediate: req.body?.immediate === true, actorUserId: req.user!.id }));
  }));

  /** Makes Hey Josi AI this server's model. The usual check of the provider, on
   * the Model page, still has to pass before it answers anything. */
  r.post('/ai/use', handle(async (req, res) => {
    const token = await relay.aiToken();
    const status = await relay.status();
    if (!token || !status.aiBaseUrl) return res.status(409).json({ error: 'Your plan doesn\'t include Hey Josi AI yet.' });
    if (ctx.masterKey === false) return res.status(503).json({ error: 'The installation key is unavailable.' });
    await saveModelConfiguration(ctx.db, loadMasterKey(ctx.masterKey ?? {}), {
      role: 'primary', provider: 'hey_josi', model: 'gpt-5.6-luna', baseUrl: status.aiBaseUrl, acknowledged: true,
      secrets: { apiKey: token }, settings: {}, actorUserId: req.user!.id, preserveMissingSecrets: false,
    });
    return res.json({ ok: true });
  }));
  return r;
}
