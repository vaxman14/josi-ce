// Test only. Real TunnelHost + httpBridge + lanListener from packages/tunnel, a stand-in API and a stand-in relay.
import { createHash, randomBytes as nodeRandom, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { x25519 } from '@noble/curves/ed25519.js';
import { poly1305 } from '@noble/ciphers/_poly1305.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { TunnelHost, displayCode, generateKeyPair, inviteId, newPairingCode, normalizeCode, pairingLink, sealInvite, staticKeyFrom, toB64url, toHex, type HostPolicy, type InviteBox } from '../../../../../packages/tunnel/src/index.ts';
import { httpBridge, lanListener } from '../../../../../packages/tunnel/src/node.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

if (process.argv[2] === 'gen') {
  const out: Record<string, unknown> = {};
  out.x25519 = Array.from({ length: 300 }, (_, i) => {
    const k = nodeRandom(32), u = nodeRandom(32);
    if (i % 3 === 0) { u[31] |= 0x80; }                                            // top bit set: must be ignored
    if (i % 7 === 0) { u.fill(0xff, 1); u[0] = 0xf0 + (i % 13); u[31] = 0x7f; }    // at or above p
    const masked = Uint8Array.from(u); masked[31] &= 0x7f;
    return { k: hex(k), u: hex(u), out: hex(x25519.scalarMult(k, masked)) };
  });
  const biased = (n: number) => { const b = nodeRandom(n); for (let i = 0; i < n; i++) { const r = b[i] % 6; if (r < 2) b[i] = 0xff; else if (r === 2) b[i] = 0; else if (r === 3) b[i] = 0xfb; } return b; };
  out.poly = Array.from({ length: 2000 }, () => { const key = biased(32), data = biased(16 * (nodeRandom(1)[0] % 12)); return { key: hex(key), data: hex(data), tag: hex(poly1305(data, key)) }; });
  out.aead = Array.from({ length: 300 }, (_, i) => {
    const key = nodeRandom(32), nonce = nodeRandom(12), ad = nodeRandom(i % 40), plain = nodeRandom(i * 3 % 301);
    return { key: hex(key), nonce: hex(nonce), ad: hex(ad), plain: hex(plain), out: hex(chacha20poly1305(key, nonce, ad).encrypt(plain)) };
  });
  out.pairing = Array.from({ length: 40 }, (_, i) => {
    const code = newPairingCode();
    const box: InviteBox = { v: 1, server: toB64url(generateKeyPair().publicKey), site: hex(nodeRandom(16)), relay: 'wss://relay.heyjosi.test', name: i % 2 ? 'alice' : null, lan: i % 3 ? ['ws://192.168.1.5:18777/__josi/noise'] : undefined };
    return { code, display: displayCode(code), messy: displayCode(code).toLowerCase().replaceAll('0', 'o').replaceAll('1', i % 2 ? 'i' : 'l').replaceAll('-', i % 2 ? ' - ' : '\t'), id: inviteId(code), sealed: sealInvite(code, box), link: pairingLink('https://alice.heyjosi.test', code, box), box };
  });
  out.normalize = ['abc-def', ' o0 Il1 ', 'ß-x', 'k7qm 4xht', '﻿abc', 'ａｂｃ'].map(input => ({ input, output: normalizeCode(input) }));
  writeFileSync(process.argv[3], JSON.stringify(out));
  process.exit(0);
}

// ---- the stand-in API
const state = { hangClosed: 0, sseOpen: 0, sseClosed: 0, omitCsrfBody: false, requests: [] as string[], uploadsAborted: 0 };
const api = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  state.requests.push(`${req.method} ${url.pathname}`);
  const json = (status: number, value: unknown, headers: Record<string, string | string[]> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
  const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').filter(Boolean).map(p => p.trim().split('=') as [string, string]));
  const native = req.headers['x-josi-client'] === 'native' && !req.headers.origin;
  const bearer = /^Bearer\s+\S+$/i.test(String(req.headers.authorization ?? ''));
  const chunks: Buffer[] = [];
  if (url.pathname === '/api/auth/csrf') {
    const token = nodeRandom(32).toString('base64url');
    return json(200, state.omitCsrfBody ? {} : { csrfToken: token }, { 'set-cookie': `josi_csrf=${token}; Path=/; SameSite=Lax` });
  }
  if (url.pathname === '/api/assistant/work-goals/stream') {
    state.sseOpen++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.on('close', () => { state.sseClosed++; });
    let n = 0;
    const timer = setInterval(() => { res.write(`event: heartbeat\ndata: {"n":${n++}}\n\n`); }, 30);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (url.pathname === '/api/big') {
    const size = Number(url.searchParams.get('n'));
    const block = Buffer.alloc(65536); for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) & 255;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size) });
    let left = size;
    const pump = () => { while (left > 0) { const part = block.subarray(0, Math.min(left, block.length)); left -= part.length; if (!res.write(part)) { res.once('drain', pump); return; } } res.end(); };
    pump();
    return;
  }
  if (url.pathname === '/api/redirect') { res.writeHead(302, { location: 'https://accounts.example.test/o?x=1' }); res.end(); return; }
  if (url.pathname === '/api/reset') { req.socket.destroy(); return; }
  if (url.pathname === '/api/hang') { res.on('close', () => { state.hangClosed++; }); return; }
  req.on('data', c => chunks.push(c));
  req.on('close', () => { if (!req.complete) state.uploadsAborted++; });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method !== 'GET' && !(native && (bearer || url.pathname === '/api/auth/login'))) {
      if (!cookies.josi_csrf || cookies.josi_csrf !== req.headers['x-josi-csrf']) return json(403, { error: 'missing or invalid CSRF token' });
    }
    if (url.pathname === '/api/auth/login') return json(200, { sessionToken: 'tok_' + nodeRandom(12).toString('hex'), user: { id: 'u1' } });
    if (url.pathname === '/api/auth/me') return bearer ? json(200, { user: { id: 'u1' } }) : json(401, { error: 'sign in' });
    json(200, { method: req.method, path: req.url, headers: req.headers, size: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  });
});
await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
const apiPort = (api.address() as { port: number }).port;

// ---- the real host
let serverKey = staticKeyFrom(generateKeyPair().privateKey);
let previousKey: typeof serverKey | null = null;
const codes = new Set<string>(), paired = new Map<string, string>(), revoked = new Set<string>();
const hostState = { rejectRotation: false, dropOldKey: false, replyRotateOk: true, lanList: [] as string[], connects: 0 };
const bridge = httpBridge({ port: apiPort, publicHost: () => 'alice.heyjosi.test' });
const policy: HostPolicy = {
  keys: () => previousKey ? [serverKey, previousKey] : [serverKey],
  async authorize(hello, remote, keyIndex) {
    const id = toHex(remote);
    if (hello.op === 'pair') {
      if (!codes.delete(hello.code)) return { ok: false, error: 'bad_code' };
      paired.set(id, randomUUID());
    }
    const device = paired.get(id);
    if (!device) return { ok: false, error: 'unknown_device' };
    if (revoked.has(device)) return { ok: false, error: 'revoked' };
    hostState.connects++;
    return { device, client: 'windows', welcome: { ok: true, device, server: 'Alice server', lan: hostState.lanList, ...(keyIndex > 0 ? { rotate: { publicKey: toB64url(serverKey.publicKey), until: null } } : {}) } };
  },
  onRequest: call => bridge.handle(call),
  async onRotateDevice(device, oldKey, newKey) {
    if (hostState.rejectRotation) throw new Error('no');
    paired.set(toHex(newKey), device);
    if (hostState.dropOldKey) paired.delete(toHex(oldKey));
  },
};
const host = new TunnelHost(policy);
let lan = await lanListener(host, { port: 0, address: '127.0.0.1' });
const lanUrl = () => `ws://127.0.0.1:${lan.port}/__josi/noise`;

// ---- the stand-in relay
const relayState = { blackhole: false, online: true, tamperNext: false, hostile: false, delayOnline: 0, sent: 0, seenBytes: [] as Buffer[], lanDown: false };
const site = nodeRandom(16).toString('hex');
const invites = new Map<string, string>();
const relayHttp = createServer((req, res) => {
  const m = /^\/v1\/invites\/([0-9a-f]{32})$/.exec(req.url!);
  const box = m && invites.get(m[1]);
  res.writeHead(box ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(box ? { box, expires: 0 } : { error: 'no such code, or it expired' }));
});
const peers = new WebSocketServer({ noServer: true });
const sockets = new Set<import('ws').WebSocket>();
relayHttp.on('upgrade', (req, socket, head) => {
  if (req.url !== `/v1/sites/${site}/peer`) { socket.destroy(); return; }
  peers.handleUpgrade(req, socket, head, ws => {
    const id = nodeRandom(16).toString('hex');
    sockets.add(ws);
    host.open(id, {
      send: data => {
        const out = Buffer.from(data); relayState.sent++;
        if (relayState.blackhole) return;
        if (relayState.tamperNext) { relayState.tamperNext = false; out[out.length - 1] ^= 1; }
        ws.send(out);
      },
      close: () => ws.close(),
      buffered: () => ws.bufferedAmount,
    });
    ws.on('message', (data, binary) => { if (binary && !relayState.blackhole) { const b = Buffer.from(data as Buffer); relayState.seenBytes.push(b); host.data(id, new Uint8Array(b)); } });
    ws.on('close', () => { sockets.delete(ws); host.gone(id); });
    ws.on('error', () => ws.terminate());
    if (relayState.hostile) { ws.send('not json at all'); ws.send('{"type":"revoked"}'); ws.send('{"t":"rotate-server","publicKey":"AAAA"}'); }
    const say = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: relayState.online ? 'server-online' : 'server-offline' })); };
    if (relayState.delayOnline) setTimeout(say, relayState.delayOnline); else say();
  });
});
await new Promise<void>(r => relayHttp.listen(0, '127.0.0.1', r));
const relayPort = (relayHttp.address() as { port: number }).port;

// ---- control
const control = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const reply = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    switch (req.url) {
      case '/mint': {
        const code = newPairingCode(); codes.add(code);
        const box: InviteBox = { v: 1, server: toB64url(serverKey.publicKey), site, relay: `ws://127.0.0.1:${relayPort}`, name: 'alice', lan: body.lan ?? [] };
        invites.set(inviteId(code), sealInvite(code, box));
        return reply({ code, display: displayCode(code), link: pairingLink('https://alice.heyjosi.test', code, box), lanUrl: lanUrl(), relay: `http://127.0.0.1:${relayPort}` });
      }
      case '/lanlist': hostState.lanList = body.list; return reply({ ok: true });
      case '/lanurl': return reply({ url: lanUrl() });
      case '/set': Object.assign(relayState, body.relay ?? {}); Object.assign(hostState, body.host ?? {}); Object.assign(state, body.api ?? {}); return reply({ ok: true });
      case '/state': return reply({ api: { ...state, requests: state.requests.slice(-20) }, hostConnects: hostState.connects, connected: host.connected(), relaySent: relayState.sent });
      case '/seen': return reply({ contains: Buffer.concat(relayState.seenBytes).includes(Buffer.from(body.text)) });
      case '/revoke': revoked.add(body.device); return reply({ cut: host.disconnectDevice(body.device) });
      case '/rotate': {
        previousKey = serverKey; serverKey = staticKeyFrom(generateKeyPair().privateKey);
        host.announceRotation(serverKey.publicKey, null);
        return reply({ publicKey: toB64url(serverKey.publicKey) });
      }
      case '/rotate-quiet': previousKey = serverKey; serverKey = staticKeyFrom(generateKeyPair().privateKey); return reply({ publicKey: toB64url(serverKey.publicKey) });
      case '/drop-previous': previousKey = null; host.disconnectAll(); return reply({ ok: true });
      case '/forget': paired.clear(); host.disconnectAll(); return reply({ ok: true });
      case '/lan-down': await lan.close(); return reply({ ok: true });
      case '/lan-up': lan = await lanListener(host, { port: lan.port, address: '127.0.0.1' }); return reply({ url: lanUrl() });
      case '/forget-jar': bridge.forget(body.device); return reply({ ok: true });
      case '/rekey-fast': for (const live of (host as unknown as { peers: Map<string, { session: { rekeyMessages: number } | null }> }).peers.values()) if (live.session) live.session.rekeyMessages = body.n; return reply({ ok: true });
      case '/say-offline': for (const s of sockets) s.send('{"type":"server-offline"}'); return reply({ ok: true });
      case '/kick': for (const s of sockets) s.terminate(); return reply({ ok: true });
      case '/keys': return reply({ known: [...paired.keys()] });
      default: res.writeHead(404); res.end();
    }
  });
});
await new Promise<void>(r => control.listen(0, '127.0.0.1', r));
console.log(JSON.stringify({ control: (control.address() as { port: number }).port, server: toB64url(serverKey.publicKey), site }));
