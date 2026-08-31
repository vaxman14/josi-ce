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
  claimJobs, completeJob, expireApprovals, expireHolds, failJob, getTask, tickSchedules,
  type Db, type Job,
} from '@josi-ce/core';

export interface JobOutcome {
  claimed: number;
  done: number;
  failed: number;
}

/** Job kinds this worker understands. An unknown kind fails the job rather
 * than silently completing it: a job nobody handles is a bug, and marking it
 * done would hide it forever. */
export async function runJob(db: Db, job: Job): Promise<void> {
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

    default:
      throw new Error(`no handler for job kind ${job.kind}`);
  }
}

/** One pass: promote due schedules, then drain what is claimable. */
export async function processQueue(db: Db, workerId: string, limit = 5): Promise<JobOutcome> {
  await tickSchedules(db);
  const jobs = await claimJobs(db, workerId, limit);
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await runJob(db, job);
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
