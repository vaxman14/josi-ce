// A disposable Josi server end for the native tunnel test: the reference
// TunnelHost and httpBridge from packages/tunnel, a stand-in API, and a stand-in
// relay that forwards frames the way services/relay does and can misbehave on
// request. Keys and pairing codes are made here and die with the process.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { TunnelHost } from '../../packages/tunnel/src/host.ts';
import { LAN_PATH, httpBridge, lanListener } from '../../packages/tunnel/src/node.ts';
import { generateKeyPair, staticKeyFrom } from '../../packages/tunnel/src/noise.ts';
import { inviteId, newPairingCode, pairingLink, sealInvite } from '../../packages/tunnel/src/pairing.ts';
import { toB64url } from '../../packages/tunnel/src/bytes.ts';

const site = 'a'.repeat(32);
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', () => done(server.address().port)));
const state = { relayFrames: 0, cancelled: 0, hellos: [], csrfEmpty: false, lastHeaders: null };
let keys = [staticKeyFrom(generateKeyPair().privateKey)];
let until = null, tamperNext = false, offline = false, nextEvent = null, lan = null;
let welcomeLan = [];
const devices = new Map(), codes = new Set(), invites = new Map();

// The stand-in API. CSRF is the real double-submit check from apps/api.
const cookieOf = (req, name) => (req.headers.cookie ?? '').split(';').map(p => p.trim().split('=')).find(p => p[0] === name)?.[1];
const json = (res, value, status = 200) => {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
};
const api = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method !== 'GET') {
      const cookie = cookieOf(req, 'josi_csrf');
      if (!cookie || cookie !== req.headers['x-josi-csrf']) return json(res, { error: 'missing or invalid CSRF token' }, 403);
    }
    state.lastHeaders = req.headers;
    switch (url.pathname) {
      case '/api/auth/csrf': {
        const token = randomUUID();
        res.setHeader('set-cookie', [`josi_csrf=${token}; Path=/; SameSite=Lax`, `josi_session=s-${token}; Path=/; HttpOnly`]);
        return json(res, { csrfToken: state.csrfEmpty ? '' : token });
      }
      case '/api/onboarding/state': return json(res, { completed: true });
      case '/api/echo':
        return json(res, { length: body.length, sha256: createHash('sha256').update(body).digest('hex'), cookie: req.headers.cookie ?? '', query: url.search,
                           type: req.headers['content-type'] ?? '', userAgent: req.headers['user-agent'] ?? '', encoding: req.headers['accept-encoding'] ?? '' });
      case '/api/assistant/threads/11111111-1111-4111-8111-111111111111/attachments':
        return json(res, { attachment: { id: createHash('sha256').update(body).digest('hex') } });
      case '/api/big': {
        const size = 300_000, data = Buffer.alloc(size, 7);
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': size });
        return res.end(data);
      }
      case '/api/redirect': res.writeHead(302, { location: '/api/echo' }); return res.end();
      case '/api/next': nextEvent?.(); return json(res, { ok: true });
      case '/api/events': {
        // Each event waits for /api/next on the same tunnel: only a client that
        // really streams, and really multiplexes, gets past the first.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        let sent = 0;
        const send = () => {
          res.write(`event: tick\ndata: {"n":${++sent}}\n\n`);
          if (sent === 3) { nextEvent = null; res.end(); }
        };
        nextEvent = send; send();
        return;
      }
      case '/api/assistant/work-goals/stream':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: heartbeat\ndata: {}\n\n');
        res.write(`event: progress\ndata: {"revision":"${'b'.repeat(64)}"}\n\n`);
        setTimeout(() => { res.write('event: access-ended\ndata: {}\n\n'); }, 100);
        return;
      case '/api/forever':
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': first\n\n');
        res.on('close', () => { state.cancelled++; });
        return;
      default: return json(res, { error: 'not found' }, 404);
    }
  });
});
const apiPort = await listen(api);

const bridge = httpBridge({ port: apiPort, publicHost: () => 'alice.heyjosi.test' });
const host = new TunnelHost({
  keys: () => keys,
  onRequest: call => bridge.handle(call),
  async authorize(hello, remote, keyIndex) {
    const key = toB64url(remote);
    const welcome = device => ({ ok: true, device, server: 'alice', lan: welcomeLan,
      ...(keyIndex > 0 ? { rotate: { publicKey: toB64url(keys[0].publicKey), until } } : {}) });
    if (hello.op === 'pair') {
      if (!codes.delete(hello.code)) return { ok: false, error: 'bad_code' };
      const device = randomUUID();
      devices.set(key, device);
      state.hellos.push({ op: hello.op, name: hello.name, platform: hello.platform });
      return { device, client: hello.platform, welcome: welcome(device) };
    }
    const device = devices.get(key);
    if (!device) return { ok: false, error: 'unknown_device' };
    state.hellos.push({ op: hello.op, client: hello.client });
    return { device, client: hello.client, welcome: welcome(device) };
  },
  async onRotateDevice(device, oldKey, newKey) {
    devices.delete(toB64url(oldKey));
    devices.set(toB64url(newKey), device);
  },
});

// The stand-in relay: invites, and device sockets that get status text first.
const peers = new Set();
const relay = createServer((req, res) => {
  const found = /^\/v1\/invites\/([0-9a-f]{32})$/.exec(req.url);
  if (found && invites.has(found[1])) return json(res, { box: invites.get(found[1]), expires: 0 });
  json(res, { error: 'no such code, or it expired' }, 404);
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 70 * 1024 });
let nextPeer = 0;
relay.on('upgrade', (req, socket, head) => {
  if (req.url !== `/v1/sites/${site}/peer`) return socket.destroy();
  sockets.handleUpgrade(req, socket, head, ws => {
    if (offline) { ws.send(JSON.stringify({ type: 'server-offline' })); return; }
    const id = `relay-${++nextPeer}`;
    peers.add(ws);
    host.open(id, {
      send: data => {
        state.relayFrames++;
        const out = Buffer.from(data);
        if (tamperNext) { tamperNext = false; out[out.length - 1] ^= 1; }
        ws.send(out, { binary: true });
      },
      close: () => ws.close(),
      buffered: () => ws.bufferedAmount,
    });
    // A hostile relay can say anything here. None of it may reach Noise.
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'surprise' }));
    ws.send(Buffer.from('ignored before online'), { binary: true });
    ws.send(JSON.stringify({ type: 'server-online' }));
    ws.on('message', (data, binary) => { if (binary) { state.relayFrames++; host.data(id, new Uint8Array(data)); } });
    ws.on('close', () => { peers.delete(ws); host.gone(id); });
  });
});
const relayPort = await listen(relay);

// A port nothing listens on yet. /lan/start opens the LAN listener on it.
const spare = createServer();
const lanPort = await listen(spare);
await new Promise(done => spare.close(done));
const lanAddress = `ws://127.0.0.1:${lanPort}${LAN_PATH}`;
welcomeLan = [lanAddress];

const box = () => ({ v: 1, server: toB64url(keys[0].publicKey), site, relay: `ws://127.0.0.1:${relayPort}`, name: 'alice', lan: [lanAddress] });
const control = createServer(async (req, res) => {
  switch (req.url) {
    case '/code': {
      const code = newPairingCode();
      codes.add(code); invites.set(inviteId(code), sealInvite(code, box()));
      return json(res, { code, link: pairingLink('https://alice.heyjosi.test', code, box()) });
    }
    case '/state': return json(res, { ...state, peers: peers.size, connected: host.connected() });
    case '/csrf-empty': state.csrfEmpty = true; return json(res, {});
    case '/tamper': tamperNext = true; return json(res, {});
    case '/offline': offline = true; for (const ws of peers) ws.send(JSON.stringify({ type: 'server-offline' })); return json(res, {});
    case '/online': offline = false; return json(res, {});
    case '/lan/start': lan = await lanListener(host, { port: lanPort, address: '127.0.0.1' }); return json(res, {});
    case '/lan/stop': void lan?.close(); lan = null; host.disconnectAll(); return json(res, {});   // close() waits on open sockets
    case '/rotate-server-overlap': {
      const next = staticKeyFrom(generateKeyPair().privateKey);
      until = new Date(Date.now() + 600_000).toISOString();
      keys = [next, keys[0]];
      host.announceRotation(next.publicKey, until);
      return json(res, {});
    }
    case '/revoke': { let count = 0; for (const device of host.connected()) count += host.disconnectDevice(device); devices.clear(); return json(res, { count }); }
    default: return json(res, { error: 'not found' }, 404);
  }
});
const controlPort = await listen(control);
console.log(JSON.stringify({ control: `http://127.0.0.1:${controlPort}`, relay: `http://127.0.0.1:${relayPort}` }));
