import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const base = resolve('artifacts/windows-native');
const executable = resolve(base, 'tools/caddy-2.11.7/caddy.exe');
const root = resolve(base, 'test-installations/caddy-spike');
await mkdir(root, { recursive: true });
const upstream = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ native: true, path: req.url, forwarded: req.headers['x-forwarded-for'] }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
// Reserve an available local port for the short-lived proxy test.
const probe = createServer();
probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port;
await new Promise((ok) => probe.close(ok));
const configuration = resolve(root, 'caddy.json');
await writeFile(configuration, JSON.stringify({ admin: { disabled: true },
  apps: { http: { servers: { test: { listen: [`127.0.0.1:${port}`],
    routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${upstream.address().port}` }] }] }],
  } } } } }));
const child = spawn(executable, ['run', '--config', configuration], {
  windowsHide: true, cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root },
});
let log = ''; let launchError;
child.on('error', (err) => { launchError = err; });
child.stdout.on('data', (data) => { log += data; });
child.stderr.on('data', (data) => { log += data; });
const closed = once(child, 'close');
try {
  let response;
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error('Proxy exited: ' + log);
    try { response = await fetch(`http://127.0.0.1:${port}/native-proxy`, { signal: AbortSignal.timeout(1000) }); break; }
    catch { await delay(250); }
  }
  assert(response, 'Proxy did not become ready');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { native: true, path: '/native-proxy', forwarded: '127.0.0.1' });
  const sockets = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -OwningProcess ${child.pid} | Select-Object LocalAddress,LocalPort)`],
  { windowsHide: true, encoding: 'utf8' }));
  assert(sockets.length > 0);
  assert(sockets.every((s) => s.LocalAddress === '127.0.0.1'));
  assert.equal(sockets.length, 1, 'No admin or unexpected listener');
  const version = execFileSync(executable, ['version'], { windowsHide: true, encoding: 'utf8' }).trim();
  await writeFile(resolve(base, 'evidence/caddy-spike.json'), JSON.stringify({
    recordedAt: new Date().toISOString(), passed: true, version, sockets,
    reverseProxy: true, adminDisabled: true, tlsTested: false, installedService: false,
  }, null, 2) + '\n');
  console.log('Native Caddy proxy and actual loopback-only socket inspection passed.');
} finally {
  child.kill();
  await closed;
  upstream.closeAllConnections();
  await new Promise((ok) => upstream.close(ok));
  await writeFile(resolve(root, 'caddy.log'), log);
}
