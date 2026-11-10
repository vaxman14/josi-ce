#!/usr/bin/env node
// The Josi browser extension's native messaging host on Linux: the port of
// apps/windows-native/src/BrowserHost.cs. Chrome, Chromium, Brave and Edge
// start it with the extension's origin (chrome-extension://<id>/); Firefox
// with the manifest path and the add-on ID. It relays each message, framed
// with a 4-byte little-endian length, to josi-pc.service over a Unix socket
// only this Linux account can open, and answers "unavailable" when the service
// is not running. It never starts the service, chooses a server or grants
// anything itself. It exits when the browser closes stdin.
//
//   socket: $JOSI_BROWSER_SOCK, else $JOSI_PC_STATE/browser.sock, else /var/lib/josi-pc/browser.sock
import { connect } from 'node:net';
import { join } from 'node:path';
import { CHROMIUM_EXTENSION_ID, FIREFOX_EXTENSION_ID, HOST_NAME, MAX_FRAME, chromiumExtensionIds } from './browser.mjs';

const STATE = process.env.JOSI_PC_STATE || '/var/lib/josi-pc';
const SOCKET = process.env.JOSI_BROWSER_SOCK || join(STATE, 'browser.sock');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --------------------------------------------------------------- the caller
const args = process.argv.slice(2);
const origins = chromiumExtensionIds(STATE).concat(CHROMIUM_EXTENSION_ID).map(id => `chrome-extension://${id}/`);
const caller = args.length >= 1 && origins.includes(args[0]) ? args[0]
  // Firefox starts the host with the manifest path and the add-on ID.
  : args.length >= 2 && args[1] === FIREFOX_EXTENSION_ID && args[0].endsWith('/' + HOST_NAME + '.json') ? args[1] : null;
if (!caller) { process.stderr.write('josi-browser-host: not started by the Josi browser extension\n'); process.exit(1); }

// ----------------------------------------------------------------- framing
const frame = body => { const header = Buffer.alloc(4); header.writeInt32LE(body.length, 0); return Buffer.concat([header, body]); };
/** Splits a stream into frames; calls bad() on an oversized or empty one. */
function reader(onFrame, bad) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 4) {
      const length = buffer.readInt32LE(0);
      if (length <= 0 || length > MAX_FRAME) { buffer = Buffer.alloc(0); bad(); return; }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length); buffer = buffer.subarray(4 + length);
      onFrame(body);
    }
  };
}
function refusal(request) {
  try {
    const id = JSON.parse(request.toString('utf8'))?.requestId;
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    return Buffer.from(JSON.stringify({ version: 1, requestId: id, ok: false, payload: {} }), 'utf8');
  } catch { return null; }
}

// ------------------------------------------------------------ the service
let pipe = null, waiting = null;
const lost = () => { const p = pipe; pipe = null; p?.destroy(); const w = waiting; waiting = null; w?.(null); };
const ready = new Promise(resolve => {
  const socket = connect(SOCKET);
  const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1500);
  socket.on('connect', () => {
    clearTimeout(timer); pipe = socket;
    // Who this is: the service checks /proc for the same account and the browser that started it.
    socket.write(frame(Buffer.from(JSON.stringify({ kind: 'peer', pid: process.pid, uid: process.getuid?.() ?? -1, caller }), 'utf8')));
    resolve();
  });
  socket.on('data', reader(body => { const w = waiting; waiting = null; if (w) w(body); else lost(); }, lost));
  socket.on('error', () => { clearTimeout(timer); lost(); resolve(); });
  socket.on('close', () => { if (pipe === socket) lost(); });
});
function relay(request) {
  if (!pipe) return Promise.resolve(null);
  return new Promise(resolve => {
    waiting = resolve;
    try { pipe.write(frame(request)); } catch { lost(); }
  });
}

// ---------------------------------------------------------------- the loop
let chain = ready;
const finish = code => { chain.then(() => { pipe?.destroy(); process.exit(code); }); };
process.stdin.on('data', reader(request => {
  chain = chain.then(async () => {
    const reply = (await relay(request)) ?? refusal(request);
    if (!reply) { pipe?.destroy(); process.exit(1); }
    process.stdout.write(frame(reply));
  });
}, () => finish(0)));
process.stdin.on('end', () => finish(0));
process.stdin.on('error', () => finish(0));
