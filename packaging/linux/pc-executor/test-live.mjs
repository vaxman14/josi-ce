#!/usr/bin/env node
// Self-contained test of live sign-in sessions (live.mjs): node test-live.mjs
// A fake server answers the signed /executor/live routes. xdotool and import
// are faked (recorded) so the logic is checked anywhere; the terminal test uses
// the real pseudo-terminal helper and runs on Linux only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanBrowserEvent, cleanTerminalEvent, createLiveSessions, jpegSize } from './live.mjs';

const linux = process.platform === 'linux';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = name => { passed++; console.log('ok', passed, '-', name); };
const state = mkdtempSync(join(tmpdir(), 'josi-live-test-'));

/** A minimal JPEG header with a start-of-frame of the given size; `salt` changes the bytes. */
const jpeg = (w, h, salt = 0) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00, salt & 255, 0xff, 0xd9]);

function fakeServer() {
  const server = { sessions: [], syncs: [], inputs: {}, ended: new Set(), listFails: false, calls: [] };
  server.request = async (method, path, body, opts) => {
    server.calls.push([method, path, opts?.signed]);
    if (method === 'GET' && path === '/executor/live') return { sessions: server.sessions };
    const m = /^\/executor\/live\/([^/]+)\/sync$/.exec(path);
    if (method === 'POST' && m) {
      server.syncs.push({ id: m[1], body });
      const input = server.inputs[m[1]] ?? []; server.inputs[m[1]] = [];
      return { input, ended: server.ended.has(m[1]) };
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  return server;
}
function fakeTools({ display = true, xdotool = true, importTool = true } = {}) {
  const t = { runs: [], image: jpeg(1280, 800, 1), spawned: [], logs: [] };
  t.which = name => (name === 'xdotool' ? (xdotool ? '/usr/bin/xdotool' : null) : name === 'import' ? (importTool ? '/usr/bin/import' : null)
    : name === 'python3' ? (linux ? '/usr/bin/python3' : null) : name === 'bash' ? '/bin/bash' : null);
  t.graphical = () => display ? { DISPLAY: ':99', x11: true, virtual: true } : null;
  t.userEnv = (extra = {}) => ({ PATH: process.env.PATH, ...extra });
  t.exec = async (file, args) => {
    t.runs.push([file.split('/').pop(), ...args]);
    if (file.endsWith('import')) return { status: 0, stdout: t.image };
    if (args[0] === 'getdisplaygeometry') return { status: 0, stdout: '2560 1600\n' };
    return { status: 0, stdout: '' };
  };
  t.spawn = (file, args, opts) => { t.spawned.push([file, args, opts]); return { on() {}, unref() {} }; };
  t.log = (...a) => t.logs.push(a.join(' '));
  return t;
}
const make = (server, tools, extra = {}) => createLiveSessions({ request: server.request, graphical: tools.graphical, userEnv: tools.userEnv, which: tools.which,
  stateDir: state, log: tools.log, home: tmpdir(), username: 'tester', spawn: tools.spawn, exec: tools.exec, listMs: 0, minFrameMs: 0, keepFrameMs: 1e9, ...extra });

try {
  // ------------------------------------------------------------- validation
  const f = { width: 1280, height: 800 };
  assert.deepEqual(cleanBrowserEvent({ t: 'click', x: 10.4, y: 20 }, f), { t: 'click', x: 10, y: 20, button: 1, count: 1 });
  assert.deepEqual(cleanBrowserEvent({ t: 'click', x: 5000, y: 900, button: 3, count: 2 }, f), { t: 'click', x: 1279, y: 799, button: 3, count: 2 });
  for (const e of [{ t: 'click', x: -1, y: 0 }, { t: 'click', x: 'a', y: 0 }, { t: 'click', x: 1, y: 1, button: 4 }, { t: 'click', x: 1, y: 1, count: 3 },
    { t: 'scroll', x: 1, y: 1, dy: 21 }, { t: 'scroll', x: 1, y: 1, dy: 0 }, { t: 'text', text: '' }, { t: 'text', text: 'x'.repeat(2001) }, { t: 'key', key: 'ctrl+;' },
    { t: 'key', key: 'a+b+c+d+e' }, { t: 'key', key: 'ctrl+a b' }, { t: 'key' }, { t: 'wat' }, null, 'x', { t: 'move', x: NaN, y: 1 }])
    assert.equal(cleanBrowserEvent(e, f), null, JSON.stringify(e));
  assert.deepEqual(cleanBrowserEvent({ t: 'key', key: 'ctrl+shift+a' }, f), { t: 'key', key: 'ctrl+shift+a' });
  assert.deepEqual(cleanBrowserEvent({ t: 'scroll', x: 1, y: 2, dy: -3 }, f), { t: 'scroll', x: 1, y: 2, dy: -3 });
  assert.deepEqual(cleanTerminalEvent({ t: 'data', data: 'ls\n' }), { t: 'data', data: 'ls\n' });
  assert.equal(cleanTerminalEvent({ t: 'data', data: 'x'.repeat(4097) }), null);
  assert.deepEqual(cleanTerminalEvent({ t: 'resize', cols: 100, rows: 30 }), { t: 'resize', cols: 100, rows: 30 });
  for (const e of [{ t: 'resize', cols: 9, rows: 30 }, { t: 'resize', cols: 100, rows: 1.5 }, { t: 'resize', cols: 1000, rows: 30 }, { t: 'data' }, {}])
    assert.equal(cleanTerminalEvent(e), null);
  assert.deepEqual(jpegSize(jpeg(1280, 720)), { width: 1280, height: 720 });
  assert.equal(jpegSize(Buffer.from('nope')), null);
  ok('event validation and JPEG size');

  // -------------------------------------------------- no screen / no tools
  for (const missing of [{ display: false }, { xdotool: false }, { importTool: false }]) {
    const server = fakeServer(), tools = fakeTools(missing), live = make(server, tools);
    server.sessions = [{ id: 's1', kind: 'browser', state: 'starting', title: 't', url: 'https://github.com/login' }];
    await live.poll();
    assert.deepEqual(server.syncs.map(s => s.body), [{ error: 'Josi has no browser screen on this machine' }]);
    assert.equal(live.count(), 0); assert.equal(tools.spawned.length, 0);
  }
  ok('no hidden screen, xdotool or import: error synced and the session ended');

  // --------------------------------------------------------------- browser
  {
    const chrome = join(state, 'browser', 'chrome-157.0.8103.50', 'chrome-linux64', 'chrome');
    mkdirSync(join(state, 'browser', 'chrome-157.0.8103.50', 'chrome-linux64'), { recursive: true }); writeFileSync(chrome, '#!/bin/sh\n', { mode: 0o755 });
    mkdirSync(join(state, 'browser', 'chrome-9.0.1', 'chrome-linux64'), { recursive: true }); // older/other and empty: ignored
    const server = fakeServer(), tools = fakeTools(), live = make(server, tools);
    server.sessions = [{ id: 'b1', kind: 'browser', state: 'starting', title: 'Sign in', url: 'https://github.com/login' }];
    await live.poll();
    assert.deepEqual(server.syncs.at(-1).body, { ready: true });
    assert.equal(tools.spawned.length, 1);
    assert.deepEqual(tools.spawned[0].slice(0, 2), [chrome, [`--user-data-dir=${join(state, 'browser', 'profile')}`, 'https://github.com/login']]);
    assert.deepEqual(tools.logs.filter(l => l.includes('live session')), ['live session started (browser)']);
    await live.poll();
    const frame = server.syncs.at(-1).body.frame;
    assert.equal(frame.width, 1280); assert.equal(frame.height, 800); assert.ok(Buffer.from(frame.jpegBase64, 'base64').equals(tools.image));
    assert.deepEqual(tools.runs.find(r => r[0] === 'import'), ['import', '-window', 'root', '-resize', '1280x>', '-quality', '60', 'jpeg:-']);
    await live.poll();
    assert.deepEqual(server.syncs.at(-1).body, {}, 'an unchanged picture is not sent again');
    // input: the screen is 2560x1600, the frame 1280x800, so coordinates double
    server.inputs.b1 = [{ t: 'click', x: 100, y: 50, count: 2 }, { t: 'move', x: 1, y: 2 }, { t: 'scroll', x: 640, y: 400, dy: 3 }, { t: 'scroll', x: 0, y: 0, dy: -2 },
      { t: 'text', text: 'hello' }, { t: 'key', key: 'ctrl+a' }, { t: 'key', key: 'ctrl+;' }, { t: 'bogus' }, { t: 'click', x: 'no', y: 1 }];
    await live.poll(); // delivers the input in its answer and applies it
    const x = tools.runs.filter(r => r[0] === 'xdotool' && r[1] !== 'getdisplaygeometry');
    assert.deepEqual(x, [
      ['xdotool', 'mousemove', '200', '100', 'click', '--repeat', '2', '--delay', '60', '1'],
      ['xdotool', 'mousemove', '2', '4'],
      ['xdotool', 'mousemove', '1280', '800', 'click', '--repeat', '3', '5'],
      ['xdotool', 'mousemove', '0', '0', 'click', '--repeat', '2', '4'],
      ['xdotool', 'type', '--delay', '12', '--', 'hello'],
      ['xdotool', 'key', '--', 'ctrl+a'],
    ]);
    tools.image = jpeg(1280, 800, 2);
    await live.poll();
    assert.ok(server.syncs.at(-1).body.frame, 'a changed picture is sent');
    assert.ok(server.calls.every(c => c[2] === true), 'every call is signed');
    server.ended.add('b1');
    await live.poll();
    assert.equal(live.count(), 0);
    assert.deepEqual(tools.logs.filter(l => l.includes('live session')), ['live session started (browser)', 'live session ended (browser)']);
    assert.equal(tools.logs.join('\n').includes('hello'), false, 'no keystrokes in the log');
    ok('browser: url opened in Josi\'s Chrome, frames only when changed, input scaled to the screen and validated, ended stops it');
  }

  // ------------------------------------------- list removal and pause file
  {
    const server = fakeServer(), tools = fakeTools();
    let on = true; const live = make(server, tools);
    live.start(() => on); live.stop();
    server.sessions = [{ id: 'b2', kind: 'browser', state: 'ready', title: 't' }, { id: 'weird id!', kind: 'browser' }, { id: 'k1', kind: 'banana' }];
    await live.poll(); assert.equal(live.count(), 1, 'bad ids and kinds are ignored');
    server.sessions = []; await live.poll(); assert.equal(live.count(), 0, 'the owner ended it');
    server.sessions = [{ id: 'b3', kind: 'browser', state: 'ready', title: 't' }]; await live.poll(); assert.equal(live.count(), 1);
    live.start(() => on); on = false; await sleep(700); assert.equal(live.count(), 0, 'paused ends sessions'); live.stop();
    ok('sessions the owner ended, malformed cards, and a paused executor');
  }

  // -------------------------------------------------------------- terminal
  if (linux) {
    const server = fakeServer();
    const tools = fakeTools();
    tools.which = name => ({ python3: '/usr/bin/python3', bash: '/bin/bash' }[name] ?? null);
    const live = make(server, tools, { spawn: (file, args, opts) => { tools.spawned.push([args.slice(3)]); const c = spawn(file, args, opts); tools.last = c; return c; } });
    server.sessions = [{ id: 't1', kind: 'terminal', state: 'starting', title: 'gh', command: 'echo hi-there; read a; echo got-$a; sleep 0.6; stty size; exit 3', runAs: 'tester' }];
    const output = () => server.syncs.filter(s => s.id === 't1' && s.body.output).map(s => s.body.output.data).join('');
    const until = async (test, what) => { for (let i = 0; i < 80; i++) { await live.poll(); if (test()) return; await sleep(100); } throw new Error('timed out: ' + what); };
    await live.poll();
    assert.deepEqual(server.syncs[0].body, { ready: true });
    assert.deepEqual(tools.spawned[0][0], ['/bin/bash', '-c', server.sessions[0].command], 'exactly bash -c <command>, not a shell');
    await until(() => output().includes('hi-there'), 'first output');
    server.inputs.t1 = [{ t: 'data', data: 'xyz\n' }, { t: 'resize', cols: 90, rows: 30 }, { t: 'resize', cols: 5, rows: 30 }, { t: 'data', data: '' }];
    await until(() => server.syncs.some(s => s.body.output && s.body.output.running === false), 'exit');
    const last = server.syncs.filter(s => s.body.output).at(-1).body.output;
    assert.equal(last.running, false); assert.equal(last.exitCode, 3);
    assert.match(output(), /got-xyz/); assert.match(output(), /30 90/, 'resized to 30 rows by 90 columns');
    assert.equal(live.count(), 1, 'stays open after exit until ended');
    server.ended.add('t1'); await live.poll(); assert.equal(live.count(), 0);
    assert.equal(tools.logs.join('\n').includes('hi-there'), false);
    ok('terminal: bash -c in a pty, input, resize, exit code reported, open until ended');

    // killing: a long-running command's group dies when the session ends
    server.ended.delete('t1');
    server.sessions = [{ id: 't2', kind: 'terminal', state: 'starting', title: 'sleep', command: 'sleep 300' }];
    await live.poll(); await sleep(200);
    const pid = tools.last.pid; process.kill(pid, 0);
    server.sessions = []; await live.poll(); assert.equal(live.count(), 0);
    await sleep(300); assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the helper is gone');
    ok('terminal: ended while running kills the process group');

    server.sessions = [{ id: 't3', kind: 'terminal', title: 'x', command: 'id', runAs: 'someone-else' }];
    await live.poll(); assert.match(server.syncs.at(-1).body.error, /someone-else/); assert.equal(live.count(), 0);
    ok('terminal: a card for another Linux user is refused');
  }

  console.log(`\nall ${passed} passed on ${process.platform} (node ${process.version})`);
} catch (error) {
  console.error('FAILED:', error); process.exitCode = 1;
} finally {
  rmSync(state, { recursive: true, force: true });
}
