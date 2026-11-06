// Runs the real relay Worker code between a real server end and real devices.
// `relay.seen` is everything the relay was handed, which is the point: these
// tests are about what that contains.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TunnelClient, TunnelError, TunnelHost, generateKeyPair, newPairingCode, staticKeyFrom, toHex, utf8, type Authorized, type HostPolicy, type IncomingCall, type StaticKey, type Transport } from '@josi-ce/tunnel';
import { fakeRelay, type FakeSocket } from './fakeWorkers.js';

const SECRET_TEXT = 'my-private-mail-subject-rosebud';

function asTransport(socket: FakeSocket): Transport {
  const transport: Transport = { onMessage: null, onClose: null, send: data => socket.send(data), close: () => socket.close() };
  socket.onmessage = data => { if (typeof data !== 'string') transport.onMessage?.(new Uint8Array(data)); };
  socket.onclose = (_code, reason) => transport.onClose?.(reason || 'closed');
  return transport;
}

/** The server's relay socket, by hand, as RelayLink does it over a real one. */
function attachServer(socket: FakeSocket, host: TunnelHost) {
  socket.onmessage = data => {
    if (typeof data === 'string') {
      const message = JSON.parse(data) as { type: string; peer: string };
      if (message.type === 'peer-open') {
        const id = Uint8Array.from(Buffer.from(message.peer, 'hex'));
        host.open(message.peer, {
          send: bytes => { const out = new Uint8Array(16 + bytes.length); out.set(id); out.set(bytes, 16); socket.send(out); },
          close: () => socket.send(JSON.stringify({ type: 'kick', peer: message.peer })),
        });
      } else if (message.type === 'peer-close') host.gone(message.peer);
      return;
    }
    const raw = new Uint8Array(data);
    host.data(toHex(raw.subarray(0, 16)), raw.subarray(16));
  };
}

describe('through the relay', () => {
  let relay: Awaited<ReturnType<typeof fakeRelay>>;
  let site: string, secret: string, host: TunnelHost, serverKey: StaticKey;
  const paired = new Map<string, string>();
  const codes = new Set<string>();
  const revoked = new Set<string>();
  const calls: IncomingCall[] = [];

  beforeAll(async () => {
    relay = await fakeRelay({ env: { OPEN_RELAY: '1' } });
    const res = await relay.fetch('https://relay.heyjosi.test/v1/sites', { method: 'POST', body: JSON.stringify({ name: 'alice' }) });
    ({ site, secret } = await res.json() as { site: string; secret: string });
    serverKey = staticKeyFrom(generateKeyPair().privateKey);
    const policy: HostPolicy = {
      keys: () => [serverKey],
      async authorize(hello, remote) {
        const id = toHex(remote);
        if (hello.op === 'pair') {
          if (!codes.delete(hello.code)) return { ok: false, error: 'bad_code' };
          paired.set(id, `device-${paired.size + 1}`);
        }
        const device = paired.get(id);
        if (!device) return { ok: false, error: 'unknown_device' };
        if (revoked.has(device)) return { ok: false, error: 'revoked' };
        return { device, client: 'cli', welcome: { ok: true, device, server: 'alice' } } satisfies Authorized;
      },
      onRequest(call) {
        calls.push(call);
        const chunks: Uint8Array[] = [];
        call.onBody = piece => {
          if (piece) { chunks.push(piece); return; }
          call.respond(200, [['content-type', 'text/plain']]);
          void call.write(utf8(`echo ${Buffer.concat(chunks).toString()}`)).then(() => call.end());
        };
      },
    };
    host = new TunnelHost(policy);
    attachServer(await relay.connect(`https://relay.heyjosi.test/v1/sites/${site}/server`, { headers: { Authorization: `Bearer ${secret}` } }), host);
  });
  afterAll(() => relay.restore());

  const device = () => staticKeyFrom(generateKeyPair().privateKey);
  const open = async () => asTransport(await relay.connect('https://alice.heyjosi.test/__josi/connect', { testHost: 'alice.heyjosi.test' }));
  const pair = async (key: StaticKey) => {
    const code = newPairingCode(); codes.add(code);
    return TunnelClient.connect({ transport: await open(), key, serverPublic: serverKey.publicKey, hello: { v: 1, op: 'pair', code, name: 'Phone', platform: 'ios', ts: Date.now() } });
  };
  const read = async (client: TunnelClient, body: string) => {
    const res = await client.request({ method: 'POST', path: '/api/x', headers: [] }, utf8(body));
    return new Response(res.body).text();
  };

  it('carries a request end to end, and the relay holds only ciphertext', async () => {
    const client = await pair(device());
    expect(await read(client, SECRET_TEXT)).toBe(`echo ${SECRET_TEXT}`);
    expect(relay.seen.length).toBeGreaterThan(3);
    const everything = Buffer.concat(relay.seen.map(frame => Buffer.from(frame)));
    expect(everything.includes(Buffer.from(SECRET_TEXT))).toBe(false);
    expect(everything.includes(Buffer.from('/api/x'))).toBe(false);
    expect(everything.includes(Buffer.from('"op"'))).toBe(false);
    client.close();
  });

  it('never carries a pairing code in the clear', async () => {
    const before = relay.seen.length;
    const code = newPairingCode(); codes.add(code);
    const client = await TunnelClient.connect({ transport: await open(), key: device(), serverPublic: serverKey.publicKey, hello: { v: 1, op: 'pair', code, name: 'Phone', platform: 'ios', ts: Date.now() } });
    const after = Buffer.concat(relay.seen.slice(before).map(frame => Buffer.from(frame)));
    expect(after.includes(Buffer.from(code))).toBe(false);
    client.close();
  });

  it('ends the session when the relay changes a byte', async () => {
    const key = device(), client = await pair(key);
    const transport = (client as unknown as { transport: Transport }).transport;
    const forward = transport.send;
    transport.send = data => { const bad = data.slice(); bad[bad.length - 1] ^= 1; forward(bad); };
    const closed = new Promise<void>(resolve => { client.onClose = () => resolve(); });
    await client.request({ method: 'GET', path: '/', headers: [] }).catch(() => undefined);
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 200))]);
    expect(calls.at(-1)?.head.path).not.toBe('/');
  });

  it('cannot be fooled by a relay that answers with its own key', async () => {
    const impostor = staticKeyFrom(generateKeyPair().privateKey);
    await expect(TunnelClient.connect({ transport: await open(), key: device(), serverPublic: impostor.publicKey, hello: { v: 1, op: 'connect', client: 'cli', ts: Date.now() } }))
      .rejects.toThrow();
  });

  it('refuses a device that never paired, and a code used twice', async () => {
    await expect(TunnelClient.connect({ transport: await open(), key: device(), serverPublic: serverKey.publicKey, hello: { v: 1, op: 'connect', client: 'cli', ts: Date.now() } }))
      .rejects.toMatchObject({ code: 'unknown_device' });
    const code = newPairingCode(); codes.add(code);
    const hello = { v: 1 as const, op: 'pair' as const, code, name: 'A', platform: 'ios', ts: Date.now() };
    (await TunnelClient.connect({ transport: await open(), key: device(), serverPublic: serverKey.publicKey, hello })).close();
    await expect(TunnelClient.connect({ transport: await open(), key: device(), serverPublic: serverKey.publicKey, hello })).rejects.toBeInstanceOf(TunnelError);
  });

  it('cuts a revoked device off at once and keeps it out', async () => {
    const key = device(), client = await pair(key);
    const told = new Promise<void>(resolve => { client.onRevoked = () => resolve(); });
    revoked.add(client.welcome.device);
    expect(host.disconnectDevice(client.welcome.device)).toBe(1);
    await told;
    await expect(TunnelClient.connect({ transport: await open(), key, serverPublic: serverKey.publicKey, hello: { v: 1, op: 'connect', client: 'cli', ts: Date.now() } }))
      .rejects.toMatchObject({ code: 'revoked' });
  });

  it('serves the same fixed loader at every path and passes nothing to the server', async () => {
    const before = relay.seen.length;
    const [one, two] = await Promise.all(['/', '/api/auth/me?secret=1'].map(path => relay.fetch(`https://alice.heyjosi.test${path}`, { testHost: 'alice.heyjosi.test' }).then(r => r.text())));
    expect(one).toBe(two);
    expect(one).toContain('/__josi/loader.js');
    expect(relay.seen.length).toBe(before);
    const worker = await relay.fetch('https://alice.heyjosi.test/sw.js', { testHost: 'alice.heyjosi.test' });
    expect(worker.status).toBe(404);
  });

  it('keeps names it reserves away from people, and passes them through', async () => {
    const res = await relay.fetch('https://relay.heyjosi.test/v1/sites', { method: 'POST', body: JSON.stringify({ name: 'relay' }) });
    expect(res.status).toBe(400);
    const missing = await relay.fetch('https://nobody.heyjosi.test/', { testHost: 'nobody.heyjosi.test' });
    expect(missing.status).toBe(404);
  });

  it('stores an invite it cannot read, and forgets it when lookups run out', async () => {
    const id = 'a'.repeat(32), url = `https://relay.heyjosi.test/v1/sites/${site}/invites/${id}`;
    const put = await relay.fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ box: 'c2VhbGVk', expires: Math.floor(Date.now() / 1000) + 600, lookups: 1 }) });
    expect(put.status).toBe(201);
    const refused = await relay.fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer wrong' }, body: '{}' });
    expect(refused.status).toBe(401);
    const lookup = () => relay.fetch(`https://relay.heyjosi.test/v1/invites/${id}`);
    expect(await (await lookup()).json()).toMatchObject({ box: 'c2VhbGVk' });
    expect((await lookup()).status).toBe(404);
  });

  it('refuses a box meant to outlive the ceiling', async () => {
    const url = `https://relay.heyjosi.test/v1/sites/${site}/invites/${'b'.repeat(32)}`;
    const res = await relay.fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ box: 'c2VhbGVk', expires: Math.floor(Date.now() / 1000) + 86400, lookups: 1 }) });
    expect(res.status).toBe(400);
  });
});

describe('a relay with accounts', () => {
  it('needs a signed grant, and stops when the grant runs out', async () => {
    const { subtle } = crypto;
    const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const pub = Buffer.from(await subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    const relay = await fakeRelay({ env: { ACCOUNTS_KEYS: pub } });
    const sign = async (claims: object) => {
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${body}.${Buffer.from(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, Buffer.from(body))).toString('base64url')}`;
    };
    const now = Math.floor(Date.now() / 1000), siteId = 'c'.repeat(32);
    const claims = { typ: 'relay-grant', site: siteId, name: 'bob', iat: now, exp: now + 60 };
    expect((await relay.fetch('https://relay.heyjosi.test/v1/sites', { method: 'POST', body: '{}' })).status).toBe(403);
    const good = await sign(claims), at = good.indexOf('.') + 1;
    // The signature's first character, because its last one is partly padding.
    const forged = good.slice(0, at) + (good[at] === 'A' ? 'B' : 'A') + good.slice(at + 1);
    expect((await relay.fetch('https://relay.heyjosi.test/v1/sites', { method: 'POST', body: JSON.stringify({ grant: forged }) })).status).toBe(403);
    const made = await relay.fetch('https://relay.heyjosi.test/v1/sites', { method: 'POST', body: JSON.stringify({ grant: await sign(claims) }) });
    expect(made.status).toBe(201);
    const { secret } = await made.json() as { secret: string };
    await relay.connect(`https://relay.heyjosi.test/v1/sites/${siteId}/server`, { headers: { Authorization: `Bearer ${secret}` } });

    const durable = (relay.env.SITES as { objects: Map<string, { storage: { data: Map<string, { exp: number }> }; instance: { alarm(): Promise<void> }; sockets: Set<unknown> }> }).objects.get(siteId)!;
    durable.storage.data.get('record')!.exp = now - 1;
    await durable.instance.alarm();
    expect(durable.sockets.size).toBe(0);
    const paused = await relay.fetch('https://bob.heyjosi.test/', { testHost: 'bob.heyjosi.test' });
    expect(paused.status).toBe(402);
    await expect(relay.connect('https://bob.heyjosi.test/__josi/connect', { testHost: 'bob.heyjosi.test' })).rejects.toThrow(/402/);
    relay.restore();
  });
});
