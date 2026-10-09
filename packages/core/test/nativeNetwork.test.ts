import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { apiListenHost } from '../src/nativeNetwork.js';

describe('native listener boundary', () => {
  it('keeps native listeners private regardless of advertised address', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(apiListenHost({ JOSI_NATIVE_RUNTIME: '1', APP_URL: 'https://example.com' }, platform)).toBe('127.0.0.1');
    }
    expect(apiListenHost({}, 'linux')).toBeUndefined();
    expect(apiListenHost({}, 'win32')).toBe('127.0.0.1');
  });
  it('opens a real loopback socket on an ephemeral port', async () => {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, apiListenHost({ JOSI_NATIVE_RUNTIME: '1' }, 'darwin'), resolve);
      });
      expect(server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    } finally {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    }
  });
});
