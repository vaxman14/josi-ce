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
  claimJobs, completeJob, enqueue, expireApprovals, expireHolds, failJob, getTask, tickSchedules,
  type Db, type Job, type MasterKey,
} from '@josi-ce/core';
import { dueOrigins, markAttempted, syncOrigin } from '@josi-ce/connectors';

/** What the worker needs beyond the database.
 *
 * Optional, and absent in most of the suite: a job kind that needs the master
 * key says so by failing, which is visible, rather than by quietly doing
 * nothing. */
export interface WorkerContext {
  masterKey?: MasterKey | null;
  /** Injected by the tests so no suite contacts a provider. */
  connectorFetch?: typeof fetch;
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

    default:
      throw new Error(`no handler for job kind ${job.kind}`);
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
