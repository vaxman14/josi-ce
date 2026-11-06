// Tailscale as a way to reach this server from a phone or another PC without
// a public domain or port forwarding. Josi does not bundle Tailscale: the
// person installs it on the server and on each device and signs both in to
// the same account. This module only asks the installed Tailscale for its
// state, so the Network page can offer the server's Tailscale name as the
// public address. The address is served like a LAN one: the proxy answers
// over HTTPS with Josi's own certificate, which the Josi apps pin once.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface TailscaleStatus {
  /** A Tailscale command was found on this machine. */
  installed: boolean;
  /** Signed in and connected (BackendState "Running"). */
  running: boolean;
  /** What Tailscale reports when it is installed but not running. */
  state: string | null;
  /** The MagicDNS name of this machine, without the trailing dot. */
  name: string | null;
  /** The Tailscale IPv4 and IPv6 addresses of this machine. */
  ips: string[];
  /** The tailnet's name, usually the account or organisation. */
  tailnet: string | null;
  /** The account this machine is signed in as. */
  loginName: string | null;
  version: string | null;
  /** Names Tailscale would issue a public certificate for (HTTPS enabled in the tailnet). */
  certDomains: string[];
  /** Why the state could not be read, in plain words, or null. */
  error: string | null;
}

const NOT_INSTALLED: TailscaleStatus = { installed: false, running: false, state: null, name: null, ips: [], tailnet: null, loginName: null, version: null, certDomains: [], error: null };

/** Where Tailscale installs its command on each platform. */
export function tailscaleCandidates(platform = process.platform, env = process.env): string[] {
  const override = env.JOSI_TAILSCALE_EXE;
  if (override) return [override];
  if (platform === 'win32') {
    return [win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
      win32.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe')];
  }
  if (platform === 'darwin') {
    return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'];
  }
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale'];
}

/** Tailscale's IPv4 range (100.64.0.0/10) and IPv6 prefix, so an address a
 * person types by hand is recognised as a Tailscale one too. */
export function isTailscaleHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h.endsWith('.ts.net')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return h.startsWith('fd7a:115c:a1e0');
}

/** `tailscale status --json`, reduced to what the Network page shows. */
export function parseTailscaleStatus(text: string): TailscaleStatus {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const self = (raw.Self ?? {}) as Record<string, unknown>;
  const tailnet = (raw.CurrentTailnet ?? {}) as Record<string, unknown>;
  const user = Object.values((raw.User ?? {}) as Record<string, Record<string, unknown>>).find((u) => typeof u.LoginName === 'string' && u.LoginName !== 'tagged-devices');
  const state = typeof raw.BackendState === 'string' ? raw.BackendState : null;
  const name = typeof self.DNSName === 'string' && self.DNSName ? self.DNSName.replace(/\.$/, '') : null;
  return {
    installed: true,
    running: state === 'Running',
    state,
    name,
    ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string') : [],
    tailnet: typeof tailnet.Name === 'string' && tailnet.Name ? tailnet.Name : typeof raw.MagicDNSSuffix === 'string' ? raw.MagicDNSSuffix : null,
    loginName: user && typeof user.LoginName === 'string' ? user.LoginName : null,
    version: typeof raw.Version === 'string' ? raw.Version.split('-')[0] : null,
    certDomains: Array.isArray(raw.CertDomains) ? raw.CertDomains.filter((d): d is string => typeof d === 'string') : [],
    error: null,
  };
}

/** Asks the installed Tailscale for its state. Never throws: a missing or
 * silent Tailscale is reported, not raised, because the Network page must
 * still render without it. */
export async function tailscaleStatus(candidates = tailscaleCandidates()): Promise<TailscaleStatus> {
  const exe = candidates.find((path) => existsSync(path));
  if (!exe) return NOT_INSTALLED;
  return new Promise((resolve) => {
    execFile(exe, ['status', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      // tailscale exits non-zero when it is stopped or needs a login, but still prints the JSON.
      try {
        if (!String(stdout).trim()) throw error ?? new Error('no output');
        resolve(parseTailscaleStatus(String(stdout)));
      } catch (e) {
        resolve({ ...NOT_INSTALLED, installed: true, error: 'Tailscale is installed but did not answer: ' + (e instanceof Error ? e.message : String(e)) });
      }
    });
  });
}
