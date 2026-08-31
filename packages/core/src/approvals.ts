// Approval gates.
//
// Two separate mechanisms live here and it matters that they stay separate:
//
//   1. HOW MUCH may Josi do without asking? A per-user preference per action
//      class, with an admin ceiling that can only tighten. That is
//      `effectiveApprovalLevel`.
//   2. Did the owner agree to THIS EXACT ACTION? A pinned, hashed approval
//      record. That is `requestApproval` / `decideApproval`.
//
// The first without the second is a policy nobody enforced; the second without
// the first means asking about everything forever, which trains people to click
// yes without reading.
import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { appendEvent } from './events.js';

/** How much autonomy the owner granted for a class of action.
 *
 * Ordered from strictest to loosest — `STRICTNESS` below depends on this
 * ordering, and `min` of two levels is what makes admin policy deny-only. */
export type ApprovalLevel = 'always_ask' | 'risky_only' | 'automatic';

const STRICTNESS: Record<ApprovalLevel, number> = {
  always_ask: 0,
  risky_only: 1,
  automatic: 2,
};

/** M33: the default is Always ask. A default of anything else would mean an
 * installation nobody configured is one where Josi acts unasked. */
export const DEFAULT_APPROVAL_LEVEL: ApprovalLevel = 'always_ask';

export class ApprovalError extends Error {}

/** The stricter of what the user consented to and what the admin permits.
 *
 * This is the whole of M33 in one expression, and the direction is the point:
 * an admin who sets `automatic` cannot make a user's `always_ask` any looser,
 * because the user's choice is consent and consent is not an administrator's to
 * widen. An admin who sets `always_ask` CAN override a user's `automatic`,
 * because that is a restriction.
 *
 * Written as `min` rather than a branch on role: there is no role in this
 * function, so there is nowhere for a "but the admin can..." to be added. */
export function effectiveApprovalLevel(
  userChoice: ApprovalLevel | null | undefined,
  adminCeiling: ApprovalLevel | null | undefined,
): ApprovalLevel {
  const user = userChoice ?? DEFAULT_APPROVAL_LEVEL;
  const admin = adminCeiling ?? 'automatic'; // no policy set = no ceiling
  return STRICTNESS[user] <= STRICTNESS[admin] ? user : admin;
}

export async function getApprovalLevel(
  db: Db,
  args: { userId: string; actionClass: string },
): Promise<{ level: ApprovalLevel; userChoice: ApprovalLevel; adminCeiling: ApprovalLevel }> {
  const [pref] = await db.query<{ level: ApprovalLevel }>(
    `select level from user_approval_prefs where user_id = $1 and action_class = $2`,
    [args.userId, args.actionClass],
  );
  const [policy] = await db.query<{ max_level: ApprovalLevel }>(
    `select max_level from admin_approval_policy where action_class = $1`,
    [args.actionClass],
  );
  const userChoice = pref?.level ?? DEFAULT_APPROVAL_LEVEL;
  const adminCeiling = policy?.max_level ?? 'automatic';
  return { level: effectiveApprovalLevel(userChoice, adminCeiling), userChoice, adminCeiling };
}

export async function setUserApprovalLevel(
  db: Db,
  args: { userId: string; actionClass: string; level: ApprovalLevel },
): Promise<void> {
  await db.query(
    `insert into user_approval_prefs (user_id, action_class, level) values ($1, $2, $3)
     on conflict (user_id, action_class) do update set level = excluded.level`,
    [args.userId, args.actionClass, args.level],
  );
  await appendEvent(db, {
    actorUserId: args.userId,
    actor: 'user',
    kind: 'approval.level_set',
    payload: { actionClass: args.actionClass, level: args.level },
  });
}

export async function setAdminApprovalCeiling(
  db: Db,
  args: { actorUserId: string; actionClass: string; maxLevel: ApprovalLevel },
): Promise<void> {
  await db.query(
    `insert into admin_approval_policy (action_class, max_level) values ($1, $2)
     on conflict (action_class) do update set max_level = excluded.max_level`,
    [args.actionClass, args.maxLevel],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'approval.ceiling_set',
    payload: { actionClass: args.actionClass, maxLevel: args.maxLevel },
  });
}

// --------------------------------------------------------------- decisions

/** Actions that are asked about even when the owner chose `risky_only`.
 *
 * The map names two of these outright — adding a recipient to an existing
 * thread, and sending any attachment — and says both require approval "even if
 * routine email sending is otherwise allowed automatically". Deleting is here
 * for the same reason: it is the one a mistake cannot be talked back from. */
export const ALWAYS_RISKY = [
  'add_recipient',
  'send_attachment',
  'delete_data',
  'spend_money',
] as const;

export function isRiskyAction(action: string): boolean {
  return (ALWAYS_RISKY as readonly string[]).includes(action);
}

/** Does this specific action need the owner to agree before it happens? */
export async function needsApproval(
  db: Db,
  args: { userId: string; actionClass: string; action: string },
): Promise<boolean> {
  if (isRiskyAction(args.action)) return true;
  const { level } = await getApprovalLevel(db, { userId: args.userId, actionClass: args.actionClass });
  return level !== 'automatic';
}

/** Binds an approval to exactly what was described.
 *
 * An approval that does not pin the action is a rubber stamp: approve "send the
 * email", change the recipient, send it anyway. The hash covers whatever the
 * caller says the action is, and `consumeApproval` refuses when it no longer
 * matches. */
export function approvalHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/** Key order must not change the hash, or an approval could be invalidated by
 * a JSON round-trip that changed nothing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface Approval {
  id: string;
  /** Exactly one of these is set. A task approval and a mail approval are the
   * same mechanism applied to different subjects, which is why they share this
   * table rather than growing two sets of subtly different rules. */
  task_id: string | null;
  thread_id: string | null;
  owner_user_id: string;
  action_class: string;
  action: string;
  summary: string;
  payload_hash: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  created_at: string;
  expires_at: string | null;
}

export async function requestApproval(
  db: Db,
  args: {
    /** A task approval (Phase 5) or a mail approval (Phase 8). Exactly one. */
    taskId?: string | null;
    threadId?: string | null;
    ownerUserId: string;
    actionClass: string;
    action: string;
    /** Shown to the owner. Content — theirs, and never copied into the audit log. */
    summary: string;
    payload: unknown;
    ttlSeconds?: number;
  },
): Promise<Approval> {
  const hash = approvalHash(args.payload);
  if ((args.taskId ? 1 : 0) + (args.threadId ? 1 : 0) !== 1) {
    throw new ApprovalError('an approval belongs to exactly one task or one thread');
  }
  // Two partial unique indexes, one per subject, so `on conflict` has to name
  // the right one. Splitting the statement is clearer than a constraint name.
  const rows = args.taskId
    ? await db.query<Approval>(
        `insert into approvals (task_id, owner_user_id, action_class, action, summary, payload_hash, expires_at)
         values ($1, $2, $3, $4, $5, $6, case when $7::int is null then null else now() + make_interval(secs => $7::int) end)
         on conflict (task_id, action, payload_hash) where status = 'pending'
           do update set summary = excluded.summary
         returning *`,
        [args.taskId, args.ownerUserId, args.actionClass, args.action, args.summary, hash, args.ttlSeconds ?? null],
      )
    : await db.query<Approval>(
        `insert into approvals (thread_id, owner_user_id, action_class, action, summary, payload_hash, expires_at)
         values ($1, $2, $3, $4, $5, $6, case when $7::int is null then null else now() + make_interval(secs => $7::int) end)
         on conflict (thread_id, action, payload_hash) where status = 'pending' and thread_id is not null
           do update set summary = excluded.summary
         returning *`,
        [args.threadId, args.ownerUserId, args.actionClass, args.action, args.summary, hash, args.ttlSeconds ?? null],
      );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'agent',
    kind: 'approval.requested',
    subjectType: args.taskId ? 'task' : 'email_thread',
    subjectId: args.taskId ?? args.threadId ?? null,
    // The summary is what the action WOULD say. It stays out of the log.
    payload: { action: args.action, actionClass: args.actionClass, approvalId: rows[0].id },
  });
  return rows[0];
}

/** The owner's answer.
 *
 * `decidedBy` must be the owner. A colleague with write access to a shared task
 * may edit it; agreeing on the owner's behalf to something done in their name is
 * a different act, and this is the line. */
export async function decideApproval(
  db: Db,
  args: { approvalId: string; decidedBy: string; approve: boolean },
): Promise<Approval> {
  const [existing] = await db.query<Approval>(`select * from approvals where id = $1`, [args.approvalId]);
  if (!existing) throw new ApprovalError('no such approval');
  if (existing.owner_user_id !== args.decidedBy) {
    throw new ApprovalError('only the person the action would be taken for can approve it');
  }
  if (existing.status !== 'pending') {
    throw new ApprovalError(`that request was already ${existing.status}`);
  }
  const rows = await db.query<Approval>(
    `update approvals set status = $2, decided_at = now(), decided_by = $3
     where id = $1 and status = 'pending' returning *`,
    [args.approvalId, args.approve ? 'approved' : 'denied', args.decidedBy],
  );
  if (!rows.length) throw new ApprovalError('that request was decided by someone else first');
  await appendEvent(db, {
    actorUserId: args.decidedBy,
    actor: 'user',
    kind: args.approve ? 'approval.granted' : 'approval.denied',
    subjectType: existing.task_id ? 'task' : 'email_thread',
    subjectId: existing.task_id ?? existing.thread_id,
    payload: { action: existing.action, approvalId: existing.id },
  });
  return rows[0];
}

/** Spend an approval, exactly once, for exactly the action it described.
 *
 * Returns false rather than throwing on every "no" so the caller cannot forget
 * to handle one of them — but the reasons are distinguishable through the event
 * log, which is where an unexplained refusal gets investigated from. */
export async function consumeApproval(
  db: Db,
  args: { approvalId: string; payload: unknown },
): Promise<{ ok: boolean; reason?: 'not_found' | 'not_approved' | 'payload_changed' | 'expired' }> {
  const [row] = await db.query<Approval>(`select * from approvals where id = $1`, [args.approvalId]);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'approved') return { ok: false, reason: 'not_approved' };
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    await db.query(`update approvals set status = 'expired' where id = $1`, [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.payload_hash !== approvalHash(args.payload)) {
    // The thing about to happen is not the thing that was agreed to.
    await appendEvent(db, {
      actorUserId: row.owner_user_id,
      actor: 'system',
      kind: 'approval.payload_mismatch',
      subjectType: row.task_id ? 'task' : 'email_thread',
      subjectId: row.task_id ?? row.thread_id,
      payload: { approvalId: row.id, action: row.action },
    });
    return { ok: false, reason: 'payload_changed' };
  }
  return { ok: true };
}

export async function listPendingApprovals(db: Db, ownerUserId: string): Promise<Approval[]> {
  return db.query<Approval>(
    `select * from approvals where owner_user_id = $1 and status = 'pending'
     order by created_at desc limit 100`,
    [ownerUserId],
  );
}

/** Expire approvals nobody answered. Run by the worker. */
export async function expireApprovals(db: Db): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `update approvals set status = 'expired'
     where status = 'pending' and expires_at is not null and expires_at < now()
     returning id`,
  );
  return rows.length;
}
