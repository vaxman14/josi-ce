import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey } from '../src/masterKey.js';
import { initializeVault } from '../src/vault.js';
import {
  addBriefTask, addNote, BriefError, checkNoteText, claimDueBriefs, deleteNote, editNote, getBriefSettings, inQuietHours, listBriefTasks, localClock,
  notesToText, pruneNotes, readNotes, removeNoteText, saveBriefSettings, setBriefTaskByPerson, updateBriefTaskByJosi, emptyNotes,
} from '../src/briefMemory.js';

let db: TestDb, owner: string, other: string;
const key = new MasterKey(Buffer.alloc(32, 91));
beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'brief@example.test', username: 'brief', role: 'super_admin' })).id;
  other = (await createUser(db, { email: 'brief2@example.test', username: 'brief2', role: 'member' })).id;
  await initializeVault(db, key, owner);
});

describe('the notes', () => {
  it('are kept sealed, per person, and read back', async () => {
    await addNote(db, key, owner, { section: 'goals', text: 'Finish the kitchen by June', day: '2026-11-12' });
    await addNote(db, key, owner, { section: 'rules', text: 'Never call me before 9', day: '2026-11-12' });
    const [row] = await db.query<{ sealed: string }>('select sealed from user_brief_notes where user_id = $1', [owner]);
    expect(row.sealed).not.toContain('kitchen');
    const notes = await readNotes(db, key, owner);
    expect(notes.goals.map(l => l.text)).toEqual(['Finish the kitchen by June']);
    expect(notesToText(notes)).toContain('Rules:\n- Never call me before 9 (2026-11-12)');
    expect((await readNotes(db, key, other)).goals).toEqual([]);
  });

  it('are edited and deleted line by line, and Josi can remove a line by its wording', async () => {
    const line = await addNote(db, key, owner, { section: 'people', text: 'Dana is my sister', day: '2026-11-12' });
    await addNote(db, key, owner, { section: 'people', text: 'Sam runs the bakery', day: '2026-11-12' });
    expect((await editNote(db, key, owner, { id: line.id, text: 'Dana is my younger sister', day: '2026-11-13' }))?.text).toBe('Dana is my younger sister');
    expect(await removeNoteText(db, key, owner, { section: 'people', text: 'bakery', day: '2026-11-13' })).toBe(1);
    expect(await deleteNote(db, key, owner, { id: line.id, day: '2026-11-13' })).toBe(true);
    expect(await deleteNote(db, key, owner, { id: line.id, day: '2026-11-13' })).toBe(false);
    expect(notesToText(await readNotes(db, key, owner))).toBe('');
  });

  it('do not repeat a line already there', async () => {
    await addNote(db, key, owner, { section: 'goals', text: 'Learn to sail', day: '2026-11-12' });
    await addNote(db, key, owner, { section: 'goals', text: 'learn to sail', day: '2026-11-14' });
    const goals = (await readNotes(db, key, owner)).goals;
    expect(goals).toHaveLength(1);
    expect(goals[0].date).toBe('2026-11-14');
  });

  it('never hold passwords, card or ID numbers, and hold health or money only when asked', () => {
    expect(() => checkNoteText('card 4111 1111 1111 1111')).toThrow(BriefError);
    expect(() => checkNoteText('my SSN is 123-45-6789')).toThrow(/ID numbers/);
    expect(() => checkNoteText('the wifi password is hunter2')).toThrow(/passwords/);
    expect(() => checkNoteText('Starts a new medication on Monday')).toThrow(/when you ask/);
    expect(checkNoteText('Starts a new medication on Monday', true)).toBe('Starts a new medication on Monday');
    expect(() => checkNoteText('x'.repeat(300))).toThrow(/240/);
    expect(() => checkNoteText('   ')).toThrow(/Say what/);
  });

  it('stay short and dated: stale lines go, each section is capped, rules stay', () => {
    const notes = emptyNotes();
    notes.talked_through.push({ id: 'a', text: 'old', date: '2026-10-01' }, { id: 'b', text: 'recent', date: '2026-11-10' });
    notes.rules.push({ id: 'r', text: 'always ask first', date: '2025-01-01' });
    for (let i = 0; i < 50; i++) notes.goals.push({ id: 'g' + i, text: 'goal ' + i, date: '2026-11-01' });
    const kept = pruneNotes(notes, '2026-11-12');
    expect(kept.talked_through.map(l => l.id)).toEqual(['b']);
    expect(kept.rules).toHaveLength(1);
    expect(kept.goals).toHaveLength(20);
    expect(kept.goals[0].id).toBe('g30');
  });

  it('refuse a bad section or day', async () => {
    await expect(addNote(db, key, owner, { section: 'secrets', text: 'x', day: '2026-11-12' })).rejects.toThrow(/section/);
    await expect(addNote(db, key, owner, { section: 'goals', text: 'x', day: 'today' })).rejects.toThrow(/day/);
  });
});

describe('the tasks', () => {
  it('let Josi move and propose, and only the person marks one done', async () => {
    const task = await addBriefTask(db, owner, { title: 'Book the dentist' });
    expect(task.state).toBe('working');
    await expect(updateBriefTaskByJosi(db, owner, task.id, { state: 'done' })).rejects.toThrow(/Only the person/);
    const waiting = await updateBriefTaskByJosi(db, owner, task.id, { state: 'waiting_on_user', detail: 'Which day suits you?' });
    expect(waiting).toMatchObject({ state: 'waiting_on_user', detail: 'Which day suits you?', doneProposed: false });
    const proposed = await updateBriefTaskByJosi(db, owner, task.id, { proposeDone: true });
    expect(proposed).toMatchObject({ state: 'waiting_on_user', doneProposed: true });
    expect((await listBriefTasks(db, owner)).map(t => t.id)).toEqual([task.id]);
    const done = await setBriefTaskByPerson(db, owner, task.id, { state: 'done' });
    expect(done.state).toBe('done');
    expect(done.doneAt).not.toBeNull();
    expect(await listBriefTasks(db, owner)).toEqual([]);
    expect(await listBriefTasks(db, owner, { includeDone: true })).toHaveLength(1);
    await expect(updateBriefTaskByJosi(db, owner, task.id, { state: 'working' })).rejects.toThrow(/not open/);
  });

  it('belong to one person and hold no secrets', async () => {
    const task = await addBriefTask(db, owner, { title: 'Private thing' });
    await expect(setBriefTaskByPerson(db, other, task.id, { state: 'done' })).rejects.toThrow(/does not exist/);
    await expect(addBriefTask(db, owner, { title: 'pay with 4111 1111 1111 1111' })).rejects.toThrow(/never hold/);
  });
});

describe('the settings and the clock', () => {
  it('start off, validate times and zones, and are per person', async () => {
    expect(await getBriefSettings(db, owner)).toEqual({ briefEnabled: false, checkinsEnabled: false, quietStart: '22:00', quietEnd: '07:00', timezone: null });
    const saved = await saveBriefSettings(db, owner, { briefEnabled: true, quietStart: '23:30', quietEnd: '06:45', timezone: 'America/Los_Angeles' });
    expect(saved).toMatchObject({ briefEnabled: true, checkinsEnabled: false, quietStart: '23:30', quietEnd: '06:45', timezone: 'America/Los_Angeles' });
    await expect(saveBriefSettings(db, owner, { quietStart: '25:00' })).rejects.toThrow(/like 22:00/);
    await expect(saveBriefSettings(db, owner, { timezone: 'Mars/Base' })).rejects.toThrow(/time zone/);
    expect((await getBriefSettings(db, other)).briefEnabled).toBe(false);
  });

  it('know quiet hours across midnight and the persons own day', () => {
    expect(inQuietHours(23 * 60, '22:00', '07:00')).toBe(true);
    expect(inQuietHours(3 * 60, '22:00', '07:00')).toBe(true);
    expect(inQuietHours(7 * 60, '22:00', '07:00')).toBe(false);
    expect(inQuietHours(12 * 60, '22:00', '07:00')).toBe(false);
    expect(inQuietHours(12 * 60, '08:00', '08:00')).toBe(false);
    expect(localClock(new Date('2026-11-12T03:30:00Z'), 'America/Los_Angeles')).toEqual({ day: '2026-11-11', minutes: 19 * 60 + 30 });
  });
});

describe('when a brief is due', () => {
  const at = (iso: string) => new Date(iso);
  // 2026-11-12 in Los Angeles is UTC-8: 07:30 local is 15:30Z.
  beforeEach(async () => {
    await saveBriefSettings(db, owner, { briefEnabled: true, checkinsEnabled: true, timezone: 'America/Los_Angeles' });
  });

  it('is silent during quiet hours', async () => {
    expect(await claimDueBriefs(db, at('2026-11-12T10:00:00Z'))).toEqual([]);
  });

  it('brings one morning brief when quiet hours end, once a day', async () => {
    const first = await claimDueBriefs(db, at('2026-11-12T15:30:00Z'));
    expect(first).toMatchObject([{ userId: owner, kind: 'morning', day: '2026-11-12' }]);
    expect(await claimDueBriefs(db, at('2026-11-12T15:35:00Z'))).toEqual([]);
    const [{ n }] = await db.query<{ n: number }>('select count(*)::int as n from brief_runs where user_id = $1', [owner]);
    expect(n).toBe(1);
    expect(await claimDueBriefs(db, at('2026-11-13T15:30:00Z'))).toMatchObject([{ kind: 'morning', day: '2026-11-13' }]);
  });

  it('brings at most two check-ins a day, four hours apart, after the morning window', async () => {
    await claimDueBriefs(db, at('2026-11-12T15:30:00Z'));
    expect(await claimDueBriefs(db, at('2026-11-12T17:00:00Z'))).toEqual([]);
    const one = await claimDueBriefs(db, at('2026-11-12T19:00:00Z'));
    expect(one).toMatchObject([{ kind: 'checkin' }]);
    await db.query(`update brief_settings set last_checkin_at = now() - interval '5 hours' where user_id = $1`, [owner]);
    const two = await claimDueBriefs(db, at('2026-11-12T23:30:00Z'));
    expect(two).toMatchObject([{ kind: 'checkin' }]);
    await db.query(`update brief_settings set last_checkin_at = now() - interval '5 hours' where user_id = $1`, [owner]);
    expect(await claimDueBriefs(db, at('2026-11-13T01:00:00Z'))).toEqual([]);
  });

  it('does nothing for a person who switched both off', async () => {
    await saveBriefSettings(db, owner, { briefEnabled: false, checkinsEnabled: false });
    expect(await claimDueBriefs(db, at('2026-11-12T15:30:00Z'))).toEqual([]);
  });
});
