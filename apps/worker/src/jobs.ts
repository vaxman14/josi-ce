// What the worker actually does with a claimed job.
//
// Kept separate from `main.ts` so it can be tested without starting a process,
// a pool, or a timer — the engine's equivalent was only ever exercised through
// the running worker, which meant its failure paths were not exercised at all.
//
// Phase 5 ships the machinery, not the executors. `task.wake` therefore has
// nothing to attempt for work that needs a calendar or a mailbox, and says so
// by leaving the task alone rather than failing it. A task marked failed
// because Phase 7 has not happened yet would read, to the person waiting on it,
// exactly like Josi tried and could not.
import {
  addMessage, claimJobs, claimReminderForDelivery, completeJob, createThread, enqueue,
  expireApprovals, expireHolds, failJob, getTask, markReminderFailed, tickSchedules,
  transition, type Db, type Job, type MasterKey,
} from '@josi-ce/core';
import {
  accessTokenFor, can, connectionsWithCapability, createInternalEvent, dueCalendarOrigins, dueCloudMappings, dueOrigins, expireCustomApiCalls,
  ensureInternalCalendar, loadClient, markAttempted, markCalendarAttempted, markSyncScheduled, provisionCalendarOrigins,
  processCalendarOutbox, syncCalendarOrigin, syncCloudMapping, syncOrigin, updateInternalEvent,
} from '@josi-ce/connectors';

// Write-action tasks (send a message, schedule an appointment, add a contact)
// only ever meant Google and Microsoft — Dropbox, Box and Nextcloud are
// storage-only providers with no mailbox, calendar or address book to write
// to. Narrower than the connectors package's own `Provider` on purpose, the
// same choice packages/agent/src/dataTools.ts makes for the same reason.
type WriteProvider = 'google' | 'microsoft';
import {
  TelegramBotApi, listLinksFor, loadConfig, openToken, prepareOutbound, sendChunk,
} from '@josi-ce/channels';
import { mailPolicy } from '@josi-ce/mail';

/** What the worker needs beyond the database.
 *
 * Optional, and absent in most of the suite: a job kind that needs the master
 * key says so by failing, which is visible, rather than by quietly doing
 * nothing. */
export interface WorkerContext {
  masterKey?: MasterKey | null;
  /** Injected by the tests so no suite contacts a provider. */
  connectorFetch?: typeof fetch;
  /** Injected by the tests so no suite contacts api.telegram.org. */
  telegramFetch?: typeof fetch;
}

export interface JobOutcome {
  claimed: number;
  done: number;
  failed: number;
}

/** Job kinds this worker understands. An unknown kind fails the job rather
 * than silently completing it: a job nobody handles is a bug, and marking it
 * done would hide it forever. */
export async function runJob(db: Db, job: Job, ctx: WorkerContext = {}): Promise<void> {
  switch (job.kind) {
    case 'task.wake': {
      const taskId = String((job.payload as { taskId?: unknown }).taskId ?? '');
      if (!taskId) throw new Error('task.wake without a taskId');
      // Throws if the task is gone, which retries and then goes dead — visible,
      // rather than a wake that quietly did nothing.
      const task = await getTask(db, taskId);
      if (task.state !== 'ready') return;
      if (['send_message', 'schedule_appointment', 'update_contact'].includes(task.template_key)
          && !(await taskWriteEnabled(db, task))) return;
      if (!ctx.masterKey) throw new Error('task.wake needs the installation master key');
      await transition(db, task.id, 'attempting', { actor: 'system' });
      try {
        await executeWriteTask(db, task, ctx);
        await transition(db, task.id, 'confirmed', { actor: 'system' });
      } catch (err) {
        await transition(db, task.id, 'failed', { actor: 'system', reason: safeTaskError(err) });
      }
      return;
    }

    case 'holds.expire': {
      await expireHolds(db);
      return;
    }

    case 'approvals.expire': {
      await expireApprovals(db);
      await expireCustomApiCalls(db);
      return;
    }

    // ---------------------------------------------------- contact sync
    //
    // Two kinds, and the split is deliberate. `contacts.sync_due` FANS OUT: it
    // finds origins whose own interval has elapsed and enqueues one job each,
    // syncing nothing itself. So one slow or rate-limited provider delays its
    // own account and nobody else's, and a worker that dies mid-run costs one
    // origin its turn rather than everybody's.
    case 'contacts.sync_due': {
      const due = await dueOrigins(db);
      for (const origin of due) {
        // Stamped BEFORE the job runs. A crash must not leave the origin
        // looking never-attempted, or the next tick picks it straight back up
        // and the crash repeats as fast as the worker can loop.
        await markAttempted(db, origin.id);
        await enqueue(db, { kind: 'contacts.sync', payload: { originId: origin.id } });
      }
      return;
    }

    case 'contacts.sync': {
      const originId = String((job.payload as { originId?: unknown }).originId ?? '');
      if (!originId) throw new Error('contacts.sync without an originId');
      if (!ctx.masterKey) {
        // The tokens are sealed with it. Failing is honest; skipping would
        // leave an origin that never syncs and never says why.
        throw new Error('contacts.sync needs the installation master key');
      }
      // `syncOrigin` resolves the owner from the ORIGIN, never from this
      // payload, so a forged job id cannot reach another person's contacts —
      // it can only sync an origin that already exists, for its own owner.
      //
      // It returns rather than throws for anything the operator can act on: a
      // revoked connection or a removed scope is a status on the origin, not a
      // dead job nobody sees.
      await syncOrigin(db, originId, {
        masterKey: ctx.masterKey,
        fetchImpl: ctx.connectorFetch,
      });
      return;
    }

    case 'calendar.sync_due': {
      await provisionCalendarOrigins(db);
      for (const origin of await dueCalendarOrigins(db)) {
        await markCalendarAttempted(db, origin.id);
        await enqueue(db, { kind: 'calendar.sync', payload: { originId: origin.id } });
      }
      return;
    }

    case 'calendar.sync': {
      const originId = String((job.payload as { originId?: unknown }).originId ?? '');
      if (!originId) throw new Error('calendar.sync without an originId');
      if (!ctx.masterKey) throw new Error('calendar.sync needs the installation master key');
      await syncCalendarOrigin(db, originId, { masterKey: ctx.masterKey, fetchImpl: ctx.connectorFetch });
      return;
    }

    case 'calendar.outbox_due': {
      if (!ctx.masterKey) throw new Error('calendar.outbox_due needs the installation master key');
      await processCalendarOutbox(db, { masterKey: ctx.masterKey, fetchImpl: ctx.connectorFetch });
      return;
    }

    // ---------------------------------------------------- cloud storage sync
    //
    // The same fan-out split as contact sync, for the same reasons: one due
    // schedule enqueues one job per due mapping, so one slow provider delays
    // its own folder and nobody else's.
    case 'storage.sync_due': {
      const due = await dueCloudMappings(db);
      for (const mapping of due) {
        // Stamped BEFORE the job runs — a crash mid-sync must cost this
        // mapping its turn, not repeat as fast as the worker can loop.
        await markSyncScheduled(db, mapping.id);
        await enqueue(db, { kind: 'storage.sync', payload: { mappingId: mapping.id } });
      }
      return;
    }

    case 'storage.sync': {
      const mappingId = String((job.payload as { mappingId?: unknown }).mappingId ?? '');
      if (!mappingId) throw new Error('storage.sync without a mappingId');
      if (!ctx.masterKey) {
        throw new Error('storage.sync needs the installation master key');
      }
      // `syncCloudMapping` resolves the owner from the MAPPING, never from
      // this payload — a forged job id can only sync a folder that already
      // exists, for its own owner, through its owner's own connection. It
      // returns rather than throws for anything the owner can act on — which
      // used to mean this job handler's own success/fail counter (the
      // "N done, 0 failed" line the process log prints) could not tell the
      // difference between a mapping that synced and one that failed and got
      // paused. Both looked identical: the call resolved, the handler
      // returned, the job was marked done. A failed result is still not
      // rethrown — doing so would turn an owner-actionable state (expired
      // token, missing scope) into a retried job the queue keeps re-running —
      // but it is now logged, so a failing sync is visible in the same place a
      // throwing one always was.
      const result = await syncCloudMapping(db, mappingId, {
        masterKey: ctx.masterKey,
        fetchImpl: ctx.connectorFetch,
      });
      if (result.status === 'failed') {
        console.error(
          `[storage.sync] mapping ${mappingId} did not sync: category=${result.errorCategory}`,
        );
      }
      return;
    }

    case 'reminder.deliver': {
      const reminderId = String((job.payload as { reminderId?: unknown }).reminderId ?? '');
      if (!reminderId) throw new Error('reminder.deliver without a reminderId');
      await deliverReminder(db, reminderId, ctx);
      return;
    }

    default:
      throw new Error(`no handler for job kind ${job.kind}`);
  }
}

type WritableTask = Awaited<ReturnType<typeof getTask>>;

function textSlot(task: WritableTask, key: string): string { return String(task.slots[key] ?? '').trim(); }
function listSlot(task: WritableTask, key: string): string[] {
  const value = task.slots[key]; return Array.isArray(value) ? value.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 20) : [];
}

function mailAddress(value: string): string {
  const clean = value.replace(/[\r\n]/g, '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error('A valid email address is required.');
  return clean;
}

function mailHeader(value: string): string { return value.replace(/[\r\n]+/g, ' ').trim(); }

function googlePersonPath(value: string): string {
  if (!/^people\/[A-Za-z0-9._-]+$/.test(value)) throw new Error('That Google contact identifier is not valid.');
  return value;
}

export function calendarEventUrl(provider: WriteProvider, calendarId: string, eventId = ''): string {
  const encodedCalendar = encodeURIComponent(calendarId);
  const encodedEvent = eventId ? `/${encodeURIComponent(eventId)}` : '';
  return provider === 'google'
    ? `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendar}/events${encodedEvent}`
    : `https://graph.microsoft.com/v1.0/me/calendars/${encodedCalendar}/events${encodedEvent}`;
}

async function taskWriteEnabled(db: Db, task: WritableTask): Promise<boolean> {
  const family = task.template_key === 'send_message' ? 'mail' : task.template_key === 'schedule_appointment' ? 'calendar' : 'contacts';
  const keys: Record<string, Record<WriteProvider, string>> = {
    mail: { google: 'google.mail.send', microsoft: 'microsoft.mail.send' },
    calendar: { google: 'google.calendar.write', microsoft: 'microsoft.calendar.write' },
    contacts: { google: 'google.contacts.write', microsoft: 'microsoft.contacts.write' },
  };
  for (const provider of ['google', 'microsoft'] as WriteProvider[]) {
    if ((await can(db, { ownerUserId: task.owner_user_id, capability: keys[family][provider] })).allowed) return true;
  }
  return false;
}

async function writeSession(db: Db, task: WritableTask, family: 'mail' | 'calendar' | 'contacts', ctx: WorkerContext,
  requested?: { provider?: unknown; account_id?: unknown }) {
  const keys: Record<typeof family, Record<WriteProvider, string>> = {
    mail: { google: 'google.mail.send', microsoft: 'microsoft.mail.send' },
    calendar: { google: 'google.calendar.write', microsoft: 'microsoft.calendar.write' },
    contacts: { google: 'google.contacts.write', microsoft: 'microsoft.contacts.write' },
  };
  for (const provider of ['google', 'microsoft'] as WriteProvider[]) {
    if (requested?.provider !== undefined && requested.provider !== provider) continue;
    if (!(await can(db, { ownerUserId: task.owner_user_id, capability: keys[family][provider] })).allowed) continue;
    const connections = await connectionsWithCapability(db, { ownerUserId: task.owner_user_id, capability: keys[family][provider] });
    const connection = requested?.account_id === undefined
      ? connections[0]
      : connections.find((candidate) => candidate.id === requested.account_id);
    if (!connection) continue;
    const client = await loadClient(db, ctx.masterKey!, provider);
    const accessToken = await accessTokenFor(db, ctx.masterKey!, { connection, client }, { fetchImpl: ctx.connectorFetch });
    return { provider, accessToken };
  }
  throw new Error(`Enable ${family} write access on the Connections page first.`);
}

async function providerFetch(ctx: WorkerContext, url: string, accessToken: string, init: RequestInit) {
  const response = await (ctx.connectorFetch ?? fetch)(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`The connected provider refused the write (${response.status}).`);
}

async function executeWriteTask(db: Db, task: WritableTask, ctx: WorkerContext): Promise<void> {
  if (task.template_key === 'send_message') {
    const session = await writeSession(db, task, 'mail', ctx); const to = mailAddress(textSlot(task, 'recipient')); const cc = listSlot(task, 'cc').map(mailAddress);
    const bodyText = textSlot(task, 'body') || textSlot(task, 'body_brief');
    if (session.provider === 'google') {
      const raw = [`To: ${to}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []), `Subject: ${mailHeader(textSlot(task, 'subject'))}`, 'Content-Type: text/plain; charset=utf-8', '', bodyText].join('\r\n');
      await providerFetch(ctx, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', session.accessToken,
        { method: 'POST', body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }) });
    } else await providerFetch(ctx, 'https://graph.microsoft.com/v1.0/me/sendMail', session.accessToken,
      { method: 'POST', body: JSON.stringify({ message: { subject: textSlot(task, 'subject'), body: { contentType: 'Text', content: bodyText },
        toRecipients: [{ emailAddress: { address: to } }], ccRecipients: cc.map((address) => ({ emailAddress: { address } })) } }) });
    return;
  }
  if (task.template_key === 'schedule_appointment') {
    const source = task.slots.calendar_source && typeof task.slots.calendar_source === 'object'
      ? task.slots.calendar_source as { provider?: unknown; account_id?: unknown; calendar_id?: unknown }
      : undefined;
    if (!source || typeof source.calendar_id !== 'string' || !source.calendar_id) {
      throw new Error('The approved task has no exact calendar source. Draft it again and choose a calendar.');
    }
    const provider = source.provider === 'google' || source.provider === 'microsoft' ? source.provider : null;
    if (!provider) throw new Error('The approved task has an invalid calendar provider.');
    const connections = await connectionsWithCapability(db, { ownerUserId: task.owner_user_id, capability: `${provider}.calendar.write` });
    const connection = connections.find((candidate) => candidate.id === source.account_id);
    if (!connection) throw new Error('The selected calendar account is unavailable or permission was lost.');
    const event = { title: textSlot(task, 'title'), description: textSlot(task, 'description'), location: textSlot(task, 'location'),
      start: textSlot(task, 'start'), end: textSlot(task, 'end'), attendees: listSlot(task, 'attendees') };
    const eventId = textSlot(task, 'event_id');
    if (eventId && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(eventId)) {
      await updateInternalEvent(db, { ownerUserId: task.owner_user_id, eventId, changes: event });
    } else {
      const origin = await ensureInternalCalendar(db, { ownerUserId: task.owner_user_id, connectionId: connection.id, provider, providerCalendarId: source.calendar_id });
      await createInternalEvent(db, { ownerUserId: task.owner_user_id, originId: origin.id, event });
    }
    return;
  }
  if (task.template_key === 'update_contact') {
    const session = await writeSession(db, task, 'contacts', ctx); const contactId = textSlot(task, 'contact_id');
    const url = session.provider === 'google'
      ? contactId ? `https://people.googleapis.com/v1/${googlePersonPath(contactId)}:updateContact?updatePersonFields=names,emailAddresses,phoneNumbers,biographies` : 'https://people.googleapis.com/v1/people:createContact'
      : `https://graph.microsoft.com/v1.0/me/contacts${contactId ? `/${encodeURIComponent(contactId)}` : ''}`;
    const body = session.provider === 'google'
      ? { names: [{ displayName: textSlot(task, 'name') }], emailAddresses: textSlot(task, 'email') ? [{ value: textSlot(task, 'email') }] : [], phoneNumbers: textSlot(task, 'phone') ? [{ value: textSlot(task, 'phone') }] : [], biographies: textSlot(task, 'notes') ? [{ value: textSlot(task, 'notes') }] : [] }
      : { displayName: textSlot(task, 'name'), emailAddresses: textSlot(task, 'email') ? [{ address: textSlot(task, 'email'), name: textSlot(task, 'name') }] : [], businessPhones: textSlot(task, 'phone') ? [textSlot(task, 'phone')] : [], personalNotes: textSlot(task, 'notes') };
    await providerFetch(ctx, url, session.accessToken, { method: contactId ? 'PATCH' : 'POST', body: JSON.stringify(body) }); return;
  }
  throw new Error('No executor exists for this task type.');
}

function safeTaskError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'The action failed.';
  return message.slice(0, 300);
}

/** Deliver one due reminder.
 *
 * The claim is the concurrency control: `claimReminderForDelivery` flips
 * 'scheduled' to 'delivered' atomically, so a cancelled reminder, a second
 * worker holding the same job, or a retry of a job that already delivered all
 * land here and find nothing to do. The chat surface is the delivery that
 * counts; Telegram is best-effort on top — a person whose bot is briefly
 * unreachable still gets the reminder where they asked for it, and a Telegram
 * failure must not fail a delivery that already happened. */
async function deliverReminder(db: Db, reminderId: string, ctx: WorkerContext): Promise<void> {
  const reminder = await claimReminderForDelivery(db, reminderId);
  if (!reminder) return;

  const text = `Reminder: ${reminder.body}`;
  try {
    // The conversation it was asked in, or a fresh one when that thread has
    // been deleted since — the reminder is owed to the person, not the thread.
    const threadId = reminder.thread_id
      ?? (await createThread(db, { ownerUserId: reminder.owner_user_id, title: 'Reminders' })).id;
    await addMessage(db, { threadId, direction: 'out', body: text, channel: 'web' });
  } catch (err) {
    // Claimed but delivered nowhere. Recorded as failed so the owner's list
    // tells the truth, then rethrown so the queue's retry/dead machinery and
    // its visible last_error apply.
    await markReminderFailed(db, reminderId);
    throw err;
  }

  await deliverReminderToTelegram(db, reminder.owner_user_id, text, ctx).catch(() => {
    // sendChunk already records the failed attempt and its category; a dead
    // chat has already revoked its own link. Nothing useful is left to do.
  });
}

async function deliverReminderToTelegram(
  db: Db,
  userId: string,
  text: string,
  ctx: WorkerContext,
): Promise<void> {
  if (!ctx.masterKey) return;   // the token is sealed with it; without it there is no channel
  const config = await loadConfig(db);
  if (!config?.enabled || !config.bot_token_enc) return;

  const links = (await listLinksFor(db, userId)).filter((l) => l.status === 'active');
  if (!links.length) return;

  const api = new TelegramBotApi({
    token: openToken(ctx.masterKey, config),
    fetchImpl: ctx.telegramFetch,
  });
  const policy = await mailPolicy(db);
  const chunks = prepareOutbound({ body: text, disclosure: policy.disclosure.replace('{user}', 'you') });
  for (const link of links) {
    for (const chunk of chunks) {
      await sendChunk({ db, api }, {
        chatId: Number(link.chat_id), text: chunk, userId, kind: 'notice',
      });
    }
  }
}

/** One pass: promote due schedules, then drain what is claimable. */
export async function processQueue(
  db: Db,
  workerId: string,
  limit = 5,
  ctx: WorkerContext = {},
): Promise<JobOutcome> {
  await tickSchedules(db);
  const jobs = await claimJobs(db, workerId, limit);
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await runJob(db, job, ctx);
      await completeJob(db, job.id);
      done++;
    } catch (err) {
      // Our own message, never a provider body — `last_error` is readable by
      // anything with database access, so it must not become a side channel for
      // content.
      await failJob(db, job.id, (err as Error).message);
      failed++;
    }
  }
  return { claimed: jobs.length, done, failed };
}
