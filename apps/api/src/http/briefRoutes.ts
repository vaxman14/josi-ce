// Daily Brief + Memory, for the signed-in person's OWN data only.
//
// The settings (brief on or off, check-ins, quiet hours), the notes file the
// person can read, change and delete line by line, the task list (where only
// the person marks a task done), and "send me a brief now". Nothing here reads
// anyone else's notes: every query is keyed by the session's user.
import { Router, type Request, type Response } from 'express';
import {
  addBriefTask, addNote, BriefError, deleteBriefTask, deleteNote, editNote, enqueue, getBriefSettings, listBriefTasks, loadMasterKey, localClock,
  NOTE_SECTIONS, readNotes, saveBriefSettings, SECTION_LABELS, setBriefTaskByPerson, startBriefRunNow, VaultError, VaultLockedError,
  type Db, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { requireAuth } from './authz.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function briefRoutes(ctx: { db: Db; masterKey?: LoadOptions | false }): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);
  r.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

  const key = (): MasterKey => {
    if (ctx.masterKey === false) throw new BriefError('Notes are unavailable because the installation key is not available.', 503);
    try { return loadMasterKey(ctx.masterKey ?? {}); } catch { throw new BriefError('Notes are unavailable because the installation key is not available.', 503); }
  };
  const handle = (work: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
    try { return await work(req, res); } catch (error) {
      if (error instanceof BriefError) return res.status(error.status).json({ error: error.message });
      if (error instanceof VaultLockedError) return res.status(423).json({ error: 'Your Vault is locked, so your notes cannot be opened right now.' });
      if (error instanceof VaultError) return res.status(409).json({ error: 'Your notes cannot be opened right now.' });
      throw error;
    }
  });
  /** The person's own day, for dating what they change. */
  async function dayFor(userId: string): Promise<string> {
    const settings = await getBriefSettings(db, userId);
    const [zone] = await db.query<{ timezone: string }>('select timezone from workspace limit 1');
    try { return localClock(new Date(), settings.timezone ?? zone?.timezone ?? 'UTC').day; } catch { return new Date().toISOString().slice(0, 10); }
  }
  const id = (req: Request) => { const value = param(req, 'id'); if (!UUID.test(value)) throw new BriefError('That does not exist.', 404); return value; };

  // ---- settings
  r.get('/settings', handle(async (req, res) => {
    const [workspace] = await db.query<{ timezone: string }>('select timezone from workspace limit 1');
    return res.json({ ...await getBriefSettings(db, req.user!.id), workspaceTimezone: workspace?.timezone ?? 'UTC' });
  }));
  r.put('/settings', handle(async (req, res) => res.json(await saveBriefSettings(db, req.user!.id, req.body ?? {}))));

  // ---- the notes
  r.get('/notes', handle(async (req, res) => {
    const notes = await readNotes(db, key(), req.user!.id);
    return res.json({ sections: NOTE_SECTIONS.map(section => ({ section, label: SECTION_LABELS[section], lines: notes[section] })) });
  }));
  r.post('/notes', handle(async (req, res) => {
    const line = await addNote(db, key(), req.user!.id, { section: req.body?.section, text: req.body?.text, explicit: true, day: await dayFor(req.user!.id) });
    return res.status(201).json(line);
  }));
  r.put('/notes/:id', handle(async (req, res) => {
    const line = await editNote(db, key(), req.user!.id, { id: id(req), text: req.body?.text, day: await dayFor(req.user!.id) });
    if (!line) throw new BriefError('That note does not exist.', 404);
    return res.json(line);
  }));
  r.delete('/notes/:id', handle(async (req, res) => {
    if (!await deleteNote(db, key(), req.user!.id, { id: id(req), day: await dayFor(req.user!.id) })) throw new BriefError('That note does not exist.', 404);
    return res.json({ ok: true });
  }));

  // ---- the tasks; only the person marks one done
  r.get('/tasks', handle(async (req, res) => res.json({ tasks: await listBriefTasks(db, req.user!.id, { includeDone: req.query.done === '1' }) })));
  r.post('/tasks', handle(async (req, res) => res.status(201).json(await addBriefTask(db, req.user!.id, req.body ?? {}))));
  r.put('/tasks/:id', handle(async (req, res) => res.json(await setBriefTaskByPerson(db, req.user!.id, id(req), req.body ?? {}))));
  r.delete('/tasks/:id', handle(async (req, res) => {
    if (!await deleteBriefTask(db, req.user!.id, id(req))) throw new BriefError('That task does not exist.', 404);
    return res.json({ ok: true });
  }));

  // ---- a brief now
  r.post('/run', handle(async (req, res) => {
    const [recent] = await db.query<{ n: number }>(`select count(*)::int as n from brief_runs where user_id = $1 and created_at > now() - interval '1 minute'`, [req.user!.id]);
    if ((recent?.n ?? 0) > 0) throw new BriefError('A brief was just started. Give it a minute.', 429);
    const run = await startBriefRunNow(db, req.user!.id);
    await enqueue(db, { kind: 'brief.run', payload: { runId: run.runId, userId: req.user!.id, kind: 'now', day: run.day } });
    return res.status(202).json({ queued: true });
  }));
  return r;
}
