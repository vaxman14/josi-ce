'use strict';
const net = require('node:net');
const { lstat, realpath } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { parseDeviceConsentMessage, deviceConsentMessage } = require('@josi-ce/protocol');
const directory = '/Library/Application Support/Josi CE Server/control';
const refused = () => new Error('Open this enrollment in the installed Josi app on the server Mac.');
const sameIdentity = (a, b) => a && b && ['serverOrigin', 'serverId', 'userId', 'deviceId'].every(k => a[k] === b[k]);

/** Main process only. A missing local request means the server is elsewhere;
 * it is not permission to approve through HTTP or a renderer callback. */
async function openLocalDeviceConsent(expected, signal) {
  if (process.platform !== 'darwin' || signal.aborted || !expected || !/^[a-f0-9-]{36}$/.test(expected.id)
    || !/^[a-f0-9]{64}$/.test(expected.challengeDigest)) throw refused();
  const socketPath = `${directory}/${expected.id}.sock`;
  let folder, file;
  try { folder = await lstat(directory); file = await lstat(socketPath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw refused(); }
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid === 0 || folder.mode & 0o022
    || !file.isSocket() || file.uid !== folder.uid || await realpath(directory) !== directory) throw refused();
  for (const path of ['/Library', '/Library/Application Support', '/Library/Application Support/Josi CE Server']) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022) throw refused();
  }
  const socket = net.createConnection({ path: socketPath });
  let buffer = Buffer.alloc(0), stopped = false, decision = false, challenge = null;
  let previousWall = Date.now(), previousMono = performance.now();
  const deadline = previousMono + expected.expiresAtMs - previousWall;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(close, Math.max(1, expected.expiresAtMs - Date.now())); timer.unref();
  const readyTimer = setTimeout(close, 10_000); readyTimer.unref();
  function close() {
    if (stopped) return;
    stopped = true; clearTimeout(timer); clearTimeout(readyTimer);
    signal.removeEventListener('abort', close); socket.destroy();
    buffer.fill(0); buffer = Buffer.alloc(0); rejectReady(refused());
  }
  function current() {
    const wall = Date.now(), mono = performance.now();
    if (stopped || signal.aborted || wall < previousWall || mono < previousMono || wall >= expected.expiresAtMs || mono >= deadline) {
      close(); throw refused();
    }
    previousWall = wall; previousMono = mono;
  }
  socket.on('error', close);
  socket.on('close', () => { if (!decision) close(); });
  socket.on('data', part => {
    try {
      current();
      if (challenge || buffer.length + part.length > 128 * 1024 + 4) throw refused();
      buffer = Buffer.concat([buffer, part]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32BE(0);
      if (!size || size > 128 * 1024) throw refused();
      if (buffer.length < size + 4) return;
      if (buffer.length !== size + 4) throw refused();
      const value = JSON.parse(buffer.subarray(4).toString('utf8'));
      if (!value || Object.keys(value).sort().join(',') !== 'challengeDigest,expiresAtMs,id,message,schemaVersion'
        || value.schemaVersion !== 1 || value.id !== expected.id || value.challengeDigest !== expected.challengeDigest
        || value.expiresAtMs !== expected.expiresAtMs || typeof value.message !== 'string') throw refused();
      const bytes = Buffer.from(value.message, 'base64');
      if (bytes.toString('base64') !== value.message || bytes.length > 64 * 1024
        || createHash('sha256').update(bytes).digest('hex') !== expected.challengeDigest) throw refused();
      challenge = parseDeviceConsentMessage(bytes.toString('utf8'));
      if (!challenge || challenge.id !== expected.id || !sameIdentity(challenge, expected.identity)
        || challenge.expiresAtMs !== expected.expiresAtMs || challenge.issuedAtMs > Date.now()) throw refused();
      clearTimeout(readyTimer); buffer.fill(0); buffer = Buffer.alloc(0); resolveReady();
    } catch { close(); }
  });
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  try { await ready; current(); } catch { close(); throw refused(); }
  return Object.freeze({
    challenge: structuredClone(challenge),
    async approve(reviewed) {
      current();
      if (decision || deviceConsentMessage(reviewed) !== deviceConsentMessage(challenge)) throw refused();
      decision = true;
      const body = Buffer.from(JSON.stringify({ schemaVersion: 1, id: challenge.id,
        challengeDigest: expected.challengeDigest, decision: 'approve' }));
      const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
      await new Promise((resolve, reject) => {
        const ended = () => { signal.removeEventListener('abort', ended); reject(refused()); };
        signal.addEventListener('abort', ended, { once: true });
        socket.write(Buffer.concat([header, body]), error => {
          signal.removeEventListener('abort', ended);
          error ? reject(refused()) : resolve();
        });
        if (signal.aborted) ended();
      });
      // A successful write is not a saved enrollment. Only the API's fresh
      // status and canonical commit may establish that result.
    },
    close,
  });
}
module.exports = { openLocalDeviceConsent };
