// Where a running capability probe is, for the client that started it.
//
// A probe is one long request (five model round trips, often half a minute),
// and the app showing it had nothing to say until the end. This keeps the
// probe's own progress reports in memory, keyed by what is being probed, so a
// GET can answer "which check is running, which are done". It is a view of
// the current process only: never persisted, never a substitute for the
// stored result, and empty after a restart.
import type { ProbeProgress, ProbeStep } from '@josi-ce/llm';

export interface ProbeProgressView {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  current: ProbeStep['id'] | null;
  steps: ProbeStep[];
}

interface Run { startedAt: string; finishedAt: string | null; current: ProbeStep['id'] | null; steps: ProbeStep[] }

const runs = new Map<string, Run>();
const KEEP_MS = 10 * 60_000;

/** Start tracking one probe. Pass `onProgress` to `probeProvider` and call
 * `done()` when it returns or throws, so a crashed probe never reads as
 * still running. */
export function trackProbe(key: string): { onProgress: (progress: ProbeProgress) => void; done: () => void } {
  const run: Run = { startedAt: new Date().toISOString(), finishedAt: null, current: null, steps: [] };
  runs.set(key, run);
  for (const [other, stale] of runs) {
    if (stale.finishedAt && Date.now() - Date.parse(stale.finishedAt) > KEEP_MS) runs.delete(other);
  }
  return {
    onProgress: (progress) => { run.current = progress.current; run.steps = progress.steps; },
    done: () => { if (!run.finishedAt) { run.finishedAt = new Date().toISOString(); run.current = null; } },
  };
}

export function probeProgress(key: string): ProbeProgressView {
  const run = runs.get(key);
  if (!run) return { running: false, startedAt: null, finishedAt: null, current: null, steps: [] };
  return { running: !run.finishedAt, startedAt: run.startedAt, finishedAt: run.finishedAt, current: run.current, steps: run.steps };
}
