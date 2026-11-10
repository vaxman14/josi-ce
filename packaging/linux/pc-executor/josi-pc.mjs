#!/usr/bin/env node
// Josi's PC executor for a Linux server: josi-pc.service.
//
// What the Josi app's executor does on Windows (apps/windows-native/src:
// BrowserBridge.cs, PcAuthority.cs, DesktopExecutor.cs, PcWork.cs,
// PcTerminals.cs), for a headless Debian or Ubuntu server: it runs as the
// Linux user the owner chose at install, claims PC Control requests the
// owner's permissions allow, runs them and reports the result. Commands,
// persistent terminals, files and programs always work; windows, screenshots,
// clicks and keys work when that user has an X11 desktop session.
//
// Pairing: a headless server has no sign-in window, so this service writes
// its public key to the spool (JOSI_PC_SPOOL) and the owner pairs it from
// chat or the PC Control page with their password; the server answers with a
// ticket holding an owner session (packages/core/src/pcLocalExecutors.ts).
// Every executor request is then signed with the key, exactly like Windows.
//
//   josi-pc.mjs            run the service (systemd)
//   josi-pc.mjs status     print whether it is paired, paused and connected
//   josi-pc.mjs pause      stop taking work until resume
//   josi-pc.mjs resume
//   josi-pc.mjs unpair     forget the session and the key
//
// No dependencies: Node's standard library, the system shells, python3 for the
// terminal's pseudo-terminal, and (optional) xdotool, wmctrl, ImageMagick.
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { hostname, userInfo, homedir, cpus, arch, release } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import { createBrowserBridge } from './browser.mjs';
import { createLiveSessions } from './live.mjs';
import { createTransferReceiver } from './receive.mjs';

const API = (process.env.JOSI_PC_API || 'http://127.0.0.1:18080').replace(/\/+$/, '');
const SPOOL = process.env.JOSI_PC_SPOOL || '/var/lib/josi/data/pc-spool';
const STATE = process.env.JOSI_PC_STATE || join(homedir(), '.local/state/josi-pc');
const ME = userInfo();
const HOME = ME.homedir || homedir();
const SHELLS = { bash: '/bin/bash', sh: '/bin/sh', zsh: '/bin/zsh' };
const PROTECTED = [STATE, SPOOL, '/var/lib/josi', '/etc/josi', '/usr/lib/josi'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

class Refusal extends Error { constructor(code, extra = {}) { super(code); this.code = code; this.extra = extra; } }
const refuse = (code, extra) => { throw new Refusal(code, extra); };

// ---------------------------------------------------------------- state files

function writePrivate(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
const IDENTITY = join(STATE, 'identity.json'), SESSION = join(STATE, 'session.json'), PAUSE = join(STATE, 'pause.json');

/** One P-256 key and one PC id per installation, kept 0600 in the state folder. */
function identity() {
  const known = readJson(IDENTITY);
  if (known && /^linux-[a-f0-9]{32}$/.test(known.pcId) && known.privateKey) {
    const privateKey = createPrivateKey(known.privateKey);
    return { pcId: known.pcId, privateKey, publicKey: rawPublicKey(createPublicKey(privateKey)) };
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pcId = 'linux-' + randomUUID().replace(/-/g, '');
  writePrivate(IDENTITY, JSON.stringify({ pcId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  return { pcId, privateKey, publicKey: rawPublicKey(createPublicKey(privateKey)) };
}
/** Base64 of the 65-byte uncompressed point, as pcExecutorIdentity.ts expects. */
function rawPublicKey(key) {
  const jwk = key.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
}

function writeHello(me) {
  try {
    mkdirSync(SPOOL, { recursive: true });
    const path = join(SPOOL, me.pcId + '.hello.json');
    const body = JSON.stringify({ pcId: me.pcId, publicKey: me.publicKey, user: ME.username, host: hostname().slice(0, 100), createdAt: new Date().toISOString() });
    const old = readJson(path);
    if (old && old.publicKey === me.publicKey && old.user === ME.username) return true;
    const temporary = join(SPOOL, `.${me.pcId}.${process.pid}.hello.tmp`);
    writeFileSync(temporary, body, { mode: 0o640 });
    renameSync(temporary, path);
    return true;
  } catch (error) { log('cannot write the pairing hello in', SPOOL, String(error?.message ?? error)); return false; }
}

/** The ticket the server leaves after the owner paired this PC. */
function takeTicket(me) {
  const path = join(SPOOL, me.pcId + '.ticket.json');
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  let text = '';
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 4096) return null;
    const buffer = Buffer.alloc(stat.size); readSync(fd, buffer, 0, stat.size, 0); text = buffer.toString('utf8');
  } finally { closeSync(fd); }
  try { unlinkSync(path); } catch { /* the server cleans up */ }
  const ticket = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (!ticket || ticket.pcId !== me.pcId || ticket.publicKey !== me.publicKey || typeof ticket.sessionToken !== 'string' || !/^[0-9a-f-]{36}$/.test(ticket.ownerId)) return null;
  const session = { ownerId: ticket.ownerId, token: ticket.sessionToken, pairedAt: new Date().toISOString() };
  writePrivate(SESSION, JSON.stringify(session));
  log('paired with the owner account');
  return session;
}

const paused = () => { const p = readJson(PAUSE); return p ? p.paused !== false : false; };

// ---------------------------------------------------------------------- HTTP

let me, session, bridge = null, live = null, receiver = null;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function request(method, path, body, { signed = false, timeout = 15000 } = {}) {
  const url = '/api/admin/pc-control' + path;
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers = { accept: 'application/json', 'x-josi-client': 'native', authorization: 'Bearer ' + session.token, 'x-josi-pc': me.pcId };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (signed) {
    const time = Date.now(), nonce = randomUUID();
    const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
    const message = 'pc-executor.1\n' + JSON.stringify([session.ownerId, me.pcId, method, url, time, nonce, digest]);
    headers['x-josi-pc-time'] = String(time); headers['x-josi-pc-nonce'] = nonce;
    headers['x-josi-pc-proof'] = sign('sha256', Buffer.from(message, 'utf8'), me.privateKey).toString('base64');
  }
  const response = await fetch(API + url, { method, headers, body: body === undefined ? undefined : raw, signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!response.ok) throw new HttpError(response.status, data?.error ?? text.slice(0, 200));
  return data;
}

// ---------------------------------------------------------- paths and scopes

const cleanAbsolute = value => typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && value.length <= 500
  ? (value.length > 1 ? posix.normalize(value).replace(/\/+$/, '') : '/') : null;
const within = (folder, root) => folder === root || folder.startsWith((root === '/' ? '' : root) + '/');
const scopeOf = (claim, kinds) => (claim.requirements || []).find(r => kinds.includes(r.scope?.kind))?.scope ?? null;
// Josi's own Chrome (josi-browser.service) lives in the state folder; its
// program may be worked on like any other, its profile and keys may not.
const OWN_BROWSER = join(STATE, 'browser');
const ownBrowserProgram = path => /^chrome-[0-9.]+$/.test(path.slice(OWN_BROWSER.length + 1).split('/')[0] ?? '') && within(path, OWN_BROWSER);
function isProtected(path, { program = false } = {}) {
  let real = path; try { real = realpathSync(path); } catch { /* missing */ }
  if (program && ownBrowserProgram(real)) return false;
  return PROTECTED.some(root => within(path, root) || within(real, root));
}
/** A folder that is exactly what it says: no symbolic link anywhere on the way. */
function exactFolder(folder, missingCode = 'folder_missing') {
  let stat; try { stat = lstatSync(folder); } catch { refuse(missingCode); }
  if (stat.isSymbolicLink()) refuse('folder_is_link');
  if (!stat.isDirectory()) refuse(missingCode);
  let real; try { real = realpathSync(folder); } catch { refuse(missingCode); }
  if (real !== folder) refuse('folder_is_link');
  if (isProtected(folder)) refuse('protected_surface');
}

// ------------------------------------------------------------ the environment

const pathDirs = () => ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', join(HOME, '.local/bin'), join(HOME, 'bin'), '/snap/bin'];
function which(name) {
  for (const dir of pathDirs()) { const file = join(dir, name); try { if (statSync(file).isFile()) return file; } catch { /* next */ } }
  return null;
}
function xdgFolders() {
  const folders = { desktop: join(HOME, 'Desktop'), documents: join(HOME, 'Documents'), downloads: join(HOME, 'Downloads'), pictures: join(HOME, 'Pictures') };
  try {
    for (const line of readFileSync(join(HOME, '.config/user-dirs.dirs'), 'utf8').split('\n')) {
      const m = /^XDG_(DESKTOP|DOCUMENTS|DOWNLOAD|PICTURES)_DIR="(.*)"$/.exec(line.trim()); if (!m) continue;
      const key = { DESKTOP: 'desktop', DOCUMENTS: 'documents', DOWNLOAD: 'downloads', PICTURES: 'pictures' }[m[1]];
      folders[key] = m[2].replace(/^\$HOME/, HOME);
    }
  } catch { /* defaults */ }
  return Object.fromEntries(Object.entries(folders).filter(([, p]) => existsSync(p)));
}
function osName() {
  try { const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(readFileSync('/etc/os-release', 'utf8')); if (m) return m[1]; } catch { /* unknown */ }
  return 'Linux';
}
function drives() {
  const out = spawnSync('/bin/df', ['-P', '-B1', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay'], { encoding: 'utf8', timeout: 5000 });
  return (out.stdout || '').split('\n').slice(1).filter(Boolean).map(line => line.trim().split(/\s+/)).filter(p => p.length >= 6)
    .map(p => ({ name: p.slice(5).join(' '), label: p[0], type: 'fixed', totalBytes: Number(p[1]), freeBytes: Number(p[3]) })).slice(0, 20);
}
const TOOLS = ['git', 'node', 'npm', 'npx', 'python3', 'pip3', 'java', 'gradle', 'gh', 'code', 'docker', 'podman', 'cargo', 'go', 'rustc', 'make', 'gcc', 'apt', 'apt-get', 'dpkg', 'systemctl', 'journalctl', 'sudo', 'ffmpeg', 'curl', 'wget', 'tar', 'zip', 'unzip', 'rsync', 'ssh', 'xdg-open', 'xdotool', 'wmctrl', 'import'];
function environment() {
  const display = graphical();
  const shells = Object.fromEntries(Object.entries(SHELLS).filter(([, p]) => existsSync(p)));
  const tools = Object.fromEntries(TOOLS.map(t => [t, which(t)]).filter(([, p]) => p));
  const sudo = spawnSync('/usr/bin/sudo', ['-n', 'true'], { timeout: 3000, stdio: 'ignore' }).status === 0;
  return {
    kind: 'desktop_environment', user: ME.username, home: HOME, computer: hostname(), os: osName(), linux: release(),
    is64Bit: ['x64', 'arm64'].includes(arch()), processors: cpus().length,
    folders: { home: HOME, ...xdgFolders(), temp: '/tmp' }, shells, tools, drives: drives(),
    desktop: display ? { session: display.virtual ? "a hidden screen with Josi's own Chrome (josi-browser.service)" : display.kind, display: display.DISPLAY ?? display.WAYLAND_DISPLAY, screenControl: !!display.x11 && !!which('xdotool') }
      : { session: 'none', note: 'This server has no graphical session for this user: commands, terminals, files and programs work; windows and screenshots do not.' },
    administrator: sudo ? 'This user has passwordless sudo, so commands may use sudo.' : 'This user has no passwordless sudo; commands that need root cannot run.',
    josiApp: 'josi-pc.service (Linux server)', untrustedContent: true,
  };
}

// The user's graphical session, borrowed from one of their own processes.
let displayCache = { at: 0, value: null };
function graphical() {
  if (Date.now() - displayCache.at < 15000) return displayCache.value;
  let found = null;
  // Josi's own hidden screen first (josi-browser.mjs), while its X server runs.
  const own = readJson(join(STATE, 'display.json'));
  if (own?.DISPLAY && Number.isInteger(own.pid) && existsSync('/proc/' + own.pid)) {
    displayCache = { at: Date.now(), value: { DISPLAY: own.DISPLAY, XAUTHORITY: own.XAUTHORITY, kind: 'x11', x11: true, virtual: true } };
    return displayCache.value;
  }
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (statSync('/proc/' + pid).uid !== ME.uid) continue;
        const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
        if (!env.DISPLAY && !env.WAYLAND_DISPLAY) continue;
        found = { DISPLAY: env.DISPLAY, XAUTHORITY: env.XAUTHORITY, WAYLAND_DISPLAY: env.WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
          XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR, kind: env.WAYLAND_DISPLAY ? 'wayland' : 'x11', x11: !!env.DISPLAY };
        if (found.DISPLAY) break;
      } catch { /* not ours or gone */ }
    }
  } catch { /* no /proc */ }
  displayCache = { at: Date.now(), value: found };
  return found;
}
function userEnv(extra = {}) {
  const display = graphical();
  const env = {
    HOME, USER: ME.username, LOGNAME: ME.username, SHELL: ME.shell || '/bin/bash', LANG: process.env.LANG || 'C.UTF-8',
    PATH: pathDirs().join(':'), JOSI_PC_CONTROL: '1',
  };
  if (display) for (const k of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) if (display[k]) env[k] = display[k];
  return { ...env, ...extra };
}

// ------------------------------------------------------------------ commands

const keepEnds = (text, head, tail) => text.length <= head + tail ? text : text.slice(0, head) + `\n[... ${text.length - head - tail} characters omitted ...]\n\n` + text.slice(-tail);
function killGroup(child) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }

function command(payload, claim, signal) {
  const scope = scopeOf(claim, ['command']); if (!scope) refuse('scope_mismatch');
  const shell = SHELLS[payload.shell];
  if (!shell || shell !== scope.application || !existsSync(shell)) refuse('shell_unknown');
  const cwd = cleanAbsolute(payload.cwd), root = cleanAbsolute(scope.target);
  if (!cwd || !root || !within(cwd, root)) refuse('folder_outside_scope');
  try { if (!statSync(cwd).isDirectory()) refuse('folder_missing'); } catch (e) { if (e instanceof Refusal) throw e; refuse('folder_missing'); }
  const text = String(payload.command ?? ''); if (!text.trim()) refuse('empty_command');
  const seconds = Math.min(600, Math.max(5, Number(payload.timeoutSeconds) || 120));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(shell, ['-c', text], { cwd, env: userEnv({ TERM: 'dumb', NO_COLOR: '1', CI: '1' }), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', truncated = false, timedOut = false, settled = false;
    const cap = 4 * 1024 * 1024;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { if (stdout.length < cap) stdout += d; else truncated = true; });
    child.stderr.on('data', d => { if (stderr.length < cap) stderr += d; else truncated = true; });
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, seconds * 1000);
    const cancel = () => { killGroup(child); };
    signal.addEventListener('abort', cancel, { once: true });
    child.on('error', error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      killGroup(child);
      if (signal.aborted) return reject(new Refusal(signal.reason === 'paused' ? 'paused' : 'execution_lease_lost'));
      if (stdout.length > 40960 + 24576) truncated = true;
      if (stderr.length > 16384) truncated = true;
      resolve({ kind: 'desktop_command', shell: payload.shell, cwd, exitCode: timedOut ? -1 : code ?? -1, timedOut, durationMs: Date.now() - started,
        stdout: keepEnds(stdout, 40960, 24576), stderr: stderr.slice(0, 16384), truncated, untrustedContent: true });
    });
  });
}

// --------------------------------------------------------------------- files

function folder(payload, claim) {
  const scope = scopeOf(claim, ['folder']); const target = cleanAbsolute(payload.folder);
  if (!scope || !target || target !== cleanAbsolute(scope.target)) refuse('folder_outside_scope');
  exactFolder(target);
  const names = readdirSync(target); const entries = [];
  for (const name of names.slice(0, 500)) {
    try {
      const s = lstatSync(join(target, name));
      const link = s.isSymbolicLink();
      let kind = s.isDirectory() ? 'folder' : 'file';
      if (link) { try { kind = statSync(join(target, name)).isDirectory() ? 'folder' : 'file'; } catch { /* dangling */ } }
      entries.push({ name, kind, modified: s.mtime.toISOString(), ...(kind === 'file' && !link ? { bytes: s.size } : {}), ...(name.startsWith('.') ? { hidden: true } : {}), ...(link ? { link: true } : {}) });
    } catch { /* vanished */ }
  }
  return { kind: 'desktop_folder', folder: target, entries, partial: names.length > 500, untrustedContent: true };
}

function fileTarget(payload, claim) {
  const scope = scopeOf(claim, ['folder']); const file = cleanAbsolute(payload.path);
  if (!scope || !file || file === '/') refuse('file_outside_scope');
  const parent = dirname(file);
  if (parent !== cleanAbsolute(scope.target)) refuse('file_outside_scope');
  if (isProtected(file)) refuse('protected_surface');
  return { file, parent };
}
function readfile(payload, claim) {
  const { file, parent } = fileTarget(payload, claim);
  exactFolder(parent);
  let s; try { s = lstatSync(file); } catch { refuse('file_missing'); }
  if (s.isSymbolicLink()) refuse('file_is_link');
  if (!s.isFile()) refuse('file_unreadable');
  if (s.nlink > 1) refuse('file_is_link');
  let fd; try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { refuse('file_unreadable'); }
  try {
    const limit = 200 * 1024, size = fstatSync(fd).size, want = Math.min(size, limit);
    const buffer = Buffer.alloc(want); let read = 0;
    while (read < want) { const n = readSync(fd, buffer, read, want - read, read); if (n <= 0) break; read += n; }
    const bytes = buffer.subarray(0, read);
    if (bytes.subarray(0, 8192).includes(0)) return { kind: 'desktop_file', path: file, bytes: size, binary: true, text: '', note: 'This is not a text file.', untrustedContent: true };
    let text = bytes.toString('utf8'), truncated = size > read;
    if (text.length > 65536) { text = text.slice(0, 65536); truncated = true; }
    return { kind: 'desktop_file', path: file, bytes: size, text, truncated, sha256: truncated ? null : createHash('sha256').update(bytes).digest('hex'), untrustedContent: true };
  } finally { closeSync(fd); }
}
function writefile(payload, claim) {
  const { file, parent } = fileTarget(payload, claim);
  const content = String(payload.content ?? ''); if (content.length > 200000) refuse('too_large');
  if (!existsSync(parent)) {
    if (!existsSync(dirname(parent))) refuse('folder_missing');
    exactFolder(dirname(parent)); mkdirSync(parent, { mode: 0o755 });
  }
  exactFolder(parent);
  let existed = false;
  try { const s = lstatSync(file); existed = true; if (s.isSymbolicLink()) refuse('file_is_link'); if (!s.isFile() || s.nlink > 1) refuse('file_is_link'); } catch (e) { if (e instanceof Refusal) throw e; }
  if (payload.expectedSha256) {
    if (!existed) refuse('file_changed_read_again');
    const now = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (now !== payload.expectedSha256) refuse('file_changed_read_again');
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (payload.append ? constants.O_APPEND : constants.O_TRUNC);
  const fd = openSync(file, flags, 0o644);
  try { writeSync(fd, Buffer.from(content, 'utf8')); } finally { closeSync(fd); }
  return { kind: 'desktop_file_written', path: file, bytes: statSync(file).size, appended: !!payload.append, created: !existed };
}

// ------------------------------------------------------------------ programs

const DESKTOP_DIRS = () => ['/usr/share/applications', '/usr/local/share/applications', join(HOME, '.local/share/applications'), '/var/lib/flatpak/exports/share/applications', join(HOME, '.local/share/flatpak/exports/share/applications'), '/var/lib/snapd/desktop/applications'];
function desktopEntry(path) {
  try {
    const text = readFileSync(path, 'utf8'); const section = text.split(/^\[/m).find(s => s.startsWith('Desktop Entry]')) ?? '';
    const get = key => (new RegExp('^' + key + '=(.*)$', 'm').exec(section) ?? [])[1]?.trim();
    if (get('Type') && get('Type') !== 'Application') return null;
    return { name: get('Name') ?? basename(path, '.desktop'), exec: get('Exec') ?? '', hidden: get('NoDisplay') === 'true' || get('Hidden') === 'true', terminal: get('Terminal') === 'true' };
  } catch { return null; }
}
function apps(payload) {
  const query = String(payload.query ?? '').trim().toLowerCase(); if (!query) refuse('empty_query');
  const words = query.split(/\s+/); const found = []; const seen = new Set();
  for (const dir of DESKTOP_DIRS()) {
    let names = []; try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.desktop')) continue;
      const entry = desktopEntry(join(dir, name)); if (!entry || entry.hidden) continue;
      const hay = (entry.name + ' ' + name).toLowerCase();
      if (!words.every(w => hay.includes(w)) || seen.has(entry.name)) continue;
      seen.add(entry.name); found.push({ name: entry.name, application: join(dir, name), source: 'applications menu' });
    }
  }
  for (const dir of pathDirs()) {
    let names = []; try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!words.every(w => name.toLowerCase().includes(w)) || seen.has(name)) continue;
      try { const s = statSync(join(dir, name)); if (!s.isFile() || !(s.mode & 0o111)) continue; } catch { continue; }
      seen.add(name); found.push({ name, application: join(dir, name), source: 'PATH' });
    }
  }
  return { kind: 'desktop_apps', query, apps: found.slice(0, 30), untrustedContent: true };
}
/** Splits a command line like a shell would, without running a shell. */
function splitArgs(text) {
  const out = []; let cur = '', quote = null, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; any = true; continue; }
    if (c === '\\' && i + 1 < text.length) { cur += text[++i]; any = true; continue; }
    if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}
async function launch(payload, claim) {
  const scope = scopeOf(claim, ['application']); const application = cleanAbsolute(payload.application);
  if (!scope || !application || application !== cleanAbsolute(scope.target)) refuse('application_missing');
  if (!existsSync(application)) refuse('application_missing');
  if (isProtected(application, { program: true }) || application === process.execPath) refuse('protected_surface');
  const extra = payload.arguments ? splitArgs(String(payload.arguments)) : [];
  let file = application, args = extra;
  if (application.endsWith('.desktop')) {
    const entry = desktopEntry(application); if (!entry?.exec) refuse('application_not_launchable');
    const parts = splitArgs(entry.exec).filter(p => !/^%[a-zA-Z]$/.test(p)).map(p => p.replace(/%[fFuUick]/g, ''));
    if (!parts.length) refuse('application_not_launchable');
    file = parts[0].startsWith('/') ? parts[0] : which(parts[0]) ?? refuse('application_not_launchable');
    args = [...parts.slice(1), ...extra];
  } else {
    try { const s = statSync(application); if (!s.isFile() || !(s.mode & 0o111)) refuse('application_not_launchable'); } catch (e) { if (e instanceof Refusal) throw e; refuse('application_missing'); }
  }
  const before = new Set(listWindowIds());
  let child;
  try { child = spawn(file, args, { cwd: HOME, env: userEnv(), detached: true, stdio: 'ignore' }); } catch { refuse('application_not_launchable'); }
  let failed = null; child.on('error', e => { failed = e; });
  child.unref();
  await sleep(1500);
  if (failed) refuse('application_not_launchable', { detail: String(failed.code ?? failed.message) });
  const windows = windowsList().filter(w => !before.has(w.windowId)).slice(0, 20);
  return { kind: 'desktop_launched', application, arguments: payload.arguments ?? '', processId: child.pid, windows, untrustedContent: true };
}

// ---------------------------------------------------- screen (X11 desktops)

function x(tool, args, input) {
  const display = graphical();
  if (!display?.x11) refuse('control_surface_unavailable', { detail: 'This server has no X11 desktop session for ' + ME.username + '.' });
  const path = which(tool); if (!path) refuse('control_surface_unavailable', { detail: tool + ' is not installed on this server.' });
  const out = spawnSync(path, args, { env: userEnv(), encoding: input === 'buffer' ? 'buffer' : 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
  if (out.status !== 0) return null;
  return out.stdout;
}
function listWindowIds() {
  const display = graphical(); if (!display?.x11 || !which('xdotool')) return [];
  const out = x('xdotool', ['search', '--onlyvisible', '--name', '']); return out ? out.split('\n').filter(id => /^\d{1,20}$/.test(id)) : [];
}
function windowInfo(id) {
  const name = x('xdotool', ['getwindowname', id]); if (name === null) return null;
  const pid = Number((x('xdotool', ['getwindowpid', id]) ?? '').trim());
  let application = null; if (pid > 0) { try { application = realpathSync(`/proc/${pid}/exe`); } catch { /* not ours */ } }
  const geometry = x('xdotool', ['getwindowgeometry', '--shell', id]) ?? '';
  const g = Object.fromEntries(geometry.split('\n').filter(l => l.includes('=')).map(l => l.split('=')));
  return { windowId: id, title: name.trim().slice(0, 300), application, processId: pid || null, x: Number(g.X), y: Number(g.Y), width: Number(g.WIDTH), height: Number(g.HEIGHT) };
}
function windowsList() {
  return listWindowIds().map(windowInfo).filter(w => w && w.application && w.width > 1 && w.height > 1 && w.processId !== process.pid).slice(0, 200)
    .map(({ windowId, title, application, processId }) => ({ windowId, title, application, processId }));
}
function windows() {
  if (!graphical()?.x11) refuse('control_surface_unavailable', { detail: 'This server has no X11 desktop session for ' + ME.username + '.' });
  return { kind: 'desktop_windows', windows: windowsList(), untrustedContent: true };
}
const observations = new Map();
function remember(id, info, extra) {
  for (const [key, value] of observations) if (Date.now() - value.at > 60000) observations.delete(key);
  while (observations.size >= 32) observations.delete(observations.keys().next().value);
  observations.set(id, { at: Date.now(), info, ...extra });
}
function checkedWindow(payload, claim) {
  const scope = scopeOf(claim, ['application']);
  const info = windowInfo(String(payload.windowId ?? '')); if (!info) refuse('window_gone');
  if (!info.application || !scope || info.application !== scope.target) refuse('application_changed');
  if (isProtected(info.application, { program: true }) || info.processId === process.pid) refuse('protected_surface');
  return info;
}
function observation(id, info, action) {
  remember(id, info, {});
  return { kind: 'desktop_observation', observationId: id, windowId: info.windowId, title: info.title, application: info.application, text: info.title,
    elements: [], partial: true, note: 'Linux windows do not expose their controls here: take a desktop_screenshot and use desktop_click_point, desktop_type and desktop_keys.',
    untrustedContent: true, ...(action ? { action } : {}) };
}
function read(payload, claim) { return observation(claim.id, checkedWindow(payload, claim)); }
function screenshot(payload, claim) {
  const info = checkedWindow(payload, claim);
  if (!which('import')) refuse('control_surface_unavailable', { detail: 'ImageMagick (import) is not installed on this server.' });
  let data = null, size = 1280, quality = 70, image = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    image = x('import', ['-window', info.windowId, '-resize', `${size}x${size}>`, '-quality', String(quality), 'jpeg:-'], 'buffer');
    if (!image?.length) refuse('window_gone');
    data = image.toString('base64'); if (data.length <= 131072) break;
    size = Math.round(size * 0.8); quality = Math.max(40, quality - 10);
  }
  if (data.length > 131072) refuse('desktop_action_failed', { detail: 'screenshot too large' });
  const dims = jpegSize(image) ?? { width: info.width, height: info.height };
  const scale = dims.width / info.width;
  remember(claim.id, info, { screenshot: { width: dims.width, height: dims.height, originX: info.x, originY: info.y, scale } });
  return { kind: 'desktop_screenshot', observationId: claim.id, windowId: info.windowId, title: info.title, application: info.application,
    width: dims.width, height: dims.height, originX: info.x, originY: info.y, scale, untrustedContent: true,
    shown: 'The picture is attached as an image.', __images: [{ data, mimeType: 'image/jpeg' }] };
}
function jpegSize(buffer) {
  for (let i = 2; i + 9 < buffer.length;) {
    if (buffer[i] !== 0xff) return null;
    const marker = buffer[i + 1], length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}
function useObservation(payload, claim) {
  const known = observations.get(String(payload.observationId ?? ''));
  if (!known || Date.now() - known.at > 60000) refuse('observation_stale_read_again');
  observations.delete(String(payload.observationId));
  const info = checkedWindow(payload, claim);
  if (info.windowId !== known.info.windowId || info.application !== known.info.application) refuse('observation_changed');
  if (info.x !== known.info.x || info.y !== known.info.y || info.width !== known.info.width || info.height !== known.info.height) refuse('window_moved');
  return { info, known };
}
const KEY_NAMES = { enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'BackSpace', delete: 'Delete', del: 'Delete',
  space: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', insert: 'Insert',
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', cmd: 'super', win: 'super', super: 'super', meta: 'super' };
const xKeys = keys => keys.split('+').map(k => KEY_NAMES[k] ?? (/^f\d{1,2}$/.test(k) ? k.toUpperCase() : k)).join('+');
function act(payload, claim, kind) {
  const { info, known } = useObservation(payload, claim);
  const id = info.windowId;
  x('xdotool', ['windowactivate', '--sync', id]);
  let method = 'xdotool';
  if (kind === 'desktop.click') refuse('element_unknown');
  else if (kind === 'desktop.type') {
    if (payload.elementId) refuse('element_unknown');
    if (x('xdotool', ['type', '--window', id, '--delay', '12', '--', String(payload.text ?? '')]) === null) refuse('desktop_action_failed');
  } else if (kind === 'desktop.keys') {
    if (x('xdotool', ['key', '--window', id, '--clearmodifiers', xKeys(String(payload.keys))]) === null) refuse('desktop_action_failed');
  } else if (kind === 'desktop.scroll') {
    const amount = Number(payload.amount); const button = payload.horizontal ? (amount > 0 ? '7' : '6') : (amount > 0 ? '4' : '5');
    x('xdotool', ['mousemove', '--window', id, String(Math.round(info.width / 2)), String(Math.round(info.height / 2))]);
    x('xdotool', ['click', '--repeat', String(Math.abs(amount)), button]);
  } else if (kind === 'desktop.clickpoint' || kind === 'desktop.drag') {
    const shot = known.screenshot; if (!shot) refuse('choose_target_window');
    const toScreen = (px, py) => [Math.round(shot.originX + px / shot.scale), Math.round(shot.originY + py / shot.scale)];
    const [sx, sy] = toScreen(Number(payload.x), Number(payload.y));
    if (sx < info.x || sy < info.y || sx >= info.x + info.width || sy >= info.y + info.height) refuse('point_outside');
    if (kind === 'desktop.clickpoint') x('xdotool', ['mousemove', String(sx), String(sy), 'click', '1']);
    else { const [ex, ey] = toScreen(Number(payload.endX), Number(payload.endY)); x('xdotool', ['mousemove', String(sx), String(sy), 'mousedown', '1', 'mousemove', '--sync', String(ex), String(ey), 'mouseup', '1']); }
  } else if (kind === 'desktop.close') {
    if (which('wmctrl')) { x('wmctrl', ['-ic', id]); method = 'wmctrl'; } else x('xdotool', ['key', '--window', id, 'alt+F4']);
    spawnSync('/bin/sleep', ['0.8']);
    return { kind: 'desktop_closed', windowId: id, stillOpen: listWindowIds().includes(id) };
  }
  spawnSync('/bin/sleep', ['0.4']);
  const after = windowInfo(id); if (!after) refuse('window_gone');
  return observation(claim.id, after, { action: kind.slice('desktop.'.length), method });
}

// ----------------------------------------------------------------- terminals

// A pseudo-terminal from Python's standard library: 120 by 36, the child in its
// own session, and the child's exit code as ours.
const PTY_HELPER = `
import os, pty, sys, fcntl, termios, struct, select, signal
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
signal.signal(signal.SIGTERM, lambda *a: (os.kill(pid, signal.SIGHUP), sys.exit(143)))
inp = sys.stdin.fileno()
while True:
    try: r, _, _ = select.select([fd, inp], [], [])
    except InterruptedError: continue
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: data = b''
        if not data: break
        os.write(1, data)
    if inp in r:
        data = os.read(inp, 65536)
        if not data: os.kill(pid, signal.SIGHUP); inp = -1
        else: os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)
`;
const RING = 262144;
const terminals = new Map();
function terminalOpen(payload, claim) {
  const scope = scopeOf(claim, ['command']); if (!scope) refuse('scope_mismatch');
  const shell = SHELLS[payload.shell]; if (!shell || shell !== scope.application || !existsSync(shell)) refuse('shell_unknown');
  const cwd = cleanAbsolute(payload.cwd), root = cleanAbsolute(scope.target);
  if (!cwd || !root || !within(cwd, root)) refuse('folder_outside_scope');
  try { if (!statSync(cwd).isDirectory()) refuse('folder_missing'); } catch (e) { if (e instanceof Refusal) throw e; refuse('folder_missing'); }
  if (terminals.size >= 8) refuse('too_many_terminals');
  const python = which('python3'); if (!python) refuse('desktop_action_failed', { detail: 'python3 is needed for terminals' });
  const seconds = Math.min(28800, Math.max(30, Number(payload.timeoutSeconds) || 1800));
  const child = spawn(python, ['-I', '-c', PTY_HELPER, shell, '-i'], { cwd, env: userEnv({ TERM: 'xterm-256color', COLUMNS: '120', LINES: '36' }), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const session = { id: claim.id, child, scope, buffer: '', start: 0, end: 0, running: true, exitCode: null, deadline: Date.now() + seconds * 1000 };
  const take = data => { session.buffer += data; session.end += data.length; if (session.buffer.length > RING) { const cut = session.buffer.length - RING; session.buffer = session.buffer.slice(cut); session.start += cut; } };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', take); child.stderr.on('data', take);
  child.on('close', code => { session.running = false; session.exitCode = code; });
  child.on('error', () => { session.running = false; });
  terminals.set(claim.id, session);
  watchTerminal(session);
  return terminalView(session, 0);
}
function terminalView(session, cursor) {
  const from = Math.min(Math.max(Number(cursor) || 0, session.start), session.end);
  const slice = session.buffer.slice(from - session.start, from - session.start + 48000);
  return { kind: 'desktop_terminal', sessionId: session.id, cursor: from + slice.length, output: slice, truncated: (Number(cursor) || 0) < session.start,
    hasMore: from + slice.length < session.end, running: session.running, exitCode: session.running ? null : session.exitCode, scope: session.scope, untrustedContent: true };
}
function terminalFor(payload, claim) {
  const session = terminals.get(String(payload.sessionId ?? '')); if (!session) refuse('terminal_gone');
  const scope = scopeOf(claim, ['command']);
  if (!scope || JSON.stringify(scope) !== JSON.stringify(session.scope)) refuse('scope_mismatch');
  return session;
}
function closeTerminal(session) { if (session.running) killGroup(session.child); terminals.delete(session.id); }
async function watchTerminal(session) {
  while (terminals.has(session.id)) {
    await sleep(1500);
    if (!terminals.has(session.id)) return;
    if (Date.now() > session.deadline || paused()) { closeTerminal(session); return; }
    try { const lease = await request('GET', `/executor/terminals/${session.id}/lease`, undefined, { signed: true, timeout: 3000 }); if (!lease?.authorized) { closeTerminal(session); return; } }
    catch { closeTerminal(session); return; }
  }
}
async function terminalInput(payload, claim) {
  const session = terminalFor(payload, claim);
  if (!session.running) return terminalView(session, payload.cursor);
  const text = String(payload.text ?? ''); if (!text.length || text.length > 16384) refuse('invalid_text');
  const cursor = session.end;
  session.child.stdin.write(text);
  await sleep(600);
  return terminalView(session, payload.cursor ?? cursor);
}
const terminalRead = (payload, claim) => terminalView(terminalFor(payload, claim), payload.cursor);
function terminalClose(payload, claim) { const session = terminalFor(payload, claim); const view = terminalView(session, payload.cursor); closeTerminal(session); return { ...view, running: false }; }

// ------------------------------------------------------------------ dispatch

async function run(claim, signal) {
  const payload = claim.payload ?? {};
  switch (payload.kind) {
    case 'desktop.environment': return environment();
    case 'desktop.apps': return apps(payload);
    case 'desktop.command': return command(payload, claim, signal);
    case 'desktop.admin.command': refuse('unsupported', { detail: 'Administrator commands are not available on a Linux server.' });
    case 'desktop.folder': return folder(payload, claim);
    case 'desktop.readfile': return readfile(payload, claim);
    case 'desktop.writefile': return writefile(payload, claim);
    case 'desktop.launch': return launch(payload, claim);
    case 'desktop.windows': return windows();
    case 'desktop.read': return read(payload, claim);
    case 'desktop.screenshot': return screenshot(payload, claim);
    case 'desktop.click': case 'desktop.type': case 'desktop.keys': case 'desktop.scroll': case 'desktop.clickpoint': case 'desktop.drag': case 'desktop.close':
      return act(payload, claim, payload.kind);
    case 'desktop.terminal.open': return terminalOpen(payload, claim);
    case 'desktop.terminal.input': return terminalInput(payload, claim);
    case 'desktop.terminal.read': return terminalRead(payload, claim);
    case 'desktop.terminal.close': return terminalClose(payload, claim);
    default:
      // Browser kinds go to the Josi browser extension through browser.mjs.
      if (bridge?.handles(payload.kind)) {
        try { return await bridge.run(claim, signal); }
        catch (e) { if (e?.browserRefusal) refuse(e.code, e.extra); throw e; }
      }
      refuse('unsupported_operation');
  }
}

/** One request under its lease: work stops the moment the owner stops,
 * revokes or changes a permission, exactly as on Windows. */
async function execute(claim) {
  const controller = new AbortController();
  let leaseOk = true;
  try { const lease = await request('GET', `/executor/${claim.id}/lease`, undefined, { signed: true, timeout: 3000 }); leaseOk = !!lease?.authorized; } catch { leaseOk = false; }
  if (!leaseOk) return { ok: false, result: { code: 'execution_lease_lost' } };
  let watching = true;
  const watch = (async () => {
    while (watching) {
      await sleep(1500); if (!watching) return;
      if (paused()) { bridge?.pause(); controller.abort('paused'); return; }
      try { const lease = await request('GET', `/executor/${claim.id}/lease`, undefined, { signed: true, timeout: 3000 }); if (!lease?.authorized) { bridge?.pause(); controller.abort('lease'); return; } }
      catch { bridge?.pause(); controller.abort('lease'); return; }
    }
  })();
  try {
    const result = await run(claim, controller.signal);
    if (controller.signal.aborted) return { ok: false, result: { code: controller.signal.reason === 'paused' ? 'paused' : 'execution_lease_lost' } };
    return { ok: true, result };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, result: { code: error.code, ...error.extra } };
    return { ok: false, result: { code: 'desktop_action_failed', detail: String(error?.code ?? error?.name ?? 'Error') } };
  } finally { watching = false; await watch.catch(() => {}); }
}

function fitResult(outcome) {
  let text = JSON.stringify(outcome.result);
  if (text.length <= 250000) return outcome;
  const r = { ...outcome.result };
  for (const key of ['stdout', 'stderr', 'text', 'output']) if (typeof r[key] === 'string') r[key] = r[key].slice(0, 30000);
  r.truncated = true; text = JSON.stringify(r);
  return text.length <= 250000 ? { ok: outcome.ok, result: r } : { ok: false, result: { code: 'result_too_large' } };
}

// ---------------------------------------------------------------- main loop

async function serve() {
  me = identity();
  try { bridge = createBrowserBridge({ stateDir: STATE, log, isPaused: paused, isProtected }); await bridge.start(); }
  catch (error) { log('browser bridge unavailable:', String(error?.message ?? error)); bridge = null; }
  log('Josi PC service for', ME.username, 'as', me.pcId, 'talking to', API);
  writeHello(me);
  session = readJson(SESSION);
  let registered = false, paired = false, identityAt = 0, presenceAt = 0, presenceKey = '', helloAt = Date.now(), lastState = '';
  // Sign-in sessions (docs/LIVE_SIGN_IN.md) run on their own timer, so they never delay claims.
  live = createLiveSessions({ request, graphical, userEnv, which, stateDir: STATE, log, home: HOME, username: ME.username });
  live.start(() => !!session?.token && paired && !paused());
  // "Send to my devices": files sent to this server land in the user's Downloads.
  receiver = createTransferReceiver({ api: API, token: () => session?.token, deviceId: () => me.pcId, home: HOME, log, isActive: () => !!session?.token && paired && !paused() });
  receiver.start();
  const state = text => { if (text !== lastState) { log(text); lastState = text; } };
  for (;;) {
    try {
      if (Date.now() - helloAt > 600000) { writeHello(me); helloAt = Date.now(); }
      const ticket = takeTicket(me); if (ticket) { session = ticket; registered = false; paired = false; identityAt = 0; }
      if (!session?.token) { state('waiting to be paired: ask Josi in chat to control this server, or use Pair on the PC Control page'); await sleep(2000); continue; }
      if (!registered) { await request('PUT', '/register', {}).catch(e => { if (e.status === 401) throw e; }); registered = true; }
      if (Date.now() - identityAt > 5000) {
        const id = await request('GET', '/identity'); identityAt = Date.now();
        paired = id?.publicKey === me.publicKey;
      }
      if (!paired) { state('the owner has not paired this key (or unpaired it)'); await sleep(2000); continue; }
      if (paused()) { bridge?.pause(); state('paused (josi-pc resume to continue)'); presenceKey = ''; await sleep(1000); continue; }
      const presence = { connected: true, browser: bridge ? bridge.presence() : { family: 'desktop', application: process.execPath, profile: 'Default', origin: null, title: null } };
      const key = JSON.stringify(presence);
      if (key !== presenceKey || Date.now() - presenceAt > 10000) { await request('PUT', '/executor/presence', presence, { signed: true }); presenceAt = Date.now(); presenceKey = key; }
      state('connected and ready');
      const next = await request('POST', '/executor/next', {}, { signed: true });
      const claim = next?.request;
      if (!claim) { await sleep(1000); continue; }
      log('working on', claim.id, String(claim.payload?.kind ?? ''), String(claim.description ?? '').slice(0, 120));
      const outcome = fitResult(await execute(claim));
      await request('POST', `/executor/${claim.id}/result`, outcome, { signed: true }).catch(e => log('result not accepted:', e.status ?? '', e.message));
      log('finished', claim.id, outcome.ok ? 'ok' : outcome.result?.code);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        state('the server no longer accepts this session; waiting to be paired again');
        try { unlinkSync(SESSION); } catch { /* gone */ }
        session = null; paired = false; registered = false;
      } else if (error instanceof HttpError && error.status === 403) { paired = false; identityAt = 0; state('identity refused: ' + error.message); }
      else state('cannot reach Josi at ' + API + ': ' + String(error?.message ?? error));
      await sleep(3000);
    }
  }
}

function shutdown() { live?.stop(); receiver?.stop(); for (const s of terminals.values()) closeTerminal(s); Promise.resolve(bridge?.stop()).catch(() => {}).finally(() => process.exit(0)); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

const verb = process.argv[2];
if (!verb || verb === 'serve') await serve();
else if (verb === 'pause') { writePrivate(PAUSE, JSON.stringify({ paused: true, at: new Date().toISOString() })); console.log('Josi PC service paused.'); }
else if (verb === 'resume') { try { unlinkSync(PAUSE); } catch { /* not paused */ } console.log('Josi PC service resumed.'); }
else if (verb === 'unpair') { for (const f of [SESSION, IDENTITY]) { try { unlinkSync(f); } catch { /* gone */ } } console.log('Forgot the pairing. Restart josi-pc.service to make a new key.'); }
else if (verb === 'status') {
  const id = readJson(IDENTITY), s = readJson(SESSION);
  console.log(JSON.stringify({ pcId: id?.pcId ?? null, user: ME.username, paired: !!s?.token, pairedAt: s?.pairedAt ?? null, paused: paused(), api: API, spool: SPOOL, state: STATE, desktop: graphical()?.kind ?? 'none' }, null, 2));
} else { console.error('usage: josi-pc.mjs [serve|status|pause|resume|unpair]'); process.exit(2); }
