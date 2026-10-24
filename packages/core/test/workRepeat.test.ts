// Build item 38: a repeat step counts its items from tool receipts, the model's
// stale revision survives those counts, and the step verifies itself at the
// end of the count.
import { expect, it } from 'vitest';
import { testDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import { createSession } from '../../auth/src/sessions.js';
import { createThread } from '../src/conversations.js';
import { claimDurableTurn, submitDurableTurn } from '../src/mobile.js';
import { advanceWorkRepeat, checkpointWorkGoal, createWorkGoal, ownedWorkGoal, reviseWorkPlan } from '../src/workGoals.js';
import { workStepProgress } from '../src/workPlan.js';

async function setup() {
  const db = await testDb();
  const user = await createUser(db, { email: 'photos@example.test', username: 'photos', role: 'super_admin' });
  const session = await createSession(db, { userId: user.id });
  const thread = await createThread(db, { ownerUserId: user.id });
  const accepted = await submitDurableTurn(db, { ownerUserId: user.id, sessionId: session.sessionId,
    threadId: thread.id, clientMessageId: 'photos', message: 'Describe photos 1 to 3 on this page.' });
  const turn = (await claimDurableTurn(db, accepted.turn.id))!;
  const goal = await createWorkGoal(db, { ownerUserId: user.id, threadId: thread.id, sourceMessageId: turn.inbound_message_id,
    outcome: 'Every photo described', criteria: ['Each photo has a description'],
    steps: ['Describe each photo', 'Review the descriptions'], repeats: [{ step: 1, count: 3, unit: 'photo', tool: 'browser_view_photo' }] });
  return { db, user, thread, goal };
}

it('counts items from the tool that did them, keeps the model’s revision usable, and verifies the step at the count', async () => {
  const { db, user, goal } = await setup();
  expect(goal.steps[0].repeat).toEqual({ count: 3, unit: 'photo', tool: 'browser_view_photo', done: 0 });
  expect(workStepProgress(goal.steps[0])).toBe('Photo 0 of 3');

  // A tool that is not the loop's tool counts nothing.
  expect(await advanceWorkRepeat(db, { ownerUserId: user.id, goalId: goal.goalId, tool: 'browser_read_page' })).toBeNull();
  const one = await advanceWorkRepeat(db, { ownerUserId: user.id, goalId: goal.goalId, tool: 'browser_view_photo' });
  expect(one?.steps[0].repeat?.done).toBe(1);
  expect(one?.activity).toBe('Photo 1 of 3');
  expect(one?.steps[0].state).toBe('working');

  // The model still holds the revision from own_goal; a checkpoint with it is accepted.
  const checkpointed = await checkpointWorkGoal(db, { ownerUserId: user.id, goalId: goal.goalId, revision: goal.revision,
    activity: 'Describing photos', checkpoint: { decisions: [], facts: ['photo 1 is a cat'], assumptions: [], nextAction: 'view photo 2' },
    next: { kind: 'action', stepId: goal.steps[0].id } });
  expect(checkpointed.revision).toBeGreaterThan(one!.revision);

  await advanceWorkRepeat(db, { ownerUserId: user.id, goalId: goal.goalId, tool: 'browser_view_photo' });
  const done = await advanceWorkRepeat(db, { ownerUserId: user.id, goalId: goal.goalId, tool: 'browser_view_photo' });
  expect(done?.steps[0].state).toBe('verified');
  expect(done?.steps[0].evidence).toBe('repeat:3');
  expect(done?.continuation).toMatchObject({ kind: 'action', stepId: goal.steps[1].id });
  expect(done?.activity).toContain('Photo 3 of 3');
  // Past the count, the loop's tool counts nothing more.
  expect(await advanceWorkRepeat(db, { ownerUserId: user.id, goalId: goal.goalId, tool: 'browser_view_photo' })).toBeNull();

  const saved = await ownedWorkGoal(db, user.id, goal.goalId);
  expect(saved.verifiedSteps).toBe(1);
});

it('a revised plan keeps the count of items already done, and a different revision is still refused', async () => {
  const { db, user, goal } = await setup();
  await advanceWorkRepeat(db, { ownerUserId: user.id, goalId: goal.goalId, tool: 'browser_view_photo' });
  const latest = await ownedWorkGoal(db, user.id, goal.goalId);
  const revised = await reviseWorkPlan(db, { ownerUserId: user.id, goalId: goal.goalId, revision: latest.revision, reason: 'More photos than first thought',
    steps: [
      { id: goal.steps[0].id, title: 'Describe each photo', dependsOn: [], repeat: { count: 5, unit: 'photo', tool: 'browser_view_photo' } },
      { id: goal.steps[1].id, title: 'Review the descriptions', dependsOn: [goal.steps[0].id] },
    ] });
  expect(revised.steps[0].repeat).toEqual({ count: 5, unit: 'photo', tool: 'browser_view_photo', done: 1 });
  // A plan revision is a real change: the old revision no longer passes.
  await expect(checkpointWorkGoal(db, { ownerUserId: user.id, goalId: goal.goalId, revision: latest.revision,
    activity: 'x', checkpoint: { decisions: [], facts: [], assumptions: [], nextAction: 'y' }, next: { kind: 'action', stepId: goal.steps[0].id } }))
    .rejects.toThrow(/This work changed/);
});
