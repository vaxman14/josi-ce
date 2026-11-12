// Daily Brief + Memory: the notes file, the task list, the settings and the
// clock that decides when a brief is due.
//
// The notes are one short file per person, sealed with their own Vault box key
// (the way My World seals its secrets), so the database holds no readable line.
// Josi writes to it in conversation whenever she learns something durable; the
// person can read, change and delete every line. Tasks have four states and
// Josi may only PROPOSE "done": the person marks it done. Scheduled runs are
// read-and-suggest and live in packages/agent/src/dailyBrief.ts.
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { refuseMemorySecret } from './memorySafety.js';
import { openForOwner, sealForOwner } from './vault.js';

export class BriefError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// ---------------------------------------------------------------- the notes

export const NOTE_SECTIONS = ['goals', 'rules', 'people', 'open_loops', 'task_status', 'talked_through'] as const;
export type NoteSection = (typeof NOTE_SECTIONS)[number];
export const SECTION_LABELS: Record<NoteSection, string> = {
  goals: 'Goals', rules: 'Rules', people: 'People', open_loops: 'Open loops', task_status: 'Task status', talked_through: 'Talked through',
};
export interface NoteLine { id: string; text: string; /** YYYY-MM-DD, the person's own day. */ date: string }
export type Notes = Record<NoteSection, NoteLine[]>;

const MAX_LINE = 240;
/** Short on purpose: a long file stops being read, by the person and by the model. */
const SECTION_CAP: Record<NoteSection, number> = { goals: 20, rules: 40, people: 40, open_loops: 30, task_status: 30, talked_through: 40 };
/** Days a line stays before it is considered stale. Rules are the person's own words and never expire. */
const STALE_DAYS: Partial<Record<NoteSection, number>> = { talked_through: 21, open_loops: 90, task_status: 60 };

export const emptyNotes = (): Notes => ({ goals: [], rules: [], people: [], open_loops: [], task_status: [], talked_through: [] });

const HEALTH_OR_MONEY = /\b(diagnos\w*|prescription|medication|medical condition|blood (?:pressure|sugar|test)|therap(?:y|ist)|surgery|chemo\w*|pregnan\w*|bank balance|account balance|salary|net worth|debt of|credit score|routing number|tax return|loan balance)\b/i;
const ID_NUMBER = /\b\d{3}-\d{2}-\d{4}\b|\b(?:social security|passport|driver'?s licen[sc]e|national id)\b.{0,24}\d/i;
const PASSWORD_LIKE = /\b(?:password|passcode|pin code|one[- ]time code|recovery code)\b.{0,16}(?:is|are|:|=)/i;

/** A line that may be kept. Throws a plain reason when it may not: notes never
 * hold passwords, card numbers, ID numbers, and hold health or money details
 * only when the person explicitly asked for them. */
export function checkNoteText(raw: unknown, explicit = false): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new BriefError('Say what to note.');
  if (text.length > MAX_LINE) throw new BriefError(`Keep a note to ${MAX_LINE} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new BriefError('That note has characters that cannot be kept.');
  const secret = refuseMemorySecret(text);
  if (secret) throw new BriefError(`Notes never hold ${secret}. Keep it in the Vault.`);
  if (ID_NUMBER.test(text)) throw new BriefError('Notes never hold ID numbers. Keep them in the Vault.');
  if (PASSWORD_LIKE.test(text)) throw new BriefError('Notes never hold passwords or codes. Keep them in the Vault.');
  if (!explicit && HEALTH_OR_MONEY.test(text)) throw new BriefError('Health and money details are only noted when you ask for them.');
  return text;
}

const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const dayNumber = (day: string) => Math.floor(Date.parse(day + 'T00:00:00Z') / 86_400_000);

/** Drops stale lines and keeps each section short, newest first kept. */
export function pruneNotes(notes: Notes, today: string): Notes {
  const out = emptyNotes();
  for (const section of NOTE_SECTIONS) {
    const limit = STALE_DAYS[section];
    const fresh = notes[section].filter(line => limit === undefined || dayNumber(today) - dayNumber(line.date) <= limit);
    out[section] = fresh.slice(Math.max(0, fresh.length - SECTION_CAP[section]));
  }
  return out;
}

function normalise(value: unknown): Notes {
  const out = emptyNotes();
  const source = (value && typeof value === 'object' ? (value as { notes?: unknown }).notes : null) as Partial<Record<NoteSection, unknown>> | null;
  for (const section of NOTE_SECTIONS) {
    const lines = Array.isArray(source?.[section]) ? source![section] as unknown[] : [];
    for (const line of lines) {
      const l = line as Partial<NoteLine>;
      if (typeof l?.id === 'string' && typeof l.text === 'string' && l.text) out[section].push({ id: l.id, text: l.text.slice(0, MAX_LINE), date: isDay(l.date) ? l.date : '1970-01-01' });
    }
  }
  return out;
}

async function loadSealed(db: Db, userId: string, lock: boolean): Promise<string | null> {
  const [row] = await db.query<{ sealed: string }>(`select sealed from user_brief_notes where user_id = $1${lock ? ' for update' : ''}`, [userId]);
  return row?.sealed ?? null;
}

/** The person's notes. A locked or missing Vault box reads as an error, not as empty notes. */
export async function readNotes(db: Db, key: MasterKey, userId: string): Promise<Notes> {
  const sealed = await loadSealed(db, userId, false);
  return sealed ? normalise(await openForOwner(db, key, userId, sealed)) : emptyNotes();
}

async function mutate<T>(db: Db, key: MasterKey, userId: string, day: string, change: (notes: Notes) => T): Promise<T> {
  const run = async (tx: Db) => {
    const sealed = await loadSealed(tx, userId, true);
    const notes = sealed ? normalise(await openForOwner(tx, key, userId, sealed)) : emptyNotes();
    const result = change(notes);
    const kept = pruneNotes(notes, day);
    for (const section of NOTE_SECTIONS) notes[section] = kept[section];
    const next = await sealForOwner(tx, key, userId, { notes } as unknown as Record<string, unknown>);
    await tx.query(`insert into user_brief_notes(user_id, sealed, updated_at) values ($1, $2, now())
      on conflict (user_id) do update set sealed = excluded.sealed, updated_at = now()`, [userId, next]);
    return result;
  };
  return db.transaction ? db.transaction(run) : run(db);
}

const sectionOf = (value: unknown): NoteSection => {
  if (!NOTE_SECTIONS.includes(value as NoteSection)) throw new BriefError('That section does not exist.');
  return value as NoteSection;
};

/** Adds a line (or finds the same one already there). */
export async function addNote(db: Db, key: MasterKey, userId: string, args: { section: unknown; text: unknown; explicit?: boolean; day: string }): Promise<NoteLine> {
  const section = sectionOf(args.section), text = checkNoteText(args.text, args.explicit === true);
  if (!isDay(args.day)) throw new BriefError('The day is not valid.');
  return mutate(db, key, userId, args.day, notes => {
    const same = notes[section].find(line => line.text.toLowerCase() === text.toLowerCase());
    if (same) { same.date = args.day; return same; }
    const line = { id: randomUUID(), text, date: args.day };
    notes[section].push(line);
    return line;
  });
}

export async function editNote(db: Db, key: MasterKey, userId: string, args: { id: string; text: unknown; day: string }): Promise<NoteLine | null> {
  const text = checkNoteText(args.text, true);
  return mutate(db, key, userId, args.day, notes => {
    for (const section of NOTE_SECTIONS) {
      const line = notes[section].find(value => value.id === args.id);
      if (line) { line.text = text; line.date = args.day; return line; }
    }
    return null;
  });
}

export async function deleteNote(db: Db, key: MasterKey, userId: string, args: { id: string; day: string }): Promise<boolean> {
  return mutate(db, key, userId, args.day, notes => {
    for (const section of NOTE_SECTIONS) {
      const at = notes[section].findIndex(value => value.id === args.id);
      if (at >= 0) { notes[section].splice(at, 1); return true; }
    }
    return false;
  });
}

/** Josi removes a line by its wording (she does not see ids). Returns how many went. */
export async function removeNoteText(db: Db, key: MasterKey, userId: string, args: { section: unknown; text: unknown; day: string }): Promise<number> {
  const section = sectionOf(args.section), needle = String(args.text ?? '').trim().toLowerCase();
  if (!needle) throw new BriefError('Say which note to remove.');
  return mutate(db, key, userId, args.day, notes => {
    const before = notes[section].length;
    notes[section] = notes[section].filter(line => !line.text.toLowerCase().includes(needle));
    return before - notes[section].length;
  });
}

export async function clearNotes(db: Db, userId: string): Promise<void> {
  await db.query('delete from user_brief_notes where user_id = $1', [userId]);
}

/** The notes as plain text for a prompt. Empty string when there is nothing. */
export function notesToText(notes: Notes): string {
  const parts: string[] = [];
  for (const section of NOTE_SECTIONS) {
    if (!notes[section].length) continue;
    parts.push(`${SECTION_LABELS[section]}:\n${notes[section].map(line => `- ${line.text} (${line.date})`).join('\n')}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- the tasks

export const TASK_STATES = ['working', 'waiting_on_user', 'blocked', 'done'] as const;
export type BriefTaskState = (typeof TASK_STATES)[number];
export interface BriefTask {
  id: string; title: string; state: BriefTaskState; detail: string | null; doneProposed: boolean;
  createdAt: string; updatedAt: string; doneAt: string | null;
}
interface TaskRow { id: string; title: string; state: BriefTaskState; detail: string | null; done_proposed: boolean; created_at: string; updated_at: string; done_at: string | null }
const taskOf = (row: TaskRow): BriefTask => ({ id: row.id, title: row.title, state: row.state, detail: row.detail, doneProposed: row.done_proposed,
  createdAt: row.created_at, updatedAt: row.updated_at, doneAt: row.done_at });
const TASK_COLUMNS = `id, title, state, detail, done_proposed, created_at::text as created_at, updated_at::text as updated_at, done_at::text as done_at`;

function taskText(value: unknown, max: number, what: string): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new BriefError(`Say ${what}.`);
  if (text.length > max) throw new BriefError(`Keep ${what} to ${max} characters.`);
  const secret = refuseMemorySecret(text);
  if (secret) throw new BriefError(`Tasks never hold ${secret}. Keep it in the Vault.`);
  return text;
}

export async function listBriefTasks(db: Db, userId: string, opts: { includeDone?: boolean } = {}): Promise<BriefTask[]> {
  const rows = await db.query<TaskRow>(`select ${TASK_COLUMNS} from brief_tasks where user_id = $1 ${opts.includeDone ? '' : `and state <> 'done'`}
    order by case state when 'waiting_on_user' then 0 when 'blocked' then 1 when 'working' then 2 else 3 end, updated_at desc limit 100`, [userId]);
  return rows.map(taskOf);
}

export async function addBriefTask(db: Db, userId: string, args: { title: unknown; detail?: unknown; state?: unknown }): Promise<BriefTask> {
  const title = taskText(args.title, 300, 'the task');
  const detail = args.detail === undefined || args.detail === null || args.detail === '' ? null : taskText(args.detail, 500, 'its detail');
  const state = args.state === 'waiting_on_user' || args.state === 'blocked' ? args.state : 'working';
  const [open] = await db.query<{ n: number }>(`select count(*)::int as n from brief_tasks where user_id = $1 and state <> 'done'`, [userId]);
  if ((open?.n ?? 0) >= 60) throw new BriefError('That is a lot of open tasks. Finish or remove some first.');
  const [row] = await db.query<TaskRow>(`insert into brief_tasks(user_id, title, detail, state) values ($1, $2, $3, $4) returning ${TASK_COLUMNS}`, [userId, title, detail, state]);
  return taskOf(row);
}

/** What Josi may do: move a task between working, waiting on the person and
 * blocked, say why, and PROPOSE that it is done. Never "done" itself. */
export async function updateBriefTaskByJosi(db: Db, userId: string, id: string, args: { state?: unknown; detail?: unknown; proposeDone?: unknown }): Promise<BriefTask> {
  if (args.state === 'done') throw new BriefError('Only the person marks a task done. Propose it instead.');
  if (args.state !== undefined && !TASK_STATES.includes(args.state as BriefTaskState)) throw new BriefError('That state does not exist.');
  const detail = args.detail === undefined ? undefined : args.detail === null || args.detail === '' ? null : taskText(args.detail, 500, 'its detail');
  const [row] = await db.query<TaskRow>(`update brief_tasks set
      state = coalesce($3, state), detail = case when $4::boolean then $5 else detail end,
      done_proposed = case when $6::boolean then true when $3::text is not null then false else done_proposed end, updated_at = now()
    where id = $1 and user_id = $2 and state <> 'done' returning ${TASK_COLUMNS}`,
  [id, userId, args.state ?? null, detail !== undefined, detail ?? null, args.proposeDone === true]);
  if (!row) throw new BriefError('That task is not open.', 404);
  return taskOf(row);
}

/** The person's own change: any state, including done and reopened. */
export async function setBriefTaskByPerson(db: Db, userId: string, id: string, args: { state?: unknown; title?: unknown; detail?: unknown }): Promise<BriefTask> {
  if (args.state !== undefined && !TASK_STATES.includes(args.state as BriefTaskState)) throw new BriefError('That state does not exist.');
  const title = args.title === undefined ? null : taskText(args.title, 300, 'the task');
  const detail = args.detail === undefined ? undefined : args.detail === null || args.detail === '' ? null : taskText(args.detail, 500, 'its detail');
  const [row] = await db.query<TaskRow>(`update brief_tasks set
      state = coalesce($3, state), title = coalesce($4, title), detail = case when $5::boolean then $6 else detail end,
      done_proposed = case when $3::text is not null then false else done_proposed end,
      done_at = case when $3::text = 'done' then now() when $3::text is not null then null else done_at end, updated_at = now()
    where id = $1 and user_id = $2 returning ${TASK_COLUMNS}`, [id, userId, args.state ?? null, title, detail !== undefined, detail ?? null]);
  if (!row) throw new BriefError('That task does not exist.', 404);
  return taskOf(row);
}

export async function deleteBriefTask(db: Db, userId: string, id: string): Promise<boolean> {
  return (await db.query('delete from brief_tasks where id = $1 and user_id = $2 returning id', [id, userId])).length > 0;
}

/** Finished tasks stay two weeks, then go. */
export async function pruneBriefTasks(db: Db): Promise<number> {
  return (await db.query(`delete from brief_tasks where state = 'done' and done_at < now() - interval '14 days' returning id`)).length;
}

// ---------------------------------------------------------------- the settings

export interface BriefSettings { briefEnabled: boolean; checkinsEnabled: boolean; quietStart: string; quietEnd: string; timezone: string | null }
const DEFAULT_SETTINGS: BriefSettings = { briefEnabled: false, checkinsEnabled: false, quietStart: '22:00', quietEnd: '07:00', timezone: null };
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); return true; } catch { return false; }
}

export async function getBriefSettings(db: Db, userId: string): Promise<BriefSettings> {
  const [row] = await db.query<{ brief_enabled: boolean; checkins_enabled: boolean; quiet_start: string; quiet_end: string; timezone: string | null }>(
    'select brief_enabled, checkins_enabled, quiet_start, quiet_end, timezone from brief_settings where user_id = $1', [userId]);
  return row ? { briefEnabled: row.brief_enabled, checkinsEnabled: row.checkins_enabled, quietStart: row.quiet_start, quietEnd: row.quiet_end, timezone: row.timezone } : { ...DEFAULT_SETTINGS };
}

export async function saveBriefSettings(db: Db, userId: string, patch: Partial<Record<keyof BriefSettings, unknown>>): Promise<BriefSettings> {
  const now = await getBriefSettings(db, userId), next = { ...now };
  if (patch.briefEnabled !== undefined) { if (typeof patch.briefEnabled !== 'boolean') throw new BriefError('Brief is on or off.'); next.briefEnabled = patch.briefEnabled; }
  if (patch.checkinsEnabled !== undefined) { if (typeof patch.checkinsEnabled !== 'boolean') throw new BriefError('Check-ins are on or off.'); next.checkinsEnabled = patch.checkinsEnabled; }
  for (const key of ['quietStart', 'quietEnd'] as const) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'string' || !HHMM.test(patch[key] as string)) throw new BriefError('Use a time like 22:00.');
    next[key] = patch[key] as string;
  }
  if (patch.timezone !== undefined) {
    if (patch.timezone === null || patch.timezone === '') next.timezone = null;
    else if (typeof patch.timezone !== 'string' || !validTimeZone(patch.timezone)) throw new BriefError('That time zone is not known. Use a name like America/Los_Angeles.');
    else next.timezone = patch.timezone;
  }
  await db.query(`insert into brief_settings(user_id, brief_enabled, checkins_enabled, quiet_start, quiet_end, timezone, updated_at) values ($1, $2, $3, $4, $5, $6, now())
    on conflict (user_id) do update set brief_enabled = excluded.brief_enabled, checkins_enabled = excluded.checkins_enabled,
      quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, timezone = excluded.timezone, updated_at = now()`,
  [userId, next.briefEnabled, next.checkinsEnabled, next.quietStart, next.quietEnd, next.timezone]);
  return next;
}

// ---------------------------------------------------------------- the clock

/** The person's local day and minute of the day. */
export function localClock(now: Date, timeZone: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Quiet hours may cross midnight (22:00 to 07:00). Equal times mean no quiet hours. */
export function inQuietHours(minutes: number, start: string, end: string): boolean {
  const s = toMinutes(start), e = toMinutes(end);
  if (s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

export const MORNING_WINDOW_MINUTES = 300;
export const CHECKIN_AFTER_MINUTES = 180;
export const MAX_CHECKINS_PER_DAY = 2;
export const CHECKIN_GAP_HOURS = 4;

export interface DueBrief { userId: string; kind: 'morning' | 'checkin'; day: string; runId: string }

/** Finds the briefs that are due now, claims each (so two workers never post
 * the same one) and records a queued run. A Morning Brief comes when quiet
 * hours end, any time in the next five hours, once a day. Up to two
 * check-ins a day follow, at least four hours apart, never inside quiet hours. */
export async function claimDueBriefs(db: Db, now: Date = new Date()): Promise<DueBrief[]> {
  const people = await db.query<{ user_id: string; brief_enabled: boolean; checkins_enabled: boolean; quiet_start: string; quiet_end: string; timezone: string | null; zone: string | null }>(
    `select s.user_id, s.brief_enabled, s.checkins_enabled, s.quiet_start, s.quiet_end, s.timezone,
       (select timezone from workspace limit 1) as zone
     from brief_settings s join users u on u.id = s.user_id and u.status = 'active' where s.brief_enabled or s.checkins_enabled`);
  const due: DueBrief[] = [];
  for (const person of people) {
    const zone = person.timezone ?? person.zone ?? 'UTC';
    if (!validTimeZone(zone)) continue;
    const { day, minutes } = localClock(now, zone);
    if (inQuietHours(minutes, person.quiet_start, person.quiet_end)) continue;
    const end = toMinutes(person.quiet_end);
    // The window is measured from the end of quiet hours, even across midnight.
    const sinceQuiet = (minutes - end + 1440) % 1440;
    let kind: DueBrief['kind'] | null = null;
    if (person.brief_enabled && sinceQuiet < MORNING_WINDOW_MINUTES) {
      const [claimed] = await db.query(`update brief_settings set last_brief_day = $2 where user_id = $1 and last_brief_day is distinct from $2 returning user_id`, [person.user_id, day]);
      if (claimed) kind = 'morning';
    }
    if (!kind && person.checkins_enabled && sinceQuiet >= CHECKIN_AFTER_MINUTES) {
      const [claimed] = await db.query(`update brief_settings set
          checkins_today = case when checkin_day = $2 then checkins_today + 1 else 1 end, checkin_day = $2, last_checkin_at = now()
        where user_id = $1 and (checkin_day is distinct from $2 or checkins_today < $3)
          and (last_checkin_at is null or last_checkin_at <= now() - make_interval(hours => $4)) returning user_id`,
      [person.user_id, day, MAX_CHECKINS_PER_DAY, CHECKIN_GAP_HOURS]);
      if (claimed) kind = 'checkin';
    }
    if (!kind) continue;
    const [run] = await db.query<{ id: string }>(`insert into brief_runs(user_id, kind, local_day) values ($1, $2, $3) returning id`, [person.user_id, kind, day]);
    due.push({ userId: person.user_id, kind, day, runId: run.id });
  }
  return due;
}

export async function startBriefRunNow(db: Db, userId: string, now: Date = new Date()): Promise<{ runId: string; day: string }> {
  const settings = await getBriefSettings(db, userId);
  const [zone] = await db.query<{ timezone: string }>('select timezone from workspace limit 1');
  const { day } = localClock(now, settings.timezone ?? zone?.timezone ?? 'UTC');
  const [run] = await db.query<{ id: string }>(`insert into brief_runs(user_id, kind, local_day) values ($1, 'now', $2) returning id`, [userId, day]);
  return { runId: run.id, day };
}

export async function finishBriefRun(db: Db, runId: string, status: 'posted' | 'silent' | 'failed', extra: { messageId?: string | null; error?: string } = {}): Promise<void> {
  await db.query(`update brief_runs set status = $2, message_id = $3, error = $4, finished_at = now() where id = $1`,
    [runId, status, extra.messageId ?? null, extra.error ? extra.error.slice(0, 500) : null]);
}
