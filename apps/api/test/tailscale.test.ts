// Tailscale as a public address: a Tailscale name or IP is its own address
// mode, served like a LAN one (HTTPS with Josi's own certificate), and the
// installed Tailscale's state is read without ever throwing.
import { describe, expect, it } from 'vitest';
import { addressMode, caddyfileFor } from '../src/http/networkRoutes.js';
import { isTailscaleHost, parseTailscaleStatus, tailscaleCandidates, tailscaleStatus } from '../src/setup/tailscale.js';

const STATUS = JSON.stringify({
  Version: '1.90.2-t1234abcd',
  BackendState: 'Running',
  Self: { HostName: 'thebutt', DNSName: 'thebutt.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'], Online: true },
  MagicDNSSuffix: 'tail1234.ts.net',
  CurrentTailnet: { Name: 'roman@example.com', MagicDNSSuffix: 'tail1234.ts.net', MagicDNSEnabled: true },
  CertDomains: ['thebutt.tail1234.ts.net'],
  User: { '123': { ID: 123, LoginName: 'roman@example.com', DisplayName: 'Roman' } },
});

describe('Tailscale addresses', () => {
  it('recognises MagicDNS names and the Tailscale IP ranges', () => {
    for (const host of ['thebutt.tail1234.ts.net', 'THEBUTT.TAIL1234.TS.NET.', '100.64.0.1', '100.101.102.103', '100.127.255.254', 'fd7a:115c:a1e0::1', '[fd7a:115c:a1e0::1]'])
      expect(isTailscaleHost(host), host).toBe(true);
    for (const host of ['localhost', '100.63.255.255', '100.128.0.1', '192.168.1.20', 'nas.local', 'ce.heyjosi.com', 'tsnet.example'])
      expect(isTailscaleHost(host), host).toBe(false);
  });

  it('is its own address mode, served like the LAN', () => {
    expect(addressMode(new URL('https://thebutt.tail1234.ts.net:8080'))).toBe('tailscale');
    expect(addressMode(new URL('https://100.101.102.103:8080'))).toBe('tailscale');
    expect(addressMode(new URL('https://192.168.1.20:8080'))).toBe('lan');
    expect(addressMode(new URL('https://ce.heyjosi.com'))).toBe('public');
    const caddy = caddyfileFor(new URL('https://thebutt.tail1234.ts.net:8080'), 8081);
    expect(caddy).toContain('https://thebutt.tail1234.ts.net:8080 {');
    expect(caddy).toContain('tls internal');
    expect(caddy).toContain('reverse_proxy 127.0.0.1:8081');
  });

  it('reduces tailscale status --json to what the page shows', () => {
    const status = parseTailscaleStatus(STATUS);
    expect(status).toMatchObject({
      installed: true, running: true, state: 'Running', name: 'thebutt.tail1234.ts.net',
      ips: ['100.101.102.103', 'fd7a:115c:a1e0::1'], tailnet: 'roman@example.com', loginName: 'roman@example.com',
      version: '1.90.2', certDomains: ['thebutt.tail1234.ts.net'], error: null,
    });
    const stopped = parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '', TailscaleIPs: null } }));
    expect(stopped).toMatchObject({ installed: true, running: false, state: 'NeedsLogin', name: null, ips: [] });
  });

  it('reports a missing Tailscale instead of failing', async () => {
    expect(await tailscaleStatus(['/nowhere/tailscale', 'C:\\nowhere\\tailscale.exe'])).toMatchObject({ installed: false, running: false, error: null });
    expect(tailscaleCandidates('win32', { ProgramFiles: 'C:\\Program Files' })[0]).toBe('C:\\Program Files\\Tailscale\\tailscale.exe');
    expect(tailscaleCandidates('linux', {})).toContain('/usr/bin/tailscale');
    expect(tailscaleCandidates('linux', { JOSI_TAILSCALE_EXE: '/opt/ts' })).toEqual(['/opt/ts']);
  });
});
