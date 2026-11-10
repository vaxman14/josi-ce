// Network and address (build items 13 and 36, Windows): where this server
// answers, and changing its public address without the installer.
//
// Three shapes of address, told apart by the host:
//   localhost            only this PC; the proxy listens on the loopback
//   a LAN name or IP     this PC and the LAN over HTTPS with a certificate the
//                        proxy issues itself (Caddy's internal CA); the Josi
//                        app pins that CA on first contact, after showing it
//   a Tailscale name/IP  this PC's devices over Tailscale, served like a LAN
//                        address (HTTPS, Josi's own certificate); see setup/tailscale.ts
//   a public domain      served through a tunnel or a reverse proxy the
//                        administrator runs; the proxy file is left alone
// The change is written to runtime.json (and the proxy's Caddyfile where the
// installer made one) and takes effect on the next server start.
import { Router, type Request, type Response } from 'express';
import { networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDataPath, type Db } from '@josi-ce/core';
import { requireSuperAdmin } from './authz.js';
import { asyncRoute } from './async.js';
import { isTailscaleHost, tailscaleStatus } from '../setup/tailscale.js';

export type AddressMode = 'local' | 'lan' | 'tailscale' | 'public';

export function addressMode(url: URL): AddressMode {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'local';
  if (isTailscaleHost(host)) return 'tailscale';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home') || !host.includes('.') || host.includes(':')) return 'lan';
  return 'public';
}

export function lanAddresses(): Array<{ name: string; address: string }> {
  const out: Array<{ name: string; address: string }> = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      // Virtual adapters (VPN, Hyper-V, Docker) announce themselves by name.
      if (/virtual|vmware|hyper-v|vethernet|docker|wsl|tailscale|zerotier|loopback/i.test(name)) continue;
      out.push({ name, address: entry.address });
    }
  }
  return out;
}

/** The proxy file the installer writes, for a given public address. The
 * localhost form is the installer's own; the LAN form binds every interface
 * and lets Caddy issue the certificate. */
export function caddyfileFor(url: URL, apiPort: number): string | null {
  const mode = addressMode(url);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (mode === 'local') return ['{', '\tadmin off', '\tauto_https off', '}', '', `http://localhost:${port} {`, '\tbind 127.0.0.1', `\treverse_proxy 127.0.0.1:${apiPort}`, '}', ''].join('\n');
  if (mode === 'lan' || mode === 'tailscale') return ['{', '\tadmin off', '}', '', `https://${url.hostname}:${port} {`, '\ttls internal', `\treverse_proxy 127.0.0.1:${apiPort}`, '}', ''].join('\n');
  return null;
}

const DATA_DIR = () => resolveDataPath('/data');
const RUNTIME_FILE = () => join(DATA_DIR(), 'config', 'runtime.json');
const CADDYFILE = () => join(DATA_DIR(), 'config', 'Caddyfile');
const CA_ROOT = () => join(DATA_DIR(), 'proxy', 'caddy', 'pki', 'authorities', 'local', 'root.crt');

async function caRoot(): Promise<{ pem: string; fingerprint: string } | null> {
  try {
    const pem = await readFile(CA_ROOT(), 'utf8');
    const der = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
    const hex = createHash('sha256').update(der).digest('hex').toUpperCase();
    return { pem, fingerprint: hex.match(/.{2}/g)!.join(':') };
  } catch { return null; }
}

export function networkRoutes(ctx: { db: Db }): Router {
  void ctx;
  const r = Router();
  r.use(requireSuperAdmin);
  r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  r.get('/', asyncRoute(async (_req: Request, res: Response) => {
    const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '') || 'http://localhost:8080';
    const url = new URL(appUrl);
    let configured: string | null = null;
    try { configured = String(JSON.parse(await readFile(RUNTIME_FILE(), 'utf8')).publicUrl ?? '').replace(/\/$/, '') || null; } catch { configured = null; }
    const ca = await caRoot();
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const tailscale = await tailscaleStatus();
    return res.json({
      tailscale,
      // The address to offer: the MagicDNS name on the port already in use, over https.
      tailscaleUrl: tailscale.running && tailscale.name ? `https://${tailscale.name}:${port}` : null,
      publicUrl: appUrl, mode: addressMode(url), https: url.protocol === 'https:', port,
      apiPort: Number(process.env.PORT ?? 8080),
      lan: lanAddresses(),
      nativeRuntime: ['win32', 'darwin', 'linux'].includes(process.platform) && process.env.JOSI_NATIVE_RUNTIME === '1',
      editable: existsSync(RUNTIME_FILE()),
      proxyManaged: existsSync(CADDYFILE()),
      configuredUrl: configured,
      restartNeeded: configured !== null && configured !== appUrl,
      certificate: ca ? { fingerprint: ca.fingerprint } : null,
    });
  }));

  r.put('/', asyncRoute(async (req: Request, res: Response) => {
    const raw = typeof req.body?.publicUrl === 'string' ? req.body.publicUrl.trim().replace(/\/$/, '') : '';
    let url: URL;
    try { url = new URL(raw); } catch { return res.status(400).json({ error: 'Enter the address as https://name-or-ip:port, or http://localhost:port for this PC only.' }); }
    if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
      return res.status(400).json({ error: 'Use only the address and port, nothing after them.' });
    const mode = addressMode(url);
    if (url.protocol === 'http:' && mode !== 'local') return res.status(400).json({ error: 'Beyond this PC the address must be https. For the LAN, Josi issues the certificate itself.' });
    if (!['http:', 'https:'].includes(url.protocol)) return res.status(400).json({ error: 'Use https (or http for localhost).' });
    if (!existsSync(RUNTIME_FILE())) return res.status(503).json({ error: 'This server has no runtime settings file to change; set APP_URL where the server is started.' });
    const settings = JSON.parse(await readFile(RUNTIME_FILE(), 'utf8')) as Record<string, unknown>;
    settings.publicUrl = url.origin.replace(/\/$/, '');
    const temp = `${RUNTIME_FILE()}.${Date.now()}.tmp`;
    let proxy: 'written' | 'kept' | 'none' = 'none';
    try {
      await writeFile(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
      await rename(temp, RUNTIME_FILE());
      if (existsSync(CADDYFILE())) {
        const caddy = caddyfileFor(url, Number(settings.apiPort ?? process.env.PORT ?? 8080));
        if (caddy) { await writeFile(`${CADDYFILE()}.tmp`, caddy, { mode: 0o600 }); await rename(`${CADDYFILE()}.tmp`, CADDYFILE()); proxy = 'written'; }
        else proxy = 'kept';
      }
    } catch (e) {
      // The Windows installer lets the services only read their settings; an
      // administrator changes them. 409 tells the Josi app on this PC to make
      // the change itself with Windows administrator approval.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') throw e;
      return res.status(409).json({
        error: 'Changing the address needs Windows administrator approval. Save it from the Josi app on the server PC; Windows asks for approval.',
        needsAdministrator: true, publicUrl: settings.publicUrl, mode,
      });
    }
    return res.json({
      publicUrl: settings.publicUrl, mode, proxy,
      note: mode === 'local' ? 'Only this PC reaches Josi. Restart the server to apply.'
        : mode === 'lan' ? 'Josi answers on your network over HTTPS with its own certificate. Restart the server to apply; the first Josi app to connect shows the certificate and asks you to trust it once. Open the port in Windows Firewall if other PCs cannot reach it.'
        : mode === 'tailscale' ? 'Josi answers at its Tailscale address over HTTPS with its own certificate. Restart the server to apply. On each phone or PC, install Tailscale, sign in to the same account, and give the Josi app this address; it shows the certificate fingerprint once.'
        : 'A public domain is served through your tunnel or reverse proxy; point it at this PC. Restart the server to apply.',
    });
  }));
  return r;
}

/** The certificate authority the proxy issues LAN certificates from, for a
 * Josi app to pin after the person confirmed its fingerprint. Public: the
 * certificate is what every browser is shown anyway. */
export function networkPublicRoutes(): Router {
  const r = Router();
  r.get('/ca', asyncRoute(async (_req: Request, res: Response) => {
    const ca = await caRoot();
    if (!ca) return res.status(404).json({ error: 'This server issues no certificate of its own.' });
    res.set('Cache-Control', 'no-store');
    return res.json({ fingerprint: ca.fingerprint, pem: ca.pem });
  }));
  return r;
}
