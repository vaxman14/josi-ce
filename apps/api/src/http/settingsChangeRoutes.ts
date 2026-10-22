// Settings changes Josi proposed in conversation: list, decide, report applied.
//
// Who may make a proposal live:
//   * personal scope: the person it belongs to, unless the super-admin set
//     "member changes wait for me", in which case the super-admin consents
//     first and the person's own app then applies it;
//   * administrator scope: the super-admin only.
// The super-admin can deny anything (override). The client performs the
// stored request with its own session and reports the outcome here, so the
// route's own checks decide, and the proposal is a truthful receipt. A
// sensitive change applied by a member is emailed to every super-admin at
// once when mail is set up.
import { Router, type Request, type Response } from 'express';
import { loadMasterKey, type Db, type LoadOptions } from '@josi-ce/core';
import { loadProfile, smtpTransport, type SmtpTransport } from '@josi-ce/mail';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';

interface Ctx { db: Db; masterKey?: LoadOptions | false; mailTransport?: SmtpTransport }
type Policy = 'self' | 'super_admin';
interface Row {
  id: string; proposer_user_id: string; proposer: string; scope: 'personal' | 'administrator'; area: string; sensitive: boolean; title: string; summary: string;
  method: string; path: string; body: unknown; state: string; approved_by: string | null; approved_at: string | null; applied_by: string | null;
  applied_at: string | null; error: string | null; expires_at: string; created_at: string;
}
const COLUMNS = `p.id, p.proposer_user_id, u.username as proposer, p.scope, p.area, p.sensitive, p.title, p.summary, p.method, p.path, p.body, p.state,
  p.approved_by, p.approved_at, p.applied_by, p.applied_at, p.error, p.expires_at, p.created_at`;

export function settingsChangeRoutes(ctx: Ctx): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);
  r.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
    try { return await fn(req, res); } catch (error) {
      const status = (error as { status?: number }).status;
      if (status) return res.status(status).json({ error: (error as Error).message });
      throw error;
    }
  });

  async function policy(): Promise<Policy> {
    const [row] = await db.query<{ settings: Record<string, unknown> }>(`select settings from workspace where id = true`);
    return row?.settings?.memberSettingsChanges === 'super_admin' ? 'super_admin' : 'self';
  }
  async function expire() {
    await db.query(`update settings_change_proposals set state = 'expired' where state in ('proposed', 'approved') and expires_at <= now()`);
  }
  async function load(id: string): Promise<Row> {
    const [row] = await db.query<Row>(`select ${COLUMNS} from settings_change_proposals p join users u on u.id = p.proposer_user_id where p.id = $1`, [id]);
    if (!row) throw fail(404, 'That proposal does not exist.');
    return row;
  }
  const visible = (row: Row, user: { id: string; role: string }) => row.proposer_user_id === user.id || user.role === 'super_admin';
  /** Whether this user is the one whose app applies the change. */
  const applier = (row: Row, user: { id: string; role: string }) =>
    row.scope === 'administrator' ? user.role === 'super_admin' : row.proposer_user_id === user.id;
  const change = (row: Row) => ({ method: row.method, path: row.path, body: row.body });
  const dto = (row: Row, user: { id: string; role: string }, rule: Policy) => ({
    id: row.id, proposer: row.proposer, mine: row.proposer_user_id === user.id, scope: row.scope, area: row.area, sensitive: row.sensitive,
    title: row.title, summary: row.summary, state: row.state, createdAt: row.created_at, expiresAt: row.expires_at,
    approvedAt: row.approved_at, appliedAt: row.applied_at, error: row.error,
    // What this viewer can do with it right now.
    canApprove: row.state === 'proposed' && (row.scope === 'administrator' ? user.role === 'super_admin'
      : rule === 'super_admin' ? user.role === 'super_admin' : row.proposer_user_id === user.id),
    canDeny: ['proposed', 'approved'].includes(row.state) && visible(row, user),
    // Approved by the super-admin for a member: that member's app applies it.
    apply: row.state === 'approved' && applier(row, user) ? change(row) : null,
  });

  r.get('/', handle(async (req, res) => {
    await expire();
    const user = req.user!; const rule = await policy();
    const rows = await db.query<Row>(user.role === 'super_admin'
      ? `select ${COLUMNS} from settings_change_proposals p join users u on u.id = p.proposer_user_id where p.state in ('proposed','approved') order by p.created_at desc limit 100`
      : `select ${COLUMNS} from settings_change_proposals p join users u on u.id = p.proposer_user_id where p.state in ('proposed','approved') and p.proposer_user_id = $1 order by p.created_at desc limit 100`,
      user.role === 'super_admin' ? [] : [user.id]);
    return res.json({ proposals: rows.map((row) => dto(row, user, rule)), policy: rule, superAdmin: user.role === 'super_admin' });
  }));

  r.get('/history', handle(async (req, res) => {
    await expire();
    const user = req.user!; const rule = await policy();
    const rows = await db.query<Row>(user.role === 'super_admin'
      ? `select ${COLUMNS} from settings_change_proposals p join users u on u.id = p.proposer_user_id where p.state not in ('proposed','approved') order by coalesce(p.applied_at, p.approved_at, p.created_at) desc limit 200`
      : `select ${COLUMNS} from settings_change_proposals p join users u on u.id = p.proposer_user_id where p.state not in ('proposed','approved') and p.proposer_user_id = $1 order by coalesce(p.applied_at, p.approved_at, p.created_at) desc limit 200`,
      user.role === 'super_admin' ? [] : [user.id]);
    return res.json({ proposals: rows.map((row) => dto(row, user, rule)) });
  }));

  /** Approve or deny. Approving returns the request to perform when this
   * user's app is the one that applies it. */
  r.post('/:id/decide', handle(async (req, res) => {
    if (typeof req.body?.approve !== 'boolean') throw fail(400, 'Choose approve or deny.');
    await expire();
    const user = req.user!; const rule = await policy();
    const row = await load(param(req, 'id'));
    if (!visible(row, user)) throw fail(404, 'That proposal does not exist.');
    if (!req.body.approve) {
      if (!['proposed', 'approved'].includes(row.state)) throw fail(409, `That proposal is already ${row.state}.`);
      await db.query(`update settings_change_proposals set state = 'denied', approved_by = $2, approved_at = now() where id = $1`, [row.id, user.id]);
      return res.json({ ok: true, state: 'denied' });
    }
    if (row.state !== 'proposed') throw fail(409, `That proposal is already ${row.state}.`);
    const allowed = row.scope === 'administrator' ? user.role === 'super_admin'
      : rule === 'super_admin' ? user.role === 'super_admin' : row.proposer_user_id === user.id;
    if (!allowed) throw fail(403, row.scope === 'administrator' ? 'Only the super-admin can approve an administrator setting.'
      : 'Changes by members wait for the super-admin on this installation.');
    await db.query(`update settings_change_proposals set state = 'approved', approved_by = $2, approved_at = now() where id = $1`, [row.id, user.id]);
    return res.json({ ok: true, state: 'approved', apply: applier(row, user) ? change(row) : null });
  }));

  /** The applier's app reports what the request did. */
  r.post('/:id/applied', handle(async (req, res) => {
    const user = req.user!;
    const row = await load(param(req, 'id'));
    if (!applier(row, user)) throw fail(403, 'Only the person whose app applies this change can report it.');
    if (row.state !== 'approved') throw fail(409, `That proposal is ${row.state}, not approved.`);
    const ok = req.body?.ok === true;
    const error = typeof req.body?.error === 'string' ? req.body.error.slice(0, 500) : null;
    await db.query(`update settings_change_proposals set state = $2, applied_by = $3, applied_at = now(), error = $4 where id = $1`,
      [row.id, ok ? 'applied' : 'failed', user.id, ok ? null : error ?? 'The change could not be applied.']);
    let notified = false;
    if (ok && row.sensitive && user.role !== 'super_admin') {
      notified = await notifySuperAdmins(ctx, db, row, user);
      if (notified) await db.query(`update settings_change_proposals set notified_at = now() where id = $1`, [row.id]);
    }
    return res.json({ ok: true, state: ok ? 'applied' : 'failed', notified });
  }));

  r.put('/policy', requireSuperAdmin, handle(async (req, res) => {
    const value = req.body?.memberSettingsChanges;
    if (value !== 'self' && value !== 'super_admin') throw fail(400, 'Choose "self" or "super_admin".');
    await db.query(`update workspace set settings = settings || $1::jsonb where id = true`, [JSON.stringify({ memberSettingsChanges: value })]);
    return res.json({ ok: true, policy: value });
  }));
  return r;
}

/** Immediate email to every super-admin when a member applied a sensitive
 * change. Best effort: no mail profile, no email, and the change still
 * stands; the proposal record is the durable receipt. */
async function notifySuperAdmins(ctx: Ctx, db: Db, row: Row, by: { username: string; email: string }): Promise<boolean> {
  if (ctx.masterKey === false) return false;
  try {
    const admins = await db.query<{ email: string }>(`select email from users where role = 'super_admin' and status = 'active' and email <> ''`);
    if (!admins.length) return false;
    const profile = await loadProfile(db, loadMasterKey(ctx.masterKey ?? {}), 'system');
    const transport = ctx.mailTransport ?? smtpTransport(profile);
    const when = new Date().toISOString();
    await transport.send({
      from: `${profile.fromName} <${profile.fromAddress}>`, replyTo: profile.fromAddress,
      to: admins.map((a) => a.email), cc: [], subject: `Josi: ${by.username} changed "${row.title}"`,
      text: `${by.username} (${by.email}) made a sensitive settings change through Josi on ${when}.\n\n`
        + `Setting: ${row.title}\nWhat changed: ${row.summary}\nScope: ${row.scope}\n\n`
        + 'Review it under Approvals in Josi (history of settings changes). As super-admin you can revert it there or under the setting\'s own screen, '
        + 'and under Approvals you can require that member changes wait for you.',
      headers: { 'Auto-Submitted': 'auto-generated' }, attachments: [],
    });
    return true;
  } catch {
    return false;
  }
}
