// The server-side pieces that need Node: the outbound link to the relay, the
// LAN listener, and the bridge that turns tunnelled requests into local ones.
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { concat, toHex, fromHex } from './bytes.js';
import type { IncomingCall, TunnelHost } from './host.js';
export * from './keyStore.js';
import { MAX_PIECE } from './mux.js';

export const LAN_PATH = '/__josi/noise';
export const DEFAULT_LAN_PORT = 18777;
const PING_MS = 30_000;

export type RelayState = 'stopped' | 'connecting' | 'online' | 'offline';

export class RelayLink {
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private stopped = true;
  private readonly peers = new Set<string>();
  state: RelayState = 'stopped';
  lastError: string | null = null;

  constructor(private readonly opts: { url: string; site: string; secret: () => string; host: TunnelHost; onState?: (state: RelayState) => void }) {}

  start(): void { if (this.stopped) { this.stopped = false; this.connect(); } }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.close();
    this.socket = null;
    this.dropPeers();
    this.set('stopped');
  }

  private set(state: RelayState): void { this.state = state; this.opts.onState?.(state); }

  private dropPeers(): void {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    for (const peer of this.peers) this.opts.host.gone(peer);
    this.peers.clear();
  }

  private connect(): void {
    this.set('connecting');
    const url = `${this.opts.url.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/sites/${this.opts.site}/server`;
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opts.secret()}` }, maxPayload: 128 * 1024, handshakeTimeout: 15_000 });
    this.socket = socket;
    let alive = true;
    socket.on('open', () => {
      this.attempt = 0; this.lastError = null; this.set('online');
      this.pinger = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false; socket.ping();
      }, PING_MS);
    });
    socket.on('pong', () => { alive = true; });
    socket.on('message', (data, binary) => {
      alive = true;
      const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (binary) {
        if (raw.length > 16) this.opts.host.data(toHex(raw.subarray(0, 16)), new Uint8Array(raw.subarray(16)));
        return;
      }
      let message: { type?: string; peer?: string };
      try { message = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (message.type === 'peer-open' && message.peer) this.openPeer(socket, message.peer);
      else if (message.type === 'peer-close' && message.peer) { this.peers.delete(message.peer); this.opts.host.gone(message.peer); }
    });
    socket.on('unexpected-response', (_req, res) => { this.lastError = `relay answered ${res.statusCode}`; socket.terminate(); });
    socket.on('error', err => { this.lastError ??= err.message; });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.dropPeers();
      if (this.stopped) return;
      this.set('offline');
      const delay = Math.min(60_000, 1000 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
      this.retry = setTimeout(() => this.connect(), delay);
    });
  }

  private openPeer(socket: WebSocket, peer: string): void {
    const id = fromHex(peer);
    this.peers.add(peer);
    this.opts.host.open(peer, {
      send: data => { if (socket.readyState === WebSocket.OPEN) socket.send(concat(id, data)); },
      close: () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'kick', peer })); },
      buffered: () => socket.bufferedAmount,
    });
  }
}

/** The direct path. Only Noise frames are spoken here: no page, no API, and no
 * trust in being on the LAN, since a device still has to complete the same
 * handshake it would over the relay. */
export function lanListener(host: TunnelHost, opts: { port: number; address?: string }): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  let next = 0;
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== LAN_PATH) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      const id = `lan-${++next}`;
      host.open(id, { send: data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); }, close: () => ws.close(), buffered: () => ws.bufferedAmount });
      ws.on('message', (data, binary) => { if (binary) host.data(id, new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : data as Buffer)); });
      ws.on('close', () => host.gone(id));
      ws.on('error', () => ws.terminate());
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.address ?? '0.0.0.0', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : opts.port,
        // An upgraded socket has left the HTTP server's hands, so closing the server
        // alone would wait on it forever.
        close: () => new Promise(done => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.close(() => done()); server.closeAllConnections(); }) });
    });
  });
}

const HOP_BY_HOP = /^(connection|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-.*|host|forwarded|x-forwarded-.*|x-real-ip|cf-.*)$/i;

/** A device on the tunnel without its own bearer session never holds a session
 * cookie: a service worker can't set one, and this way page script can't read
 * one either. The server keeps the jar per device, in memory, so a restart signs
 * those devices out. */
class CookieJar {
  private readonly cookies = new Map<string, string>();
  header(): string { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  get(name: string): string | undefined { return this.cookies.get(name); }
  absorb(lines: string[] | undefined): void {
    for (const line of lines ?? []) {
      const [pair, ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      if (at < 1) continue;
      const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
      const expired = !value || attributes.some(a => {
        const [k, v] = a.split('=').map(s => s.trim().toLowerCase());
        return (k === 'max-age' && Number(v) <= 0) || (k === 'expires' && Date.parse(v) <= Date.now());
      });
      if (expired) this.cookies.delete(name); else this.cookies.set(name, value);
    }
  }
}

/** A stable private address per device, so per-address limits and the audit
 * trail tell tunnelled devices apart. */
function deviceAddress(device: string): string {
  const h = createHash('sha256').update(device).digest('hex');
  return `fd4a:6f73:6900:${h.slice(0, 4)}:${h.slice(4, 8)}:${h.slice(8, 12)}:${h.slice(12, 16)}:${h.slice(16, 20)}`;
}

export interface BridgeOptions {
  /** The local API. */
  port: number;
  /** What the API should see as its address, e.g. alice.heyjosi.com. */
  publicHost: () => string;
  csrfCookie?: string;
  csrfHeader?: string;
}

export function httpBridge(opts: BridgeOptions): { handle(call: IncomingCall): void; forget(device: string): void } {
  const jars = new Map<string, CookieJar>();
  const csrfCookie = opts.csrfCookie ?? 'josi_csrf', csrfHeader = opts.csrfHeader ?? 'x-josi-csrf';
  const jarOf = (device: string) => { let jar = jars.get(device); if (!jar) jars.set(device, jar = new CookieJar()); return jar; };

  function handle(call: IncomingCall): void {
    const jarred = !call.head.headers.some(([key, value]) => /^authorization$/i.test(key) && /^Bearer\s/i.test(value));
    const headers: Record<string, string> = {};
    for (const [key, value] of call.head.headers) if (!HOP_BY_HOP.test(key) && !(jarred && /^cookie$/i.test(key))) headers[key.toLowerCase()] = value;
    headers.host = opts.publicHost();
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-for'] = deviceAddress(call.device);
    if (jarred) {
      const jar = jarOf(call.device), cookie = jar.header(), csrf = jar.get(csrfCookie);
      if (cookie) headers.cookie = cookie;
      if (csrf) headers[csrfHeader] = decodeURIComponent(csrf);
    }
    const local = httpRequest({ host: '127.0.0.1', port: opts.port, method: call.head.method, path: call.head.path, headers }, res => {
      const out: Array<[string, string]> = [];
      const raw: IncomingHttpHeaders = res.headers;
      for (const [key, value] of Object.entries(raw)) {
        if (HOP_BY_HOP.test(key) || value === undefined) continue;
        if (jarred && key === 'set-cookie') continue;
        for (const item of Array.isArray(value) ? value : [value]) out.push([key, item]);
      }
      if (jarred) jarOf(call.device).absorb(res.headers['set-cookie']);
      call.respond(res.statusCode ?? 502, out);
      void (async () => {
        try {
          for await (const chunk of res as AsyncIterable<Buffer>) {
            for (let at = 0; at < chunk.length; at += MAX_PIECE) await call.write(new Uint8Array(chunk.subarray(at, at + MAX_PIECE)));
          }
          call.end();
        } catch { try { call.reset(); } catch { /* the peer is gone */ } }
      })();
    });
    local.on('error', () => { try { call.reset(); } catch { /* the peer is gone */ } });
    call.onBody = piece => { if (piece) local.write(piece); else local.end(); };
    call.onCancel = () => local.destroy();
  }
  return { handle, forget: device => { jars.delete(device); } };
}
