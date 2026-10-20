'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const DIRECTORY = '/Library/Logs/Josi CE Server';
const phases = Object.freeze({
  prepared: 'Preparing this installation', verifying: 'Verifying the application and server files',
  verified: 'Application and server files verified',
  'Copying and flushing protected files': 'Preparing server files',
  quiescing: 'Preparing to stop services for the update', 'Stopping services': 'Stopping services for the update',
  quiesced: 'Services stopped for the update',
  'Retaining subscription temporary files': 'Retaining existing model connection files',
  snapshot: 'Safety copy prepared', provisioned: 'Local server storage prepared',
  'database-ready': 'Database ready', migrating: 'Updating the database',
  migrated: 'Database update finished', activating: 'Activating the server',
  'Starting services': 'Starting services', activated: 'Server services started',
  'Checking readiness': 'Waiting for services to become ready', 'Waiting for readiness': 'Waiting for services to become ready', healthy: 'Services are ready',
  committed: 'Finishing installation',
  'Keeping existing data for upgrade': 'Keeping your existing data for the update',
  'Restoring the verified safety copy': 'Restoring the verified safety copy',
  'Retrying incomplete setup': 'Resuming incomplete setup',
  'Continuing installation': 'Continuing installation',
  'Clearing empty installation records': 'Preparing installation records',
  'Recovery required; existing data retained': 'Installation needs repair; existing data is retained',
});
const services = Object.freeze({ installer: 'Setup', database: 'Database', web: 'Josi app',
  worker: 'Background work', proxy: 'Local connection', voice: 'Speech', 'voice-control': 'Speech control',
  'web / worker / speech': 'Josi services' });
const id = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

/** Read only this main-process-created attempt. Never select the newest log,
 * accept a renderer path, return raw diagnostics, or load an unbounded file. */
async function readInstallProgress(attemptId) {
  if (!id(attemptId)) throw new Error('Invalid installation attempt.');
  for (const directory of ['/Library', '/Library/Logs', DIRECTORY]) {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022) throw new Error('Installation progress is unavailable.');
  }
  const handle = await fs.open(`${DIRECTORY}/Install-${attemptId}.jsonl`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    // The installer grants this interactive user a read-only ACL. Unix owner
    // remains root, so the app cannot manufacture a successful setup record.
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || before.mode & 0o077
      || before.size > 16 * 1024 * 1024) throw new Error('Installation progress is unavailable.');
    const start = Math.max(0, before.size - 64 * 1024), buffer = Buffer.alloc(Math.min(before.size, 64 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const after = await handle.stat();
    if (after.size < before.size || after.ino !== before.ino || after.dev !== before.dev) throw new Error('Installation progress changed.');
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    lines.pop(); // A final unterminated record may still be being written.
    const entries = [];
    let outcome = null;
    for (const line of lines) {
      if (line.length > 8192) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || typeof record.time !== 'number' || !Number.isFinite(record.time)
        || record.time <= 0 || record.time * 1000 > Date.now() + 5000) continue;
      let message = typeof record.phase === 'string' && Object.hasOwn(phases, record.phase) ? phases[record.phase] : null;
      if (record.result === 'success') { outcome = 'completed'; message = 'Installation completed'; }
      else if (record.result === 'failure') { outcome = 'failed'; message = 'Installation stopped. Your data is retained; use Repair or check the status report.'; }
      if (!message) continue;
      const service = typeof record.service === 'string' && Object.hasOwn(services, record.service) ? services[record.service] : null;
      const previous = entries.at(-1);
      if (previous?.message === message && previous?.service === service) previous.at = new Date(record.time * 1000).toISOString();
      else entries.push({ message, service, at: new Date(record.time * 1000).toISOString() });
    }
    return { available: true, outcome, entries: entries.slice(-6), updatedAt: entries.at(-1)?.at ?? null };
  } finally { await handle.close(); }
}
module.exports = { readInstallProgress };
