// Crash reports and feedback, for the owner of a beta-tester installation.
//
// A report is built from a failure with everything private stripped
// (packages/core/src/crashReport.ts). Here the owner chooses whether reports go
// out by themselves, reads and edits a waiting one before sending it (or says
// not to), and writes feedback. The browser reports its own crashes through
// `POST /client`, which any signed-in person may call (it can only add a
// scrubbed report; it never reads one).
import { Router, type Request, type Response } from 'express';
import {
  buildReport, crashSettings, json, listPending, recordReport, reportUrl, scrubReport, sendReport, setCrashAuto, settleSend, testerToken,
  type CrashReport, type CrashRow, type Db,
} from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function crashReportRoutes(ctx: { db: Db; fetchImpl?: typeof fetch }): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);
  r.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

  // What the tester chose when they signed up, asked of the report server once an hour.
  let prefs: { at: number; auto: boolean | null } | null = null;
  async function onboardingDefault(): Promise<boolean | null> {
    const token = testerToken();
    if (!token) return null;
    if (prefs && Date.now() - prefs.at < 3_600_000) return prefs.auto;
    let auto: boolean | null = null;
    try {
      const response = await (ctx.fetchImpl ?? fetch)(reportUrl().replace(/\/report$/, '/tester-prefs'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(4000) });
      if (response.ok) { const body = await response.json() as { auto_reports?: unknown }; auto = typeof body.auto_reports === 'boolean' ? body.auto_reports : null; }
    } catch { auto = null; }
    prefs = { at: Date.now(), auto };
    return auto;
  }

  const view = (row: CrashRow) => ({ id: row.id, createdAt: row.created_at, service: row.service, kind: row.kind, report: row.report });
  const owner = [requireSuperAdmin];

  r.get('/', ...owner, asyncRoute(async (_req, res) => {
    const settings = await crashSettings(db);
    return res.json({ settings: { ...settings, defaultAuto: settings.auto === null ? await onboardingDefault() : null }, pending: settings.tokenPresent ? (await listPending(db)).map(view) : [] });
  }));

  r.put('/settings', ...owner, asyncRoute(async (req, res) => {
    if (typeof req.body?.auto !== 'boolean') return res.status(400).json({ error: 'Automatic crash reports are on or off.' });
    await setCrashAuto(db, req.body.auto);
    return res.json({ settings: await crashSettings(db) });
  }));

  // The browser's own crashes. A few a minute at most from one person.
  const seen = new Map<string, number[]>();
  r.post('/client', asyncRoute(async (req: Request, res: Response) => {
    if (!testerToken()) return res.status(204).end();
    const now = Date.now(), mine = (seen.get(req.user!.id) ?? []).filter(at => now - at < 600_000);
    if (mine.length >= 5) return res.status(429).json({ error: 'Too many reports.' });
    seen.set(req.user!.id, [...mine, now]);
    const message = typeof req.body?.message === 'string' ? req.body.message : 'The page crashed';
    const stack = typeof req.body?.stack === 'string' ? req.body.stack : '';
    const report = await buildReport({ type: 'crash', error: `Browser: ${message}`, stack, logs: [], db });
    await recordReport(db, 'web-client', report);
    return res.status(202).json({ ok: true });
  }));

  r.post('/feedback', ...owner, asyncRoute(async (req, res) => {
    if (!testerToken()) return res.status(409).json({ error: 'This Josi has no tester token, so there is nowhere to send feedback.' });
    const note = typeof req.body?.note === 'string' ? req.body.note : '';
    const report = await buildReport({ type: 'feedback', note, logs: [], db });
    const id = await recordReport(db, 'feedback', report);
    const [row] = await db.query<CrashRow>(`select id, created_at::text as created_at, service, kind, report, status, attempts, last_error from crash_reports where id = $1`, [id]);
    return res.status(201).json(view(row));
  }));

  r.post('/:id/send', ...owner, asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    if (!UUID.test(id)) return res.status(404).json({ error: 'That report does not exist.' });
    const [row] = await db.query<CrashRow>(`select id, created_at::text as created_at, service, kind, report, status, attempts, last_error from crash_reports where id = $1 and status = 'pending'`, [id]);
    if (!row) return res.status(404).json({ error: 'That report is not waiting any more.' });
    // What the owner edited is what goes, scrubbed again and kept as the same kind of report.
    const edited: CrashReport = req.body?.report && typeof req.body.report === 'object' ? scrubReport({ ...req.body.report, type: row.kind }) : row.report;
    if (edited !== row.report) await db.query('update crash_reports set report = $2 where id = $1', [id, json(edited)]);
    const result = await sendReport(edited, { fetchImpl: ctx.fetchImpl });
    await settleSend(db, id, result);
    return res.status(result.ok ? 200 : result.retry ? 502 : 422).json({ ok: result.ok, message: result.ok ? 'Sent. Thank you.' : result.message });
  }));

  r.post('/:id/dismiss', ...owner, asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    if (!UUID.test(id)) return res.status(404).json({ error: 'That report does not exist.' });
    await db.query(`update crash_reports set status = 'dismissed' where id = $1 and status = 'pending'`, [id]);
    return res.json({ ok: true });
  }));
  return r;
}
