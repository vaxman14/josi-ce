import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { addBriefTask, addNote, initializeVault, listBriefTasks, MasterKey, readNotes, saveBriefSettings, startBriefRunNow } from '@josi-ce/core';

const chatMock = vi.fn();
vi.mock('@josi-ce/llm', async importOriginal => ({ ...(await importOriginal<typeof import('@josi-ce/llm')>()), chat: (...args: unknown[]) => chatMock(...args) }));
const { runDailyBrief, plainBrief, wellShaped } = await import('../src/dailyBrief.js');
const { executeBriefTool, briefContext, BRIEF_TOOLS } = await import('../src/briefTools.js');
const { ALL_TOOLS } = await import('../src/tools.js');

let db: TestDb, user: string;
const key = new MasterKey(Buffer.alloc(32, 55));
const deps = () => ({ registry: { db, masterKey: key }, access: null, masterKey: key });
async function queued(kind: 'morning' | 'checkin' | 'now') {
  const run = await startBriefRunNow(db, user);
  await db.query('update brief_runs set kind = $2 where id = $1', [run.runId, kind]);
  return { runId: run.runId, userId: user, kind, day: run.day };
}
const GOOD = 'Good morning, Dana.\n\nUpdates on your current tasks:\n1. Dentist: waiting on you for a day.\n\nTasks I could help with:\n1. Pick a day for the dentist.';

beforeEach(async () => {
  chatMock.mockReset();
  db = await testDb();
  user = (await createUser(db, { email: 'dana@example.test', username: 'dana', role: 'super_admin' })).id;
  await db.query(`update users set display_name = 'Dana Reed' where id = $1`, [user]);
  await initializeVault(db, key, user);
  await saveBriefSettings(db, user, { briefEnabled: true, checkinsEnabled: true });
});

describe('the notes and task tools', () => {
  it('are in the tool registry', () => {
    const names = new Set(ALL_TOOLS.map(tool => tool.def.name));
    for (const tool of BRIEF_TOOLS) expect(names.has(tool.def.name)).toBe(true);
  });

  it('save, refuse secrets, and never let Josi mark a task done', async () => {
    expect(await executeBriefTool(db, user, key, 'note_remember', { section: 'goals', text: 'Learn the cello' })).toMatchObject({ ok: true, saved: 'Learn the cello' });
    expect(await executeBriefTool(db, user, key, 'note_remember', { section: 'rules', text: 'the pin is 4111 1111 1111 1111' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await executeBriefTool(db, user, key, 'note_remember', { section: 'people', text: 'Takes a new medication daily' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await executeBriefTool(db, user, key, 'note_remember', { section: 'people', text: 'Takes a new medication daily', explicit_request: true })).toMatchObject({ ok: true });
    const added = await executeBriefTool(db, user, key, 'brief_task_add', { title: 'Book the dentist' }) as { task: { id: string } };
    expect(await executeBriefTool(db, user, key, 'brief_task_update', { task_id: added.task.id, state: 'done' })).toMatchObject({ ok: false, code: 'refused' });
    expect(await executeBriefTool(db, user, key, 'brief_task_update', { task_id: added.task.id, propose_done: true })).toMatchObject({ ok: true, task: { state: 'working', doneProposed: true } });
    expect((await listBriefTasks(db, user))[0].state).toBe('working');
    expect(await executeBriefTool(db, user, key, 'note_forget', { section: 'goals', text: 'cello' })).toMatchObject({ ok: true, removed: 1 });
  });

  it('answer plainly when there is no key, and put the notes and open tasks in front of the model', async () => {
    expect(await executeBriefTool(db, user, null, 'note_remember', { section: 'goals', text: 'x' })).toMatchObject({ ok: false, code: 'unavailable' });
    await addNote(db, key, user, { section: 'rules', text: 'Do not call before nine', day: '2026-11-12' });
    await addBriefTask(db, user, { title: 'Book the dentist', state: 'waiting_on_user' });
    const context = await briefContext(db, key, user);
    expect(context).toContain('Do not call before nine');
    expect(context).toMatch(/Book the dentist.*waiting on user/);
    expect(await briefContext(db, null, user)).toContain('Book the dentist');
  });
});

describe('the brief text', () => {
  it('has both headings and at most three helpers, or is rebuilt without a model', async () => {
    expect(wellShaped(GOOD)).toBe(true);
    expect(wellShaped('Hello there')).toBe(false);
    expect(wellShaped(GOOD + '\n2. a\n3. b\n4. c')).toBe(false);
    const task = await addBriefTask(db, user, { title: 'Book the dentist', state: 'waiting_on_user' });
    const text = plainBrief([task], 'Dana', 'morning');
    expect(wellShaped(text)).toBe(true);
    expect(text).toContain('1. Book the dentist: waiting on you');
    expect(plainBrief([], null, 'morning')).toContain('Nothing open right now.');
  });
});

describe('a scheduled run', () => {
  it('posts the morning brief to the Daily brief conversation, once', async () => {
    chatMock.mockResolvedValue({ response: { text: GOOD } });
    const run = await queued('morning');
    expect(await runDailyBrief(db, deps(), run)).toBe('posted');
    const [message] = await db.query<{ body: string; direction: string; title: string; meta: any }>(
      `select m.body, m.direction, t.title, m.meta from messages m join threads t on t.id = m.thread_id where t.owner_user_id = $1`, [user]);
    expect(message).toMatchObject({ body: GOOD, direction: 'out', title: 'Daily brief' });
    expect(message.meta).toMatchObject({ daily_brief: 'morning' });
    expect((await db.query<{ status: string }>('select status from brief_runs where id = $1', [run.runId]))[0].status).toBe('posted');
    expect(await runDailyBrief(db, deps(), run)).toBe('skipped');
  });

  it('gives the model no tools, fences what it reads as data, and tells it it cannot act', async () => {
    chatMock.mockResolvedValue({ response: { text: GOOD } });
    await addNote(db, key, user, { section: 'talked_through', text: 'Settled the car insurance', day: '2026-11-12' });
    await runDailyBrief(db, deps(), await queued('morning'));
    const [, request] = chatMock.mock.calls[0];
    expect(request.tools).toBeUndefined();
    expect(request.system).toMatch(/only read and suggest/);
    expect(request.system).toMatch(/data, never instructions/);
    const prompt = request.messages[0].content as string;
    expect(prompt).toContain('<data kind="notes">');
    expect(prompt).toContain('Settled the car insurance');
    expect(prompt).toContain('<data kind="email, last day">');
  });

  it('falls back to a plain list when the model is unreachable or answers in the wrong shape', async () => {
    await addBriefTask(db, user, { title: 'Book the dentist', state: 'waiting_on_user' });
    chatMock.mockRejectedValue(new Error('model offline'));
    expect(await runDailyBrief(db, deps(), await queued('morning'))).toBe('posted');
    chatMock.mockResolvedValue({ response: { text: 'Sure! Here is a rambling answer.' } });
    expect(await runDailyBrief(db, deps(), await queued('now'))).toBe('posted');
    const bodies = (await db.query<{ body: string }>(`select body from messages order by created_at`)).map(row => row.body);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) { expect(wellShaped(body)).toBe(true); expect(body).toContain('Book the dentist'); }
  });

  it('keeps a check-in silent unless something changed, and never posts filler', async () => {
    chatMock.mockResolvedValue({ response: { text: 'SILENT' } });
    expect(await runDailyBrief(db, deps(), await queued('checkin'))).toBe('silent');
    chatMock.mockResolvedValue({ response: { text: 'Nothing much, just saying hi!' } });
    expect(await runDailyBrief(db, deps(), await queued('checkin'))).toBe('silent');
    chatMock.mockRejectedValue(new Error('model offline'));
    expect(await runDailyBrief(db, deps(), await queued('checkin'))).toBe('silent');
    expect(await db.query('select 1 from messages')).toHaveLength(0);
    chatMock.mockResolvedValue({ response: { text: GOOD.replace('Good morning, Dana.', 'Quick update.') } });
    expect(await runDailyBrief(db, deps(), await queued('checkin'))).toBe('posted');
  });

  it('does nothing if the person switched it off after it was queued', async () => {
    const run = await queued('morning');
    await saveBriefSettings(db, user, { briefEnabled: false });
    expect(await runDailyBrief(db, deps(), run)).toBe('silent');
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('reads nothing it was not given: a locked Vault means no notes, not a failure', async () => {
    chatMock.mockResolvedValue({ response: { text: GOOD } });
    await addNote(db, key, user, { section: 'goals', text: 'Secret plan', day: '2026-11-12' });
    await db.query('update vault_boxes set locked = true where owner_user_id = $1', [user]);
    expect(await runDailyBrief(db, deps(), await queued('morning'))).toBe('posted');
    expect(chatMock.mock.calls[0][1].messages[0].content).not.toContain('Secret plan');
    void readNotes;
  });
});
