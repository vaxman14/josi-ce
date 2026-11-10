// You sign in for Josi: the owner's side of docs/LIVE_SIGN_IN.md.
//
// A sign-in card (area `sign_in_card`) opens a session between the person's
// browser and the PC service through the in-memory broker
// (packages/core/src/liveSignIn.ts). What the person sees and types is relayed
// and never stored, logged or shown to the model; the outcome is one note in
// the thread.
import { Router, type Request, type Response } from 'express';
import { addMessage, cleanEvents, mayLiveSignIn, type Db, type LiveSession, type LiveSignInBroker } from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class RouteError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
  try { return await fn(req, res); } catch (e) {
    if (e instanceof RouteError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

interface CardRow { id: string; thread_id: string | null; title: string; body: unknown; state: string; proposer_user_id: string; expires_at: string }
interface SignInCard { kind: 'sign_in'; mode: 'browser' | 'terminal'; pcId: string; title: string; url: string | null; command: string | null; runAs: string | null }

function parseCard(row: CardRow): SignInCard | null {
  let body: unknown = row.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return null; } }
  const card = (body as { card?: Record<string, unknown> } | null)?.card;
  if (!card || card.kind !== 'sign_in' || (card.mode !== 'browser' && card.mode !== 'terminal')) return null;
  if (typeof card.pcId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(card.pcId)) return null;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
  return { kind: 'sign_in', mode: card.mode, pcId: card.pcId, title: text(card.title, 120) ?? 'Sign in', url: text(card.url, 2048), command: text(card.command, 400), runAs: text(card.runAs, 40) };
}

export function liveSignInRoutes(ctx: { db: Db; live: LiveSignInBroker }): { person: Router; admin: Router } {
  const { db, live } = ctx;
  const person = Router(); person.use(requireAuth);
  person.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const dto = (s: LiveSession) => ({ id: s.id, kind: s.kind, pcId: s.pcId, title: s.title, state: s.state, error: s.error,
    url: s.url, command: s.command, runAs: s.runAs, ...(s.frame ? { width: s.frame.width, height: s.frame.height } : {}) });
  /** The session, if it is this person's (or the owner is looking). */
  function mine(req: Request): LiveSession {
    const id = param(req, 'id');
    const s = UUID.test(id) ? live.get(id) : null;
    if (!s || (s.userId !== req.user!.id && req.user!.role !== 'super_admin')) throw new RouteError(404, 'That sign-in is not open any more.');
    return s;
  }
  async function allowed(req: Request) {
    if (!await mayLiveSignIn(db, req.user!)) throw new RouteError(403, 'Only the owner, or someone the owner allowed, can sign in for Josi.');
  }
  /** The owner's note in the thread: the one thing Josi learns. */
  const tell = async (threadId: string | null, body: string, cardId: string) => {
    if (!threadId) return;
    try { await addMessage(db, { threadId, direction: 'out', body, meta: { settings_change: cardId } }); } catch { /* the thread may be gone */ }
  };

  person.get('/access', handle(async (req, res) => res.json({ allowed: await mayLiveSignIn(db, req.user!), owner: req.user!.role === 'super_admin' })));

  person.post('/sessions', handle(async (req, res) => {
    await allowed(req);
    const cardId = typeof req.body?.cardId === 'string' ? req.body.cardId : '';
    if (!UUID.test(cardId)) throw new RouteError(400, 'Open a sign-in card from the chat.');
    const [row] = await db.query<CardRow>(
      `select id, thread_id, title, body, state, proposer_user_id, expires_at from settings_change_proposals where id = $1 and area = 'sign_in_card'`, [cardId]);
    if (!row || row.proposer_user_id !== req.user!.id) throw new RouteError(404, 'That sign-in card does not exist.');
    if (row.state !== 'proposed' || Date.parse(row.expires_at) <= Date.now()) throw new RouteError(409, 'This sign-in card is finished or has expired. Ask Josi for a new one.');
    const existing = live.forCard(cardId);
    if (existing && existing.userId === req.user!.id) { live.touch(existing.id); return res.json(dto(existing)); }
    const card = parseCard(row);
    if (!card) throw new RouteError(409, 'This sign-in card is not usable. Ask Josi for a new one.');
    // The PC service must be paired, switched on and announcing itself, like every PC action.
    const [pc] = await db.query<{ owner_user_id: string }>(
      `select s.owner_user_id from pc_control_settings s join pc_control_presence p on p.owner_user_id = s.owner_user_id and p.pc_id = s.pc_id
       where s.pc_id = $1 and s.enabled and p.expires_at > now() limit 1`, [card.pcId]);
    if (!pc) throw new RouteError(409, 'Josi\'s computer is not connected right now, so there is nothing to sign in on. Check PC control, then open the card again.');
    const made = live.create({ kind: card.mode, pcId: card.pcId, userId: req.user!.id, cardId, title: card.title, url: card.url, command: card.command, runAs: card.runAs });
    if (made === 'busy') throw new RouteError(409, 'Someone is already signing in on that computer. Wait for them to finish.');
    await db.query(`insert into pc_control_activity(owner_user_id, pc_id, kind) values ($1, $2, $3)`,
      [pc.owner_user_id, card.pcId, `A sign-in view (${card.mode}) was opened; what is typed there is never recorded`]).catch(() => undefined);
    return res.json(dto(made));
  }));

  person.get('/sessions/:id', handle(async (req, res) => { const s = mine(req); live.touch(s.id); return res.json(dto(s)); }));

  person.get('/sessions/:id/frame', handle(async (req, res) => {
    const s0 = mine(req);
    if (s0.kind !== 'browser') throw new RouteError(400, 'This sign-in has no screen.');
    const after = Number.parseInt(String(req.query.after ?? '0'), 10) || 0, wait = Number.parseInt(String(req.query.wait ?? '0'), 10) || 0;
    const s = await live.nextFrame(s0.id, after, wait);
    if (!s || s.state === 'ended') return res.status(410).json({ error: s?.error ?? 'This sign-in ended.', ended: true });
    if (!s.frame || s.frame.seq <= after) return res.status(204).end();
    res.set({ 'Content-Type': 'image/jpeg', 'X-Frame-Seq': String(s.frame.seq), 'X-Frame-Width': String(s.frame.width), 'X-Frame-Height': String(s.frame.height) });
    return res.status(200).send(s.frame.jpeg);
  }));

  person.get('/sessions/:id/output', handle(async (req, res) => {
    const s0 = mine(req);
    if (s0.kind !== 'terminal') throw new RouteError(400, 'This sign-in has no terminal.');
    const after = Math.max(0, Number.parseInt(String(req.query.after ?? '0'), 10) || 0), wait = Number.parseInt(String(req.query.wait ?? '0'), 10) || 0;
    const s = await live.nextOutput(s0.id, after, wait);
    if (!s) return res.status(410).json({ error: 'This sign-in ended.', ended: true });
    const o = s.output;
    return res.json({ cursor: o.end, data: o.text.slice(Math.max(0, after - o.start)), truncated: after < o.start,
      running: o.running, exitCode: o.exitCode, ended: s.state === 'ended', error: s.error });
  }));

  person.post('/sessions/:id/input', handle(async (req, res) => {
    const s = mine(req);
    const events = cleanEvents(s.kind, req.body?.events);
    return res.json({ queued: live.queueInput(s.id, events) });
  }));

  person.post('/sessions/:id/end', handle(async (req, res) => {
    const s = mine(req);
    const outcome = req.body?.outcome === 'done' ? 'done' : 'cancelled';
    live.end(s.id);
    if (s.cardId) {
      const [row] = await db.query<CardRow>(`select id, thread_id, title, body, state, proposer_user_id, expires_at from settings_change_proposals where id = $1`, [s.cardId]);
      if (row && row.state === 'proposed') {
        if (outcome === 'done') await db.query(`update settings_change_proposals set state = 'applied', applied_by = $2, applied_at = now() where id = $1 and state = 'proposed'`, [row.id, req.user!.id]);
        else await db.query(`update settings_change_proposals set state = 'denied', approved_by = $2, approved_at = now() where id = $1 and state = 'proposed'`, [row.id, req.user!.id]);
        await tell(row.thread_id, outcome === 'done'
          ? `Done: you finished the sign-in "${s.title}". I did not see the screen or anything you typed. Ask me to carry on, and I will check it worked.`
          : `Not done: you closed the sign-in "${s.title}" without finishing it.`, row.id);
      }
    }
    return res.json({ ok: true, outcome });
  }));

  // ---- the owner decides who else may (off by default)
  const admin = Router(); admin.use(requireSuperAdmin);
  admin.get('/grants', handle(async (_req, res) => {
    const users = await db.query<{ id: string; name: string; granted: boolean }>(
      `select u.id, coalesce(nullif(u.display_name, ''), u.username) as name, (g.user_id is not null) as granted
       from users u left join live_signin_grants g on g.user_id = u.id where u.status = 'active' and u.role <> 'super_admin' order by name`);
    return res.json({ users });
  }));
  admin.put('/grants/:userId', handle(async (req, res) => {
    const userId = param(req, 'userId');
    if (!UUID.test(userId) || typeof req.body?.granted !== 'boolean') throw new RouteError(400, 'Choose a person and whether they may sign in for Josi.');
    const [target] = await db.query<{ role: string }>(`select role from users where id = $1 and status = 'active'`, [userId]);
    if (!target) throw new RouteError(404, 'That person does not exist.');
    if (req.body.granted) await db.query(`insert into live_signin_grants(user_id, granted_by) values ($1, $2) on conflict (user_id) do nothing`, [userId, req.user!.id]);
    else await db.query(`delete from live_signin_grants where user_id = $1`, [userId]);
    return res.json({ ok: true, granted: req.body.granted });
  }));
  return { person, admin };
}
