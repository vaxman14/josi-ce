// The built-in debugger, replaying what was found by hand on gate on 2026-11-10.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import { createSession } from '../../auth/src/sessions.js';
import {
  addMessage, attachCollectingAction, collectDebugCase, createTask, createThread, createWorkGoal, debugText, debuggerEnabled,
  markActionsPresented, prepareAction, proposeDebugRepair, runDebugRepair, saveDebugHandoff, DebugRepairError, type Db,
} from '../src/index.js';
import { claimDurableTurn, submitDurableTurn } from '../src/mobile.js';

let db: Db; let owner: string; let thread: string;
beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'owner@example.test', username: 'owner', role: 'super_admin' })).id;
  thread = (await createThread(db, { ownerUserId: owner })).id;
});

const slots = { recipient: 'roman@example.test', subject: 'Call tomorrow at 9:00 AM', body: 'Are you free?' };
async function emailRequest() {
  const task = await createTask(db, { ownerUserId: owner, threadId: thread, templateKey: 'send_message', slots });
  const state = await attachCollectingAction(db, { ownerUserId: owner, threadId: thread, domain: 'email', operation: 'send', taskId: task.id });
  const out = await prepareAction(db, { actionState: state, task, summary: 'Send email\nTo: roman@example.test', actionClass: 'email_send', action: 'send' });
  const shown = await addMessage(db, { threadId: thread, direction: 'out', body: 'Send email To: roman@example.test. Use the Approve or Deny control below for this exact action.' });
  await markActionsPresented(db, { ownerUserId: owner, threadId: thread, taskIds: [task.id], messageId: shown.id });
  return { task, approvalId: out.approval.id, stateId: out.id };
}
const expire = async (r: { task: { id: string }; approvalId: string }) => {
  await db.query(`update approvals set expires_at = now() - interval '1 minute' where id = $1`, [r.approvalId]);
  await db.query(`update assistant_action_states set expires_at = now() - interval '1 minute' where task_id = $1`, [r.task.id]);
};
const liveApprovals = () => db.query<{ id: string }>(`select id from approvals where owner_user_id = $1 and status = 'pending' and expires_at > now()`, [owner]);

describe('the case file', () => {
  it('finds nothing wrong in a healthy conversation', async () => {
    await addMessage(db, { threadId: thread, direction: 'in', body: 'hello' });
    await addMessage(db, { threadId: thread, direction: 'out', body: 'Hi. What can I do?' });
    const file = await collectDebugCase(db, { ownerUserId: owner, threadId: thread });
    expect(file.findings).toEqual([]);
    expect(file.messages.map((m) => m.from)).toEqual(['person', 'josi']);
    expect(file.window.minutes).toBe(180);
    expect(await db.query(`select 1 from events where kind = 'debug.investigated'`)).toHaveLength(1);
  });

  it('names an expired request and offers to prepare it again', async () => {
    const request = await emailRequest();
    await expire(request);
    const file = await collectDebugCase(db, { ownerUserId: owner, threadId: thread });
    const finding = file.findings.find((f) => f.code === 'request_expired_unanswered')!;
    expect(finding).toMatchObject({ cause: 'stuck_state', repair: { kind: 'prepare_request_again', target_id: request.stateId } });
    expect(file.requests[0]).toMatchObject({ kind: 'email send', expired: true, carried_out: null });
  });

  it('notices Josi pointing at a card that no request stood behind', async () => {
    const request = await emailRequest();
    await expire(request);
    await addMessage(db, { threadId: thread, direction: 'in', body: 'send it now' });
    await addMessage(db, { threadId: thread, direction: 'out', body: 'Use the Approve control on the email action card above. I can’t approve or send it from a chat message.' });
    const file = await collectDebugCase(db, { ownerUserId: owner, threadId: thread });
    expect(file.findings.map((f) => f.code)).toContain('pointed_at_missing_card');
    expect(file.findings.find((f) => f.code === 'pointed_at_missing_card')!.cause).toBe('own_answer');
  });

  it('does not accuse her while the request she pointed at was live', async () => {
    await emailRequest();
    const file = await collectDebugCase(db, { ownerUserId: owner, threadId: thread });
    expect(file.findings).toEqual([]);
  });

  it('leaves out anything that looks like a credential, and trims long text', () => {
    expect(debugText('my password is hunter2')).toBe('[left out: it may contain a credential]');
    expect(debugText('Authorization: Bearer abcdefghijklmnop')).toBe('[left out: it may contain a credential]');
    expect(debugText('a\n  b\tc')).toBe('a b c');
    expect(debugText('x'.repeat(500)).length).toBe(281);
  });

  it('is only for the owner of the conversation', async () => {
    const other = (await createUser(db, { email: 'other@example.test', username: 'other', role: 'member' })).id;
    await expect(collectDebugCase(db, { ownerUserId: other, threadId: thread })).rejects.toThrow(/not yours/);
  });

  it('can be switched off, and on, from outside', () => {
    expect(debuggerEnabled({ JOSI_DEBUGGER: '0' })).toBe(false);
    expect(debuggerEnabled({ JOSI_DEBUGGER: '1' })).toBe(true);
  });
});

describe('repairs', () => {
  it('prepares an expired request again only after the person has answered', async () => {
    const request = await emailRequest();
    await expire(request);
    const file = await collectDebugCase(db, { ownerUserId: owner, threadId: thread });
    const repair = file.findings[0]!.repair!;
    const proposed = await proposeDebugRepair(db, { ownerUserId: owner, threadId: thread, kind: repair.kind, targetId: repair.target_id });
    expect(proposed.what_it_does).toMatch(/Nothing is sent or changed until you approve/);
    expect(await liveApprovals()).toHaveLength(0);

    // Proposed and made in the same breath: refused.
    await expect(runDebugRepair(db, { ownerUserId: owner, threadId: thread, repairId: proposed.repair_id })).rejects.toThrow(/has not answered/);
    expect(await liveApprovals()).toHaveLength(0);

    await addMessage(db, { threadId: thread, direction: 'in', body: 'yes, do that' });
    const result = await runDebugRepair(db, { ownerUserId: owner, threadId: thread, repairId: proposed.repair_id });
    expect(result).toMatchObject({ ok: true, state: 'prepared', action_class: 'email_send' });
    expect((await liveApprovals()).map((a) => a.id)).toEqual([result.approval_id]);
    // Nothing was sent by the repair.
    expect(await db.query(`select 1 from job_queue where kind = 'task.wake'`)).toHaveLength(0);
    // Once only.
    await expect(runDebugRepair(db, { ownerUserId: owner, threadId: thread, repairId: proposed.repair_id })).rejects.toThrow(DebugRepairError);
    expect(await db.query(`select kind from events where kind like 'debug.repair%' order by id`)).toEqual([{ kind: 'debug.repair_proposed' }, { kind: 'debug.repair_done' }]);
  });

  it('will not prepare again a request that is still waiting, or one from another conversation', async () => {
    const request = await emailRequest();
    await expect(proposeDebugRepair(db, { ownerUserId: owner, threadId: thread, kind: 'prepare_request_again', targetId: request.stateId })).rejects.toThrow(/has not expired/);
    const elsewhere = (await createThread(db, { ownerUserId: owner })).id;
    await expire(request);
    await expect(proposeDebugRepair(db, { ownerUserId: owner, threadId: elsewhere, kind: 'prepare_request_again', targetId: request.stateId })).rejects.toThrow(/no such request/);
    await expect(proposeDebugRepair(db, { ownerUserId: owner, threadId: thread, kind: 'drop_database', targetId: null })).rejects.toThrow(/not one of the repairs/);
  });

  it('tells a goal its email went out, and lets it continue', async () => {
    const session = await createSession(db, { userId: owner });
    const accepted = await submitDurableTurn(db, { ownerUserId: owner, sessionId: session.sessionId, threadId: thread, clientMessageId: 'goal', message: 'Ask Roman about a call and book it if he says yes.' });
    const turn = (await claimDurableTurn(db, accepted.turn.id))!;
    const goal = await createWorkGoal(db, { ownerUserId: owner, threadId: thread, sourceMessageId: turn.inbound_message_id,
      outcome: 'A call with Roman is booked if he confirms', criteria: ['The meeting exists'], steps: ['Send the email', 'Wait for the reply', 'Create the event'] });
    // As on gate: the goal is asking about a card, last touched an hour ago.
    await db.query(`update work_goals set state = 'needs_instruction', continuation = $2, updated_at = now() - interval '1 hour' where id = $1`,
      [goal.goalId, JSON.stringify({ kind: 'question', text: 'Please approve the resurfaced email action card.', questionId: '397779d7-0026-4e5b-af86-87aedc39bbb5' })]);
    const request = await emailRequest();
    await db.query(`update assistant_action_states set status = 'succeeded', executed_at = now() where id = $1`, [request.stateId]);

    const file = await collectDebugCase(db, { ownerUserId: owner, threadId: thread });
    const finding = file.findings.find((f) => f.code === 'goal_waiting_on_finished_work')!;
    expect(finding.cause).toBe('defect');
    expect(file.findings.map((f) => f.code)).not.toContain('pointed_at_missing_card');
    expect(finding.summary).toMatch(/was never told/);
    expect(finding.repair).toMatchObject({ kind: 'goal_continue', target_id: goal.goalId });
    expect(file.goals[0]).toMatchObject({ state: 'needs_instruction', asking: 'Please approve the resurfaced email action card.' });

    const proposed = await proposeDebugRepair(db, { ownerUserId: owner, threadId: thread, kind: 'goal_continue', targetId: goal.goalId });
    await addMessage(db, { threadId: thread, direction: 'in', body: 'yes' });
    const result = await runDebugRepair(db, { ownerUserId: owner, threadId: thread, repairId: proposed.repair_id });
    expect(result).toMatchObject({ ok: true, repaired: 'goal_continue' });
    const [after] = await db.query<{ state: string; continuation_ready_at: string | null; owner_checkpoint: { nextAction?: string } }>(
      'select state, continuation_ready_at, owner_checkpoint from work_goals where id = $1', [goal.goalId]);
    expect(after.state).not.toBe('needs_instruction');
    expect(after.continuation_ready_at).not.toBeNull();
    expect(after.owner_checkpoint.nextAction).toMatch(/approved and carried out/);
    expect(after.owner_checkpoint.nextAction).toMatch(/say it and wait for them/);
  });

  it('files a handoff with the case it belongs to', async () => {
    expect(await saveDebugHandoff(db, { ownerUserId: owner, threadId: thread, title: 't', markdown: 'm' })).toBeNull();
    const file = await collectDebugCase(db, { ownerUserId: owner, threadId: thread });
    expect(await saveDebugHandoff(db, { ownerUserId: owner, threadId: thread, title: 'Expired approval', markdown: '# Handoff' })).toEqual({ case_id: file.case_id });
    expect((await db.query<{ handoff_title: string }>('select handoff_title from debug_cases where id = $1', [file.case_id]))[0].handoff_title).toBe('Expired approval');
  });
});
