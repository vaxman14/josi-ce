// Josi CE background worker.
//
// Phase 5 gives it the task queue and the scheduler. It exists now because the
// compose stack needs a second process to prove restart policy, health
// checking and least-privilege networking against — and because adding it later
// would mean revisiting all three.
import { connectFromEnv, loadMasterKey } from '@josi-ce/core';
import { processQueue } from './jobs.js';
import { writeFileSync } from 'node:fs';

const HEARTBEAT_FILE = '/tmp/worker-alive';
const TICK_MS = 30_000;

const { db, close, describe } = await connectFromEnv({ ...process.env }, { max: 4 });
console.log(`josi-ce worker: database ${describe}`);

try {
  loadMasterKey();
  console.log('josi-ce worker: master key loaded');
} catch (err) {
  console.error(`josi-ce worker: ${(err as Error).message}`);
  await close();
  process.exit(1);
}

let running = true;

/** The container healthcheck reads this file's mtime. A worker that is wedged
 * stops touching it and gets restarted; one that is merely idle keeps ticking. */
function heartbeat(): void {
  try {
    writeFileSync(HEARTBEAT_FILE, new Date().toISOString());
  } catch (err) {
    console.error('josi-ce worker: could not write heartbeat', (err as Error).message);
  }
}

const WORKER_ID = `worker-${process.pid}`;

async function tick(): Promise<void> {
  const outcome = await processQueue(db, WORKER_ID);
  if (outcome.claimed) {
    console.log(`josi-ce worker: ${outcome.done} done, ${outcome.failed} failed`);
  }
  heartbeat();
}

heartbeat();
await tick().catch((err) => console.error('josi-ce worker: first tick failed', err?.message));

const timer = setInterval(() => {
  if (!running) return;
  void tick().catch((err) => console.error('josi-ce worker: tick failed', err?.message));
}, TICK_MS);

async function shutdown(signal: string): Promise<void> {
  console.log(`josi-ce worker: ${signal} received, shutting down`);
  running = false;
  clearInterval(timer);
  await close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
