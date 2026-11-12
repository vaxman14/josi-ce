import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import { createSession } from '../../auth/src/sessions.js';
import {
  addMessage, attachCollectingAction, createTask, createWorkGoal, expirePreparedActionApprovals, markActionsPresented, ownedWorkGoal,
  prepareAction, reconcileWorkGoals, resolveConversationalAction, type AssistantActionState, type Db,
} from '../src/index.js';

let db: Db; let owner: string; let thread: string;
beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'goal-follow@example.test', username: 'goalfollow', role: 'super_admin' })).id;
  thread = (await db.query<{ id: string }>(`insert into threads(owner_user_id,title) values($1,'Call') returning id`, [owner]))[0].id;
});

const slots = { recipient: 'someone@example.test', subject: 'A call', body: 'Are you free on Thursday?' };
async function emailRequest() {
  const task = await createTask(db, { ownerUserId: owner, threadId: thread, templateKey: 'send_message', slots });
  const state = await attachCollectingAction(db, { ownerUserId: owner, threadId: thread, domain: 'email', operation: 'send', taskId: task.id });
  const out = await prepareAction(db, { actionState: state, task, summary: 'email preview', actionClass: 'email_send', action: 'send' }) as AssistantActionState & { approval: { id: string } };
  const message = await addMessage(db, { threadId: thread, direction: 'out', body: 'Please approve.' });
  await markActionsPresented(db, { ownerUserId: owner, threadId: thread, taskIds: [task.id], messageId: message.id });
  return { task, approval: out.approval };
}
async function goalWaitingOn(taskId: string) {
  const inbound = await addMessage(db, { threadId: thread, direction: 'in', body: 'Check if he is free and book it if he says yes.' });
  const goal = await createWorkGoal(db, { ownerUserId: owner, threadId: thread, sourceMessageId: inbound.id,
    outcome: 'Book the call', criteria: ['The event exists'], steps: ['Send the email', 'Check the reply', 'Draft the event'] });
  await db.query(`update work_goals set state='needs_instruction',
    steps=jsonb_set(jsonb_set(steps,'{0,taskId}',to_jsonb($2::text)),'{0,state}','"blocked"'::jsonb),
    continuation='{"kind":"question","questionId":"11111111-1111-4111-8111-111111111111","text":"Please approve the email card"}'::jsonb
    where id=$1`, [goal.goalId, taskId]);
  return goal.goalId;
}

describe('a goal follows the request it asked for', () => {
  it('moves to the request prepared again after the first expired, and says which one is open', async () => {
    const { task, approval } = await emailRequest();
    const goalId = await goalWaitingOn(task.id);
    await db.query(`update approvals set expires_at=now()-interval '1 minute' where id=$1`, [approval.id]);
    await db.query(`update assistant_action_states set expires_at=now()-interval '1 minute' where task_id=$1`, [task.id]);
    const again = await resolveConversationalAction(db, { ownerUserId: owner, threadId: thread, inbound: 'send it now', requireReplyTarget: true, replyToMessageId: null });
    expect(again.handled).toBe(true);
    const goal = await ownedWorkGoal(db, owner, goalId);
    expect(goal.steps[0].taskId).toBe(again.task!.id);
    expect(goal.steps[0].taskId).not.toBe(task.id);
    expect(goal.state).toBe('needs_instruction');
    expect(JSON.stringify(goal.continuation)).toContain('waiting for your approval');
  });

  it('goes on by itself once the request it waited on has been carried out', async () => {
    const { task } = await emailRequest();
    await createSession(db, { userId: owner }); // a continuation needs the person to be signed in
    const goalId = await goalWaitingOn(task.id);
    // Nothing has happened yet: the question stands and nothing is rewritten.
    const before = await ownedWorkGoal(db, owner, goalId);
    await reconcileWorkGoals(db, { continueReady: true });
    expect((await ownedWorkGoal(db, owner, goalId)).revision).toBe(before.revision);

    await db.query(`update tasks set state='confirmed' where id=$1`, [task.id]);
    await db.query(`update assistant_action_states set status='succeeded' where task_id=$1`, [task.id]);
    await reconcileWorkGoals(db, { continueReady: true });
    const after = await ownedWorkGoal(db, owner, goalId);
    expect(after.steps[0].state).toBe('verified');
    expect(JSON.stringify(after.continuation ?? '')).not.toContain('Please approve the email card');
    expect(after.state).toBe('working');
    expect(after.continuation).toMatchObject({ kind: 'action' });
  });

  it('does not touch a waiting goal whose request failed', async () => {
    const { task } = await emailRequest();
    const goalId = await goalWaitingOn(task.id);
    await db.query(`update tasks set state='failed' where id=$1`, [task.id]);
    const before = await ownedWorkGoal(db, owner, goalId);
    await reconcileWorkGoals(db, { continueReady: true });
    const after = await ownedWorkGoal(db, owner, goalId);
    expect(after.revision).toBe(before.revision);
    expect(after.state).toBe('needs_instruction');
  });
});

describe('an approval that runs out says so', () => {
  it('tells the person in the conversation, once, and offers to prepare it again', async () => {
    const { task, approval } = await emailRequest();
    await db.query(`update approvals set expires_at=now()-interval '1 minute' where id=$1`, [approval.id]);
    await db.query(`update assistant_action_states set expires_at=now()-interval '1 minute' where task_id=$1`, [task.id]);
    expect(await expirePreparedActionApprovals(db)).toBe(1);
    expect(await expirePreparedActionApprovals(db)).toBe(0);
    const notices = await db.query<{ body: string }>(`select body from messages where thread_id=$1 and direction='out' and meta ? 'approval_expired'`, [thread]);
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toMatch(/approval for that email expired, so nothing was sent/);
    expect(notices[0].body).toMatch(/send it/);
  });
});
