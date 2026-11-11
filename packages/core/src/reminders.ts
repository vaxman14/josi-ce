// Reminders: private content in the reminder row, timing/revision only in jobs.
import { enqueue } from './queue.js';
import { appendEvent } from './events.js';
import type { Db } from './db.js';

export const REMINDER_JOB_KIND = 'reminder.deliver';
export const MAX_REMINDER_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

/** Content-free reminder intent for status/calendar export only. Server push
 * remains authoritative; this contract does not transfer delivery ownership. */
export interface NativeReminderAction {
  version: 1;
  id: string;
  threadId: string;
  revision: number;
  operation: 'upsert' | 'cancel';
  at?: string;
  timezone?: string;
}

export interface Reminder {
  id: string;
  owner_user_id: string;
  thread_id: string | null;
  body: string;
  due_at: string;
  timezone: string;
  revision: number;
  /** `completed` is the owner marking it done; it is terminal and never fires. */
  status: 'scheduled' | 'delivered' | 'cancelled' | 'failed' | 'completed';
  delivered_at: string | null;
  completed_at: string | null;
  /** `josi` for reminders made here; otherwise the system that pushed it. */
  source: ReminderSource;
  /** That system's own identifier. Opaque: stored and returned, never parsed. */
  external_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export class ReminderError extends Error {}

export type ReminderSource = 'josi' | 'ios';
/** Systems allowed to push reminders in. One for now. */
export const EXTERNAL_REMINDER_SOURCES = ['ios'] as const;
export type ExternalReminderSource = typeof EXTERNAL_REMINDER_SOURCES[number];
export const MAX_REMINDER_BODY_CHARS = 2000;
export const MAX_REMINDER_NOTES_CHARS = 4000;
export const MAX_REMINDER_EXTERNAL_ID_CHARS = 200;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedDue(dueAt: Date): Date {
  return new Date(Math.floor(dueAt.getTime() / 1000) * 1000);
}

function validateDue(dueAt: Date): Date {
  const due = normalizedDue(dueAt);
  const ahead = due.getTime() - Date.now();
  if (!Number.isFinite(ahead)) throw new ReminderError('that is not a time Josi can schedule');
  if (ahead <= 0) throw new ReminderError('that time has already passed');
  if (ahead > MAX_REMINDER_AHEAD_MS) throw new ReminderError('that is more than a year away — ask again nearer the time');
  return due;
}

export function validateReminderTimezone(timezone: string): string {
  const value = timezone.trim();
  if (!value || value.length > 100) throw new ReminderError('choose a valid IANA timezone');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0)); }
  catch { throw new ReminderError('choose a valid IANA timezone'); }
  return value;
}

/** Format an absolute instant with the offset and local clock for its IANA zone.
 * The native v1 validator intentionally requires both to agree, including DST
 * folds/gaps, rather than accepting a UTC instant plus an unrelated zone. */
export function reminderInstant(dueAt: Date | string, timezone: string): string {
  const zone = validateReminderTimezone(timezone);
  const instant = normalizedDue(dueAt instanceof Date ? dueAt : new Date(dueAt));
  if (!Number.isFinite(instant.getTime())) throw new ReminderError('that is not a time Josi can schedule');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  const rawOffset = part('timeZoneName' as Intl.DateTimeFormatPartTypes);
  const offset = rawOffset === 'GMT' || rawOffset === 'UTC' ? 'Z'
    : /^GMT[+-]\d{2}:\d{2}$/.test(rawOffset) ? rawOffset.slice(3)
    : (() => { throw new ReminderError('choose a timezone with a supported UTC offset'); })();
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
}

export function nativeReminderAction(reminder: Reminder): NativeReminderAction | null {
  if (!reminder.thread_id || !Number.isSafeInteger(Number(reminder.revision))) return null;
  // Done before it fired is, for a mirror holding the schedule, a withdrawal.
  if (reminder.status === 'cancelled' || reminder.status === 'completed') {
    return { version: 1, id: reminder.id, threadId: reminder.thread_id, revision: Number(reminder.revision), operation: 'cancel' };
  }
  if (reminder.status !== 'scheduled') return null;
  return {
    version: 1, id: reminder.id, threadId: reminder.thread_id, revision: Number(reminder.revision), operation: 'upsert',
    at: reminderInstant(reminder.due_at, reminder.timezone), timezone: reminder.timezone,
  };
}

async function transaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error('reminder mutation requires transaction support');
  return db.transaction(work);
}

export async function reminderTimezoneFor(db: Db, ownerUserId: string, requested?: string | null): Promise<string> {
  if (requested?.trim()) return validateReminderTimezone(requested);
  const [device] = await db.query<{ timezone: string }>(
    `select timezone from mobile_devices where owner_user_id=$1 and revoked_at is null order by last_seen_at desc limit 1`,
    [ownerUserId],
  );
  return validateReminderTimezone(device?.timezone ?? 'UTC');
}

export async function createReminder(
  db: Db,
  args: { ownerUserId: string; threadId?: string | null; body: string; dueAt: Date; timezone?: string },
): Promise<Reminder> {
  const body = args.body.trim();
  if (!body) throw new ReminderError('a reminder needs something to say');
  if (body.length > 2000) throw new ReminderError('that reminder is too long to store — keep it under 2000 characters');
  const due = validateDue(args.dueAt);
  const timezone = validateReminderTimezone(args.timezone ?? 'UTC');
  if (args.threadId && !uuid.test(args.threadId)) throw new ReminderError('a reminder needs a valid conversation');
  return transaction(db, async tx => {
    const [row] = await tx.query<Reminder>(
      `insert into reminders (owner_user_id,thread_id,body,due_at,timezone)
       values ($1,$2::uuid,$3,$4,$5) returning *`,
      [args.ownerUserId, args.threadId ?? null, body, due.toISOString(), timezone],
    );
    await enqueue(tx, { kind: REMINDER_JOB_KIND, payload: { reminderId: row.id, revision: Number(row.revision) }, runAt: due });
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'user', kind: 'reminder.created', subjectType: 'reminder', subjectId: row.id,
      payload: { dueAt: row.due_at, timezone, revision: Number(row.revision), bodyChars: body.length } });
    return row;
  });
}

export async function updateReminder(
  db: Db,
  args: { ownerUserId: string; reminderId: string; body?: string; dueAt?: Date; timezone?: string },
): Promise<Reminder | null> {
  if (!uuid.test(args.reminderId)) return null;
  if (args.body === undefined && args.dueAt === undefined && args.timezone === undefined) {
    throw new ReminderError('choose what to change about the reminder');
  }
  const body = args.body === undefined ? null : args.body.trim();
  if (body !== null && !body) throw new ReminderError('a reminder needs something to say');
  if (body !== null && body.length > 2000) throw new ReminderError('that reminder is too long to store — keep it under 2000 characters');
  return transaction(db, async tx => {
    const [current] = await tx.query<Reminder>(`select * from reminders where id=$1 and owner_user_id=$2 and status='scheduled' for update`, [args.reminderId, args.ownerUserId]);
    if (!current) return null;
    const due = args.dueAt ? validateDue(args.dueAt) : new Date(current.due_at);
    const timezone = validateReminderTimezone(args.timezone ?? current.timezone);
    const [row] = await tx.query<Reminder>(
      `update reminders set body=coalesce($3,body),due_at=$4,timezone=$5,revision=revision+1
       where id=$1 and owner_user_id=$2 and status='scheduled' returning *`,
      [args.reminderId, args.ownerUserId, body, due.toISOString(), timezone],
    );
    if (!row) return null;
    await enqueue(tx, { kind: REMINDER_JOB_KIND, payload: { reminderId: row.id, revision: Number(row.revision) }, runAt: due });
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'user', kind: 'reminder.updated', subjectType: 'reminder', subjectId: row.id,
      payload: { dueAt: row.due_at, timezone, revision: Number(row.revision), bodyChars: row.body.length } });
    return row;
  });
}

export async function listRemindersFor(db: Db, args: { ownerUserId: string; includeSettled?: boolean; limit?: number }): Promise<Reminder[]> {
  return db.query<Reminder>(`select * from reminders where owner_user_id=$1 and ($2 or status='scheduled') order by due_at asc limit $3`,
    [args.ownerUserId, args.includeSettled === true, Math.min(args.limit ?? 50, 200)]);
}

export async function listNativeReminderActions(db: Db, args: { ownerUserId: string }): Promise<NativeReminderAction[]> {
  const rows = await db.query<Reminder>(
    `select * from reminders where owner_user_id=$1 and thread_id is not null and status in ('scheduled','cancelled','completed') order by updated_at,id`,
    [args.ownerUserId],
  );
  return rows.map(nativeReminderAction).filter((action): action is NativeReminderAction => action !== null);
}

export async function cancelReminder(db: Db, args: { ownerUserId: string; reminderId: string }): Promise<Reminder | null> {
  if (!uuid.test(args.reminderId)) return null;
  return transaction(db, async tx => {
    const [row] = await tx.query<Reminder>(
      `update reminders set status='cancelled',revision=revision+1 where id=$1 and owner_user_id=$2 and status='scheduled' returning *`,
      [args.reminderId, args.ownerUserId],
    );
    if (!row) return null;
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'user', kind: 'reminder.cancelled', subjectType: 'reminder', subjectId: row.id,
      payload: { revision: Number(row.revision) } });
    return row;
  });
}

/** Create or update the reminder a phone knows by its own identifier.
 *
 * Keyed on (owner, source, external id) and backed by a unique index, so the
 * same item pushed twice — or twice at once — is one row. The owner is part of
 * the key: another member's identical identifier is a different reminder.
 *
 * A reminder that is still scheduled takes the new text and time. One that
 * already fired is scheduled again only when the phone moved it to a new
 * future time. One that is done or cancelled is returned as it stands — the
 * phone reads the state from the answer rather than overwriting it. */
export async function upsertExternalReminder(
  db: Db,
  args: { ownerUserId: string; source: string; externalId: string; title: string; notes?: string | null; dueAt: Date; timezone: string },
): Promise<{ reminder: Reminder; created: boolean }> {
  if (!(EXTERNAL_REMINDER_SOURCES as readonly string[]).includes(args.source)) throw new ReminderError('that reminder source is not supported');
  const source = args.source as ExternalReminderSource;
  const externalId = args.externalId;
  if (typeof externalId !== 'string' || !externalId || externalId.length > MAX_REMINDER_EXTERNAL_ID_CHARS || /[\u0000-\u001f\u007f]/.test(externalId)) {
    throw new ReminderError(`a synced reminder needs an external_id of 1 to ${MAX_REMINDER_EXTERNAL_ID_CHARS} characters`);
  }
  const body = args.title.trim();
  if (!body) throw new ReminderError('a reminder needs something to say');
  if (body.length > MAX_REMINDER_BODY_CHARS) throw new ReminderError('that reminder is too long to store — keep it under 2000 characters');
  const notes = args.notes?.trim() ? args.notes.trim() : null;
  if (notes && notes.length > MAX_REMINDER_NOTES_CHARS) throw new ReminderError('those notes are too long to store — keep them under 4000 characters');
  const timezone = validateReminderTimezone(args.timezone);
  const due = normalizedDue(args.dueAt);
  if (!Number.isFinite(due.getTime())) throw new ReminderError('that is not a time Josi can schedule');

  return transaction(db, async tx => {
    const find = () => tx.query<Reminder>(
      `select * from reminders where owner_user_id=$1 and source=$2 and external_id=$3 for update`,
      [args.ownerUserId, source, externalId]);
    let [current] = await find();
    if (!current) {
      validateDue(due);
      const [row] = await tx.query<Reminder>(
        `insert into reminders (owner_user_id,body,notes,due_at,timezone,source,external_id)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (owner_user_id,source,external_id) where external_id is not null do nothing returning *`,
        [args.ownerUserId, body, notes, due.toISOString(), timezone, source, externalId],
      );
      if (row) {
        await enqueue(tx, { kind: REMINDER_JOB_KIND, payload: { reminderId: row.id, revision: Number(row.revision) }, runAt: due });
        await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'user', kind: 'reminder.created', subjectType: 'reminder', subjectId: row.id,
          payload: { dueAt: row.due_at, timezone, revision: Number(row.revision), bodyChars: body.length, source } });
        return { reminder: row, created: true };
      }
      // Lost a race to the same identifier: the winner's row is the reminder.
      [current] = await find();
      if (!current) throw new Error('reminder upsert found no row after a conflict');
    }

    const dueChanged = new Date(current.due_at).getTime() !== due.getTime();
    const changed = dueChanged || current.body !== body || (current.notes ?? null) !== notes || current.timezone !== timezone;
    const reschedule = (current.status === 'delivered' || current.status === 'failed') && dueChanged && due.getTime() > Date.now();
    if (!changed || (current.status !== 'scheduled' && !reschedule)) return { reminder: current, created: false };
    if (dueChanged) validateDue(due);
    const [row] = await tx.query<Reminder>(
      `update reminders set body=$2,notes=$3,due_at=$4,timezone=$5,status='scheduled',delivered_at=null,revision=revision+1
       where id=$1 returning *`,
      [current.id, body, notes, due.toISOString(), timezone],
    );
    // The earlier queue row names the old revision and is now harmless.
    await enqueue(tx, { kind: REMINDER_JOB_KIND, payload: { reminderId: row.id, revision: Number(row.revision) }, runAt: due });
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'user', kind: 'reminder.updated', subjectType: 'reminder', subjectId: row.id,
      payload: { dueAt: row.due_at, timezone, revision: Number(row.revision), bodyChars: body.length, source } });
    return { reminder: row, created: false };
  });
}

/** Mark a reminder done. Works before or after it fired, and asking twice is
 * the same as asking once. The revision moves, so a delivery job queued for
 * the earlier revision finds nothing to deliver. A cancelled reminder stays
 * cancelled and is returned as it stands. Null means it is not this owner's. */
export async function completeReminder(db: Db, args: { ownerUserId: string; reminderId: string }): Promise<Reminder | null> {
  if (!uuid.test(args.reminderId)) return null;
  return transaction(db, async tx => {
    const [row] = await tx.query<Reminder>(
      `update reminders set status='completed',completed_at=now(),revision=revision+1
       where id=$1 and owner_user_id=$2 and status in ('scheduled','delivered','failed') returning *`,
      [args.reminderId, args.ownerUserId],
    );
    if (!row) {
      const [settled] = await tx.query<Reminder>(`select * from reminders where id=$1 and owner_user_id=$2`, [args.reminderId, args.ownerUserId]);
      return settled ?? null;
    }
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'user', kind: 'reminder.completed', subjectType: 'reminder', subjectId: row.id,
      payload: { revision: Number(row.revision) } });
    return row;
  });
}

export async function deliverReminderPersisted(
  db: Db,
  args: { reminderId: string; revision: number; text: string; category: 'reminder' | 'calendar'; pushBody: string },
): Promise<Reminder | null> {
  const [row] = await db.query<Reminder>(`with claimed as (
    update reminders set status='delivered',delivered_at=now() where id=$1 and revision=$2 and status='scheduled' and due_at<=now() returning *
  ), fresh_thread as (
    insert into threads(owner_user_id,title) select owner_user_id,'Reminders' from claimed where thread_id is null returning id
  ), target as (
    select c.*,coalesce(c.thread_id,f.id) target_thread_id from claimed c left join fresh_thread f on true
  ), cleared as (
    update assistant_action_states set presented_turn_id=null where thread_id in(select target_thread_id from target) and status='prepared' and presented_turn_id is not null returning id
  ), message as (
    insert into messages(thread_id,direction,channel,body) select target_thread_id,'out','web',$3 from target returning id,thread_id
  ), touched as (
    update threads set last_activity_at=now() where id in(select thread_id from message) returning id
  ), pushed as (
    insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,route_thread_id,title,body,explicit_reminder)
      select t.owner_user_id,d.id,'reminder:'||t.id||':'||t.revision,$4,'reminder',t.id,coalesce(t.thread_id,(select thread_id from message limit 1)),'Josi reminder',$5,true from target t
      join mobile_devices d on d.owner_user_id=t.owner_user_id and d.revoked_at is null and coalesce((d.categories->>$4)::boolean,true)
      on conflict(device_id,event_key) do nothing
  ) select * from claimed`, [args.reminderId, args.revision, args.text, args.category, args.pushBody]);
  return row ?? null;
}

export async function reminderOverview(db: Db, args: { ownerUserId: string; recentDays?: number }): Promise<{ upcoming: Reminder[]; recent: Reminder[] }> {
  const days = Math.min(Math.max(args.recentDays ?? 7, 1), 31);
  const upcoming = await db.query<Reminder>(`select * from reminders where owner_user_id=$1 and status='scheduled' order by due_at asc limit 100`, [args.ownerUserId]);
  const recent = await db.query<Reminder>(`select * from reminders where owner_user_id=$1 and status<>'scheduled' and coalesce(completed_at,delivered_at,updated_at,due_at)>now()-make_interval(days=>$2) order by coalesce(completed_at,delivered_at,updated_at,due_at) desc limit 100`, [args.ownerUserId, days]);
  return { upcoming, recent };
}

export async function markReminderFailed(db: Db, reminderId: string): Promise<void> {
  await db.query(`update reminders set status='failed',delivered_at=null where id=$1`, [reminderId]);
}
