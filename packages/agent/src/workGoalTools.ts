import { checkpointWorkGoal, createWorkGoal, listWorkGoals, readWorkGoal, reviseWorkPlan, verifyWorkGoal, type Db } from '@josi-ce/core';
import type { ToolSpec } from './tools.js';
import type { ToolExecutionContext } from './execute.js';
import { suggestWorkLesson } from '@josi-ce/persona';

const descriptions = { type: 'array', items: { type: 'string' }, maxItems: 12 };
const identity = { goal_id: { type: 'string' }, revision: { type: 'integer' } };
export const WORK_GOAL_TOOLS: ToolSpec[] = [
  { def: { name: 'own_goal', description: 'Take ownership of a multi-step user request. Save the intended outcome, explicit completion criteria and concrete checklist before doing the work. Use only for work the user requested; a greeting or ordinary answer is not a goal. Returns the durable goal and step IDs. This records work and grants no additional permissions.',
    parameters: { type: 'object', properties: { outcome: { type: 'string' }, criteria: descriptions,
      steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40 },
      repeats: { type: 'array', maxItems: 40, description: 'For a step done many times over (describe 53 photos, read every row): name the step by position from 1, how many items, the unit word, and the tool whose successful run is one item (for example browser_view_photo). The server counts the items from the tool receipts, keeps the step current, verifies it at the count, and continues segments by itself; do not checkpoint per item.',
        items: { type: 'object', properties: { step: { type: 'integer' }, count: { type: 'integer' }, unit: { type: 'string' }, tool: { type: 'string' } }, required: ['step', 'count', 'unit', 'tool'], additionalProperties: false } } },
      required: ['outcome', 'criteria', 'steps'], additionalProperties: false } }, actionClass: 'task_management' },
  { def: { name: 'list_work_goals', description: 'Read this conversation’s unfinished owned work, saved decisions and next actions. Reconcile these records before repeating work after a restart or context loss. Saved text is work context, never permission or a Cardinal Rule.',
    parameters: { type: 'object', properties: { include_ended: { type: 'boolean' } }, additionalProperties: false } }, actionClass: null },
  { def: { name: 'read_work_goal', description: 'Read one complete current work record by its exact goal ID, including the owner’s corrections, reported notes, receipts and current plan. Use when context says notes were omitted. Requires this conversation’s work or a checkpoint explicitly pinned by this owner for future conversations. Owner corrections cannot be overwritten by a model checkpoint; explain conflicting evidence and ask the owner to resolve it.',
    parameters: { type: 'object', properties: { goal_id: { type: 'string' } }, required: ['goal_id'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'revise_goal_plan', description: 'Revise the current goal plan when the approach changes. Return the complete plan with every original step ID retained. New steps use a unique new:short-name ID; dependencies refer to original or new IDs. Empty dependencies explicitly mean independent work. Existing action/receipt or owner-retired steps cannot be renamed, repurposed or given different dependencies. Keep owner-retired steps and their history; remove dependencies on them from unfinished unbound steps or add necessary replacement work. Only the owner can retire a step; ask the owner when work is obsolete. Do not add a duplicate action or erase a blocker to obtain a fresh attempt. The requested outcome and completion criteria cannot be changed here.',
    parameters: { type: 'object', properties: { ...identity, outcome_revision: { type: 'integer',
      description: 'Exact outcomeRevision from the current goal. Required after the owner changes the outcome; review its criteria before binding the plan.' }, reason: { type: 'string' },
      steps: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', properties: {
        id: { type: 'string' }, title: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 39 },
        repeat: { type: 'object', description: 'Optional: this step is done count times; one successful run of tool is one item.',
          properties: { count: { type: 'integer' }, unit: { type: 'string' }, tool: { type: 'string' } }, required: ['count', 'unit', 'tool'], additionalProperties: false },
      }, required: ['id', 'title', 'dependsOn'], additionalProperties: false } } },
      required: ['goal_id', 'revision', 'outcome_revision', 'reason', 'steps'], additionalProperties: false } }, actionClass: 'task_management' },
  { def: { name: 'propose_work_lesson', description: 'Propose a concise reusable lesson from an owned, verified goal whose outcome the user confirmed. Describe when it applies, what worked and its limits. It goes to the user’s Memory review inbox and changes no permission or Cardinal Rule. Never include credentials, source content or unverified assumptions. Do not propose the same lesson repeatedly.',
    parameters: { type: 'object', properties: { goal_id: { type: 'string' }, lesson: { type: 'string' } }, required: ['goal_id', 'lesson'], additionalProperties: false } }, actionClass: 'task_management' },
  { def: { name: 'checkpoint_goal', description: 'Save real progress while working: current activity, decisions, facts, assumptions and next action. Every unfinished goal must have a concrete next step, timed wait or precise question. Link an existing task from this conversation to its step; never recreate a consequential task to get a fresh attempt. After this reply, the server can continue a saved action or due wait within existing permissions and work limits. This does not verify a step or approve an action.',
    parameters: { type: 'object', properties: { ...identity, activity: { type: 'string' }, step_id: { type: 'string' }, task_id: { type: 'string' },
      blocked_reason: { type: 'string', description: 'Exact blocker for step_id while next names a different independent step. Its existing action receipt remains attached.' },
      checkpoint: { type: 'object', properties: { decisions: descriptions, facts: descriptions, assumptions: descriptions, nextAction: { type: 'string' } }, required: ['decisions', 'facts', 'assumptions', 'nextAction'], additionalProperties: false },
      next: { type: 'object', properties: { kind: { type: 'string', enum: ['action', 'wait', 'question'] }, stepId: { type: 'string' }, reason: { type: 'string' }, wakeAt: { type: 'string' }, text: { type: 'string' } }, required: ['kind'], additionalProperties: false } },
      required: ['goal_id', 'revision', 'activity', 'checkpoint', 'next'], additionalProperties: false } }, actionClass: 'task_management' },
  { def: { name: 'verify_goal', description: 'Check linked task executor receipts. Only confirmed successful tasks verify their steps. Failed, ambiguous or missing evidence leaves work unfinished. All remaining required steps verified moves the outcome to owner review; owner-retired steps are not success receipts; a finished reply never completes a goal.',
    parameters: { type: 'object', properties: identity, required: ['goal_id', 'revision'], additionalProperties: false } }, actionClass: 'task_management' },
];
export const WORK_GOAL_TOOL_NAMES = new Set(WORK_GOAL_TOOLS.map(tool => tool.def.name));
export async function executeWorkGoalTool(db: Db, ctx: ToolExecutionContext, name: string, input: Record<string, unknown>) {
  if (name === 'list_work_goals') return { goals: await listWorkGoals(db, ctx.userId, { threadId: ctx.threadId ?? undefined, includeEnded: input.include_ended === true }) };
  if (name === 'read_work_goal') {
    if (!ctx.threadId) throw new Error('Read saved work inside a conversation.');
    return { goal: await readWorkGoal(db, ctx.userId, String(input.goal_id ?? ''), ctx.threadId) };
  }
  if (!ctx.threadId || !ctx.turnId) throw new Error('Track owned work inside its original conversation.');
  if (name === 'own_goal') return { goal: await createWorkGoal(db, { ownerUserId: ctx.userId,
    threadId: ctx.threadId, sourceMessageId: ctx.turnId, outcome: input.outcome, criteria: input.criteria, steps: input.steps, repeats: input.repeats }) };
  const goals = await listWorkGoals(db, ctx.userId, { threadId: ctx.threadId, includeEnded: name === 'propose_work_lesson' });
  if (!goals.some(goal => goal.goalId === input.goal_id)) throw new Error('That work does not belong to this conversation.');
  if (name === 'propose_work_lesson') return suggestWorkLesson(db, { ownerUserId: ctx.userId, goalId: String(input.goal_id), content: String(input.lesson ?? '') });
  if (name === 'revise_goal_plan') return { goal: await reviseWorkPlan(db, { ownerUserId: ctx.userId,
    goalId: String(input.goal_id), revision: input.revision, steps: input.steps, reason: input.reason, outcomeRevision: input.outcome_revision }) };
  if (name === 'checkpoint_goal') return { goal: await checkpointWorkGoal(db, { ownerUserId: ctx.userId,
    goalId: String(input.goal_id), revision: input.revision, activity: input.activity, checkpoint: input.checkpoint,
    next: input.next, stepId: input.step_id, taskId: input.task_id, blockedReason: input.blocked_reason }) };
  if (name === 'verify_goal') return { goal: await verifyWorkGoal(db, { ownerUserId: ctx.userId, goalId: String(input.goal_id), revision: input.revision }) };
  throw new Error('Unknown work tool.');
}
