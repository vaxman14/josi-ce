import { randomUUID } from 'node:crypto';
import type { Continuation, GoalProgress } from '@josi-ce/protocol';
import { json, type Db } from './db.js';
import { addMessage } from './conversations.js';

export class WorkGoalError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export interface WorkGoalStep {
  id: string;
  title: string;
  state: 'pending' | 'working' | 'blocked' | 'verified';
  taskId: string | null;
  evidence: string | null;
}
export interface WorkCheckpoint {
  decisions: string[];
  facts: string[];
  assumptions: string[];
  nextAction: string;
}
interface GoalRow {
  id: string; owner_user_id: string; thread_id: string; source_message_id: string;
  revision: number; state: GoalProgress['state']; outcome: string; criteria: string[];
  steps: WorkGoalStep[]; continuation: Continuation | null; activity: string;
  checkpoint: WorkCheckpoint; created_at: string; updated_at: string;
}
export interface WorkGoalSnapshot extends GoalProgress {
  threadId: string;
  criteria: string[];
  steps: WorkGoalStep[];
  checkpoint: WorkCheckpoint;
  createdAt: string;
  updatedAt: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new WorkGoalError('Choose an existing work item.');
  return value;
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new WorkGoalError('Use a clear, bounded description.');
  return value.trim();
}
function strings(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new WorkGoalError('Too many work details.');
  return value.map(item => text(item));
}
function snapshot(row: GoalRow): WorkGoalSnapshot {
  return { goalId: row.id, threadId: row.thread_id, revision: row.revision, afterSequence: row.revision,
    state: row.state, title: row.outcome, activity: row.activity, criteria: row.criteria, steps: row.steps,
    verifiedSteps: row.steps.filter(step => step.state === 'verified').length, totalSteps: row.steps.length,
    continuation: row.continuation, checkpoint: row.checkpoint, createdAt: row.created_at, updatedAt: row.updated_at };
}
async function owned(db: Db, owner: string, goalId: string, lock = false): Promise<GoalRow> {
  const [row] = await db.query<GoalRow>(`select * from work_goals where id=$1 and owner_user_id=$2${lock ? ' for update' : ''}`, [id(goalId), owner]);
  if (!row) throw new WorkGoalError('Work item not found.', 404);
  return row;
}
async function event(db: Db, row: GoalRow, kind: string, summary: string) {
  await db.query(`insert into work_goal_events(id,goal_id,owner_user_id,sequence,kind,summary) values($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), row.id, row.owner_user_id, row.revision, kind, summary]);
}
function transaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new WorkGoalError('Durable work storage is unavailable.', 503);
  return db.transaction(work);
}
async function save(db: Db, row: GoalRow, kind: string): Promise<WorkGoalSnapshot> {
  const [saved] = await db.query<GoalRow>(`update work_goals set revision=revision+1,state=$3,steps=$4,continuation=$5,
    activity=$6,checkpoint=$7,updated_at=now() where id=$1 and owner_user_id=$2 returning *`,
  [row.id, row.owner_user_id, row.state, json(row.steps), row.continuation ? json(row.continuation) : null, row.activity, json(row.checkpoint)]);
  await event(db, saved, kind, saved.activity);
  return snapshot(saved);
}
function current(row: GoalRow, revision: unknown) {
  if (!Number.isSafeInteger(revision) || revision !== row.revision) throw new WorkGoalError('This work changed. Refresh it before updating.', 409);
  if (['completed', 'cancelled'].includes(row.state)) throw new WorkGoalError('This work has already ended.', 409);
}

export async function createWorkGoal(db: Db, args: { ownerUserId: string; threadId: string; sourceMessageId: string;
  outcome: unknown; criteria: unknown; steps: unknown }): Promise<WorkGoalSnapshot> {
  const outcome = text(args.outcome, 500), criteria = strings(args.criteria), titles = strings(args.steps, 40);
  if (!criteria.length || !titles.length) throw new WorkGoalError('Record what finished means and at least one concrete step.');
  return transaction(db, async tx => {
    await tx.query(`select id from users where id=$1 for update`, [args.ownerUserId]);
    const [source] = await tx.query(`select m.id from messages m join threads t on t.id=m.thread_id
      where m.id=$1 and m.thread_id=$2 and t.owner_user_id=$3 and m.direction='in' for update of m`,
      [id(args.sourceMessageId), id(args.threadId), args.ownerUserId]);
    if (!source) throw new WorkGoalError('The original user request is unavailable.', 404);
    const [existing] = await tx.query<GoalRow>(`select * from work_goals where owner_user_id=$1 and source_message_id=$2`, [args.ownerUserId, args.sourceMessageId]);
    if (existing) return snapshot(existing); // Replay never creates another goal.
    const [count] = await tx.query<{ count: number }>(`select count(*)::integer as count from work_goals where owner_user_id=$1 and state not in ('completed','cancelled')`, [args.ownerUserId]);
    if (count.count >= 100) throw new WorkGoalError('Finish or cancel an existing goal before starting more work.', 409);
    const steps: WorkGoalStep[] = titles.map(title => ({ id: randomUUID(), title, state: 'pending', taskId: null, evidence: null }));
    const [row] = await tx.query<GoalRow>(`insert into work_goals(id,owner_user_id,thread_id,source_message_id,state,outcome,criteria,steps,continuation,activity)
      values($1,$2,$3,$4,'planning',$5,$6,$7,$8,$9) returning *`,
      [randomUUID(), args.ownerUserId, args.threadId, args.sourceMessageId, outcome, json(criteria), json(steps),
        json({ kind: 'action', stepId: steps[0].id }), 'Planning the work']);
    await event(tx, row, 'goal.accepted', row.activity);
    return snapshot(row);
  });
}

export async function listWorkGoals(db: Db, ownerUserId: string, options: { threadId?: string; includeEnded?: boolean } = {}): Promise<WorkGoalSnapshot[]> {
  const rows = await db.query<GoalRow>(`select * from work_goals where owner_user_id=$1
    ${options.threadId ? 'and thread_id=$2' : ''} ${options.includeEnded ? '' : "and state not in ('completed','cancelled')"}
    order by (state in ('completed','cancelled')),updated_at desc,id desc limit 100`, [ownerUserId, ...(options.threadId ? [id(options.threadId)] : [])]);
  return rows.map(snapshot);
}
export async function workGoalEvents(db: Db, ownerUserId: string, goalId: string, after: number) {
  await owned(db, ownerUserId, goalId);
  if (!Number.isSafeInteger(after) || after < 0) throw new WorkGoalError('Invalid progress cursor.');
  return db.query<{ id: string; sequence: number; kind: string; summary: string; created_at: string }>(
    `select id,sequence,kind,summary,created_at from work_goal_events where goal_id=$1 and owner_user_id=$2 and sequence>$3 order by sequence limit 200`, [goalId, ownerUserId, after]);
}

export async function checkpointWorkGoal(db: Db, args: { ownerUserId: string; goalId: string; revision: unknown;
  activity: unknown; checkpoint: unknown; next: unknown; stepId?: unknown; taskId?: unknown }): Promise<WorkGoalSnapshot> {
  const activity = text(args.activity, 500);
  const cp = args.checkpoint as Record<string, unknown> | null;
  if (!cp || typeof cp !== 'object' || Array.isArray(cp)) throw new WorkGoalError('Save the decisions, facts, assumptions and next action.');
  const checkpoint: WorkCheckpoint = { decisions: strings(cp.decisions), facts: strings(cp.facts), assumptions: strings(cp.assumptions), nextAction: text(cp.nextAction) };
  return transaction(db, async tx => {
    const row = await owned(tx, args.ownerUserId, args.goalId, true); current(row, args.revision);
    if (row.state === 'paused') throw new WorkGoalError('The user paused this work. Only the user can resume it.', 409);
    const next = args.next as Record<string, unknown> | null;
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new WorkGoalError('Every unfinished goal needs a next step, wait or question.');
    if (next.kind === 'action') {
      const stepId = id(next.stepId);
      if (!row.steps.some(step => step.id === stepId && step.state !== 'verified')) throw new WorkGoalError('Choose an unfinished step.');
      row.continuation = { kind: 'action', stepId }; row.state = 'working';
    } else if (next.kind === 'wait') {
      const wakeAt = typeof next.wakeAt === 'string' ? new Date(next.wakeAt) : new Date(NaN);
      if (!Number.isFinite(wakeAt.getTime()) || wakeAt.getTime() <= Date.now()) throw new WorkGoalError('Choose a future time to check again.');
      row.continuation = { kind: 'wait', reason: text(next.reason, 500), wakeAt: wakeAt.toISOString() }; row.state = 'waiting';
    } else if (next.kind === 'question') {
      row.continuation = { kind: 'question', questionId: randomUUID(), text: text(next.text) }; row.state = 'needs_instruction';
    } else throw new WorkGoalError('Choose a concrete next action, wait or question.');
    if (args.stepId !== undefined) {
      const step = row.steps.find(value => value.id === id(args.stepId));
      if (!step || step.state === 'verified') throw new WorkGoalError('Choose an unfinished step.');
      step.state = next.kind === 'action' ? 'working' : 'blocked';
      if (args.taskId !== undefined) {
        const taskId = id(args.taskId);
        const [task] = await tx.query(`select id from tasks where id=$1 and owner_user_id=$2 and thread_id=$3`, [taskId, args.ownerUserId, row.thread_id]);
        if (!task) throw new WorkGoalError('That task does not belong to this conversation.', 404);
        if (row.steps.some(value => value.id !== step.id && value.taskId === taskId)) throw new WorkGoalError('A task receipt can verify only its linked step.');
        step.taskId = taskId;
      }
    }
    row.activity = activity; row.checkpoint = checkpoint;
    return save(tx, row, next.kind === 'question' ? 'instruction.requested' : next.kind === 'wait' ? 'goal.waiting' : 'memory.checkpoint');
  });
}

export async function verifyWorkGoal(db: Db, args: { ownerUserId: string; goalId: string; revision: unknown }): Promise<WorkGoalSnapshot> {
  return transaction(db, async tx => {
    const row = await owned(tx, args.ownerUserId, args.goalId, true); current(row, args.revision);
    if (row.state === 'paused') throw new WorkGoalError('The user paused this work.', 409);
    for (const step of row.steps) {
      if (!step.taskId || step.state === 'verified') continue;
      // Verification comes from a settled executor outcome, never the model's
      // assertion or completion of its chat turn. Ambiguous/failed tasks stay open.
      const [task] = await tx.query(`select t.id from tasks t join assistant_action_states a on a.task_id=t.id
        where t.id=$1 and t.owner_user_id=$2 and t.thread_id=$3 and t.state='confirmed' and a.status='succeeded'`,
        [step.taskId, args.ownerUserId, row.thread_id]);
      if (task) { step.state = 'verified'; step.evidence = step.taskId; }
    }
    const unfinished = row.steps.find(step => step.state !== 'verified');
    if (unfinished) {
      row.state = 'needs_instruction';
      row.continuation = { kind: 'question', questionId: randomUUID(), text: `What evidence or additional work is needed to verify “${unfinished.title}”?` };
      row.activity = 'The result still needs verification';
    } else {
      // Execution receipts verify individual steps. The outcome criteria still
      // need an explicit owner review until the outcome-verifier adapter exists.
      row.state = 'verifying';
      row.continuation = { kind: 'question', questionId: randomUUID(), text: 'The recorded steps have verified receipts. Does the result meet every completion criterion?' };
      row.activity = 'Steps verified; waiting for outcome confirmation';
    }
    return save(tx, row, 'goal.verification');
  });
}

export async function controlWorkGoal(db: Db, args: { ownerUserId: string; goalId: string; revision: unknown;
  action: 'pause' | 'resume' | 'cancel' | 'confirm'; instruction?: unknown }): Promise<WorkGoalSnapshot> {
  return transaction(db, async tx => {
    const row = await owned(tx, args.ownerUserId, args.goalId, true); current(row, args.revision);
    if (args.action === 'pause') { row.state = 'paused'; row.continuation = { kind: 'user_paused' }; row.activity = 'Paused by you'; }
    else if (args.action === 'cancel') { row.state = 'cancelled'; row.continuation = null; row.activity = 'Cancelled by you'; }
    else if (args.action === 'confirm') {
      if (row.state !== 'verifying' || row.steps.some(step => step.state !== 'verified')) throw new WorkGoalError('Verify all recorded steps before confirming the outcome.', 409);
      row.state = 'completed'; row.continuation = null; row.activity = 'Outcome confirmed by you';
    } else if (args.action === 'resume') {
      const instruction = text(args.instruction);
      row.checkpoint = { decisions: row.checkpoint.decisions ?? [], facts: row.checkpoint.facts ?? [],
        assumptions: row.checkpoint.assumptions ?? [], nextAction: instruction };
      const step = row.steps.find(value => value.state !== 'verified');
      row.state = step ? 'working' : 'verifying';
      row.continuation = step ? { kind: 'action', stepId: step.id } : { kind: 'question', questionId: randomUUID(), text: 'Confirm the completed outcome.' };
      row.activity = 'Your instructions were saved';
    } else throw new WorkGoalError('Unsupported work control.');
    return save(tx, row, `goal.${args.action}`);
  });
}

/** Continue observing existing executor work after a reply ends. This worker
 * performs no new consequential action and never retries a failed effect. */
export async function reconcileWorkGoals(db: Db): Promise<number> {
  return transaction(db, async tx => {
    const rows = await tx.query<GoalRow & { stale: boolean; wake_due: boolean }>(`select g.*,
      g.updated_at < now()-interval '5 minutes' as stale,
      case when g.continuation->>'kind'='wait' then (g.continuation->>'wakeAt')::timestamptz <= now() else false end as wake_due
      from work_goals g where g.state in ('planning','working','waiting')
      and not exists(select 1 from assistant_turns t where t.thread_id=g.thread_id
        and t.status='running' and t.lease_expires_at>=now())
      order by g.reconciled_at,g.id for update of g skip locked limit 100`);
    let changed = 0;
    for (const row of rows) {
      await tx.query(`update work_goals set reconciled_at=now() where id=$1`, [row.id]);
      let updated = false, active = false, failed: WorkGoalStep | null = null;
      for (const step of row.steps) {
        if (!step.taskId || step.state === 'verified') continue;
        const [task] = await tx.query<{ state: string; action_status: string | null }>(
          `select t.state,a.status as action_status from tasks t left join assistant_action_states a on a.task_id=t.id
           where t.id=$1 and t.owner_user_id=$2 and t.thread_id=$3`, [step.taskId, row.owner_user_id, row.thread_id]);
        if (task?.state === 'confirmed' && task.action_status === 'succeeded') {
          step.state = 'verified'; step.evidence = step.taskId; updated = true;
        } else if (!task || ['failed', 'cancelled', 'closed'].includes(task.state)) failed ??= step;
        else if (['attempting', 'ready', 'held'].includes(task.state)) active = true;
      }
      if (row.steps.every(step => step.state === 'verified')) {
        row.state = 'verifying'; row.activity = 'Steps verified; waiting for outcome confirmation';
        row.continuation = { kind: 'question', questionId: randomUUID(), text: 'The recorded steps have verified receipts. Does the result meet every completion criterion?' };
        updated = true;
      } else if (failed) {
        failed.state = 'blocked'; row.state = 'needs_instruction'; row.activity = 'A step needs your instructions';
        row.continuation = { kind: 'question', questionId: randomUUID(), text: `“${failed.title}” did not finish. Should Josi check the destination and try another approach, change the task, or stop?` };
        updated = true;
      } else if (!active && (row.wake_due || (row.stale && row.continuation?.kind !== 'wait'))) {
        row.state = 'needs_instruction'; row.activity = row.wake_due ? 'The requested check is due' : 'Work needs a continuation instruction';
        row.continuation = { kind: 'question', questionId: randomUUID(), text: row.checkpoint.nextAction
          ? `Continue with this next action: ${row.checkpoint.nextAction}` : `How should Josi continue “${row.steps.find(step => step.state !== 'verified')!.title}”?` };
        updated = true;
      } else if (updated) row.activity = 'A task result was verified';
      if (updated) {
        const saved = await save(tx, row, row.state === 'needs_instruction' ? 'instruction.requested' : 'step.verified');
        if (row.continuation?.kind === 'question') await addMessage(tx, { threadId: row.thread_id, direction: 'out',
          body: `${row.outcome}\n${row.continuation.text}`, meta: { work_goal_id: row.id, work_goal_revision: saved.revision, progress_notice: true } });
        changed++;
      }
    }
    return changed;
  });
}
