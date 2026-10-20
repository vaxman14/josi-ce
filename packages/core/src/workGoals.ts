import { randomUUID } from 'node:crypto';
import type { Continuation, GoalProgress } from '@josi-ce/protocol';
import { json, type Db } from './db.js';
import { addMessage } from './conversations.js';
import { refuseMemorySecret } from './memorySafety.js';
import { queueWorkContinuation, WORK_SEGMENT_LIMIT } from './workContinuation.js';
import { readyWorkSteps, workDependencies, workDependenciesSatisfied, workStepRequired, workStepUnfinished, type WorkGoalStep } from './workPlan.js';
export type { WorkGoalStep } from './workPlan.js';

export class WorkGoalError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
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
  checkpoint: WorkCheckpoint; checkpoint_pinned: boolean; created_at: string; updated_at: string;
  owner_checkpoint: WorkCheckpoint | null; owner_checkpoint_at: string | null;
  control_generation: number; continuation_ready_at: string | null;
  continuation_segments: number; continuation_verified: number;
  plan_revision: number;
  outcome_revision: number; planned_outcome_revision: number; plan_review_required: boolean;
}
export interface WorkGoalSnapshot extends GoalProgress {
  threadId: string;
  criteria: string[];
  steps: WorkGoalStep[];
  checkpoint: WorkCheckpoint;
  checkpointPinned: boolean;
  ownerCheckpoint?: WorkCheckpoint | null;
  ownerCheckpointAt?: string | null;
  createdAt: string;
  updatedAt: string;
  planRevision?: number;
  outcomeRevision?: number;
  planNeedsReview?: boolean;
  automaticWork?: { segmentsSinceVerifiedProgress: number; segmentLimit: number; nextCheckAt: string | null };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new WorkGoalError('Choose an existing work item.');
  return value;
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new WorkGoalError('Use a clear, bounded description.');
  if (refuseMemorySecret(value)) throw new WorkGoalError('Keep credentials in the Vault, not in saved work.');
  return value.trim();
}
function strings(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new WorkGoalError('Too many work details.');
  return value.map(item => text(item));
}
function needsPlanReview(row: GoalRow): boolean { return row.plan_review_required === true || row.outcome_revision !== row.planned_outcome_revision; }
function snapshot(row: GoalRow): WorkGoalSnapshot {
  return { goalId: row.id, threadId: row.thread_id, revision: row.revision, afterSequence: row.revision,
    state: row.state, title: row.outcome, activity: row.activity, criteria: row.criteria,
    steps: row.steps.map(step => ({ ...step, dependsOn: workDependencies(row.steps, step) })),
    verifiedSteps: row.steps.filter(step => step.state === 'verified').length, totalSteps: row.steps.filter(workStepRequired).length, retiredSteps: row.steps.filter(step => !workStepRequired(step)).length,
    continuation: row.continuation, checkpoint: row.checkpoint, checkpointPinned: row.checkpoint_pinned,
    ownerCheckpoint: row.owner_checkpoint ?? null, ownerCheckpointAt: row.owner_checkpoint_at ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at, planRevision: row.plan_revision,
    outcomeRevision: row.outcome_revision, planNeedsReview: needsPlanReview(row),
    automaticWork: { segmentsSinceVerifiedProgress: row.continuation_segments, segmentLimit: WORK_SEGMENT_LIMIT,
      nextCheckAt: row.continuation_ready_at } };
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
async function save(db: Db, row: GoalRow, kind: string, summary?: string): Promise<WorkGoalSnapshot> {
  const [saved] = await db.query<GoalRow>(`update work_goals set revision=revision+1,state=$3,steps=$4,continuation=$5,
    activity=$6,checkpoint=$7,checkpoint_pinned=$8,plan_revision=$9,updated_at=now() where id=$1 and owner_user_id=$2 returning *`,
  [row.id, row.owner_user_id, row.state, json(row.steps), row.continuation ? json(row.continuation) : null, row.activity, json(row.checkpoint), row.checkpoint_pinned, row.plan_revision]);
  await event(db, saved, kind, summary ?? saved.activity);
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
    const stepIds = titles.map(() => randomUUID());
    const steps: WorkGoalStep[] = titles.map((title, index) => ({ id: stepIds[index], title, state: 'pending', taskId: null,
      evidence: null, dependsOn: index ? [stepIds[index - 1]] : [], blockedReason: null }));
    const [row] = await tx.query<GoalRow>(`insert into work_goals(id,owner_user_id,thread_id,source_message_id,state,outcome,criteria,steps,continuation,activity)
      values($1,$2,$3,$4,'planning',$5,$6,$7,$8,$9) returning *`,
      [randomUUID(), args.ownerUserId, args.threadId, args.sourceMessageId, outcome, json(criteria), json(steps),
        json({ kind: 'action', stepId: steps[0].id }), 'Planning the work']);
    await event(tx, row, 'goal.accepted', row.activity);
    await tx.query(`insert into work_goal_plans(goal_id,owner_user_id,plan_revision,goal_revision,steps,reason)
      values($1,$2,1,$3,$4,'Initial saved plan')`, [row.id, row.owner_user_id, row.revision, json(steps)]);
    await tx.query(`insert into work_goal_outcomes(goal_id,owner_user_id,outcome_revision,goal_revision,outcome,criteria,reason,source)
      values($1,$2,1,$3,$4,$5,'Initial outcome recorded from the request','request_plan')`,
      [row.id, row.owner_user_id, row.revision, outcome, json(criteria)]);
    return snapshot(row);
  });
}

/** Revise ordering/dependencies or add necessary steps without erasing work,
 * changing the requested outcome or minting replacement effect identities. */
export async function reviseWorkPlan(db: Db, args: { ownerUserId: string; goalId: string; revision: unknown;
  steps: unknown; reason: unknown; outcomeRevision?: unknown }): Promise<WorkGoalSnapshot> {
  const reason = text(args.reason, 500);
  if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > 40) throw new WorkGoalError('Use between 1 and 40 plan steps.');
  const input = args.steps.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'dependsOn,id,title'
      || typeof value.id !== 'string' || !(UUID.test(value.id) || /^new:[a-z0-9_-]{1,40}$/.test(value.id))
      || !Array.isArray(value.dependsOn) || value.dependsOn.length > 39
      || value.dependsOn.some((item: unknown) => typeof item !== 'string')) throw new WorkGoalError('Use an exact step identity, title and dependency list.');
    return { id: value.id as string, title: text(value.title), dependsOn: [...value.dependsOn] as string[] };
  });
  return transaction(db, async tx => {
    const row = await owned(tx, args.ownerUserId, args.goalId, true); current(row, args.revision);
    if (row.state === 'paused' || row.state === 'verifying') throw new WorkGoalError('Resume this work with instructions before changing its plan.', 409);
    const needsReview = needsPlanReview(row);
    if ((needsReview || args.outcomeRevision !== undefined) && args.outcomeRevision !== row.outcome_revision) {
      throw new WorkGoalError('Read the current outcome and bind the revised plan to its exact outcome revision.', 409);
    }
    const names = new Set(input.map(step => step.id));
    if (names.size !== input.length || row.steps.some(step => !names.has(step.id))) throw new WorkGoalError('Keep every existing step and its original identity.');
    const effects = await tx.query<{ step_id: string }>('select step_id from work_goal_effects where goal_id=$1', [row.id]);
    const locked = new Set(effects.map(value => value.step_id));
    const ids = new Map(input.map(step => [step.id, step.id.startsWith('new:') ? randomUUID() : step.id]));
    const next = input.map(step => {
      const previous = row.steps.find(value => value.id === step.id);
      if (!previous && !step.id.startsWith('new:')) throw new WorkGoalError('Use new: followed by a unique short name for a new step.');
      if (new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(dependency => !names.has(dependency) || dependency === step.id)) {
        throw new WorkGoalError('Dependencies must name other steps in this plan, once each.');
      }
      const dependsOn = step.dependsOn.map(name => ids.get(name)!);
      if (previous?.state !== 'skipped' && dependsOn.some(dependency => row.steps.some(value => value.id === dependency && value.state === 'skipped'))) {
        throw new WorkGoalError('A retired step does not satisfy a dependency. Review and explicitly remove that dependency or add the needed replacement work.', 409);
      }
      if (previous && (previous.taskId || previous.evidence || previous.state === 'verified' || previous.state === 'skipped' || locked.has(previous.id))
        && (step.title !== previous.title || JSON.stringify([...dependsOn].sort()) !== JSON.stringify([...workDependencies(row.steps, previous)].sort()))) {
        throw new WorkGoalError('Keep the meaning and dependencies of a step that already has an action or receipt.', 409);
      }
      return previous ? { ...previous, title: step.title, dependsOn }
        : { id: ids.get(step.id)!, title: step.title, dependsOn, state: 'pending' as const, taskId: null, evidence: null, blockedReason: null };
    });
    const visiting = new Set<string>(), visited = new Set<string>();
    function visit(stepId: string) {
      if (visiting.has(stepId)) throw new WorkGoalError('The plan contains a circular dependency.');
      if (visited.has(stepId)) return;
      visiting.add(stepId);
      for (const dependency of next.find(step => step.id === stepId)!.dependsOn) visit(dependency);
      visiting.delete(stepId); visited.add(stepId);
    }
    next.forEach(step => visit(step.id));
    row.steps = next; row.plan_revision += 1; row.activity = `Plan updated: ${reason}`;
    const selected = row.continuation?.kind === 'action' ? row.continuation.stepId : null;
    const ready = readyWorkSteps(next), following = ready.find(step => step.id === selected) ?? ready[0];
    if (needsReview) {
      row.state = following ? 'working' : !next.some(workStepUnfinished) ? 'verifying' : 'needs_instruction';
      row.continuation = following ? { kind: 'action', stepId: following.id }
        : { kind: 'question', questionId: randomUUID(), text: row.state === 'verifying'
          ? 'The plan was reviewed. Do the required results meet every current completion criterion? Retired steps are not verified work.'
          : 'The revised plan retains blocked work. Which blocker should Josi address before continuing?' };
    } else if (row.continuation?.kind === 'action' && following) row.continuation = { kind: 'action', stepId: following.id };
    else if (row.continuation?.kind === 'action' && !following) {
      row.state = 'needs_instruction'; row.continuation = { kind: 'question', questionId: randomUUID(),
        text: 'Every remaining step is blocked or depends on unfinished work. Which blocker should Josi address first?' };
    }
    await tx.query('update work_goals set planned_outcome_revision=outcome_revision,plan_review_required=false where id=$1', [row.id]);
    const saved = await save(tx, row, 'plan.revised');
    await tx.query(`insert into work_goal_plans(goal_id,owner_user_id,plan_revision,goal_revision,steps,reason,outcome_revision)
      values($1,$2,$3,$4,$5,$6,$7)`, [row.id, row.owner_user_id, row.plan_revision, saved.revision, json(next), reason, row.outcome_revision]);
    return saved;
  });
}

export async function workPlanHistory(db: Db, ownerUserId: string, goalId: string, before?: number) {
  await owned(db, ownerUserId, goalId);
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new WorkGoalError('Invalid plan history cursor.');
  return db.query<{ plan_revision: number; goal_revision: number; outcome_revision: number; steps: WorkGoalStep[]; reason: string; created_at: string }>(
    `select plan_revision,goal_revision,outcome_revision,steps,reason,created_at from work_goal_plans
      where goal_id=$1 and owner_user_id=$2 and ($3::integer is null or plan_revision<$3)
      order by plan_revision desc limit 20`, [goalId, ownerUserId, before ?? null]);
}

/** Owner-only scope reduction, never a model tool, success receipt or effect
 * cancellation. A retired step stays in every later plan with its history. */
export async function retireWorkStep(db: Db, args: { ownerUserId: string; goalId: string; revision: unknown;
  stepId: unknown; reason: unknown; continueWork: boolean }): Promise<WorkGoalSnapshot> {
  const stepId = id(args.stepId), reason = text(args.reason);
  if (typeof args.continueWork !== 'boolean') throw new WorkGoalError('Choose whether to continue after reviewing the plan.');
  return transaction(db, async tx => {
    const row = await owned(tx, args.ownerUserId, args.goalId, true); current(row, args.revision);
    const step = row.steps.find(value => value.id === stepId);
    if (!step || !workStepUnfinished(step)) throw new WorkGoalError('Choose an unfinished required step.');
    if (row.steps.filter(workStepRequired).length <= 1) throw new WorkGoalError('Keep at least one required step. Add replacement work to the plan or cancel the goal if it is no longer needed.');
    const [thread] = await tx.query(`select id from threads where id=$1 and owner_user_id=$2 and status='open'`, [row.thread_id, args.ownerUserId]);
    if (!thread) throw new WorkGoalError('Reopen this conversation before changing its plan.', 409);
    const effects = await tx.query<{ step_id: string; state: string }>(
      'select step_id,state from work_goal_effects where goal_id=$1 for update', [row.id]);
    if (effects.some(value => value.state === 'started')) throw new WorkGoalError('This goal has an unresolved action. Reconcile its result before retiring work.', 409);
    if (!step.taskId && effects.some(value => value.step_id === step.id)) {
      throw new WorkGoalError('This step has an action receipt. Attach and close its original task before retiring it.', 409);
    }
    if (step.taskId) {
      // Closed is irreversible in the task state machine. Failed/cancelled
      // alone may still have live workers or a retry path; never hide them.
      const [task] = await tx.query<{ state: string }>(
        'select state from tasks where id=$1 and owner_user_id=$2 and thread_id=$3 for update',
        [step.taskId, args.ownerUserId, row.thread_id]);
      if (task?.state !== 'closed') throw new WorkGoalError('Close and reconcile the linked task before retiring this step. Retirement does not cancel an action.', 409);
      const [unresolved] = await tx.query(`select 1 from automation_reservations
        where task_id=$1 and state in ('reserved','dispatched','uncertain') limit 1`, [step.taskId]);
      const [action] = await tx.query(`select 1 from assistant_action_states
        where task_id=$1 and status in ('collecting','prepared','approved','executing') limit 1`, [step.taskId]);
      const [attempt] = await tx.query('select 1 from task_attempts where task_id=$1 and ended_at is null limit 1', [step.taskId]);
      const [job] = await tx.query(`select 1 from job_queue
        where kind='task.wake' and payload->>'taskId'=$1 and status in ('queued','running') limit 1`, [step.taskId]);
      if (unresolved || action || attempt || job) throw new WorkGoalError('The linked task still has a queued, running or unresolved action. Reconcile it before retiring this step.', 409);
    }
    if (row.steps.some(value => workStepRequired(value) && workDependencies(row.steps, value).includes(stepId)
      && (value.taskId || value.evidence || value.state === 'verified' || effects.some(effect => effect.step_id === value.id)))) {
      throw new WorkGoalError('A step with an existing action or receipt depends on this work. Keep that dependency history and resolve it before retiring this step.', 409);
    }
    const [{ at }] = await tx.query<{ at: string }>('select clock_timestamp()::text as at');
    row.plan_revision += 1;
    step.state = 'skipped';
    step.retirement = { actorUserId: args.ownerUserId, reason, at: new Date(at).toISOString(),
      outcomeRevision: row.outcome_revision, planRevision: row.plan_revision };
    row.plan_review_required = true;
    row.state = args.continueWork ? 'planning' : 'paused';
    row.continuation = args.continueWork ? { kind: 'question', questionId: randomUUID(),
      text: 'You retired a step. Review the remaining requirements and dependencies, then save a revised plan before further actions.' }
      : { kind: 'user_paused' };
    row.activity = args.continueWork ? 'You retired an obsolete step; Josi must review the plan' : 'You retired an obsolete step; work is paused';
    // Invalidate running/queued continuation authority and stale memory before
    // another effect. Existing action/receipt counters are never reset.
    await tx.query(`update work_goals set plan_review_required=true,control_generation=control_generation+1,
      continuation_ready_at=case when $2 then now() else null end where id=$1`, [row.id, args.continueWork]);
    await tx.query(`update users set work_memory_version=work_memory_version+1 where id=$1`, [args.ownerUserId]);
    await tx.query(`update assistant_turns set status='failed',error_code='work_control_changed',error_retryable=false,completed_at=now()
      where work_goal_id=$1 and status='queued'`, [row.id]);
    const saved = await save(tx, row, 'step.retired');
    await tx.query(`insert into work_goal_plans(goal_id,owner_user_id,plan_revision,goal_revision,steps,reason,outcome_revision)
      values($1,$2,$3,$4,$5,$6,$7)`, [row.id, args.ownerUserId, row.plan_revision, saved.revision,
      json(row.steps), `Owner retired “${step.title}”: ${reason}`, row.outcome_revision]);
    await addMessage(tx, { threadId: row.thread_id, direction: 'out',
      body: `You retired this step: ${step.title}\nReason: ${reason}\nIts history remains; it was not marked successful. Josi must review the remaining plan before further actions.`,
      meta: { work_goal_id: row.id, work_goal_revision: saved.revision, progress_notice: true } });
    return saved;
  });
}

/** Explicit owner steering, never a model tool or an automation grant.
 * Retain all original steps, receipts and budgets; invalidate old continuations
 * and require a new exact-version plan before another assistant effect. */
export async function changeWorkOutcome(db: Db, args: { ownerUserId: string; goalId: string; revision: unknown;
  outcome: unknown; criteria: unknown; reason: unknown; continueWork: boolean }): Promise<WorkGoalSnapshot> {
  const outcome = text(args.outcome, 500), criteria = strings(args.criteria), reason = text(args.reason);
  if (!criteria.length || typeof args.continueWork !== 'boolean') throw new WorkGoalError('Record completion criteria and choose whether to continue.');
  return transaction(db, async tx => {
    const row = await owned(tx, args.ownerUserId, args.goalId, true); current(row, args.revision);
    if (row.outcome === outcome && JSON.stringify(row.criteria) === JSON.stringify(criteria)) {
      throw new WorkGoalError('The outcome and criteria are unchanged. Use Add instructions to steer the next action.');
    }
    const [thread] = await tx.query(`select id from threads where id=$1 and owner_user_id=$2 and status='open'`, [row.thread_id, args.ownerUserId]);
    if (!thread) throw new WorkGoalError('Reopen this conversation before changing its outcome.', 409);
    row.outcome = outcome; row.criteria = criteria; row.outcome_revision += 1;
    row.state = args.continueWork ? 'planning' : 'paused';
    row.continuation = args.continueWork ? { kind: 'question', questionId: randomUUID(),
      text: 'Review the current outcome, criteria and any retired steps, then save a revised plan before further actions.' } : { kind: 'user_paused' };
    row.activity = args.continueWork ? 'Your outcome changed; Josi must update its plan' : 'Your outcome changed; work stays paused';
    const correction: WorkCheckpoint = { decisions: row.owner_checkpoint?.decisions ?? [], facts: row.owner_checkpoint?.facts ?? [],
      assumptions: row.owner_checkpoint?.assumptions ?? [], nextAction: reason };
    await tx.query(`update work_goals set outcome=$2,criteria=$3,outcome_revision=$4,owner_checkpoint=$5,owner_checkpoint_at=now(),
      control_generation=control_generation+1,continuation_segments=0,
      continuation_ready_at=case when $6 then now() else null end where id=$1`,
      [row.id, outcome, json(criteria), row.outcome_revision, json(correction), args.continueWork]);
    await tx.query(`update users set work_memory_version=work_memory_version+1 where id=$1`, [args.ownerUserId]);
    await tx.query(`update assistant_turns set status='failed',error_code='work_control_changed',error_retryable=false,completed_at=now()
      where work_goal_id=$1 and status='queued'`, [row.id]);
    const saved = await save(tx, row, 'outcome.changed');
    await tx.query(`insert into work_goal_outcomes(goal_id,owner_user_id,outcome_revision,goal_revision,outcome,criteria,reason,source)
      values($1,$2,$3,$4,$5,$6,$7,'owner_edit')`,
      [row.id, row.owner_user_id, row.outcome_revision, saved.revision, outcome, json(criteria), reason]);
    await addMessage(tx, { threadId: row.thread_id, direction: 'out',
      body: `Your requested outcome is now: ${outcome}\nFinished means:\n${criteria.map(value => `• ${value}`).join('\n')}\n${row.activity}. Existing action receipts remain saved.`,
      meta: { work_goal_id: row.id, work_goal_revision: saved.revision, progress_notice: true } });
    return saved;
  });
}

export async function workOutcomeHistory(db: Db, ownerUserId: string, goalId: string, before?: number) {
  await owned(db, ownerUserId, goalId);
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new WorkGoalError('Invalid outcome history cursor.');
  return db.query<{ outcome_revision: number; goal_revision: number; outcome: string; criteria: string[];
    reason: string; source: string; created_at: string }>(
    `select outcome_revision,goal_revision,outcome,criteria,reason,source,created_at from work_goal_outcomes
      where goal_id=$1 and owner_user_id=$2 and ($3::integer is null or outcome_revision<$3)
      order by outcome_revision desc limit 20`, [goalId, ownerUserId, before ?? null]);
}

export async function workChannelProgress(db: Db, ownerUserId: string, goalId: string) {
  const goal = await owned(db, ownerUserId, goalId);
  const [row] = await db.query<{ state: string; last_sent_revision: number; updated_at: string; error_code: string | null;
    connected: boolean }>(`select p.state,p.last_sent_revision,p.updated_at,p.error_code,
      (l.status='active' and l.user_id=p.owner_user_id and l.thread_id=$3 and l.chat_id=p.chat_id
        and t.status='open' and t.owner_user_id=p.owner_user_id and c.enabled and c.bot_id::text=p.bot_id) as connected
      from telegram_work_progress p left join telegram_links l on l.id=p.link_id
      left join threads t on t.id=$3
      left join telegram_config c on c.id=true where p.goal_id=$1 and p.owner_user_id=$2`,
      [goalId, ownerUserId, goal.thread_id]);
  return row ? { channel: 'telegram' as const, state: row.connected ? row.state : 'disabled',
    revision: row.last_sent_revision, currentRevision: goal.revision, updatedAt: row.updated_at, errorCode: row.error_code } : null;
}

export async function listWorkGoals(db: Db, ownerUserId: string, options: { threadId?: string; includeEnded?: boolean; endedOnly?: boolean } = {}): Promise<WorkGoalSnapshot[]> {
  const rows = await db.query<GoalRow>(`select * from work_goals where owner_user_id=$1
    ${options.threadId ? 'and thread_id=$2' : ''} ${options.endedOnly ? "and state in ('completed','cancelled')" : options.includeEnded ? '' : "and state not in ('completed','cancelled')"}
    order by (state in ('completed','cancelled')),updated_at desc,id desc limit 100`, [ownerUserId, ...(options.threadId ? [id(options.threadId)] : [])]);
  return rows.map(snapshot);
}
export async function workGoalEvents(db: Db, ownerUserId: string, goalId: string, after: number, options: { before?: number; limit?: number } = {}) {
  await owned(db, ownerUserId, goalId);
  if (!Number.isSafeInteger(after) || after < 0) throw new WorkGoalError('Invalid progress cursor.');
  const limit = options.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || options.before !== undefined
    && (!Number.isSafeInteger(options.before) || options.before < 1 || after !== 0)) throw new WorkGoalError('Invalid activity page.');
  const rows = await db.query<{ id: string; sequence: number; kind: string; summary: string; created_at: string }>(
    `select id,sequence,kind,summary,created_at from work_goal_events where goal_id=$1 and owner_user_id=$2
      and sequence${options.before === undefined ? '>' : '<'}$3 order by sequence ${options.before === undefined ? 'asc' : 'desc'} limit $4`,
    [goalId, ownerUserId, options.before ?? after, limit]);
  return options.before === undefined ? rows : rows.reverse();
}

export async function pinnedWorkGoals(db: Db, ownerUserId: string): Promise<WorkGoalSnapshot[]> {
  return (await db.query<GoalRow>(`select * from work_goals where owner_user_id=$1 and checkpoint_pinned
    order by updated_at desc,id desc limit 8`, [ownerUserId])).map(snapshot);
}

export async function readWorkGoal(db: Db, ownerUserId: string, goalId: string, threadId: string): Promise<WorkGoalSnapshot> {
  const row = await owned(db, ownerUserId, goalId);
  // A pin is explicit permission to recall this owner's notes across their
  // conversations; it does not grant another owner's or an unpinned record.
  if (row.thread_id !== threadId && !row.checkpoint_pinned) throw new WorkGoalError('Work item not found in this conversation.', 404);
  return snapshot(row);
}

/** Owner-only correction, pinning and forgetting; deliberately not a model
 * tool. Corrections never resume a paused goal or grant execution authority. */
export async function editWorkMemory(db: Db, args: { ownerUserId: string; goalId: string; revision: unknown;
  action: 'correct' | 'pin' | 'unpin' | 'forget'; checkpoint?: unknown }): Promise<WorkGoalSnapshot> {
  return transaction(db, async tx => {
    const row = await owned(tx, args.ownerUserId, args.goalId, true);
    if (!Number.isSafeInteger(args.revision) || args.revision !== row.revision) throw new WorkGoalError('Saved work changed. Refresh before editing.', 409);
    if (args.action === 'pin') {
      await tx.query(`select id from users where id=$1 for update`, [args.ownerUserId]);
      const [count] = await tx.query<{ count: number }>(`select count(*)::integer as count from work_goals where owner_user_id=$1 and checkpoint_pinned`, [args.ownerUserId]);
      if (!row.checkpoint_pinned && count.count >= 8) throw new WorkGoalError('Unpin a saved checkpoint before pinning another.', 409);
      row.checkpoint_pinned = true;
    } else if (args.action === 'unpin') row.checkpoint_pinned = false;
    else if (args.action === 'forget') {
      row.checkpoint = { decisions: [], facts: [], assumptions: [], nextAction: '' }; row.checkpoint_pinned = false;
    } else if (args.action === 'correct') {
      const value = args.checkpoint as Record<string, unknown> | null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkGoalError('Enter the corrected work notes.');
      row.checkpoint = { decisions: strings(value.decisions), facts: strings(value.facts), assumptions: strings(value.assumptions), nextAction: text(value.nextAction) };
    } else throw new WorkGoalError('Choose a memory action.');
    if (args.action === 'correct' || args.action === 'forget') {
      // Only this owner route writes the correction source. Model checkpoints
      // use save(), which deliberately does not include these columns.
      await tx.query(`update work_goals set owner_checkpoint=$2,owner_checkpoint_at=case when $2::jsonb is null then null else now() end where id=$1`,
        [row.id, args.action === 'forget' ? null : json(row.checkpoint)]);
      await tx.query(`update work_goals set control_generation=control_generation+1,
        continuation_ready_at=case when state in ('planning','working','waiting') then now()+interval '30 seconds' else null end where id=$1`, [row.id]);
      await tx.query(`update assistant_turns set status='failed',error_code='work_control_changed',error_retryable=false,completed_at=now()
        where work_goal_id=$1 and status='queued'`, [row.id]);
    }
    await tx.query(`update users set work_memory_version=work_memory_version+1 where id=$1`, [args.ownerUserId]);
    const summaries = { correct: 'Your correction was saved separately from Josi’s progress notes',
      forget: 'Saved work notes and your correction were cleared', pin: 'Work notes pinned for future conversations',
      unpin: 'Work notes unpinned from future conversations' };
    return save(tx, row, `memory.${args.action}`, summaries[args.action]);
  });
}

export async function checkpointWorkGoal(db: Db, args: { ownerUserId: string; goalId: string; revision: unknown;
  activity: unknown; checkpoint: unknown; next: unknown; stepId?: unknown; taskId?: unknown; blockedReason?: unknown }): Promise<WorkGoalSnapshot> {
  const activity = text(args.activity, 500);
  const cp = args.checkpoint as Record<string, unknown> | null;
  if (!cp || typeof cp !== 'object' || Array.isArray(cp)) throw new WorkGoalError('Save the decisions, facts, assumptions and next action.');
  const checkpoint: WorkCheckpoint = { decisions: strings(cp.decisions), facts: strings(cp.facts), assumptions: strings(cp.assumptions), nextAction: text(cp.nextAction) };
  return transaction(db, async tx => {
    const row = await owned(tx, args.ownerUserId, args.goalId, true); current(row, args.revision);
    if (row.state === 'paused') throw new WorkGoalError('The user paused this work. Only the user can resume it.', 409);
    const next = args.next as Record<string, unknown> | null;
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new WorkGoalError('Every unfinished goal needs a next step, wait or question.');
    if (needsPlanReview(row) && (next.kind !== 'question' || args.stepId !== undefined || args.taskId !== undefined)) {
      throw new WorkGoalError('Update the plan for the current outcome before selecting or changing a work step.', 409);
    }
    if (next.kind === 'action') {
      const stepId = id(next.stepId);
      const selected = row.steps.find(step => step.id === stepId && workStepUnfinished(step));
      if (!selected || !workDependenciesSatisfied(row.steps, selected)) throw new WorkGoalError('Choose an unfinished step whose dependencies are verified.');
      if (selected.state === 'blocked' && selected.taskId) throw new WorkGoalError('Reconcile the blocked task before choosing another action for this step.', 409);
      row.continuation = { kind: 'action', stepId }; row.state = 'working';
    } else if (next.kind === 'wait') {
      const wakeAt = typeof next.wakeAt === 'string' ? new Date(next.wakeAt) : new Date(NaN);
      if (!Number.isFinite(wakeAt.getTime()) || wakeAt.getTime() <= Date.now()) throw new WorkGoalError('Choose a future time to check again.');
      row.continuation = { kind: 'wait', reason: text(next.reason, 500), wakeAt: wakeAt.toISOString() }; row.state = 'waiting';
    } else if (next.kind === 'question') {
      row.continuation = { kind: 'question', questionId: randomUUID(), text: text(next.text) }; row.state = 'needs_instruction';
    } else throw new WorkGoalError('Choose a concrete next action, wait or question.');
    if (args.blockedReason !== undefined && args.stepId === undefined) throw new WorkGoalError('Name the blocked step.');
    if (args.stepId !== undefined) {
      const step = row.steps.find(value => value.id === id(args.stepId));
      if (!step || !workStepUnfinished(step)) throw new WorkGoalError('Choose an unfinished step.');
      if (args.blockedReason !== undefined && next.kind === 'action' && next.stepId === step.id) throw new WorkGoalError('Choose an independent next step while this one is blocked.');
      step.state = next.kind === 'action' && args.blockedReason === undefined ? 'working' : 'blocked';
      step.blockedReason = args.blockedReason !== undefined ? text(args.blockedReason) : next.kind === 'question' ? text(next.text) : next.kind === 'wait' ? text(next.reason, 500) : null;
      step.blockedUntil = next.kind === 'wait' ? new Date(String(next.wakeAt)).toISOString() : null;
      if (args.taskId !== undefined) {
        const taskId = id(args.taskId);
        if (step.taskId && step.taskId !== taskId) throw new WorkGoalError('Keep the original task receipt attached to this step.', 409);
        const [task] = await tx.query(`select id from tasks where id=$1 and owner_user_id=$2 and thread_id=$3`, [taskId, args.ownerUserId, row.thread_id]);
        if (!task) throw new WorkGoalError('That task does not belong to this conversation.', 404);
        if (row.steps.some(value => value.id !== step.id && value.taskId === taskId)) throw new WorkGoalError('A task receipt can verify only its linked step.');
        step.taskId = taskId;
      }
    }
    row.activity = activity; row.checkpoint = checkpoint;
    const independent = ['question', 'wait'].includes(String(next.kind)) && args.stepId !== undefined ? readyWorkSteps(row.steps)[0] : null;
    if (independent) {
      row.state = 'working'; row.continuation = { kind: 'action', stepId: independent.id };
      row.activity = `${activity} · Continuing independent work`;
    }
    const saved = await save(tx, row, next.kind === 'question' ? 'instruction.requested' : next.kind === 'wait' ? 'goal.waiting' : 'memory.checkpoint');
    if (independent && next.kind === 'question') await addMessage(tx, { threadId: row.thread_id, direction: 'out',
      body: `${text(next.text)}\nJosi can continue with “${independent.title}” while this step waits.`,
      meta: { work_goal_id: row.id, work_goal_revision: saved.revision, progress_notice: true } });
    return saved;
  });
}

export async function verifyWorkGoal(db: Db, args: { ownerUserId: string; goalId: string; revision: unknown }): Promise<WorkGoalSnapshot> {
  return transaction(db, async tx => {
    const row = await owned(tx, args.ownerUserId, args.goalId, true); current(row, args.revision);
    if (row.state === 'paused') throw new WorkGoalError('The user paused this work.', 409);
    if (needsPlanReview(row)) throw new WorkGoalError('Review the plan for the updated outcome before verification.', 409);
    for (const step of row.steps) {
      if (!step.taskId || !workStepUnfinished(step)) continue;
      // Verification comes from a settled executor outcome, never the model's
      // assertion or completion of its chat turn. Ambiguous/failed tasks stay open.
      const [task] = await tx.query(`select t.id from tasks t join assistant_action_states a on a.task_id=t.id
        where t.id=$1 and t.owner_user_id=$2 and t.thread_id=$3 and t.state='confirmed' and a.status='succeeded'`,
        [step.taskId, args.ownerUserId, row.thread_id]);
      if (task) { step.state = 'verified'; step.evidence = step.taskId; step.blockedReason = null; step.blockedUntil = null; }
    }
    const unfinished = row.steps.find(workStepUnfinished);
    if (unfinished) {
      const ready = readyWorkSteps(row.steps)[0];
      row.state = ready ? 'working' : 'needs_instruction';
      row.continuation = ready ? { kind: 'action', stepId: ready.id }
        : { kind: 'question', questionId: randomUUID(), text: unfinished.blockedReason ?? `What evidence or additional work is needed to verify “${unfinished.title}”?` };
      row.activity = ready ? 'Continuing the remaining work' : 'The result still needs verification';
    } else {
      // Execution receipts verify individual steps. The outcome criteria still
      // need an explicit owner review until the outcome-verifier adapter exists.
      row.state = 'verifying';
      row.continuation = { kind: 'question', questionId: randomUUID(), text: 'The remaining required steps have verified receipts. Does the result meet every completion criterion? Retired steps were not counted as completed work.' };
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
      if (needsPlanReview(row) || row.state !== 'verifying' || row.steps.some(workStepUnfinished)) throw new WorkGoalError('Review the current plan and verify all recorded steps before confirming the outcome.', 409);
      row.state = 'completed'; row.continuation = null; row.activity = 'Outcome confirmed by you';
    } else if (args.action === 'resume') {
      const instruction = text(args.instruction);
      row.checkpoint = { decisions: row.checkpoint.decisions ?? [], facts: row.checkpoint.facts ?? [],
        assumptions: row.checkpoint.assumptions ?? [], nextAction: instruction };
      const correction: WorkCheckpoint = { decisions: row.owner_checkpoint?.decisions ?? [], facts: row.owner_checkpoint?.facts ?? [],
        assumptions: row.owner_checkpoint?.assumptions ?? [], nextAction: instruction };
      await tx.query(`update work_goals set owner_checkpoint=$2,owner_checkpoint_at=now() where id=$1`, [row.id, json(correction)]);
      await tx.query(`update users set work_memory_version=work_memory_version+1 where id=$1`, [args.ownerUserId]);
      // Reconsider the first unfinished step without clearing unrelated waits,
      // original effect/task receipts or dependency ordering.
      const first = row.steps.find(workStepUnfinished);
      if (first?.state === 'blocked' && !first.taskId) {
        first.state = 'pending'; first.blockedReason = null; first.blockedUntil = null;
      }
      const step = readyWorkSteps(row.steps)[0] ?? row.steps.find(workStepUnfinished);
      row.state = step ? 'working' : 'verifying';
      row.continuation = step ? { kind: 'action', stepId: step.id } : { kind: 'question', questionId: randomUUID(), text: 'Confirm the completed outcome.' };
      row.activity = 'Your instructions were saved';
      if (needsPlanReview(row)) {
        row.state = 'planning'; row.continuation = { kind: 'question', questionId: randomUUID(),
          text: 'Review the current outcome, criteria and any retired steps, then save a revised plan before further actions.' };
      }
    } else throw new WorkGoalError('Unsupported work control.');
    // Fence the old automatic segment before recording owner steering. A
    // queued segment can be cancelled; already dispatched effects keep receipts.
    await tx.query(`update work_goals set control_generation=control_generation+1,
      continuation_ready_at=case when $2='resume' then now() else null end,
      continuation_segments=case when $2='resume' then 0 else continuation_segments end where id=$1`, [row.id, args.action]);
    await tx.query(`update assistant_turns set status='failed',error_code='work_control_changed',error_retryable=false,completed_at=now()
      where work_goal_id=$1 and status='queued'`, [row.id]);
    return save(tx, row, `goal.${args.action}`);
  });
}

/** Reconcile receipts, then schedule a bounded model continuation. Scheduling
 * grants no effect permission and never retries an uncertain dispatch. */
export async function reconcileWorkGoals(db: Db, options: { continueReady?: boolean } = {}): Promise<number> {
  return transaction(db, async tx => {
    const rows = await tx.query<GoalRow & { stale: boolean; wake_due: boolean; continuation_due: boolean }>(`select g.*,
      g.updated_at < now()-interval '5 minutes' as stale,
      g.continuation_ready_at <= now() as continuation_due,
      case when g.continuation->>'kind'='wait' then (g.continuation->>'wakeAt')::timestamptz <= now() else false end as wake_due
      from work_goals g where g.state in ('planning','working','waiting')
      and not exists(select 1 from assistant_turns t where t.thread_id=g.thread_id
        and t.status in ('queued','running'))
      order by g.reconciled_at,g.id for update of g skip locked limit 100`);
    let changed = 0;
    for (const row of rows) {
      await tx.query(`update work_goals set reconciled_at=now() where id=$1`, [row.id]);
      let updated = false, failed: WorkGoalStep | null = null;
      const activeSteps = new Set<string>();
      for (const step of row.steps) {
        if (step.state === 'blocked' && !step.taskId && step.blockedUntil && Date.parse(step.blockedUntil) <= Date.now()) {
          step.state = 'pending'; step.blockedReason = null; step.blockedUntil = null; updated = true;
        }
        if (!step.taskId || !workStepUnfinished(step)) continue;
        const [task] = await tx.query<{ state: string; action_status: string | null }>(
          `select t.state,a.status as action_status from tasks t left join assistant_action_states a on a.task_id=t.id
           where t.id=$1 and t.owner_user_id=$2 and t.thread_id=$3`, [step.taskId, row.owner_user_id, row.thread_id]);
        if (task?.state === 'confirmed' && task.action_status === 'succeeded') {
          step.state = 'verified'; step.evidence = step.taskId; step.blockedReason = null; step.blockedUntil = null; updated = true;
        } else if (!task || ['failed', 'cancelled', 'closed'].includes(task.state)) {
          failed ??= step;
          if (step.state !== 'blocked' || !step.blockedReason) {
            step.state = 'blocked'; step.blockedReason = `“${step.title}” did not finish. Its original task must be reconciled before another attempt.`; updated = true;
          }
        } else if (['attempting', 'ready', 'held'].includes(task.state)) activeSteps.add(step.id);
      }
      const ready = readyWorkSteps(row.steps, activeSteps);
      const needsPlan = needsPlanReview(row);
      const selected = row.continuation?.kind === 'action' ? row.continuation.stepId : null;
      const nextStep = ready.find(step => step.id === selected) ?? ready[0];
      const timed = row.steps.filter(step => step.state === 'blocked' && step.blockedUntil && Date.parse(step.blockedUntil) > Date.now())
        .sort((a, b) => Date.parse(a.blockedUntil!) - Date.parse(b.blockedUntil!))[0];
      if (!needsPlan && !row.steps.some(workStepUnfinished)) {
        row.state = 'verifying'; row.activity = 'Steps verified; waiting for outcome confirmation';
        row.continuation = { kind: 'question', questionId: randomUUID(), text: 'The remaining required steps have verified receipts. Does the result meet every completion criterion? Retired steps were not counted as completed work.' };
        updated = true;
      } else if (!needsPlan && !nextStep && !activeSteps.size && !timed && (failed || row.steps.some(step => step.state === 'blocked'))) {
        const blocked = failed ?? row.steps.find(step => step.state === 'blocked')!;
        row.state = 'needs_instruction'; row.activity = 'The remaining work needs your instructions';
        row.continuation = { kind: 'question', questionId: randomUUID(),
          text: blocked.blockedReason ?? `What should change before Josi continues “${blocked.title}”?` };
        updated = true;
      } else if ((nextStep || needsPlan) && options.continueReady && (row.continuation_due || updated && row.continuation_ready_at !== null)
        && (needsPlan || row.continuation?.kind === 'action' || row.wake_due)) {
        const verified = row.steps.filter(step => step.state === 'verified').length;
        if (verified > row.continuation_verified) {
          row.continuation_segments = 0; row.continuation_verified = verified;
          await tx.query(`update work_goals set continuation_segments=0,continuation_verified=$2 where id=$1`, [row.id, verified]);
        }
        const [uncertain] = await tx.query('select 1 from work_goal_effects where goal_id=$1 and state=$2 limit 1', [row.id, 'started']);
        const [thread] = await tx.query(`select id from threads where id=$1 and owner_user_id=$2 and status='open'`, [row.thread_id, row.owner_user_id]);
        const [capacity] = await tx.query<{ active_count: number }>('select active_count from assistant_turn_capacity where owner_user_id=$1', [row.owner_user_id]);
        if (thread && row.continuation_segments < WORK_SEGMENT_LIMIT && (capacity?.active_count ?? 0) < 50) {
          row.state = needsPlan ? 'planning' : 'working';
          row.continuation = needsPlan ? { kind: 'question', questionId: randomUUID(),
            text: 'Review the current outcome, criteria and any retired steps, then save a revised plan before further actions.' }
            : { kind: 'action', stepId: nextStep!.id };
          row.activity = needsPlan ? 'Updating the plan for your changed instructions' : uncertain ? 'Inspecting an uncertain result before further actions'
            : failed || activeSteps.size ? 'Continuing independent work' : 'Continuing the next step';
          const saved = await save(tx, row, 'continuation.queued');
          row.revision = saved.revision;
          if (await queueWorkContinuation(tx, row)) { changed++; continue; }
        }
        row.state = 'needs_instruction'; row.activity = 'Work needs your instructions';
        row.continuation = { kind: 'question', questionId: randomUUID(), text: !thread ? 'This conversation is closed. Reopen it before continuing this work.'
          : row.continuation_segments >= WORK_SEGMENT_LIMIT ? `Josi used ${WORK_SEGMENT_LIMIT} work segments without a new verified step. What should change before it continues?`
          : (capacity?.active_count ?? 0) >= 50 ? 'The work queue is full. Finish or cancel queued work, then resume this goal.'
          : 'Sign in again, then resume this goal so Josi can continue.' };
        updated = true;
      } else if (!needsPlan && !nextStep && !activeSteps.size && timed) {
        if (row.continuation?.kind !== 'wait' || row.continuation.wakeAt !== timed.blockedUntil) {
          row.state = 'waiting'; row.activity = 'Waiting for the next scheduled check';
          row.continuation = { kind: 'wait', reason: timed.blockedReason ?? 'A step is waiting for its scheduled check.', wakeAt: timed.blockedUntil! };
          await tx.query('update work_goals set continuation_ready_at=$2 where id=$1', [row.id, timed.blockedUntil]);
          updated = true;
        }
      } else if (!activeSteps.size && (row.wake_due || (row.stale && row.continuation?.kind !== 'wait'))
        && (!options.continueReady || !row.continuation_ready_at)) {
        row.state = 'needs_instruction'; row.activity = row.wake_due ? 'The requested check is due' : 'Work needs a continuation instruction';
        row.continuation = { kind: 'question', questionId: randomUUID(), text: row.checkpoint.nextAction
          ? `Continue with this next action: ${row.checkpoint.nextAction}` : needsPlan ? 'Resume with instructions so Josi can revise the plan for your updated outcome.'
            : `How should Josi continue “${row.steps.find(workStepUnfinished)!.title}”?` };
        updated = true;
      } else if (updated) {
        row.activity = failed ? 'A step is blocked; independent work remains' : 'A task result was verified';
        if (options.continueReady && row.continuation_ready_at !== null) await tx.query(`update work_goals set continuation_ready_at=now() where id=$1`, [row.id]);
      }
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
