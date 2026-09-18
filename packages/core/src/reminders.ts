// Reminders: content here, timing in the queue.
//
// A reminder is two things and they are deliberately separate. The TEXT is
// content — owned, readable only through ownership checks, stored in the
// `reminders` table like a message. The TIMING is infrastructure — a
// `job_queue` row whose payload carries the reminder's id and nothing else,
// so a queue reader learns that something is due and not what it says.
//
// Cancellation does not chase the queued job. The job fires anyway, finds the
// row is no longer 'scheduled', and does nothing — one state machine, in one
// place, instead of two that can disagree.
import { enqueue } from './queue.js';
import { appendEvent } from './events.js';
import type { Db } from './db.js';

export const REMINDER_JOB_KIND = 'reminder.deliver';

/** A year. A reminder further out than this is almost always a mistyped date,
 * and the person who genuinely wants one can ask again nearer the time. */
export const MAX_REMINDER_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

export interface Reminder {
  id: string;
  owner_user_id: string;
  thread_id: string | null;
  body: string;
  due_at: string;
  status: 'scheduled' | 'delivered' | 'cancelled' | 'failed';
  delivered_at: string | null;
  created_at: string;
}

export class ReminderError extends Error {}

export async function createReminder(
  db: Db,
  args: { ownerUserId: string; threadId?: string | null; body: string; dueAt: Date },
): Promise<Reminder> {
  const body = args.body.trim();
  if (!body) throw new ReminderError('a reminder needs something to say');
  if (body.length > 2000) throw new ReminderError('that reminder is too long to store — keep it under 2000 characters');

  const ahead = args.dueAt.getTime() - Date.now();
  if (!Number.isFinite(ahead)) throw new ReminderError('that is not a time Josi can schedule');
  if (ahead <= 0) throw new ReminderError('that time has already passed');
  if (ahead > MAX_REMINDER_AHEAD_MS) {
    throw new ReminderError('that is more than a year away — ask again nearer the time');
  }

  const [row] = await db.query<Reminder>(
    `insert into reminders (owner_user_id, thread_id, body, due_at)
     values ($1, $2, $3, $4) returning *`,
    [args.ownerUserId, args.threadId ?? null, body, args.dueAt.toISOString()],
  );
  await enqueue(db, { kind: REMINDER_JOB_KIND, payload: { reminderId: row.id }, runAt: args.dueAt });
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'reminder.created',
    subjectType: 'reminder',
    subjectId: row.id,
    // Timing is auditable; the text is not the audit trail's business.
    payload: { dueAt: row.due_at, bodyChars: body.length },
  });
  return row;
}

export async function listRemindersFor(
  db: Db,
  args: { ownerUserId: string; includeSettled?: boolean; limit?: number },
): Promise<Reminder[]> {
  return db.query<Reminder>(
    `select * from reminders
     where owner_user_id = $1 and ($2 or status = 'scheduled')
     order by due_at asc
     limit $3`,
    [args.ownerUserId, args.includeSettled === true, Math.min(args.limit ?? 50, 200)],
  );
}

/** Cancel one of the OWNER'S reminders. Returns null for a reminder that does
 * not exist, belongs to somebody else, or has already settled — the caller
 * gives all three the same sentence, for the same reason task lookups do. */
export async function cancelReminder(
  db: Db,
  args: { ownerUserId: string; reminderId: string },
): Promise<Reminder | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(args.reminderId)) return null;
  const [row] = await db.query<Reminder>(
    `update reminders set status = 'cancelled'
     where id = $1 and owner_user_id = $2 and status = 'scheduled'
     returning *`,
    [args.reminderId, args.ownerUserId],
  );
  if (!row) return null;
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'reminder.cancelled',
    subjectType: 'reminder',
    subjectId: row.id,
  });
  return row;
}

/** Claim a reminder for delivery: flips 'scheduled' to 'delivered' atomically
 * and returns the row, or null when there is nothing to deliver — already
 * cancelled, already delivered by another worker, or gone. The worker calls
 * this FIRST, so two workers holding the same job cannot both deliver. */
export async function claimReminderForDelivery(db: Db, reminderId: string): Promise<Reminder | null> {
  const [row] = await db.query<Reminder>(
    `update reminders set status = 'delivered', delivered_at = now()
     where id = $1 and status = 'scheduled'
     returning *`,
    [reminderId],
  );
  return row ?? null;
}

/** Persist chat delivery and its native push outbox atomically. */
export async function deliverReminderPersisted(db:Db,args:{reminderId:string;text:string;category:'reminder'|'calendar';pushBody:string}):Promise<Reminder|null>{
  const [row]=await db.query<Reminder>(`with claimed as (
    update reminders set status='delivered',delivered_at=now() where id=$1 and status='scheduled' returning *
  ), fresh_thread as (
    insert into threads(owner_user_id,title) select owner_user_id,'Reminders' from claimed where thread_id is null returning id
  ), target as (
    select c.*,coalesce(c.thread_id,f.id) target_thread_id from claimed c left join fresh_thread f on true
  ), cleared as (
    update assistant_action_states set presented_turn_id=null where thread_id in(select target_thread_id from target) and status='prepared' and presented_turn_id is not null returning id
  ), message as (
    insert into messages(thread_id,direction,channel,body) select target_thread_id,'out','web',$2 from target returning id,thread_id
  ), touched as (
    update threads set last_activity_at=now() where id in(select thread_id from message) returning id
  ), pushed as (
    insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body,explicit_reminder)
      select t.owner_user_id,d.id,'reminder:'||t.id,$3,'reminder',t.id,'Josi reminder',$4,true from target t
      join mobile_devices d on d.owner_user_id=t.owner_user_id and d.revoked_at is null and d.app_state<>'foreground' and coalesce((d.categories->>$3)::boolean,true)
      on conflict(device_id,event_key) do nothing
  ) select id,owner_user_id,thread_id,body,due_at,status,delivered_at,created_at from claimed`,[args.reminderId,args.text,args.category,args.pushBody]);
  return row??null;
}

/** What the Tasks page shows (round-2 item 13): everything still to come,
 * plus the recent past — anything that settled (delivered, cancelled, failed)
 * in the last week. Anything the assistant schedules must be visible and
 * manageable in the product, not trapped in chat. Owner-scoped like every
 * other read here. */
export async function reminderOverview(
  db: Db,
  args: { ownerUserId: string; recentDays?: number },
): Promise<{ upcoming: Reminder[]; recent: Reminder[] }> {
  const days = Math.min(Math.max(args.recentDays ?? 7, 1), 31);
  const upcoming = await db.query<Reminder>(
    `select * from reminders
     where owner_user_id = $1 and status = 'scheduled'
     order by due_at asc
     limit 100`,
    [args.ownerUserId],
  );
  const recent = await db.query<Reminder>(
    `select * from reminders
     where owner_user_id = $1 and status <> 'scheduled'
       and coalesce(delivered_at, due_at) > now() - make_interval(days => $2)
     order by coalesce(delivered_at, due_at) desc
     limit 100`,
    [args.ownerUserId, days],
  );
  return { upcoming, recent };
}

/** Delivery was claimed and then could not happen anywhere. Recorded as failed
 * rather than silently un-delivered, so the owner's list tells the truth. */
export async function markReminderFailed(db: Db, reminderId: string): Promise<void> {
  await db.query(
    `update reminders set status = 'failed', delivered_at = null where id = $1`,
    [reminderId],
  );
}
