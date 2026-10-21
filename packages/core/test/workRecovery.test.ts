import { expect, it } from 'vitest';
import { testDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import { createSession } from '../../auth/src/sessions.js';
import { createThread } from '../src/conversations.js';
import { claimDurableTurn, completeDurableTurn, submitDurableTurn } from '../src/mobile.js';
import { createWorkGoal, ownedWorkGoal } from '../src/workGoals.js';
import { settleWorkContinuation } from '../src/workContinuation.js';

it.each([false, true])('keeps the original task and saves precise recovery after an uncheckpointed segment (automation=%s)', async automation => {
  const db = await testDb();
  const user = await createUser(db, { email: 'recovery@example.test', username: 'recovery', role: 'super_admin' });
  const session = await createSession(db, { userId: user.id });
  const thread = await createThread(db, { ownerUserId: user.id });
  const accepted = await submitDurableTurn(db, { ownerUserId: user.id, sessionId: session.sessionId,
    threadId: thread.id, clientMessageId: 'recovery', message: 'Fill the first photo description.' });
  const turn = (await claimDurableTurn(db, accepted.turn.id))!;
  const goal = await createWorkGoal(db, { ownerUserId: user.id, threadId: thread.id, sourceMessageId: turn.inbound_message_id,
    outcome: 'Fill the first description', criteria: ['Description entered for review'], steps: ['Connect Chrome', 'Inspect photo', 'Fill description'] });
  await db.query(`update assistant_turns set work_goal_id=$2,work_goal_revision=$3,
    work_control_generation=(select control_generation from work_goals where id=$2) where id=$1`, [turn.id, goal.goalId, goal.revision]);
  await completeDurableTurn(db, { turnId: turn.id, leaseToken: turn.lease_token, reply: 'Checking the connection.',
    toolReceipts: automation ? [{ tool: 'get_automation_workspaces', result: { blocker: { code: 'device_offline', message: 'untrusted alternate wording' } } }] : [] });
  await settleWorkContinuation(db, turn.id);
  const recovered = await ownedWorkGoal(db, user.id, goal.goalId);
  expect(recovered.state).toBe('needs_instruction');
  expect(recovered.steps.map(step => step.id)).toEqual(goal.steps.map(step => step.id));
  expect(recovered.verifiedSteps).toBe(0);
  expect(recovered.activity).toBe(automation ? 'Automation needs setup' : 'Progress needs recovery');
  expect(JSON.stringify(recovered.continuation)).not.toMatch(/What should Josi try next|untrusted alternate wording/);
  expect(JSON.stringify(recovered.continuation)).toContain(automation ? 'offline' : 'original request');
  await settleWorkContinuation(db, turn.id);
  expect((await ownedWorkGoal(db, user.id, goal.goalId)).revision).toBe(recovered.revision);
});
