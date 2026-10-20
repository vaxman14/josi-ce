'use strict';
const { randomUUID } = require('node:crypto');
const { readInstallProgress } = require('./install-progress.cjs');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const PRODUCT = '/Library/Application Support/Josi CE Server';
const APPLICATION = '/Applications/Josi.app';
const REQUIREMENT = '=anchor apple generic and identifier "com.heyjosi.ce.unified" and certificate leaf[subject.OU] = "LRH75YR6QW" and certificate leaf[subject.CN] = "Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)"';
const ROLES = ['database', 'web', 'worker', 'proxy', 'voice', 'voice-control'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function protectedJson(file, owner, maximum = 8192, privateFile = false) {
  // This is the existing installation receipt/bootstrap handoff, never a new
  // credential store. No token is returned through shell IPC or diagnostic text.
  for (let dir = path.dirname(file); dir !== '/'; dir = path.dirname(dir)) {
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || ![0, owner].includes(info.uid) || (info.mode & 0o022)) throw new Error('Unsafe installation folder.');
  }
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== owner || info.nlink !== 1 || info.size > maximum
      || (info.mode & (privateFile ? 0o077 : 0o022))) throw new Error('Unsafe installation record.');
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum) throw new Error('Installation record is too large.');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Josi did not return a response.');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 16384) { await reader.cancel(); throw new Error('Josi returned an oversized response.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!response.ok) throw new Error('The local server is not ready.');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

class LocalServer {
  constructor({ app, session }) {
    this.app = app; this.session = session; this.pending = null; this.failure = ''; this.installAttempt = null;
    this.health = session.fromPartition('local-health');
    this.health.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    this.health.setPermissionCheckHandler(() => false);
  }
  async packagedRuntime() {
    if (process.platform !== 'darwin' || !this.app.isPackaged
      || path.resolve(this.app.getAppPath()) !== `${APPLICATION}/Contents/Resources/app.asar`) return false;
    try {
      const archive = await fs.lstat(`${APPLICATION}/Contents/Resources/app.asar`);
      if (!archive.isFile() || archive.isSymbolicLink() || archive.mode & 0o022) return false;
      return (await fs.stat(`${APPLICATION}/Contents/Resources/runtime/python/bin/python3.11`)).isFile();
    }
    catch { return false; }
  }
  async receipt() {
    const value = await protectedJson(`${PRODUCT}/status.json`, 0);
    if (typeof value.installed !== 'boolean' || typeof value.version !== 'string'
      || !/^\d+\.\d+\.\d+-[a-z0-9.]+$/.test(value.version)) throw new Error('Invalid installation receipt.');
    if (value.installed && (!Number.isInteger(value.publicPort) || value.publicPort < 1024 || value.publicPort > 65535)) throw new Error('Invalid local server port.');
    return { installed: value.installed, version: value.version, serviceState: value.serviceState === 'stopped' ? 'stopped' : null,
      origin: value.installed ? `http://localhost:${value.publicPort}` : null };
  }
  async request(isolated, origin, route, options = {}) {
    return isolated.fetch(origin + route, { credentials: 'include', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(5000), ...options });
  }
  async status() {
    const result = { supported: process.platform === 'darwin', canManage: await this.packagedRuntime(),
      installed: false, phase: 'not-installed', origin: null, version: null, setupCompleted: null,
      operation: this.pending, error: this.failure, services: [] };
    result.installationProgress = null;
    if (this.installAttempt) {
      try { result.installationProgress = await readInstallProgress(this.installAttempt); }
      catch (error) { result.installationProgress = { available: false, waiting: error.code === 'ENOENT', entries: [], outcome: null, updatedAt: null }; }
    }
    if (!result.supported) return result;
    try { Object.assign(result, await this.receipt()); }
    catch (error) { if (error.code !== 'ENOENT') { result.phase = 'needs-attention'; result.error = 'The installation record could not be read safely. Your data is retained.'; } return result; }
    if (!result.installed) return result;
    result.phase = 'unavailable';
    try {
      const ready = await responseJson(await this.request(this.health, result.origin, '/ready'));
      if (ready.ready === true && Array.isArray(ready.blockers) && ready.blockers.length === 0) result.phase = 'ready';
      else if (ready.ready === true && ready.blockers === undefined) result.phase = 'ready';
      if (result.phase === 'ready') {
        const setup = await responseJson(await this.request(this.health, result.origin, '/api/onboarding/state'));
        if (typeof setup.completed === 'boolean') result.setupCompleted = setup.completed;
      }
    } catch { /* Show the recovery shell even if CE or its database is down. */ }
    return result;
  }
  async services() {
    if (process.platform !== 'darwin') return [];
    return Promise.all(ROLES.map(async role => {
      try {
        const { stdout } = await run('/bin/launchctl', ['print', `system/com.heyjosi.ce.${role}`],
          { timeout: 5000, maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
        const lines = stdout.split('\n').map(line => line.trim());
        return { role, state: lines.includes('state = running') ? 'running' : 'stopped' };
      } catch { return { role, state: 'unavailable' }; }
    }));
  }
  async prepareConnection(isolated, origin) {
    const receipt = await this.receipt();
    if (!receipt.installed || origin !== receipt.origin) throw new Error('The local installation changed. Open it again.');
    const state = await responseJson(await this.request(isolated, origin, '/api/onboarding/state'));
    if (state.completed === true) return '/';
    if (state.completed !== false) throw new Error('Josi could not determine its setup state.');
    let bootstrap;
    try { bootstrap = await protectedJson(`${PRODUCT}/handoff/${process.getuid()}/bootstrap.json`, process.getuid(), 4096, true); }
    catch { throw new Error('Open Josi using the Mac account that installed this server to resume setup.'); }
    if (!/^[a-f0-9]{64}$/.test(bootstrap.token) || `http://localhost:${bootstrap.port}` !== origin) throw new Error('The setup handoff does not match this installation.');
    const csrf = await responseJson(await this.request(isolated, origin, '/api/auth/csrf'));
    if (typeof csrf.csrfToken !== 'string' || !csrf.csrfToken || csrf.csrfToken.length > 256) throw new Error('Josi could not prepare setup.');
    const headers = { 'Content-Type': 'application/json', 'x-josi-csrf': csrf.csrfToken, Origin: origin };
    const launch = await responseJson(await this.request(isolated, origin, '/api/onboarding/launch', {
      method: 'POST', headers: { ...headers, 'x-josi-setup-token': bootstrap.token }, body: '{}' }));
    bootstrap = null;
    if (!/^[a-f0-9]{64}$/.test(launch.token)) throw new Error('Josi could not prepare its one-use setup session.');
    // Consume entirely in the main process. Only the HTTP-only setup cookie
    // reaches the shared in-memory session; neither token enters a URL/page.
    const consumed = await this.request(isolated, origin, '/api/onboarding/consume', {
      method: 'POST', headers, body: JSON.stringify({ token: launch.token }) });
    if (consumed.status !== 204) throw new Error('The setup session expired. Open local setup again.');
    return '/setup';
  }
  async operate(operation) {
    if (!['install', 'start', 'stop', 'restart', 'recover-latest', 'uninstall'].includes(operation)) throw new Error('Unsupported server operation.');
    if (this.pending) throw new Error('A server operation is already running.');
    if (!await this.packagedRuntime()) throw new Error('Install the unified Josi app in Applications to manage local services.');
    this.pending = operation; this.failure = '';
    this.installAttempt = operation === 'install' ? randomUUID() : null;
    try {
      const runtime = `${APPLICATION}/Contents/Resources/runtime`;
      const helper = operation === 'install' ? 'pkg-driver.py' : 'maintenance.py';
      const command = 'set -eu; /usr/bin/codesign --verify --deep --strict -R ' + quote(REQUIREMENT) + ' ' + quote(APPLICATION)
        + '; /usr/bin/env -i PATH=/usr/bin:/bin ' + quote(`${runtime}/python/bin/python3.11`)
        + ' -I -B ' + quote(`${runtime}/app/native/${helper}`) + ' ' + quote(operation)
        + (this.installAttempt ? ' ' + quote(this.installAttempt) : '');
      const script = 'do shell script "' + command.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '" with administrator privileges';
      // Do not kill a privileged transaction at an arbitrary UI timeout. Its
      // existing lifecycle has bounded steps and a durable recovery journal.
      await run('/usr/bin/osascript', ['-e', script], { maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    } catch {
      this.failure = 'The server change did not finish or authorization was cancelled. Your data is retained. Check status before trying again.';
      throw new Error(this.failure);
    } finally { this.pending = null; }
    return this.status();
  }
  async diagnostics() {
    const status = await this.status();
    return { application: 'Josi', appVersion: this.app.getVersion(), platform: process.platform,
      capturedAt: new Date().toISOString(), ...status, services: await this.services() };
  }
}
module.exports = { LocalServer };
