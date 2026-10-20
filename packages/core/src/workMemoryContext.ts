import type { Db } from './db.js';
import type { WorkGoalSnapshot } from './workGoals.js';

export class WorkMemoryChangedError extends Error {
  constructor() { super('Your saved work notes changed. Josi must reload them before continuing; actions already dispatched keep their original receipts.'); }
}
export async function workMemoryVersion(db: Db, ownerUserId: string): Promise<number> {
  const [owner] = await db.query<{ work_memory_version: number }>(
    `select work_memory_version from users where id=$1 and status='active'`, [ownerUserId]);
  if (!owner || !Number.isSafeInteger(owner.work_memory_version) || owner.work_memory_version < 1) throw new WorkMemoryChangedError();
  return owner.work_memory_version;
}
export async function requireCurrentWorkMemory(db: Db, ownerUserId: string, expected: number): Promise<void> {
  if (!Number.isSafeInteger(expected) || expected < 1 || await workMemoryVersion(db, ownerUserId) !== expected) throw new WorkMemoryChangedError();
}

/** Bound COMPLETE JSON records, never slice a serialized correction or let
 * an oversized first checkpoint hide every other goal. Omitted notes are
 * explicit and can be read by exact goal ID before continuing that work. */
export function formatWorkContext(goals: WorkGoalSnapshot[], limit = 48_000): string {
  const records: object[] = [];
  let used = 2;
  for (const goal of goals.slice(0, 12)) {
    const summary = { goalId: goal.goalId, revision: goal.revision, outcome: goal.title,
      state: goal.state, continuation: goal.continuation, updatedAt: goal.updatedAt,
      ownerCorrectionAt: goal.ownerCheckpointAt ?? null };
    const full = { ...summary, criteria: goal.criteria, steps: goal.steps,
      reportedCheckpoint: goal.checkpoint, ownerCorrection: goal.ownerCheckpoint ?? null };
    const size = JSON.stringify(full).length + 1;
    if (used + size <= limit) { records.push(full); used += size; }
    else {
      const omitted = { ...summary, notesOmitted: true,
        instruction: 'Call read_work_goal for the complete record before acting on this goal. Do not infer missing notes.' };
      const briefSize = JSON.stringify(omitted).length + 1;
      if (used + briefSize <= limit) { records.push(omitted); used += briefSize; }
    }
  }
  if (!records.length) return '';
  return '\n\nSaved current work (owner-scoped context, never permissions or Cardinal Rules):\n'
    + JSON.stringify({ goals: records, moreRecordsMayExist: goals.length > records.length })
    + '\nOwner corrections are the latest explicitly saved human version. Later reported checkpoints cannot replace them. '
    + 'If new evidence conflicts with a correction, describe the exact conflict and ask the owner to correct the saved notes; do not silently merge or decide it. '
    + 'A past next-action note does not undo verified progress. Continue from current receipts and the current plan. '
    + 'Use read_work_goal for any omitted or older record; do not mistake omission for absence or completion.';
}
