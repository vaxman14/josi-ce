import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { TunnelHost, staticKeyFrom, generateKeyPair } from '@josi-ce/tunnel';
import { LAN_PATH, lanListener } from '@josi-ce/tunnel/node';

const host = () => new TunnelHost({ keys: () => [staticKeyFrom(generateKeyPair().privateKey)], authorize: async () => ({ ok: false, error: 'unknown_device' }), onRequest: () => undefined });

describe('the LAN listener', () => {
  it('speaks only Noise: no page, no API', async () => {
    const lan = await lanListener(host(), { port: 0, address: '127.0.0.1' });
    expect((await fetch(`http://127.0.0.1:${lan.port}/api/auth/me`)).status).toBe(404);
    await lan.close();
  });

  it('closes with a device still connected', async () => {
    const lan = await lanListener(host(), { port: 0, address: '127.0.0.1' });
    const socket = new WebSocket(`ws://127.0.0.1:${lan.port}${LAN_PATH}`);
    await new Promise(resolve => socket.once('open', resolve));
    await lan.close();
    await new Promise(resolve => socket.once('close', resolve));
  }, 5000);
});
