import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { json } from './db.js';
import { addMessage } from './conversations.js';
import { workDependenciesSatisfied, type WorkGoalStep } from './workPlan.js';

/** Fixed implementation limits, visible in the work projection. These bound
 * model segments without granting a single tool permission. */
export const WORK_SEGMENT_LIMIT = 12;
export const WORK_SEGMENT_DELAY_SECONDS = 30;
export class WorkContinuationError extends Error {}
/** An unreviewed outcome has no current effect plan. With no unambiguous goal
 * binding on many legacy tools, hold new effects in that conversation until
 * its changed outcomes have been reviewed. Inspection remains available. */
export async function requireReviewedWorkOutcome(db: Db, ownerUserId: string, threadId: string) {
  const [pending] = await db.query(`select id from work_goals where owner_user_id=$1 and thread_id=$2
    and state not in ('completed','cancelled') and (outcome_revision<>planned_outcome_revision or plan_review_required) limit 1`, [ownerUserId, threadId]);
  if (pending) throw new WorkContinuationError('The owner changed the outcome or retired work. Read the current goal and revise its complete plan for that exact outcome revision before further actions.');
}
export interface WorkExecutionContext {
  ownerUserId: string;
  threadId: string;
  sourceMessageId?: string;
  durableTurnId?: string;
  durableLeaseToken?: string;
  mutating?: boolean;
}
interface Binding {
  goal_id: string; step_id: string; owner_user_id: string;
  state: string; control_generation: number; work_control_generation: number | null;
  steps: WorkGoalStep[];
}
const INTENT_TOOLS = new Set(['create_task', 'draft_email', 'draft_calendar_event', 'draft_contact_update',
  'call_custom_api', 'run_native_workflow', 'workspace_propose_change', 'workspace_propose_code', 'schedule_reminder']);
const BACKGROUND_DENIED = new Set(['own_goal', 'approve_task', 'cancel_task', 'update_task_slots',
  'update_reminder', 'cancel_reminder', 'propose_work_lesson']);
// These adapters have their own original-task reservation journal and current
// selected-step check. They cannot use the one-intent-per-step legacy fence.
const AUTOMATION_TOOLS = new Set(['start_automation_task', 'connect_automation_workspace', 'observe_automation_workspace', 'browser_control', 'computer_control']);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** Rechecked before each model hop and every tool, including subscription MCP.
 * A fresh user message or owner control supersedes an automatic segment.
 * Already-dispatched legacy effects may finish and retain their receipts. */
export async function requireWorkContinuation(db: Db, context: WorkExecutionContext, allowCheckpoint = false): Promise<string | null> {
  if (!context.durableTurnId) return null;
  const [turn] = await db.query<{ work_goal_id: string | null; current: boolean }>(`select t.work_goal_id,
    (t.status='running' and t.lease_token=$2 and t.lease_expires_at>now()
      and t.owner_user_id=$3 and t.thread_id=$4
      and g.owner_user_id=t.owner_user_id and g.thread_id=t.thread_id
      and g.control_generation=t.work_control_generation
      and (g.state in ('planning','working') or ($5 and g.state in ('waiting','needs_instruction','verifying')))
      and u.status='active' and th.status='open'
      and s.user_id=t.owner_user_id and s.revoked_at is null and s.expires_at>now()
      and not exists(select 1 from messages m where m.thread_id=t.thread_id and m.direction='in'
        and m.id<>t.inbound_message_id and m.created_at>t.started_at)) as current
    from assistant_turns t left join work_goals g on g.id=t.work_goal_id
    left join users u on u.id=t.owner_user_id left join threads th on th.id=t.thread_id
    left join sessions s on s.id=t.accepted_session_id where t.id=$1`,
  [context.durableTurnId, context.durableLeaseToken ?? null, context.ownerUserId, context.threadId, allowCheckpoint]);
  if (!turn) throw new WorkContinuationError('The durable work segment is unavailable.');
  if (!turn.work_goal_id) return null;
  if (!turn.current) throw new WorkContinuationError('Automatic work stopped because its instructions, control or sign-in changed.');
  return turn.work_goal_id;
}

/** An ordinary user turn suspends the next background wake until its result
 * has been saved. Calling this does not resume owner-paused work. */
export async function beginWorkConversation(db: Db, ownerUserId: string, threadId: string) {
  if (!db.transaction) throw new WorkContinuationError('Durable work storage is unavailable.');
  await db.transaction(async tx => {
    await tx.query(`update work_goals set continuation_ready_at=null,control_generation=control_generation+1
      where owner_user_id=$1 and thread_id=$2 and state in ('planning','working','waiting')`, [ownerUserId, threadId]);
    await tx.query(`update assistant_turns set status='failed',error_code='work_control_changed',error_retryable=false,completed_at=now()
      where owner_user_id=$1 and thread_id=$2 and work_goal_id is not null and status='queued'`, [ownerUserId, threadId]);
  });
}
export async function releaseWorkConversation(db: Db, ownerUserId: string, threadId: string) {
  await db.query(`update work_goals set continuation_ready_at=now()+interval '30 seconds'
    where owner_user_id=$1 and thread_id=$2 and state in ('planning','working','waiting')`, [ownerUserId, threadId]);
}

/** Uses the original goal/step identity across turns. Exact completed calls
 * replay their receipt; any changed/uncertain intent requires instructions.
 * No claim that a provider itself implements exactly-once side effects. */
export async function runWorkIntent<T>(db: Db, context: WorkExecutionContext, name: string,
  input: Record<string, unknown>, execute: () => Promise<T>): Promise<T> {
  const automatic = await requireWorkContinuation(db, context);
  if (context.mutating && !['checkpoint_goal', 'revise_goal_plan'].includes(name)) {
    await requireReviewedWorkOutcome(db, context.ownerUserId, context.threadId);
  }
  if (automatic && (BACKGROUND_DENIED.has(name) || name === 'workspace_code_status' && input.cancel === true)) {
    throw new WorkContinuationError('This change requires an explicit user instruction; automatic continuation cannot supply an approval.');
  }
  if (automatic && ['checkpoint_goal', 'verify_goal', 'revise_goal_plan'].includes(name) && input.goal_id !== automatic) {
    throw new WorkContinuationError('Continue only the goal assigned to this work segment.');
  }
  if (automatic && context.mutating && !INTENT_TOOLS.has(name) && !AUTOMATION_TOOLS.has(name) && !['checkpoint_goal', 'verify_goal', 'revise_goal_plan'].includes(name)) {
    throw new WorkContinuationError('This effect has no automatic-work adapter.');
  }
  if (automatic && INTENT_TOOLS.has(name) && !context.sourceMessageId) throw new WorkContinuationError('The original request is unavailable.');
  if (!INTENT_TOOLS.has(name) || !context.sourceMessageId) return execute();
  if (!db.transaction) throw new WorkContinuationError('Durable work storage is unavailable.');
  const checksum = createHash('sha256').update(name + '\n' + canonical(input)).digest('hex');
  const reserved = await db.transaction(async tx => {
    await requireReviewedWorkOutcome(tx, context.ownerUserId, context.threadId);
    // Resolve only this turn's original goal, or the server-bound continuation.
    const [goal] = await tx.query<Binding>(`select g.id as goal_id,g.owner_user_id,g.state,g.control_generation,g.steps,
      g.continuation->>'stepId' as step_id,t.work_control_generation
      from work_goals g left join assistant_turns t on t.id=$4
      where g.owner_user_id=$1 and g.thread_id=$2
        and (g.id=$5::uuid or ($5::uuid is null and g.source_message_id=$3))
      for update of g`, [context.ownerUserId, context.threadId, context.sourceMessageId, context.durableTurnId ?? null, automatic]);
    if (!goal) return { kind: 'untracked' as const };
    if (!['planning', 'working'].includes(goal.state) || !goal.step_id
      || automatic && goal.control_generation !== goal.work_control_generation) {
      throw new WorkContinuationError('Choose an unfinished, active step before dispatching another action.');
    }
    const unfinished = goal.steps.find(step => step.id === goal.step_id);
    if (!unfinished || unfinished.state === 'verified' || unfinished.state === 'blocked' || unfinished.state === 'skipped'
      || !workDependenciesSatisfied(goal.steps, unfinished)) throw new WorkContinuationError('Choose an unfinished, unblocked step with verified dependencies before another action.');
    await requireWorkContinuation(tx, context);
    const [prior] = await tx.query<{ tool_name: string; input_digest: string; state: string; receipt: T }>(
      'select tool_name,input_digest,state,receipt from work_goal_effects where goal_id=$1 and step_id=$2', [goal.goal_id, goal.step_id]);
    if (prior) {
      if (prior.tool_name !== name || prior.input_digest !== checksum) throw new WorkContinuationError('This step already has a different consequential intent. Reconcile it before changing the plan.');
      if (prior.state !== 'completed') throw new WorkContinuationError('This step has an uncertain action. Inspect its destination before any further attempt.');
      return { kind: 'replay' as const, receipt: prior.receipt };
    }
    const [uncertain] = await tx.query(`select 1 from work_goal_effects where goal_id=$1 and state='started' limit 1`, [goal.goal_id]);
    if (uncertain) throw new WorkContinuationError('An action in this goal has an uncertain result. Use read-only destination checks; do not dispatch another effect until its receipt is reconciled.');
    const [duplicate] = await tx.query(`select 1 from work_goal_effects where goal_id=$1 and tool_name=$2 and input_digest=$3 limit 1`,
      [goal.goal_id, name, checksum]);
    if (duplicate) throw new WorkContinuationError('This goal already recorded that exact action under another step. Reconcile its existing receipt instead of repeating it.');
    await tx.query(`insert into work_goal_effects(goal_id,step_id,owner_user_id,tool_name,input_digest,state)
      values($1,$2,$3,$4,$5,'started')`, [goal.goal_id, goal.step_id, context.ownerUserId, name, checksum]);
    return { kind: 'started' as const, goalId: goal.goal_id, stepId: goal.step_id };
  });
  if (reserved.kind === 'replay') return reserved.receipt;
  const result = await execute();
  if (reserved.kind === 'started') {
    // Preserve the truthful outcome even if the owner paused after dispatch.
    const saved = await db.query(`update work_goal_effects set state='completed',receipt=$4,completed_at=now()
      where goal_id=$1 and step_id=$2 and input_digest=$3 and state='started' returning goal_id`,
    [reserved.goalId, reserved.stepId, checksum, json(result)]);
    if (!saved.length) throw new WorkContinuationError('The action receipt could not be saved. Reconcile its result before continuing.');
  }
  return result;
}

/** Scheduler's caller already owns the goal row lock and saved its revision.
 * No message is invented and no user-policy or step-up approval is reused. */
export async function queueWorkContinuation(tx: Db, goal: { id: string; owner_user_id: string; thread_id: string;
  source_message_id: string; revision: number; control_generation: number }): Promise<boolean> {
  const [session] = await tx.query<{ id: string }>(`select s.id from sessions s join users u on u.id=s.user_id
    where s.user_id=$1 and s.revoked_at is null and s.expires_at>now() and u.status='active'
    order by s.created_at desc limit 1`, [goal.owner_user_id]);
  if (!session) return false;
  const attachments = await tx.query<{ id: string }>(`select a.id from chat_attachments a join messages m on m.id=$3
    where a.owner_user_id=$1 and a.thread_id=$2 and a.storage_state='ready'
      and exists(select 1 from jsonb_array_elements(coalesce(m.meta->'attachments','[]'::jsonb)) item where item->>'id'=a.id::text)
    order by a.id limit 10`, [goal.owner_user_id, goal.thread_id, goal.source_message_id]);
  const turnId = randomUUID();
  await tx.query(`insert into assistant_turns(id,owner_user_id,accepted_session_id,thread_id,client_message_id,request_hash,
    inbound_message_id,work_goal_id,work_goal_revision,work_control_generation,attachment_ids)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [turnId, goal.owner_user_id, session.id, goal.thread_id,
    `work:${goal.id}:${goal.revision}`, createHash('sha256').update(`work:${goal.id}:${goal.revision}:${goal.control_generation}`).digest('hex'),
    goal.source_message_id, goal.id, goal.revision, goal.control_generation, attachments.map(value => value.id)]);
  await tx.query(`insert into job_queue(kind,payload) values('assistant.turn',$1)`, [json({ turnId })]);
  await tx.query(`update work_goals set continuation_ready_at=null,continuation_segments=continuation_segments+1 where id=$1`, [goal.id]);
  return true;
}

/** Failed background segments produce a saved, actionable question. They
 * never silently retry a model/provider boundary or overwrite newer steering. */
export async function settleWorkContinuation(db: Db, turnId: string): Promise<void> {
  if (!db.transaction) throw new WorkContinuationError('Durable work storage is unavailable.');
  await db.transaction(async tx => {
    const [bound] = await tx.query<{ work_goal_id: string | null }>('select work_goal_id from assistant_turns where id=$1', [turnId]);
    if (!bound?.work_goal_id) return;
    const [goal] = await tx.query<{ id: string; owner_user_id: string; thread_id: string; revision: number; state: string; control_generation: number }>(
      'select id,owner_user_id,thread_id,revision,state,control_generation from work_goals where id=$1 for update', [bound.work_goal_id]);
    const [turn] = await tx.query<{ status: string; error_code: string | null; work_control_generation: number; work_goal_revision: number }>(
      'select status,error_code,work_control_generation,work_goal_revision from assistant_turns where id=$1', [turnId]);
    if (!goal || !turn || goal.control_generation !== turn.work_control_generation
      || !['planning', 'working', 'waiting'].includes(goal.state) || !['failed', 'completed'].includes(turn.status)) return;
    const [steered] = await tx.query(`select 1 from assistant_turns t join messages m on m.thread_id=t.thread_id
      where t.id=$1 and m.direction='in' and m.id<>t.inbound_message_id and m.created_at>t.started_at limit 1`, [turnId]);
    if (steered) return;
    if (turn.status === 'completed' && goal.revision > turn.work_goal_revision) {
      await tx.query(`update work_goals set continuation_ready_at=now()+interval '30 seconds' where id=$1`, [goal.id]);
      return;
    }
    const question = turn.status === 'failed'
      ? turn.error_code === 'session_expired' ? 'Sign in again, then use Resume with instructions to continue this work.'
        : 'The last work segment did not finish reliably. Should Josi inspect the existing results, change the approach, or stop?'
      : 'The last segment did not save a next step or verified result. What should Josi try next?';
    const continuation = { kind: 'question', questionId: randomUUID(), text: question };
    const [saved] = await tx.query<{ revision: number }>(`update work_goals set revision=revision+1,state='needs_instruction',
      continuation=$2,continuation_ready_at=null,activity='Work needs your instructions',updated_at=now()
      where id=$1 returning revision`, [goal.id, json(continuation)]);
    await tx.query(`insert into work_goal_events(id,goal_id,owner_user_id,sequence,kind,summary)
      values($1,$2,$3,$4,'instruction.requested','Work needs your instructions')`, [randomUUID(), goal.id, goal.owner_user_id, saved.revision]);
    await addMessage(tx, { threadId: goal.thread_id, direction: 'out', body: question,
      meta: { work_goal_id: goal.id, work_goal_revision: saved.revision, progress_notice: true } });
  });
}
