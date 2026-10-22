import { Router, type Request, type Response } from 'express';
import type { Db } from '@josi-ce/core';
import { ALL_TOOLS, ImprovementError, decideProposal, disableRule, improvementsOverview, rollbackSkill } from '@josi-ce/agent';
import { requireAuth, requireSuperAdmin } from './authz.js';
import { asyncRoute, param } from './async.js';

const uuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const toolNames = () => ALL_TOOLS.map(t => t.def.name);
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
  try { return await fn(req, res); } catch (error) {
    if (error instanceof ImprovementError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

/** Self-improvement, administrator only: Josi proposes, the super admin
 * approves (optionally edited), rejects, or rolls back. */
export function improvementRoutes(db: Db): Router {
  const r = Router();
  r.use(requireSuperAdmin);
  r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  r.get('/', handle(async (_req, res) => res.json(await improvementsOverview(db))));
  r.post('/proposals/:id/decision', handle(async (req, res) => {
    if (typeof req.body?.approve !== 'boolean') throw new ImprovementError(400, 'Choose approve or reject.');
    return res.json(await decideProposal(db, { adminId: req.user!.id, proposalId: param(req, 'id'), approve: req.body.approve, edits: req.body.edits, toolNames: toolNames() }));
  }));
  r.post('/skills/:key/rollback', handle(async (req, res) => res.json(await rollbackSkill(db, { adminId: req.user!.id, skillKey: param(req, 'key') }))));
  r.post('/rules/:id/disable', handle(async (req, res) => {
    if (!uuid(param(req, 'id'))) throw new ImprovementError(400, 'Choose a rule.');
    return res.json(await disableRule(db, { adminId: req.user!.id, ruleId: param(req, 'id') }));
  }));
  return r;
}

/** "What Josi knew" for one of the person's own replies. */
export function turnContextRoutes(db: Db): Router {
  const r = Router();
  r.use(requireAuth);
  r.get('/:turnId', asyncRoute(async (req, res) => {
    const id = param(req, 'turnId');
    if (!uuid(id)) return res.status(400).json({ error: 'Choose a reply.' });
    const [row] = await db.query<{ context: unknown }>('select context from turn_context where turn_id=$1 and owner_user_id=$2', [id, req.user!.id]);
    if (!row) return res.status(404).json({ error: 'Nothing was recorded for this reply.' });
    res.set('Cache-Control', 'no-store');
    return res.json({ context: row.context });
  }));
  return r;
}
