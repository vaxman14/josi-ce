// My World (docs/JOSI_IS_THE_INTERFACE.md rule 8): the person's own records.
//
// Everything here is the signed-in person's own World. Plain facts read and
// write freely; a secret value is written from a card or the page and read
// back only through /reveal, which needs the same five-minute unlock the
// Vault page uses (the person's password). The reveal is logged and meant
// for the screen; no route hands a secret value to a model.
import { Router, type Request, type Response } from 'express';
import { WorldError, WORLD_KIND_SPECS, addWorldMemory, asSecret, clearWorldSecret, deleteWorldItem, getWorldItem, listWorldItems, listWorldMemory,
  loadMasterKey, removeWorldMemory, revealWorldSecret, setWorldSecret, setWorldSensitivity, updateWorldMemory, upsertWorldItem, vaultUiUnlocked,
  VaultError, VaultLockedError, type Db, type LoadOptions, type MasterKey } from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { requireAuth } from './authz.js';

interface Ctx { db: Db; masterKey?: LoadOptions | false }
class RouteError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
  try { return await fn(req, res); } catch (e) {
    if (e instanceof RouteError || e instanceof WorldError) return res.status(e.status).json({ error: e.message });
    if (e instanceof VaultLockedError) return res.status(423).json({ error: e.message });
    if (e instanceof VaultError) return res.status(409).json({ error: e.message });
    throw e;
  }
});
function master(ctx: Ctx): MasterKey | null {
  if (ctx.masterKey === false) return null;
  try { return loadMasterKey(ctx.masterKey ?? {}); } catch { return null; }
}
function requireMaster(ctx: Ctx): MasterKey {
  const key = master(ctx);
  if (!key) throw new RouteError(503, 'the installation key is unavailable, so secrets cannot be stored right now');
  return key;
}
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

export function myWorldRoutes(ctx: Ctx): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);
  r.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const unlocked = (req: Request) => vaultUiUnlocked(db, { userId: req.user!.id, targetUserId: req.user!.id, sessionId: req.user!.session_id });

  /** The whole World: items with their plain facts and the names of the
   * secret fields that are set, the "Josi knows" lines, the kind specs the
   * page builds its forms from, and whether the five-minute unlock is on. */
  r.get('/', handle(async (req, res) => {
    const owner = req.user!.id;
    return res.json({ kinds: WORLD_KIND_SPECS, items: await listWorldItems(db, owner, master(ctx)), memory: await listWorldMemory(db, owner), unlocked: await unlocked(req) });
  }));
  r.post('/items', handle(async (req, res) => {
    const item = await upsertWorldItem(db, { ownerUserId: req.user!.id, kind: req.body?.kind, label: req.body?.label, fields: req.body?.fields, dates: req.body?.dates, actor: 'page', masterKey: master(ctx) });
    return res.status(201).json({ item });
  }));
  r.put('/items/:id', handle(async (req, res) => {
    const item = await upsertWorldItem(db, { ownerUserId: req.user!.id, id: param(req, 'id'), label: req.body?.label, fields: req.body?.fields, dates: req.body?.dates, actor: 'page', masterKey: master(ctx) });
    return res.json({ item });
  }));
  r.delete('/items/:id', handle(async (req, res) => {
    if (!(await deleteWorldItem(db, req.user!.id, param(req, 'id')))) throw new RouteError(404, 'That item is not in this World.');
    return res.status(204).end();
  }));
  r.put('/items/:id/sensitivity', handle(async (req, res) => res.json({ item: await setWorldSensitivity(db, req.user!.id, param(req, 'id'), req.body?.secretKeys) })));
  /** A secret field, from a credential card or the page. Writing needs no
   * unlock: nothing readable comes back. */
  r.put('/items/:id/secrets/:key', handle(async (req, res) => {
    const key = param(req, 'key');
    if (!KEY.test(key)) throw new RouteError(400, 'That is not a usable field name.');
    const item = await setWorldSecret(db, requireMaster(ctx), { ownerUserId: req.user!.id, id: param(req, 'id'), key, value: asSecret(req.body?.value) });
    return res.json({ item });
  }));
  r.delete('/items/:id/secrets/:key', handle(async (req, res) => res.json({ item: await clearWorldSecret(db, requireMaster(ctx), { ownerUserId: req.user!.id, id: param(req, 'id'), key: param(req, 'key') }) })));
  /** Screen only, behind the password (POST /vault/unlock), logged. */
  r.post('/items/:id/secrets/:key/reveal', handle(async (req, res) => {
    if (!(await unlocked(req))) throw new RouteError(401, 'Unlock My World with your password first.');
    const item = await getWorldItem(db, req.user!.id, param(req, 'id'));
    if (!item) throw new RouteError(404, 'That item is not in this World.');
    const value = await revealWorldSecret(db, requireMaster(ctx), { ownerUserId: req.user!.id, id: item.id, key: param(req, 'key'), actorUserId: req.user!.id });
    return res.json({ value: value.reveal(), screenOnly: true });
  }));

  r.post('/memory', handle(async (req, res) => res.status(201).json({ line: await addWorldMemory(db, { ownerUserId: req.user!.id, content: String(req.body?.content ?? ''), itemId: typeof req.body?.itemId === 'string' ? req.body.itemId : null, source: 'page' }) })));
  r.put('/memory/:id', handle(async (req, res) => res.json({ line: await updateWorldMemory(db, req.user!.id, param(req, 'id'), String(req.body?.content ?? '')) })));
  r.delete('/memory/:id', handle(async (req, res) => {
    if (!(await removeWorldMemory(db, req.user!.id, param(req, 'id')))) throw new RouteError(404, 'That line is not in this World.');
    return res.status(204).end();
  }));
  return r;
}
