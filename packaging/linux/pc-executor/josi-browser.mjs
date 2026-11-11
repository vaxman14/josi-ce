#!/usr/bin/env node
// Josi's own browser on a headless Linux server: josi-browser.service.
//
// A server has no screen and, on Ubuntu, only a snap Chromium that cannot
// start Josi's native messaging host. So Josi gets a browser of her own: a
// hidden X screen (Xvfb), a small window manager (openbox, when installed) and
// a pinned Chrome for Testing with the Josi browser extension loaded. The PC
// service (josi-pc.mjs) reads display.json to work on that screen (windows,
// screenshots, clicks, keys) and links the extension through browser.mjs, so
// every browser tool works exactly as with a desktop Chrome on Windows.
//
// Runs as the PC-control user, never as root. Everything lives in
// $JOSI_PC_STATE/browser: the verified Chrome download, the profile and the
// X authority cookie.
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeHostManifests, nativeHostWrapper } from './browser.mjs';

// Chrome for Testing: the one Chrome build that still loads an unpacked
// extension from the command line. Pinned by version and SHA-256.
const CHROME = {
  version: '157.0.8103.50',
  url: 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.50/linux64/chrome-linux64.zip',
  sha256: 'd17167bc092eb495a3b768c7467f27e35f625aa03834233a1663af67dcb668c9',
  bytes: 203527334,
};
const STATE = process.env.JOSI_PC_STATE || '/var/lib/josi-pc';
const ROOT = join(STATE, 'browser');
const EXTENSION = process.env.JOSI_BROWSER_EXTENSION || '';
const PROFILE = join(ROOT, 'profile');
const XAUTH = join(ROOT, 'Xauthority');
const DISPLAY_FILE = join(STATE, 'display.json');
const WIDTH = 1600, HEIGHT = 1000;
const HERE = dirname(fileURLToPath(import.meta.url));
const log = (...parts) => console.log(new Date().toISOString(), ...parts);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const which = name => ['/usr/bin', '/bin', '/usr/local/bin'].map(d => join(d, name)).find(p => existsSync(p)) ?? null;

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** On ARM there is no Chrome for Testing for Linux, so Josi uses the system's
 * Chromium (the `chromium` package of Debian and Raspberry Pi OS), which also
 * loads an unpacked extension. It is linked where the pinned Chrome would be,
 * so everything that looks for Josi's browser finds it in the same place. */
function systemChromium() {
  const found = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/lib/chromium/chromium'].find(p => existsSync(p));
  if (!found) throw new Error('Chromium is not installed (ARM has no Chrome for Testing): install the chromium package, or run the Josi installer again and choose the browser');
  const dir = join(ROOT, 'chrome-0', 'chrome-linux64'), link = join(dir, 'chrome');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let current = null; try { current = readlinkSync(link); } catch { /* not there yet */ }
  if (current !== found) { rmSync(link, { force: true }); symlinkSync(found, link); }
  log('using the system Chromium at', found);
  return link;
}

/** Downloads and unpacks the pinned Chrome once; a bad hash is never used. */
async function ensureChrome() {
  if (process.arch !== 'x64') return systemChromium();
  const dir = join(ROOT, 'chrome-' + CHROME.version), binary = join(dir, 'chrome-linux64', 'chrome');
  if (existsSync(join(dir, '.verified')) && existsSync(binary)) return binary;
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const zip = join(ROOT, `chrome-${CHROME.version}.zip`);
  if (!existsSync(zip) || statSync(zip).size !== CHROME.bytes || await sha256(zip) !== CHROME.sha256) {
    log('downloading Chrome for Testing', CHROME.version);
    const partial = zip + '.part';
    const response = await fetch(CHROME.url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!response.ok || !response.body) throw new Error('Chrome download failed: HTTP ' + response.status);
    await pipeline(response.body, createWriteStream(partial, { mode: 0o600 }));
    if (statSync(partial).size !== CHROME.bytes || await sha256(partial) !== CHROME.sha256) { unlinkSync(partial); throw new Error('Chrome download did not match its pinned SHA-256'); }
    renameSync(partial, zip);
  }
  const unzip = which('unzip'); if (!unzip) throw new Error('unzip is not installed; run the Josi installer again');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = spawnSync(unzip, ['-q', zip, '-d', dir], { stdio: 'inherit' });
  if (out.status !== 0 || !existsSync(binary)) throw new Error('could not unpack Chrome');
  writeFileSync(join(dir, '.verified'), CHROME.sha256 + '\n');
  try { unlinkSync(zip); } catch { /* keep going */ }
  log('Chrome for Testing', CHROME.version, 'is ready');
  return binary;
}

function freeDisplay() {
  for (let n = 90; n < 140; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  throw new Error('no free X display number');
}

function nativeHost() {
  // The extension finds Josi through a native messaging host in the profile,
  // which this Chrome reads even with a custom profile folder.
  const wrapper = join(ROOT, 'josi-browser-host');
  writeFileSync(wrapper, nativeHostWrapper(process.execPath, join(HERE, 'josi-browser-host.mjs'), STATE), { mode: 0o700 });
  chmodSync(wrapper, 0o700);
  const folder = join(PROFILE, 'NativeMessagingHosts'); mkdirSync(folder, { recursive: true, mode: 0o700 });
  const chromium = nativeHostManifests(wrapper).find(m => m.path.includes('/etc/opt/chrome/'));
  const json = chromium?.json ?? nativeHostManifests(wrapper)[0].json;
  writeFileSync(join(folder, 'com.heyjosi.browser.json'), typeof json === 'string' ? json : JSON.stringify(json, null, 2));
}

let children = [], stopping = false;
function start(file, args, env, name) {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  // A server has no desktop bus, power or network managers: Chrome's complaints about them are noise.
  const noise = /dbus|SharedImage|UPower|NetworkManager|org\.freedesktop/i;
  const tag = data => { for (const line of String(data).split('\n')) if (line.trim() && !noise.test(line)) log(`[${name}]`, line.slice(0, 300)); };
  child.stdout.on('data', tag); child.stderr.on('data', tag);
  children.push(child);
  return child;
}
const alive = child => child && child.exitCode === null && child.signalCode === null;
function kill(child) { if (!child) return; try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }

async function serve() {
  if (!EXTENSION || !existsSync(join(EXTENSION, 'manifest.json'))) throw new Error('JOSI_BROWSER_EXTENSION does not hold the Josi extension');
  const xvfb = which('Xvfb'), xauth = which('xauth');
  if (!xvfb || !xauth) throw new Error('Xvfb and xauth are needed; run the Josi installer again and choose the browser');
  const chrome = await ensureChrome();
  mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
  nativeHost();
  for (;;) {
    if (stopping) return;
    const n = freeDisplay(), display = ':' + n;
    try { unlinkSync(XAUTH); } catch { /* fresh */ }
    spawnSync(xauth, ['-f', XAUTH, 'add', display, '.', randomBytes(16).toString('hex')], { stdio: 'ignore' });
    const base = { HOME: process.env.HOME || '/', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8', DISPLAY: display, XAUTHORITY: XAUTH, JOSI_PC_STATE: STATE };
    const server = start(xvfb, [display, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp', '-auth', XAUTH, '-dpi', '96'], base, 'xvfb');
    for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
    if (!alive(server)) { log('Xvfb did not start'); await sleep(5000); continue; }
    const wm = which('openbox') ? start(which('openbox'), [], base, 'openbox') : null;
    writeFileSync(DISPLAY_FILE, JSON.stringify({ DISPLAY: display, XAUTHORITY: XAUTH, pid: server.pid, kind: 'x11', virtual: true, width: WIDTH, height: HEIGHT }), { mode: 0o600 });
    log('hidden screen', display, 'is up');
    let sandbox = true, quickFailures = 0;
    while (alive(server) && !stopping) {
      const args = [`--user-data-dir=${PROFILE}`, `--load-extension=${EXTENSION}`, '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
        '--password-store=basic', '--disable-dev-shm-usage', '--disable-features=Translate,MediaRouter', '--window-position=0,0',
        `--window-size=${WIDTH},${HEIGHT}`, '--start-maximized', ...(sandbox ? [] : ['--no-sandbox']), 'about:blank'];
      const startedAt = Date.now();
      const browser = start(chrome, args, base, 'chrome');
      await new Promise(resolve => browser.once('exit', resolve));
      if (stopping) break;
      if (Date.now() - startedAt < 15000) quickFailures++; else quickFailures = 0;
      // Ubuntu 24.04 and later restrict the user namespaces Chrome's sandbox
      // needs; after two quick failures, run without it rather than not at all.
      if (sandbox && quickFailures >= 2) { sandbox = false; log('Chrome cannot start its sandbox here; running it without one'); }
      log('Chrome exited; starting it again');
      await sleep(Math.min(30000, 2000 * Math.max(1, quickFailures)));
    }
    kill(wm); kill(server);
    try { unlinkSync(DISPLAY_FILE); } catch { /* gone */ }
    children = [];
    if (!stopping) { log('hidden screen stopped; starting it again'); await sleep(3000); }
  }
}

function shutdown() {
  stopping = true;
  for (const child of children) kill(child);
  try { unlinkSync(DISPLAY_FILE); } catch { /* gone */ }
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

const verb = process.argv[2];
if (verb === 'check') {
  console.log(JSON.stringify({ chrome: CHROME.version, ready: existsSync(join(ROOT, 'chrome-' + CHROME.version, '.verified')), display: (() => { try { return JSON.parse(readFileSync(DISPLAY_FILE, 'utf8')); } catch { return null; } })() }, null, 2));
} else {
  try { await serve(); } catch (error) { log('cannot start Josi\'s browser:', String(error?.message ?? error)); process.exit(1); }
}
