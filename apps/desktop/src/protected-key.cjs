'use strict';
// Main-process only. This module exposes no renderer IPC or network listener.
const { spawn, execFile } = require('node:child_process');
const { lstat, realpath } = require('node:fs/promises');
const { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const { isProtectedControlOrigin, parseProtectedControlChallenge, protectedControlMessage,
  parseProtectedHostChallenge, protectedHostMessage } = require('@josi-ce/protocol');
const execute = promisify(execFile);
const HELPER = '/Applications/Josi.app/Contents/Helpers/JosiProtectedKeyHost';
const REQUIREMENT = '=anchor apple generic and identifier "com.heyjosi.ce.protected-key" and certificate leaf[subject.OU] = "LRH75YR6QW"';
const MAX = 256 * 1024;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identityValid = value => exact(value, ['serverOrigin', 'serverId', 'userId', 'deviceId'])
  && isProtectedControlOrigin(value.serverOrigin) && [value.serverId, value.userId, value.deviceId].every(uuid);
const sameIdentity = (a, b) => a && b
  && ['serverOrigin', 'serverId', 'userId', 'deviceId'].every(key => a[key] === b[key]);
const sameReference = (a, b) => exact(a, ['recordId', 'version', 'digest', 'epoch'])
  && exact(b, ['recordId', 'version', 'digest', 'epoch'])
  && ['recordId', 'version', 'digest', 'epoch'].every(key => a[key] === b[key]);
const refused = () => new Error('Protected native signing is unavailable, cancelled or stale.');

function createNativeProtectedKeyBridge(identity) {
  if (process.platform !== 'darwin' || !identityValid(identity)) throw refused();
  const bound = Object.freeze({ ...identity });
  let child = null, starting = null, closed = false, pending = null, buffer = Buffer.alloc(0), approval = null;
  let lifeTimer = null;
  const signals = new Set();
  let previousWall = Date.now(), previousMono = performance.now();
  function lifetime(expiresAtMs) {
    const wall = Date.now(), mono = performance.now();
    if (wall < previousWall || mono < previousMono || wall >= expiresAtMs) throw refused();
    previousWall = wall; previousMono = mono;
    return { expiresAtMs, deadline: mono + expiresAtMs - wall };
  }
  function live(lease) {
    const wall = Date.now(), mono = performance.now();
    if (closed || wall < previousWall || mono < previousMono || wall >= lease.expiresAtMs || mono >= lease.deadline) throw refused();
    previousWall = wall; previousMono = mono;
  }
  function cancel() {
    if (closed) return;
    closed = true; approval = null;
    for (const signal of signals) signal.removeEventListener('abort', cancel);
    signals.clear();
    if (lifeTimer) clearTimeout(lifeTimer);
    const request = pending; pending = null;
    request?.finish(refused());
    buffer.fill(0); buffer = Buffer.alloc(0);
    const process = child; child = null;
    process?.stdin.destroy(); process?.stdout.destroy();
    // A native biometric result arriving later cannot return through this pipe.
    process?.kill('SIGKILL');
  }
  async function start() {
    if (closed) throw refused();
    if (child) return;
    if (starting) return starting;
    starting = (async () => {
      const stat = await lstat(HELPER);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o022 || await realpath(HELPER) !== HELPER) throw refused();
      await execute('/usr/bin/codesign', ['--verify', '--strict', '-R', REQUIREMENT, HELPER],
        { timeout: 30_000, maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin' } });
      if (closed) throw refused();
      child = spawn(HELPER, [], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
      lifeTimer = setTimeout(cancel, 120_000); lifeTimer.unref();
      child.once('error', cancel); child.once('exit', cancel);
      child.stdin.on('error', cancel);
      child.stdout.on('data', part => {
        if (closed || buffer.length + part.length > MAX + 4) { cancel(); return; }
        buffer = Buffer.concat([buffer, part]);
        if (buffer.length < 4) return;
        const size = buffer.readUInt32BE(0);
        if (!size || size > MAX) { cancel(); return; }
        if (buffer.length < size + 4) return;
        // One outstanding request; extra/unsolicited frames are not accepted.
        if (buffer.length !== size + 4 || !pending) { cancel(); return; }
        let value;
        try { value = JSON.parse(buffer.subarray(4).toString('utf8')); } catch { cancel(); return; }
        buffer.fill(0); buffer = Buffer.alloc(0);
        if (!exact(value, ['schemaVersion', 'id', 'result']) || value.schemaVersion !== 1
          || value.id !== pending.id || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) { cancel(); return; }
        const request = pending; pending = null; request.finish(null, value.result);
      });
    })().catch(() => { cancel(); throw refused(); });
    return starting;
  }
  async function request(operation, payload, signal) {
    if (!signal || signal.aborted || closed || pending) throw refused();
    if (!signals.has(signal)) {
      signals.add(signal); signal.addEventListener('abort', cancel, { once: true });
    }
    try {
      await start();
      if (signal.aborted || closed || pending || !child) throw refused();
      const id = randomUUID();
      const body = Buffer.from(JSON.stringify({ schemaVersion: 1, id, identity: bound, operation, ...payload }));
      if (body.length > MAX) { body.fill(0); throw refused(); }
      const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
      const frame = Buffer.concat([header, body]); body.fill(0);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(cancel, 120_000); timer.unref();
        pending = { id, finish(error, value) { clearTimeout(timer); error ? reject(error) : resolve(value); } };
        child.stdin.write(frame, error => { frame.fill(0); if (error) cancel(); });
      });
    } catch { cancel(); throw refused(); }
  }
  function material(value) {
    if (!exact(value, ['schemaVersion', 'identity', 'wrappingPublicKey', 'signingPublicKeySpki', 'wrappedPrivateKey'])
      || value.schemaVersion !== 1 || !identityValid(value.identity) || !sameIdentity(value.identity, bound)) throw refused();
    for (const [name, min, max] of [['wrappingPublicKey', 65, 65], ['signingPublicKeySpki', 44, 44], ['wrappedPrivateKey', 33, 4096]]) {
      if (typeof value[name] !== 'string' || value[name].length > Math.ceil(max / 3) * 4) throw refused();
      const decoded = Buffer.from(value[name], 'base64');
      if (decoded.length < min || decoded.length > max || decoded.toString('base64') !== value[name]) throw refused();
    }
    return { schemaVersion: 1, identity: { ...bound }, wrappingPublicKey: value.wrappingPublicKey,
      signingPublicKeySpki: value.signingPublicKeySpki, wrappedPrivateKey: value.wrappedPrivateKey };
  }
  function projection(challenge, value) {
    const parsed = parseProtectedControlChallenge(challenge), now = Date.now();
    if (!parsed || !sameIdentity(parsed, bound) || !exact(value, ['schemaVersion', 'reference', 'issuedAtMs', 'expiresAtMs', 'material'])
      || value.schemaVersion !== 1
      || !sameReference(parsed.keyReference, value.reference) || !Number.isSafeInteger(value.issuedAtMs)
      || !Number.isSafeInteger(value.expiresAtMs) || value.issuedAtMs > now || value.expiresAtMs <= now
      || value.expiresAtMs - value.issuedAtMs > 60_000 || parsed.expiresAtMs <= now) throw refused();
    return { message: Buffer.from(protectedControlMessage(parsed)).toString('base64'),
      material: material(value.material), expiresAtMs: Math.min(value.expiresAtMs, parsed.expiresAtMs) };
  }
  function signature(result) {
    if (!exact(result, ['signature']) || typeof result.signature !== 'string'
      || !/^[A-Za-z0-9_-]{86}$/.test(result.signature) || Buffer.from(result.signature, 'base64url').toString('base64url') !== result.signature) throw refused();
    return result.signature;
  }
  return Object.freeze({
    cancel,
    async proveHost(challenge, signal) {
      try {
        if (approval) throw refused();
        const parsed = parseProtectedHostChallenge(challenge);
        if (!parsed || !sameIdentity(parsed, bound) || parsed.issuedAtMs > Date.now()) throw refused();
        const lease = lifetime(parsed.expiresAtMs), message = Buffer.from(protectedHostMessage(parsed));
        const result = await request('proveHost', { message: message.toString('base64') }, signal);
        live(lease);
        if (!exact(result, ['signature']) || typeof result.signature !== 'string' || !/^[A-Za-z0-9_-]{11,96}$/.test(result.signature)) throw refused();
        const bytes = Buffer.from(result.signature, 'base64url');
        if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes.toString('base64url') !== result.signature) throw refused();
        return { schemaVersion: 1, challengeId: parsed.id,
          challengeDigest: createHash('sha256').update(message).digest('hex'), signature: result.signature };
      } catch { cancel(); throw refused(); }
    },
    async createEnrollmentMaterial(signal) {
      try {
        const result = await request('create', {}, signal);
        if (!exact(result, ['material'])) throw refused();
        return material(result.material);
      } catch { cancel(); throw refused(); }
    },
    async authenticate(challenge, value, signal) {
      try {
        if (approval) throw refused();
        const snapshot = projection(challenge, value);
        const lease = lifetime(snapshot.expiresAtMs);
        const result = await request('authenticate', { message: snapshot.message, material: snapshot.material }, signal);
        live(lease);
        if (!exact(result, ['authenticated']) || result.authenticated !== true) throw refused();
        approval = { ...snapshot, lease };
      } catch { cancel(); throw refused(); }
    },
    async sign(challenge, value, signal) {
      try {
        const snapshot = projection(challenge, value), approved = approval; approval = null;
        if (!approved || snapshot.message !== approved.message || JSON.stringify(snapshot.material) !== JSON.stringify(approved.material)
          || Date.now() >= approved.expiresAtMs) throw refused();
        live(approved.lease);
        const result = await request('sign', { message: snapshot.message, material: snapshot.material }, signal);
        live(approved.lease);
        return signature(result);
      } finally { cancel(); }
    },
    async enrollmentProof(commandDigest, value, attemptId, expiresAtMs, signal) {
      try {
        if (typeof commandDigest !== 'string' || !/^[a-f0-9]{64}$/.test(commandDigest) || !uuid(attemptId)
          || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now() || expiresAtMs - Date.now() > 120_000) throw refused();
        const payload = { commandDigest, material: material(value), attemptId, expiresAtMs };
        const lease = lifetime(expiresAtMs);
        const authenticated = await request('authenticateEnrollment', payload, signal);
        live(lease);
        if (!exact(authenticated, ['authenticated']) || authenticated.authenticated !== true) throw refused();
        const result = await request('signEnrollment', payload, signal);
        live(lease);
        return signature(result);
      } finally { cancel(); }
    },
  });
}
module.exports = { createNativeProtectedKeyBridge };
