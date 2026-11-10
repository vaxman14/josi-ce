#!/usr/bin/env node
// Self-contained test of the device-transfer receiver: node test-receive.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTransferReceiver, numbered, safeName } from './receive.mjs';

const linux = process.platform === 'linux';
const home = mkdtempSync(join(tmpdir(), 'josi-receive-test-'));
const DEVICE = 'linux-' + 'a1'.repeat(16);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let passed = 0;
const ok = name => { passed++; console.log('ok', passed, '-', name); };

// ---- the fake server
const files = new Map([[id(1), { name: 'photo.jpg', bytes: Buffer.from('JPEGDATA') }], [id(2), { name: 'photo.jpg', bytes: Buffer.from('SECOND') }],
  [id(3), { name: '../../etc/passwd', bytes: Buffer.from('evil') }], [id(5), { name: 'big.bin', bytes: Buffer.alloc(26 * 1024 * 1024) }]]);
const seen = [];
let accepted = [id(1), id(2), id(3)];
const received = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = ''; req.on('data', c => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, client: req.headers['x-josi-client'], body });
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'PUT' && url.pathname === `/api/device-transfers/devices/${DEVICE}`) return send(200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/device-transfers/inbox') {
      const row = (n, state, size) => ({ id: id(n), name: files.get(id(n))?.name ?? 'x', size: size ?? files.get(id(n))?.bytes.length ?? 1, state, own: false, mine: false });
      return send(200, { transfers: [...accepted.map(i => row(Number(i.slice(-1)), 'accepted')), row(4, 'offered', 10), row(5, 'accepted')], sent: [] });
    }
    const m = /^\/api\/device-transfers\/([^/]+)\/(content|received)$/.exec(url.pathname);
    if (m && m[2] === 'content' && files.has(m[1])) {
      const f = files.get(m[1]);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(f.bytes.length) }); return res.end(f.bytes);
    }
    if (m && m[2] === 'received' && req.method === 'POST') { received.push([m[1], JSON.parse(body)]); accepted = accepted.filter(i => i !== m[1]); return send(200, { ok: true }); }
    return send(404, { error: 'no' });
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const api = `http://127.0.0.1:${server.address().port}`;
const logs = [];
let active = true;
const rx = createTransferReceiver({ api, token: () => 'owner-token', deviceId: () => DEVICE, home, log: (...a) => logs.push(a.join(' ')), isActive: () => active, name: 'box (server)' });

try {
  // pure helpers
  assert.equal(safeName('../../etc/passwd'), 'passwd'); assert.equal(safeName('C:\\Users\\x\\a<b>.txt'), 'a_b_.txt'); assert.equal(safeName('.bashrc'), 'bashrc');
  assert.equal(safeName('  '), 'file'); assert.equal(safeName('a\u0000b\n.txt'), 'ab.txt'); assert.ok(Buffer.byteLength(safeName('é'.repeat(300))) <= 200);
  assert.equal(numbered('photo.jpg', 2), 'photo (2).jpg'); assert.equal(numbered('README', 3), 'README (3)'); assert.equal(numbered('.x', 2), '.x (2)');
  ok('file name sanitising and numbering');

  // inactive: nothing is sent
  active = false; await rx.poll(); assert.equal(seen.length, 0);
  ok('unpaired or paused: silent, no requests');

  active = true; await rx.poll();
  assert.equal(seen[0].method, 'PUT'); assert.deepEqual(JSON.parse(seen[0].body), { name: 'box (server)', platform: 'linux' });
  assert.ok(seen.every(r => r.auth === 'Bearer owner-token' && r.client === 'native'));
  assert.ok(seen.some(r => r.path === '/api/device-transfers/inbox' && r.query === `?deviceId=${DEVICE}`));
  const downloads = join(home, 'Downloads');
  assert.deepEqual(readdirSync(downloads).sort(), ['passwd', 'photo (2).jpg', 'photo.jpg']);
  assert.equal(readFileSync(join(downloads, 'photo.jpg'), 'utf8'), 'JPEGDATA'); assert.equal(readFileSync(join(downloads, 'photo (2).jpg'), 'utf8'), 'SECOND');
  assert.equal(readFileSync(join(downloads, 'passwd'), 'utf8'), 'evil');
  if (linux) { assert.equal(statSync(join(downloads, 'photo.jpg')).mode & 0o777, 0o644); assert.equal(statSync(downloads).mode & 0o777, 0o755); }
  assert.deepEqual(received.map(r => r[0]), [id(1), id(2), id(3)]); assert.ok(received.every(r => r[1].deviceId === DEVICE));
  assert.ok(!seen.some(r => r.path.includes(id(4))), 'another person\'s offer is left for the owner');
  assert.ok(!seen.some(r => r.path.includes(id(5))), 'a file over 25 MB is never fetched');
  assert.equal(logs.filter(l => l.includes('received a file')).length, 3);
  ok('registers, fetches accepted files into Downloads (0644, never overwriting), confirms receipt, leaves offers and oversize alone');

  // a second round: nothing new, no re-register, no re-download
  const before = seen.length; await rx.poll();
  assert.equal(seen.length - before, 1, 'only the inbox check'); assert.equal(readdirSync(downloads).length, 3);
  ok('next check: no re-register and no duplicates');

  // a failed receipt is retried without downloading again
  files.set(id(6), { name: 'a.txt', bytes: Buffer.from('A') }); accepted = [id(6)];
  let fail = true; const realFetch = globalThis.fetch;
  const flaky = createTransferReceiver({ api, token: () => 't', deviceId: () => DEVICE, home, log: () => {}, registerMs: 1e12,
    fetch: (u, o) => (fail && String(u).endsWith('/received') ? Promise.resolve(new Response('{}', { status: 500 })) : realFetch(u, o)) });
  await flaky.poll(); assert.ok(existsSync(join(downloads, 'a.txt')));
  fail = false; await flaky.poll();
  assert.deepEqual(readdirSync(downloads).filter(n => n.startsWith('a')), ['a.txt']); assert.equal(received.at(-1)[0], id(6));
  ok('a failed confirmation is retried without a second copy');
} catch (error) {
  console.error('FAILED:', error); console.error(logs.join('\n')); process.exitCode = 1;
} finally {
  server.close(); rmSync(home, { recursive: true, force: true });
}
if (!process.exitCode) console.log(`\nall ${passed} passed on ${process.platform} (node ${process.version})`);
