import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { privateTemporaryDirectory } from '@josi-ce/core';
import { nativeVoiceHelper } from '../src/http/voiceBoxRoutes.js';

const directories: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = privateTemporaryDirectory('josi-voice-transport-');
  directories.push(directory);
  const tokenFile = join(directory, 'token'), token = randomBytes(32).toString('hex');
  await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
  const seen: Array<{ path: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url!, body: Buffer.concat(chunks).toString() });
    if (req.url === '/speech') { res.writeHead(200).end(Buffer.alloc(4 * 1024 * 1024 + 1)); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"accepted":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { helper: nativeVoiceHelper({ port: (server.address() as AddressInfo).port, tokenFile }), tokenFile, seen };
}

describe('native voice transport boundary', () => {
  it('authenticates to a real loopback listener and transmits exact request bodies', async () => {
    const { helper, seen, tokenFile } = await fixture();
    expect((await helper('/operation/settings', { model: 'base.en' })).status).toBe(200);
    expect(seen).toEqual([{ path: '/operation/settings', body: '{"model":"base.en"}' }]);
    await writeFile(tokenFile, '0'.repeat(64));
    expect((await helper('/status')).status).toBe(401);
    expect(seen).toHaveLength(1);
  });
  it('rejects arbitrary targets, oversized requests and invalid credentials before sending', async () => {
    const { helper, seen, tokenFile } = await fixture();
    for (const path of ['http://example.test/', '//example.test/', '/exec', '/status?command=anything']) {
      await expect(helper(path)).rejects.toThrow();
    }
    await expect(helper('/speech', { text: 'a'.repeat(100001) })).rejects.toThrow();
    await writeFile(tokenFile, 'invalid');
    await expect(helper('/status')).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
  it('terminates an oversized response from the local peer', async () => {
    const { helper } = await fixture();
    await expect(helper('/speech', { text: 'test' })).rejects.toThrow();
  });
});
