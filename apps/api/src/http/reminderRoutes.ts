// Reminder sync for a phone's own reminder list (Apple Reminders).
//
// The phone pushes what the person wrote there, reads back what Josi holds,
// and ticks items off in either direction. Everything resolves by the signed-in
// owner, so another member's reminder id — or external id — earns a 404 or a
// separate row, never a 403 that would confirm it exists.
//
// Mounted twice with one implementation: at `/api/reminders`, the address the
// phone uses, and under `/api/assistant/reminders` beside the routes the
// Tasks page already reads.
import { Router, type Request, type Response } from 'express';
import {
  LIMITS, ReminderError, completeReminder, consume, reminderOverview, upsertExternalReminder,
  type Db,
} from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { requireAuth } from './authz.js';

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      if (err instanceof ReminderError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

export function reminderRoutes(ctx: { db: Db }): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireAuth);

  /** Upcoming and recently settled, each row carrying `source`, `external_id`
   * and a truthful `status` so the phone can tick off what is done. */
  r.get('/', handle(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    return res.json(await reminderOverview(db, { ownerUserId: req.user!.id }));
  }));

  /** Create, or update the reminder this phone already pushed under the same
   * `external_id`. Never a second row for the same identifier. */
  r.post('/', handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.source !== 'ios') throw new RouteError(400, 'source must be "ios".');
    if (typeof body.external_id !== 'string') throw new RouteError(400, 'external_id is required.');
    if (typeof body.title !== 'string') throw new RouteError(400, 'title is required.');
    if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') throw new RouteError(400, 'notes must be text.');
    if (typeof body.timezone !== 'string') throw new RouteError(400, 'timezone is required.');
    const dueAt = typeof body.due_at === 'string' && body.due_at.trim() ? new Date(body.due_at.trim()) : null;
    if (!dueAt || Number.isNaN(dueAt.getTime())) throw new RouteError(400, 'Choose a valid due_at instant.');

    const rate = await consume(db, { limit: LIMITS.reminder_sync, subject: `reminder_sync:${req.user!.id}` });
    if (!rate.ok) {
      res.set('Retry-After', String(rate.retryAfterSeconds));
      throw new RouteError(429, 'Too many reminders were synced at once. Try again shortly.');
    }
    const { reminder, created } = await upsertExternalReminder(db, {
      ownerUserId: req.user!.id, source: body.source, externalId: body.external_id,
      title: body.title, notes: (body.notes as string | null | undefined) ?? null, dueAt, timezone: body.timezone,
    });
    return res.status(created ? 201 : 200).json({ reminder, created });
  }));

  /** Mark done. Idempotent; somebody else's or unknown is one answer. */
  r.post('/:id/complete', handle(async (req, res) => {
    const reminder = await completeReminder(db, { ownerUserId: req.user!.id, reminderId: param(req, 'id') });
    if (!reminder) throw new RouteError(404, 'not found');
    return res.json({ reminder });
  }));

  return r;
}
