// Live sign-in sessions for josi-pc.service (docs/LIVE_SIGN_IN.md): the owner
// signs in on a live view of Josi's hidden screen (a website) or in a terminal
// (a command such as `gh auth login`). What they type goes straight to the
// program; this module never logs, keeps or interprets frames, keystrokes or
// terminal output, and the only things it logs are one line when a session
// starts and one when it ends.
//
//   const live = createLiveSessions({ request, graphical, userEnv, which, stateDir, log, ... });
//   live.start(() => paired && !paused());   // its own timer; never delays claims
//   live.stop();                              // ends every session
//
// Browser: frames of the hidden screen (ImageMagick `import`), input through
// xdotool with coordinates scaled from the frame to the screen. Terminal: a
// pseudo-terminal running exactly `bash -c <command>` as the PC user.
import { createHash } from 'node:crypto';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';

export const FRAME_MAX_WIDTH = 1280;
const RING = 262144;
const MAX_EVENTS = 64, MAX_TEXT = 2000, MAX_DATA = 4096, MAX_SESSIONS = 4;
const KEY = /^([a-zA-Z0-9_]+\+){0,3}[a-zA-Z0-9_]+$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

// A pseudo-terminal from Python's standard library (the same helper as the
// persistent terminals in josi-pc.mjs): 120 by 36, the child in its own
// session, the child's exit code as ours. Extra here: file descriptor 3 is a
// control channel carrying "cols rows\n" lines, applied with TIOCSWINSZ, so the
// terminal can be resized without a restart or any marker in the data stream.
export const PTY_HELPER = `
import os, pty, sys, fcntl, termios, struct, select, signal
pid, fd = pty.fork()
if pid == 0:
    os.closerange(3, 256)
    os.execvp(sys.argv[1], sys.argv[1:])
def size(cols, rows): fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
size(120, 36)
signal.signal(signal.SIGTERM, lambda *a: (os.kill(pid, signal.SIGHUP), sys.exit(143)))
inp = sys.stdin.fileno()
try: os.fstat(3); ctl = 3
except OSError: ctl = -1
line = b''
while True:
    try: r, _, _ = select.select([x for x in (fd, inp, ctl) if x >= 0], [], [])
    except InterruptedError: continue
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: data = b''
        if not data: break
        os.write(1, data)
    if inp >= 0 and inp in r:
        data = os.read(inp, 65536)
        if not data: os.kill(pid, signal.SIGHUP); inp = -1
        else: os.write(fd, data)
    if ctl >= 0 and ctl in r:
        data = os.read(ctl, 4096)
        if not data: ctl = -1
        else:
            line += data
            while b'\\n' in line:
                one, line = line.split(b'\\n', 1)
                try:
                    c, w = one.split(); size(max(10, min(500, int(c))), max(2, min(200, int(w))))
                except Exception: pass
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)
`;

// ------------------------------------------------------------------ helpers

const num = v => typeof v === 'number' && Number.isFinite(v);
/** One browser event checked and normalised, or null. Coordinates are pixels of the frame. */
export function cleanBrowserEvent(e, frame) {
  if (!e || typeof e !== 'object') return null;
  const point = () => {
    if (!num(e.x) || !num(e.y) || e.x < 0 || e.y < 0 || e.x > 20000 || e.y > 20000) return null;
    return { x: Math.min(Math.round(e.x), frame.width - 1), y: Math.min(Math.round(e.y), frame.height - 1) };
  };
  switch (e.t) {
    case 'click': {
      const p = point(); if (!p) return null;
      const button = e.button === undefined ? 1 : e.button, count = e.count === undefined ? 1 : e.count;
      if (![1, 2, 3].includes(button) || ![1, 2].includes(count)) return null;
      return { t: 'click', ...p, button, count };
    }
    case 'move': { const p = point(); return p ? { t: 'move', ...p } : null; }
    case 'scroll': {
      const p = point(); if (!p || !num(e.dy)) return null;
      const dy = Math.round(e.dy); if (dy === 0 || Math.abs(dy) > 20) return null;
      return { t: 'scroll', ...p, dy };
    }
    case 'text': return typeof e.text === 'string' && e.text.length > 0 && e.text.length <= MAX_TEXT && !e.text.includes('\0') ? { t: 'text', text: e.text } : null;
    case 'key': return typeof e.key === 'string' && e.key.length <= 60 && KEY.test(e.key) ? { t: 'key', key: e.key } : null;
    default: return null;
  }
}
/** One terminal event checked, or null. */
export function cleanTerminalEvent(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.t === 'data') return typeof e.data === 'string' && e.data.length > 0 && e.data.length <= MAX_DATA ? { t: 'data', data: e.data } : null;
  if (e.t === 'resize') {
    if (!Number.isInteger(e.cols) || !Number.isInteger(e.rows) || e.cols < 10 || e.cols > 500 || e.rows < 2 || e.rows > 200) return null;
    return { t: 'resize', cols: e.cols, rows: e.rows };
  }
  return null;
}
/** Width and height from a JPEG's start-of-frame marker, or null. */
export function jpegSize(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) { i++; continue; }
    const marker = buffer[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = buffer.readUInt16BE(i + 5), width = buffer.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}
const defaultExec = (file, args, { env, timeout = 8000, binary = false, input } = {}) => new Promise(resolve => {
  const child = execFile(file, args, { env, timeout, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 32 * 1024 * 1024 },
    (error, stdout) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? (binary ? Buffer.alloc(0) : '') }));
  if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
});

/**
 * @param {object} o
 * @param {(method,path,body?,opts?)=>Promise<any>} o.request  the signed /api/admin/pc-control request of josi-pc.mjs
 * @param {()=>({DISPLAY?,x11?}|null)} o.graphical   Josi's hidden screen (display.json) or the user's session
 * @param {(extra?)=>object} o.userEnv
 * @param {(name)=>string|null} o.which
 * @param {string} o.stateDir
 * @param {(...a)=>void} [o.log]
 * @param {string} [o.home]  the PC user's home (terminal cwd)
 * @param {string} [o.username]  the PC user (a card's runAs must match)
 * @param {Function} [o.spawn]  child_process.spawn (tests)
 * @param {Function} [o.exec]   (file,args,{env,timeout,binary}) => Promise<{status,stdout}> (tests)
 */
export function createLiveSessions({ request, graphical, userEnv, which, stateDir, log = () => {}, home = '/', username = '',
  spawn = nodeSpawn, exec = defaultExec, listMs = 1000, minFrameMs = 250, keepFrameMs = 1000, tickMs = 250 } = {}) {
  const sessions = new Map();
  let timer = null, enabled = () => true, lastList = 0, ticking = false;

  const bad = status => status === 404 || status === 410;
  const hasDisplay = () => { const d = graphical(); return !!(d?.x11 && d.DISPLAY); };

  // ------------------------------------------------------------- browser
  function chromeBinary() {
    try {
      const root = join(stateDir, 'browser');
      const dirs = readdirSync(root).filter(d => /^chrome-[0-9.]+$/.test(d))
        .sort((a, b) => a.slice(7).split('.').map(Number).reduce((r, n, i) => r || n - (b.slice(7).split('.').map(Number)[i] ?? 0), 0));
      for (const dir of dirs.reverse()) { const file = join(root, dir, 'chrome-linux64', 'chrome'); if (statSync(file).isFile()) return file; }
    } catch { /* none */ }
    return null;
  }
  function openUrl(url) {
    // A second invocation with the same --user-data-dir hands the URL to the running Chrome as a new tab.
    let ok = false; try { const u = new URL(url); ok = (u.protocol === 'https:' || u.protocol === 'http:') && url.length <= 2048; } catch { /* not a URL */ }
    const chrome = ok ? chromeBinary() : null;
    if (!chrome) return;
    try {
      const child = spawn(chrome, [`--user-data-dir=${join(stateDir, 'browser', 'profile')}`, url], { env: userEnv(), stdio: 'ignore', detached: true });
      child.on?.('error', () => {}); child.unref?.();
    } catch { /* Josi's Chrome is not startable; the person still sees the screen */ }
  }
  async function startBrowser(s, info) {
    if (!hasDisplay() || !which('xdotool') || !which('import')) return 'Josi has no browser screen on this machine';
    s.frame = { width: 0, height: 0 }; s.screen = null; s.screenAt = 0; s.lastHash = ''; s.lastFrameAt = 0;
    if (typeof info.url === 'string' && info.url) openUrl(info.url);
    return null;
  }
  async function screenSize(s) {
    if (s.screen && Date.now() - s.screenAt < 5000) return s.screen;
    const out = await exec(which('xdotool'), ['getdisplaygeometry'], { env: userEnv(), timeout: 3000 });
    const m = out.status === 0 ? /^(\d+)\s+(\d+)/.exec(String(out.stdout).trim()) : null;
    if (m) { s.screen = { width: Number(m[1]), height: Number(m[2]) }; s.screenAt = Date.now(); }
    return s.screen;
  }
  async function frameBody(s) {
    const now = Date.now();
    if (now - s.lastFrameAt < minFrameMs) return null;
    const out = await exec(which('import'), ['-window', 'root', '-resize', FRAME_MAX_WIDTH + 'x>', '-quality', '60', 'jpeg:-'], { env: userEnv(), timeout: 6000, binary: true });
    const jpeg = out.status === 0 ? out.stdout : null;
    const size = jpeg && jpeg.length > 0 && jpeg.length < 3 * 1024 * 1024 ? jpegSize(jpeg) : null;
    if (!size) return null;
    const hash = createHash('sha1').update(jpeg).digest('hex');
    const changed = hash !== s.lastHash;
    if (!changed && now - s.lastFrameAt < keepFrameMs) return null;
    s.lastHash = hash; s.lastFrameAt = now; s.frame = size;
    return { width: size.width, height: size.height, jpegBase64: jpeg.toString('base64') };
  }
  async function applyBrowserInput(s, events) {
    const screen = await screenSize(s);
    if (!screen || !s.frame.width) return;
    const sx = screen.width / s.frame.width, sy = screen.height / s.frame.height;
    const tool = which('xdotool'), env = userEnv();
    const at = e => [String(Math.min(screen.width - 1, Math.round(e.x * sx))), String(Math.min(screen.height - 1, Math.round(e.y * sy)))];
    for (const raw of events.slice(0, MAX_EVENTS)) {
      const e = cleanBrowserEvent(raw, s.frame); if (!e) continue;
      let args;
      if (e.t === 'click') args = ['mousemove', ...at(e), 'click', '--repeat', String(e.count), '--delay', '60', String(e.button)];
      else if (e.t === 'move') args = ['mousemove', ...at(e)];
      else if (e.t === 'scroll') args = ['mousemove', ...at(e), 'click', '--repeat', String(Math.abs(e.dy)), e.dy > 0 ? '5' : '4'];
      else if (e.t === 'text') args = ['type', '--delay', '12', '--', e.text];
      else args = ['key', '--', e.key];
      await exec(tool, args, { env, timeout: 10000 });
    }
  }

  // ------------------------------------------------------------ terminal
  function startTerminal(s, info) {
    const command = info.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 4096 || command.includes('\0')) return 'This sign-in card has no command to run.';
    if (typeof info.runAs === 'string' && info.runAs && username && info.runAs !== username) return `This server's Josi account is ${username}, not ${info.runAs}.`;
    const python = which('python3'); if (!python) return 'python3 is needed for terminals on this server';
    const bash = which('bash') || '/bin/bash';
    let child;
    try {
      child = spawn(python, ['-I', '-c', PTY_HELPER, bash, '-c', command], { cwd: home, env: userEnv({ TERM: 'xterm-256color', COLUMNS: '120', LINES: '36' }),
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true });
    } catch { return 'The command could not be started'; }
    const t = { child, pending: '', dropped: false, running: true, exitCode: null, sentRunning: null, decoders: [new StringDecoder('utf8'), new StringDecoder('utf8')] };
    const take = i => data => {
      t.pending += t.decoders[i].write(data);
      if (t.pending.length > RING) t.pending = t.pending.slice(t.pending.length - RING);
    };
    child.stdout.on('data', take(0)); child.stderr.on('data', take(1));
    child.stdin.on('error', () => {}); child.stdio[3]?.on?.('error', () => {});
    child.on('error', () => { t.running = false; if (t.exitCode === null) t.exitCode = 127; });
    child.on('close', code => { t.running = false; t.exitCode = code ?? 1; });
    s.term = t;
    return null;
  }
  function killTerminal(s) {
    const child = s.term?.child; if (!child || !s.term.running) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
  function applyTerminalInput(s, events) {
    const t = s.term; if (!t?.running) return;
    for (const raw of events.slice(0, MAX_EVENTS)) {
      const e = cleanTerminalEvent(raw); if (!e) continue;
      try {
        if (e.t === 'data') t.child.stdin.write(e.data);
        else t.child.stdio[3]?.write(`${e.cols} ${e.rows}\n`);
      } catch { /* the program has exited */ }
    }
  }

  // --------------------------------------------------------------- drive
  function end(s) {
    if (!sessions.delete(s.id)) return;
    if (s.kind === 'terminal') killTerminal(s);
    log(`live session ended (${s.kind})`);
  }
  async function drive(s) {
    if (s.busy) return;
    s.busy = true;
    try {
      const body = {};
      if (!s.started) {
        s.started = true;
        const problem = s.kind === 'browser' ? await startBrowser(s, s.info) : startTerminal(s, s.info);
        if (problem) { s.failed = true; body.error = problem; } else { body.ready = true; log(`live session started (${s.kind})`); }
      } else if (s.kind === 'browser') {
        const frame = await frameBody(s); if (frame) body.frame = frame;
      } else {
        const t = s.term;
        if (t.pending.length > 0 || t.sentRunning !== t.running) {
          body.output = { data: t.pending, running: t.running, exitCode: t.running ? null : t.exitCode };
          t.pending = ''; t.sentRunning = t.running;
        }
      }
      let answer;
      try { answer = await request('POST', `/executor/live/${s.id}/sync`, body, { signed: true, timeout: 5000 }); s.failures = 0; }
      catch (error) {
        if (bad(error?.status) || ++s.failures > 40) end(s);
        return;
      }
      if (s.failed || answer?.ended === true) { end(s); return; }
      const input = Array.isArray(answer?.input) ? answer.input : [];
      if (input.length) { if (s.kind === 'browser') await applyBrowserInput(s, input); else applyTerminalInput(s, input); }
    } catch { /* one bad round; the next one tries again */ }
    finally { s.busy = false; }
  }

  async function poll() {
    if (!enabled()) { stopAll(); return; }
    if (Date.now() - lastList >= listMs) {
      lastList = Date.now();
      let list = null;
      try { list = (await request('GET', '/executor/live', undefined, { signed: true, timeout: 5000 }))?.sessions; } catch { list = null; }
      if (Array.isArray(list)) {
        const ids = new Set();
        for (const item of list) {
          if (!item || typeof item.id !== 'string' || !SESSION_ID.test(item.id) || !['browser', 'terminal'].includes(item.kind)) continue;
          ids.add(item.id);
          if (!sessions.has(item.id) && sessions.size < MAX_SESSIONS)
            sessions.set(item.id, { id: item.id, kind: item.kind, info: { url: item.url, command: item.command, runAs: item.runAs }, started: false, failures: 0, busy: false });
        }
        for (const s of [...sessions.values()]) if (!ids.has(s.id)) end(s); // the owner ended it
      }
    }
    await Promise.all([...sessions.values()].map(drive));
  }
  function stopAll() { for (const s of [...sessions.values()]) end(s); }

  return {
    poll,
    /** Runs poll() on its own timer, about four times a second while sessions exist (and a list check each second). */
    start(isEnabled = () => true) {
      enabled = isEnabled; if (timer) return;
      timer = setInterval(() => { if (ticking) return; ticking = true; poll().catch(() => {}).finally(() => { ticking = false; }); }, tickMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; stopAll(); },
    count: () => sessions.size,
  };
}
