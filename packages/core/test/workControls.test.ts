import { expect, it } from 'vitest';
import { testDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import { createSession } from '../../auth/src/sessions.js';
import { createThread } from '../src/conversations.js';
import { claimDurableTurn, submitDurableTurn } from '../src/mobile.js';
import { controlWorkGoal, createWorkGoal, ownedWorkGoal } from '../src/workGoals.js';
import { runWorkIntent } from '../src/workContinuation.js';

async function setup(email: string) {
  const db = await testDb();
  const user = await createUser(db, { email, username: email.split('@')[0], role: 'super_admin' });
  const session = await createSession(db, { userId: user.id });
  const thread = await createThread(db, { ownerUserId: user.id });
  const accepted = await submitDurableTurn(db, { ownerUserId: user.id, sessionId: session.sessionId,
    threadId: thread.id, clientMessageId: 'controls', message: 'Click the letter S in Character Map.' });
  const turn = (await claimDurableTurn(db, accepted.turn.id))!;
  const goal = await createWorkGoal(db, { ownerUserId: user.id, threadId: thread.id, sourceMessageId: turn.inbound_message_id,
    outcome: 'Click S', criteria: ['S is selected'], steps: ['List windows', 'Click S'] });
  return { db, user, thread, turn, goal };
}

it('cancel and pause win even when the screen showed an older revision', async () => {
  const { db, user, goal } = await setup('stop-wins@example.test');
  // The goal moves on after the person's screen was drawn.
  await db.query(`update work_goals set revision = revision + 5 where id = $1`, [goal.goalId]);
  const paused = await controlWorkGoal(db, { ownerUserId: user.id, goalId: goal.goalId, revision: goal.revision, action: 'pause' });
  expect(paused.state).toBe('paused');
  const cancelled = await controlWorkGoal(db, { ownerUserId: user.id, goalId: goal.goalId, revision: goal.revision, action: 'cancel' });
  expect(cancelled.state).toBe('cancelled');
  expect((await ownedWorkGoal(db, user.id, goal.goalId)).state).toBe('cancelled');
});

it('resume still needs the exact revision the person saw', async () => {
  const { db, user, goal } = await setup('resume-exact@example.test');
  await db.query(`update work_goals set revision = revision + 5 where id = $1`, [goal.goalId]);
  await expect(controlWorkGoal(db, { ownerUserId: user.id, goalId: goal.goalId, revision: goal.revision, action: 'resume', instruction: 'go on' }))
    .rejects.toThrow();
});

it('a background segment may use the PC Control tools but not an arbitrary consequential tool', async () => {
  const { db, user, thread, turn, goal } = await setup('background@example.test');
  await db.query(`update assistant_turns set work_goal_id=$2,work_goal_revision=$3,
    work_control_generation=(select control_generation from work_goals where id=$2) where id=$1`, [turn.id, goal.goalId, goal.revision]);
  const context = { ownerUserId: user.id, threadId: thread.id, sourceMessageId: turn.inbound_message_id,
    durableTurnId: turn.id, durableLeaseToken: turn.lease_token, mutating: true };
  // The Windows app's own tools: PC Control is their permission layer.
  await expect(runWorkIntent(db, context, 'desktop_click_point', { x: 1 }, async () => 'clicked')).resolves.toBe('clicked');
  await expect(runWorkIntent(db, context, 'browser_click', { element_id: 'e' }, async () => 'clicked')).resolves.toBe('clicked');
  // Anything else consequential still has no adapter in a background segment.
  await expect(runWorkIntent(db, context, 'some_other_effect', {}, async () => 'ran')).rejects.toThrow(/no automatic-work adapter/);
});
