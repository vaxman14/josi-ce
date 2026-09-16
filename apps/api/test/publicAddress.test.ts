import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@josi-ce/core';
import { publicAddressFromEnvironment, reconcilePublicAddress } from '../src/setup/publicAddress.js';

describe('canonical public-address reconciliation', () => {
  it('preserves the browser-facing port and maps proxy mode', () => {
    expect(publicAddressFromEnvironment('https://Josi.Example.test:8443/', 'proxy')).toEqual({
      origin: 'https://josi.example.test:8443',
      hostname: 'josi.example.test',
      tlsMode: 'external_proxy',
    });
  });

  it('accepts a LAN HTTP origin but rejects unsafe and contradictory origins', () => {
    expect(publicAddressFromEnvironment('http://192.168.1.20:8081', 'lan').origin)
      .toBe('http://192.168.1.20:8081');
    expect(() => publicAddressFromEnvironment('http://josi.example.test', 'domain')).toThrow(/HTTPS/);
    expect(() => publicAddressFromEnvironment('https://user:pass@josi.example.test', 'proxy')).toThrow(/valid/);
    expect(() => publicAddressFromEnvironment('https://josi.example.test/path', 'proxy')).toThrow(/valid/);
  });

  it.each([
    ['LAN to bundled-Caddy domain', 'https://one.example.test', 'domain', 'one.example.test', 'bundled_caddy'],
    ['domain to another domain', 'https://two.example.test:8443', 'domain', 'two.example.test', 'bundled_caddy'],
    ['domain to LAN recovery', 'http://192.168.1.30:8080', 'lan', '192.168.1.30', 'bundled_caddy'],
    ['domain to external proxy or Tunnel', 'https://tunnel.example.test', 'proxy', 'tunnel.example.test', 'external_proxy'],
  ] as const)('normalizes %s transitions from the runtime environment', (_label, origin, mode, hostname, tlsMode) => {
    expect(publicAddressFromEnvironment(origin, mode)).toEqual({ origin, hostname, tlsMode });
  });

  it('updates deployment, workspace, OAuth, and webhook metadata in one statement', async () => {
    const query = vi.fn(async () => []);
    await reconcilePublicAddress({ query } as unknown as Db, {
      origin: 'https://new.example.test:8443',
      hostname: 'new.example.test',
      tlsMode: 'external_proxy',
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('update deployment_config');
    expect(sql).toContain('update workspace');
    expect(sql).toContain('update oauth_clients');
    expect(sql).toContain('update telegram_config');
    expect(sql).toContain("'{publicAddress}', to_jsonb($3::text)");
    expect(sql).toContain('certificate_verified_at = case when domain is distinct from $1 then null');
    expect(values).toEqual(['new.example.test', 'external_proxy', 'https://new.example.test:8443']);
  });

  it('propagates a database failure so the new runtime never becomes ready', async () => {
    const failure = new Error('transaction failed');
    const db = { query: vi.fn(async () => { throw failure; }) } as unknown as Db;
    await expect(reconcilePublicAddress(db, {
      origin: 'https://new.example.test', hostname: 'new.example.test', tlsMode: 'bundled_caddy',
    })).rejects.toBe(failure);
  });
});
