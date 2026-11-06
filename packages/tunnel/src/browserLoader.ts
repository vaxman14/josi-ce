// The page the relay hands a browser. It holds no Josi code of its own: it pairs
// the browser if needed, installs the tunnel worker, and reloads. From then on
// every page, script and API call comes from the person's own server, through
// the worker, end to end.
import { TunnelClient, TunnelError } from './client.js';
import { fromB64url } from './bytes.js';
import { inviteId, isPairingCode, normalizeCode, openInvite, parsePairingLink, type InviteBox } from './pairing.js';
import { loadPairing, newBrowserKey, savePairing, staticKeyOf } from './browserStore.js';
import { webSocketTransport } from './transport.js';

const statusLine = document.getElementById('status')!;
const form = document.getElementById('pair') as HTMLFormElement;
const input = document.getElementById('code') as HTMLInputElement;
const say = (text: string) => { statusLine.textContent = text; };

async function installWorker(): Promise<void> {
  const registration = await navigator.serviceWorker.register('/__josi/sw.js', { scope: '/' });
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (worker && worker.state !== 'activated') {
    await new Promise<void>(resolve => worker.addEventListener('statechange', () => { if (worker.state === 'activated') resolve(); }));
  }
}

async function pair(code: string, box: InviteBox): Promise<void> {
  const fresh = await newBrowserKey();
  const transport = await webSocketTransport(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__josi/connect`, { relay: true });
  const client = await TunnelClient.connect({
    transport, key: staticKeyOf(fresh), serverPublic: fromB64url(box.server),
    hello: { v: 1, op: 'pair', code, name: browserName(), platform: 'web', ts: Date.now() },
  });
  await savePairing({ ...fresh, site: box.site, server: box.server, device: client.welcome.device });
  client.close();
}

function browserName(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  const system = /iPhone|iPad/.test(agent) ? 'iPhone or iPad' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}

function explain(error: unknown): string {
  const code = error instanceof TunnelError ? error.code : '';
  if (code === 'bad_code') return 'That code was wrong, used, or expired. Make a new one on your server.';
  if (code === 'offline') return 'Your Josi server is not connected right now. Check that its computer is on, then try again.';
  return error instanceof Error ? error.message : 'Pairing failed. Try again.';
}

async function pairWithCode(raw: string): Promise<void> {
  const code = normalizeCode(raw);
  if (!isPairingCode(code)) { say('That doesn\'t look like a pairing code. It has 32 characters.'); return; }
  say('Pairing…');
  const res = await fetch(`/__josi/invite/${inviteId(code)}`, { cache: 'no-store' });
  if (!res.ok) { say('That code was wrong, used, or expired. Make a new one on your server.'); return; }
  const { box } = await res.json() as { box: string };
  await pair(code, openInvite(code, box));
  await finish();
}

async function finish(): Promise<void> {
  say('Opening Josi…');
  await installWorker();
  location.replace('/');
}

async function main(): Promise<void> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) { say('This browser can\'t open Josi securely. Try a current version of Chrome, Edge, Safari or Firefox.'); return; }
  const fromLink = parsePairingLink(location.href);
  if (fromLink) {
    history.replaceState(null, '', '/');   // the code shouldn't sit in history or the address bar
    say('Pairing…');
    await pair(fromLink.code, fromLink.box);
    await finish();
    return;
  }
  if (await loadPairing()) { await finish(); return; }
  say('Pair this browser with your Josi server to open it here.');
  form.hidden = false;
  form.addEventListener('submit', event => {
    event.preventDefault();
    void pairWithCode(input.value).catch(error => say(explain(error)));
  });
}

main().catch(error => say(explain(error)));
