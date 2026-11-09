// The tunnel worker. It answers every same-origin request by sending it through
// Noise to the person's own server, so the app runs as usual with no idea it's
// tunnelled. The worker can be stopped at any moment, so a session is only ever
// a cache: the IK handshake is one round trip, and it is redone on demand.
/// <reference lib="webworker" />
import { TunnelClient, TunnelError } from './client.js';
import { fromB64url } from './bytes.js';
import { clearPairing, loadPairing, savePairing, staticKeyOf, type Pairing } from './browserStore.js';
import { webSocketTransport } from './transport.js';

declare const self: ServiceWorkerGlobalScope;

let connecting: Promise<TunnelClient> | null = null;
let client: TunnelClient | null = null;

self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

async function connect(pairing: Pairing, server: string): Promise<TunnelClient> {
  const transport = await webSocketTransport(`${self.location.protocol === 'https:' ? 'wss' : 'ws'}://${self.location.host}/__josi/connect`, { relay: true });
  const next = await TunnelClient.connect({
    transport, key: staticKeyOf(pairing), serverPublic: fromB64url(server),
    hello: { v: 1, op: 'connect', client: 'web', ts: Date.now() },
  });
  next.onServerRotation = notice => { void savePairing({ ...pairing, server: notice.publicKey, previousServer: pairing.server }); };
  next.onRevoked = () => { void clearPairing(); };
  next.onClose = () => { if (client === next) client = null; };
  return next;
}

function tunnel(): Promise<TunnelClient> {
  if (client && !client.isClosed) return Promise.resolve(client);
  connecting ??= (async () => {
    const pairing = await loadPairing();
    if (!pairing) throw new TunnelError('unpaired');
    try {
      client = await connect(pairing, pairing.server);
    } catch (error) {
      if (error instanceof TunnelError && (error.code === 'revoked' || error.code === 'unknown_device')) await clearPairing();
      throw error;
    }
    return client;
  })().finally(() => { connecting = null; });
  return connecting;
}

function notice(title: string, text: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Josi</title><link rel="stylesheet" href="/__josi/loader.css"><main><h1>${title}</h1><p>${text}</p><p><a href="/">Try again</a></p></main></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function forward(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // A navigation is the one request another site can aim at this worker. A
  // cross-site form post must not arrive with this device's session, so
  // navigations may only read.
  if (request.mode === 'navigate' && request.method !== 'GET') return new Response('', { status: 403 });
  let body: Uint8Array | null = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') body = new Uint8Array(await request.arrayBuffer());
  try {
    const session = await tunnel();
    const response = await session.request(
      { method: request.method, path: url.pathname + url.search, headers: Array.from((request.headers as unknown as { entries(): IterableIterator<[string, string]> }).entries()) },
      body, request.signal,
    );
    const bare = response.status === 204 || response.status === 205 || response.status === 304 || request.method === 'HEAD';
    const headers = new Headers();
    for (const [key, value] of response.headers) { try { headers.append(key, value); } catch { /* not a header a Response may carry */ } }
    if (response.status < 200 || response.status > 599) return new Response('', { status: 502 });
    return new Response(bare ? null : response.body, { status: response.status, headers });
  } catch (error) {
    const code = error instanceof TunnelError ? error.code : '';
    const page = request.mode === 'navigate';
    if (code === 'unpaired' || code === 'revoked' || code === 'unknown_device') {
      await self.registration.unregister();
      return page ? Response.redirect('/', 302) : new Response('', { status: 401 });
    }
    if (!page) return new Response(JSON.stringify({ error: 'Your Josi server can\'t be reached right now.' }), { status: 503, headers: { 'content-type': 'application/json' } });
    return code === 'offline'
      ? notice('Your Josi server is offline', 'It isn\'t connected right now. Check that its computer is on, then try again.', 503)
      : notice('That didn\'t work', 'Josi couldn\'t be reached just now.', 503);
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/__josi/')) return;
  event.respondWith(forward(event.request));
});
