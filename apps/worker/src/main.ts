// Josi CE background worker.
//
// Phase 5 gives it the task queue and the scheduler. It exists now because the
// compose stack needs a second process to prove restart policy, health
// checking and least-privilege networking against — and because adding it later
// would mean revisiting all three.
import { connectFromEnv, loadMasterKey, resolveDataPath, createNativeInspectionRuntime } from '@josi-ce/core';
import { cleanupAttachments, probeAttachmentStorage, nativeScanner } from '@josi-ce/storage';
import { processQueue } from './jobs.js';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startWorkerPolling } from './polling.js';

const HEARTBEAT_FILE = process.env.JOSI_WORKER_HEARTBEAT_FILE ?? join(tmpdir(), 'worker-alive');
// Installer-owned absolute configuration; user requests never select executables.
const scanner = process.platform === 'win32' && process.env.JOSI_NATIVE_RUNTIME === '1'
  ? nativeScanner({
    python: process.env.JOSI_PYTHON_EXE ?? '', adapter: process.env.JOSI_SCANNER_ADAPTER ?? '',
    scratch: process.env.JOSI_SCANNER_TEMP ?? '',
  }) : undefined;

const { db, close, describe } = await connectFromEnv({ ...process.env }, { max: 4 });
console.log(`josi-ce worker: database ${describe}`);

let masterKey: Awaited<ReturnType<typeof loadMasterKey>> | null = null;
try {
  masterKey = loadMasterKey();
  console.log('josi-ce worker: master key loaded');
} catch (err) {
  console.error(`josi-ce worker: ${(err as Error).message}`);
  await close();
  process.exit(1);
}

const automationRuntime = masterKey ? createNativeInspectionRuntime(db, masterKey) : undefined;

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
// Windows has no signal a service stop can send a console process, so a stop
// request is a file beside the heartbeat. Seen between passes, it drains the
// pass in flight and exits; a stale one from an earlier stop is cleared here.
const STOP_FILE = resolveDataPath('/data/state/worker.stop');
try { rmSync(STOP_FILE, { force: true }); } catch { /* best effort */ }
let stopping = false;

let lastCleanup = 0;
let lastAntivirusProbe = 0;
let storageAvailable = false;
async function tick(maintenance: boolean): Promise<void> {
  if (!stopping && existsSync(STOP_FILE)) { void shutdown('stop request'); return; }
  if (stopping) return;
  if (scanner && Date.now() - lastAntivirusProbe > 5 * 60_000) {
    const result = await scanner.scanStatus(Buffer.from('Josi antivirus availability check.'));
    const status = result === 'clean' ? 'available' : result === 'unavailable' ? 'unavailable' : 'error';
    const path = resolveDataPath('/data/state/antivirus.json'), pending = `${path}.${randomUUID()}.pending`;
    const file = await open(pending, 'wx');
    try { await file.writeFile(JSON.stringify({ provider: 'windows-amsi', status, checkedAt: new Date().toISOString() })); await file.sync(); }
    finally { await file.close(); }
    await rename(pending, path);
    lastAntivirusProbe = Date.now();
    if (status !== 'available') console.warn(`josi-ce worker: Windows antivirus scanning ${status}; required file scans remain blocked.`);
  }
  if (maintenance) {
    const storage = await probeAttachmentStorage();
    storageAvailable = storage.ok;
    if (!storage.ok) console.error(`josi-ce worker: ${storage.code}: ${storage.message}`);
  }
  if (!storageAvailable) return;
  if (Date.now() - lastCleanup > 3600000) {
    await cleanupAttachments(db); lastCleanup = Date.now();
  }
  const outcome = await processQueue(db, WORKER_ID, 5, { masterKey, pushFetch: fetch, scanner, automationRuntime, maintenance });
  if (outcome.claimed) {
    console.log(`josi-ce worker: ${outcome.done} done, ${outcome.failed} failed`);
  }
  heartbeat();
}

heartbeat();
const stopPolling = startWorkerPolling(tick, error =>
  console.error('josi-ce worker: tick failed', error instanceof Error ? error.message : 'unknown error'));

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`josi-ce worker: ${signal} received, shutting down`);
  // Finish the pass in flight (bounded: a model call is capped at three
  // minutes) so a subscription login lease is written back, never stranded.
  await Promise.race([stopPolling(), new Promise<void>(resolve => setTimeout(resolve, 200_000).unref())]);
  try { rmSync(STOP_FILE, { force: true }); } catch { /* best effort */ }
  scanner?.close();
  await close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
