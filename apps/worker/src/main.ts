// Josi CE background worker.
//
// Phase 5 gives it the task queue and the scheduler. It exists now because the
// compose stack needs a second process to prove restart policy, health
// checking and least-privilege networking against — and because adding it later
// would mean revisiting all three.
import { connectFromEnv, loadMasterKey, resolveDataPath } from '@josi-ce/core';
import { cleanupAttachments, probeAttachmentStorage, nativeScanner } from '@josi-ce/storage';
import { processQueue } from './jobs.js';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const HEARTBEAT_FILE = process.env.JOSI_WORKER_HEARTBEAT_FILE ?? join(tmpdir(), 'worker-alive');
const TICK_MS = 30_000;
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

let lastCleanup = 0;
let lastAntivirusProbe = 0;
let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
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
  const storage = await probeAttachmentStorage();
  if (!storage.ok) { console.error(`josi-ce worker: ${storage.code}: ${storage.message}`); return; }
  if (Date.now() - lastCleanup > 3600000) {
    await cleanupAttachments(db); lastCleanup = Date.now();
  }
  const outcome = await processQueue(db, WORKER_ID, 5, { masterKey, pushFetch: fetch, scanner });
  if (outcome.claimed) {
    console.log(`josi-ce worker: ${outcome.done} done, ${outcome.failed} failed`);
  }
  heartbeat();
  } finally { ticking = false; }
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
  scanner?.close();
  await close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
