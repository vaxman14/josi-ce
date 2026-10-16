import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { nativeMacDoctor } from '../src/http/nativeMacDoctor.js';

let db: TestDb;
let root: string;
let server: Server;
let address: string;
let proxyStatus = 200;
let proxyBody: unknown;
let voiceStatus: Record<string, unknown>;
const version = '0.1.78-macos.18';
const now = Date.now();
let env: NodeJS.ProcessEnv;
let workspaceAvailable = true;

function helper(overrides: Partial<Parameters<typeof nativeMacDoctor>[0]> = {}) {
  return nativeMacDoctor({ db, env, appDirectory: join(root, 'app'), masterKey: false,
    platform: 'darwin', architecture: 'arm64', now: () => now,
    voice: async () => ({ status: 200, type: 'application/json', data: Buffer.from(JSON.stringify(voiceStatus)) }),
    workspace: { available: async () => workspaceAvailable }, ...overrides });
}
async function checks(h = helper()) {
  const reply = await h('/doctor/check');
  expect(reply.status).toBe(200);
  const data = reply.data as { runtime: string; safeRepairAvailable: boolean; checks: Array<{ check: string; status: string }> };
  expect(data.runtime).toBe('macos');
  expect(data.safeRepairAvailable).toBe(false);
  return Object.fromEntries(data.checks.map(row => [row.check, row.status]));
}

beforeAll(async () => {
  db = await testDb();
  await db.exec('create table _migrations (name text primary key)');
  await db.query("insert into _migrations values ('0001_fixture.sql')");
  root = await mkdtemp(join(tmpdir(), 'josi-native-doctor-'));
  for (const folder of ['config', 'roots', 'chat-attachments', 'backups', 'diagnostics', 'versions', 'codex', 'state']) {
    await mkdir(join(root, 'data', folder), { recursive: true });
  }
  for (const file of ['apps/api/dist/server.js', 'apps/worker/dist/main.js', 'apps/web/dist/index.html', 'packages/db/migrations/0001_fixture.sql']) {
    await mkdir(join(root, 'app', file, '..'), { recursive: true });
    await writeFile(join(root, 'app', file), 'fixture');
  }
  await writeFile(join(root, 'app/package.json'), JSON.stringify({ version }));
  server = createServer((req, res) => {
    expect(req.url).toBe('/ready'); expect(req.headers.host).toBe('localhost');
    res.writeHead(proxyStatus, { 'content-type': 'application/json' });
    res.end(typeof proxyBody === 'string' ? proxyBody : JSON.stringify(proxyBody));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  address = `http://localhost:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  env = { JOSI_DATA_DIR: join(root, 'data'), JOSI_VERSION: version, APP_URL: address };
  proxyStatus = 200; proxyBody = { ready: true, blockers: [] };
  voiceStatus = { helperAvailable: true, enabled: true, healthy: true };
  workspaceAvailable = true;
  await writeFile(join(root, 'data/config/runtime.json'), JSON.stringify({ schemaVersion: 1, version }));
  await writeFile(join(root, 'data/state/worker-heartbeat'), new Date(now).toISOString());
  await utimes(join(root, 'data/state/worker-heartbeat'), now / 1000, now / 1000);
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('native Mac Doctor', () => {
  it('checks real fixture files, database and loopback HTTP without a maintenance socket', async () => {
    const result = await checks();
    expect(Object.keys(result)).toHaveLength(12);
    expect(Object.entries(result).filter(([, state]) => state !== 'pass')).toEqual([['native_backup_history', 'warn']]);
    expect(result).not.toHaveProperty('runtime'); // No Docker probe on a native installation.
    expect(await readFile(join(root, 'data/config/runtime.json'), 'utf8')).toBe(JSON.stringify({ schemaVersion: 1, version }));
  });

  it('reports a stale, missing or future worker heartbeat as a failure', async () => {
    for (const offset of [-91_000, 31_000]) {
      await utimes(join(root, 'data/state/worker-heartbeat'), (now + offset) / 1000, (now + offset) / 1000);
      expect((await checks()).native_worker).toBe('fail');
    }
    await rm(join(root, 'data/state/worker-heartbeat'));
    expect((await checks()).native_worker).toBe('fail');
  });

  it('does not accept an empty 200, malformed JSON, failed readiness or redirects as a healthy proxy', async () => {
    for (const response of ['', 'not json', {}, { ready: true }, { ready: false, blockers: ['database'] }]) {
      proxyBody = response;
      expect((await checks()).public_health).toBe('fail');
    }
    proxyStatus = 302; proxyBody = { ready: true, blockers: [] };
    expect((await checks()).public_health).toBe('fail');
  });

  it('refuses remote URLs and URL credentials before sending requests', async () => {
    for (const APP_URL of ['http://example.com:8080', 'http://secret@localhost:8080', 'https://localhost:8080']) {
      expect((await checks(helper({ env: { ...env, APP_URL } }))).public_health).toBe('fail');
    }
  });

  it('distinguishes intentionally disabled speech from an absent helper or unhealthy enabled speech', async () => {
    voiceStatus = { helperAvailable: true, enabled: false, healthy: false };
    expect((await checks()).native_voice).toBe('pass');
    voiceStatus.helperAvailable = false;
    expect((await checks()).native_voice).toBe('fail');
    voiceStatus = { helperAvailable: true, enabled: true, healthy: false };
    expect((await checks()).native_voice).toBe('fail');
  });

  it('checks only an explicitly selected workspace and reports loss of access', async () => {
    expect(await checks()).not.toHaveProperty('native_workspace');
    env.JOSI_WORKSPACE_ENABLED = '1';
    expect((await checks()).native_workspace).toBe('pass');
    expect((await checks()).native_workspace_mapping).toBe('fail'); // Readable is not the same as connected.
    workspaceAvailable = false;
    expect((await checks()).native_workspace).toBe('fail');
  });

  it('detects version drift, missing migrations and unsupported architecture', async () => {
    await writeFile(join(root, 'data/config/runtime.json'), JSON.stringify({ schemaVersion: 1, version: 'wrong' }));
    expect((await checks()).native_runtime).toBe('fail');
    await db.query("delete from _migrations where name='0001_fixture.sql'");
    try { expect((await checks()).migrations).toBe('fail'); }
    finally { await db.query("insert into _migrations values ('0001_fixture.sql')"); }
    expect((await checks(helper({ architecture: 'x64' }))).architecture).toBe('fail');
  });

  it('reports SQL errors per check without exposing exception details', async () => {
    const reply = await helper({ db: { query: async () => { throw new Error('password=private /sensitive/file'); } } })('/doctor/check');
    expect(JSON.stringify(reply)).not.toMatch(/password|sensitive/);
    const result = (reply.data as any).checks;
    expect(result.find((row: any) => row.check === 'migrations').status).toBe('fail');
    expect(result.find((row: any) => row.check === 'worker_backlog').status).toBe('fail');
  });

  it('does not follow a symlink in a checked data directory', async () => {
    await rm(join(root, 'data/diagnostics'), { recursive: true });
    await symlink(join(root, 'data/backups'), join(root, 'data/diagnostics'));
    try { expect((await checks()).writable_data).toBe('fail'); }
    finally { await rm(join(root, 'data/diagnostics')); await mkdir(join(root, 'data/diagnostics')); }
  });

  it('provides native version status and refuses browser repair/update operations', async () => {
    const h = helper();
    expect(await h('/update/status')).toMatchObject({ status: 200, data: { currentVersion: version, applyMode: 'installer' } });
    expect((await h('/doctor/repair', { operation: 'safe_repair' })).status).toBe(409);
    expect((await h('/update/start', { operation: 'update', version: '99.0.0', confirm: 'UPDATE 99.0.0' })).status).toBe(409);
    expect((await h('/doctor/check', { path: '/arbitrary' })).status).toBe(409);
  });
});
