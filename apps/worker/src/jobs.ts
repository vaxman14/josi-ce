// What the worker actually does with a claimed job.
//
// Kept separate from `main.ts` so it can be tested without starting a process,
// a pool, or a timer — the engine's equivalent was only ever exercised through
// the running worker, which meant its failure paths were not exercised at all.
//
// The write executors themselves now live in `@josi-ce/connectors`
// (`writeTasks.ts`), because the worker stopped being their only caller in
// round-3 item 26: the request that authorised a write runs it in the same
// breath so the person is told what the provider actually said. `task.wake`
// keeps its old job — draining anything queued — and shares one implementation
// with that path rather than owning a second copy of it.
import {
  addMessage, claimJobs, claimReminderForDelivery, completeJob, createThread, enqueue,
  expireApprovals, expireHolds, failJob, markReminderFailed, tickSchedules,
  type Db, type Job, type MasterKey,
} from '@josi-ce/core';
import {
  dueCloudMappings, dueOrigins, expireCustomApiCalls, expireMcpCalls, markAttempted,
  markSyncScheduled, runWriteTaskNow, syncCloudMapping, syncOrigin,
} from '@josi-ce/connectors';
import {
  TelegramBotApi, listLinksFor, loadConfig, openToken, prepareOutbound, sendChunk,
} from '@josi-ce/channels';
import { mailPolicy } from '@josi-ce/mail';
import {
  createBackup, runBackupAgent, type BackupDestination, type BackupWriter, type CommandRunner,
} from '@josi-ce/ops';

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
  backupWriter?: BackupWriter;
  resticRunner?: CommandRunner;
  resticSecretRoot?: string;
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
      // rather than a wake that quietly did nothing. The shared runner does the
      // rest: it re-checks the capability at the moment of writing, and records
      // a task nothing can carry out as failed rather than leaving it sitting
      // at "ready" forever (round-3 item 26).
      await runWriteTaskNow(db, taskId, ctx);
      return;
    }

    case 'holds.expire': {
      await expireHolds(db);
      return;
    }

    case 'approvals.expire': {
      await expireApprovals(db);
      // Custom API requests waiting on their owner expire on the same tick and
      // for the same reason: a pending write nobody answered is not consent,
      // and offering it as one a week later is how somebody approves something
      // they no longer remember being asked about.
      await expireCustomApiCalls(db);
      // And external MCP tool calls, on the same tick and for the same reason.
      await expireMcpCalls(db);
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

    case 'backup.run': {
      if (!ctx.backupWriter) throw new Error('backup.run needs the backup writer');
      const destinationId = String((job.payload as { destinationId?: unknown }).destinationId ?? '');
      const scheduleId = String((job.payload as { scheduleId?: unknown }).scheduleId ?? '');
      if (!destinationId || !scheduleId) throw new Error('backup.run without destination and schedule ids');
      const [destination] = await db.query<BackupDestination>(
        `select id,name,kind,repository,secret_ref,enabled from backup_destinations where id=$1`, [destinationId],
      );
      const [schedule] = await db.query<{ created_by:string|null; keep_daily:number; keep_weekly:number; keep_monthly:number }>(
        `select created_by,keep_daily,keep_weekly,keep_monthly from backup_schedules where id=$1 and destination_id=$2`,
        [scheduleId, destinationId],
      );
      if (!destination || !schedule || !destination.enabled) throw new Error('backup.run destination is unavailable');
      let actor = schedule.created_by;
      if (!actor) {
        const [admin] = await db.query<{ id:string }>(`select id from users where role='super_admin' and status='active' order by created_at limit 1`);
        actor = admin?.id ?? null;
      }
      if (!actor) throw new Error('backup.run has no active administrator');
      const { backup } = await createBackup(db, { kind: 'full', createdBy: actor, masterKeyConfirmed: true,
        writer: ctx.backupWriter, filename: `josi-full-scheduled-${Date.now()}.zip` });
      await runBackupAgent(db, { destination, backupId: backup.id, archivePath: backup.stored_path,
        actorUserId: actor, retention: { keepDaily: schedule.keep_daily, keepWeekly: schedule.keep_weekly,
          keepMonthly: schedule.keep_monthly }, runner: ctx.resticRunner, secretRoot: ctx.resticSecretRoot });
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
