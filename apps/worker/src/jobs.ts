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
  type Db, type Job, type MasterKey,
} from '@josi-ce/core';
import { dueOrigins, markAttempted, syncOrigin } from '@josi-ce/connectors';
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
      // Nothing in Phase 5 can attempt work. The task stays where it is.
      // Phase 7 replaces this with the executor lookup.
      if (task.state !== 'ready') return;
      return;
    }

    case 'holds.expire': {
      await expireHolds(db);
      return;
    }

    case 'approvals.expire': {
      await expireApprovals(db);
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
