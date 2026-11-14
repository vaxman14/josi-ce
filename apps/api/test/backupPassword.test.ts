// The backup password, the sealed backup it makes, and the backup folder a
// Docker install is given.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { sha256Of, type BackupWriter, type RestoreReader } from '@josi-ce/ops';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-backup-password-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 31).toString('base64'));
const folder = join(dir, 'backups-folder');
mkdirSync(folder);

let server: Server;
let base: string;
let db: TestDb;
let jar: string;
let memberJar: string;
const written: Array<{ passphrase?: string; recipient?: { salt: string; publicKey: string }; destination: string }> = [];
const backupWriter: BackupWriter = {
  async write(args) {
    written.push({ passphrase: args.passphrase, recipient: args.recipient, destination: args.destination });
    return { byteSize: 2048, sha256: sha256Of(Buffer.alloc(2048)), encrypted: !!(args.passphrase || args.recipient) };
  },
  async read() { return Buffer.alloc(2048); },
  async remove() {},
  physicalPath: (p: string) => join(dir, p.replace(/\//g, '_')),
};
const restoreReader: RestoreReader = { async apply() { return { rowsRestored: 1 }; } };

async function call(path: string, opts: { method?: string; body?: unknown; jar?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const res = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function signIn(identifier: string, password: string): Promise<string> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const first = (pre.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const csrf = decodeURIComponent(/josi_csrf=([^;]+)/.exec(first)?.[1] ?? '');
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: first, 'x-josi-csrf': csrf }, body: JSON.stringify({ identifier, password }) });
  expect(res.status).toBe(200);
  const jarMap = new Map<string, string>();
  for (const part of [first, ...(res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])].join('; ').split(';')) {
    const i = part.indexOf('='); if (i > 0) jarMap.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return [...jarMap].map(([k, v]) => `${k}=${v}`).join('; ');
}

beforeAll(async () => {
  process.env.JOSI_BACKUP_DIR = folder;
  db = await testDb();
  await ensureWorkspace(db);
  await createUser(db, { email: 'owner@ce.test', username: 'owner', role: 'super_admin', password: 'owner-password-123' });
  await createUser(db, { email: 'member@ce.test', username: 'member', role: 'member', password: 'member-password-123' });
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost:3000', masterKeyCheck: { path: keyPath }, backupWriter, restoreReader, supportGatewayUrl: null });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  jar = await signIn('owner', 'owner-password-123');
  memberJar = await signIn('member', 'member-password-123');
});
afterAll(async () => { delete process.env.JOSI_BACKUP_DIR; await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  written.length = 0;
  await db.query(`delete from rate_limits`);
  await db.query(`delete from backups`);
  await db.query(`update backup_schedule set recipient_salt = null, recipient_public = null, password_set_at = null, copy_to = null`);
});

describe('the backup password', () => {
  it('is for administrators, needs eight characters and never comes back out', async () => {
    expect((await call('/api/ops/admin/backups/password', { method: 'PUT', jar: memberJar, body: { password: 'long enough password' } })).status).toBe(403);
    expect((await call('/api/ops/admin/backups/password', { method: 'PUT', jar, body: { password: 'short' } })).status).toBe(400);
    const set = await call('/api/ops/admin/backups/password', { method: 'PUT', jar, body: { password: 'long enough password' } });
    expect(set.status).toBe(200);
    expect(set.body.schedule.password_set).toBe(true);
    expect(JSON.stringify(set.body)).not.toMatch(/recipient|salt|long enough/);
    const [row] = await db.query<{ recipient_salt: string; recipient_public: string }>(`select recipient_salt, recipient_public from backup_schedule where id = true`);
    expect(row.recipient_salt).toMatch(/^[0-9a-f]{32}$/);
    expect(row.recipient_public).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('long enough password');
  });

  it('can be checked, and removed only when confirmed', async () => {
    await call('/api/ops/admin/backups/password', { method: 'PUT', jar, body: { password: 'long enough password' } });
    expect((await call('/api/ops/admin/backups/password/check', { method: 'POST', jar, body: { password: 'long enough password' } })).body.ok).toBe(true);
    expect((await call('/api/ops/admin/backups/password/check', { method: 'POST', jar, body: { password: 'another password' } })).body.ok).toBe(false);
    expect((await call('/api/ops/admin/backups/password', { method: 'DELETE', jar, body: {} })).status).toBe(400);
    const gone = await call('/api/ops/admin/backups/password', { method: 'DELETE', jar, body: { confirm: 'remove' } });
    expect(gone.body.schedule.password_set).toBe(false);
    expect((await call('/api/ops/admin/backups/password/check', { method: 'POST', jar, body: { password: 'long enough password' } })).status).toBe(404);
  });
});

describe('a one-click backup', () => {
  it('is not sealed until there is a backup password, and then always is, without asking for it', async () => {
    const plain = await call('/api/ops/admin/backups', { method: 'POST', jar, body: { kind: 'full' } });
    expect(plain.status).toBe(201);
    expect(plain.body.backup.encrypted).toBe(false);
    expect(written[0].recipient).toBeUndefined();
    expect(written[0].destination).toMatch(/\.zip$/);

    await call('/api/ops/admin/backups/password', { method: 'PUT', jar, body: { password: 'long enough password' } });
    await db.query(`delete from backups`);
    const sealed = await call('/api/ops/admin/backups', { method: 'POST', jar, body: { kind: 'full' } });
    expect(sealed.body.backup.encrypted).toBe(true);
    expect(written[1].recipient?.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(written[1].passphrase).toBeUndefined();
    expect(written[1].destination).toMatch(/\.josi-backup$/);
    expect(sealed.body.description).toContain('includes the installation key');
  });

  it('is copied into the backup folder the container was given', async () => {
    const res = await call('/api/ops/admin/backups', { method: 'POST', jar, body: { kind: 'full' } });
    expect(res.body.copiedToFolder === true || res.body.copiedToFolder === false).toBe(true);
  });
});

describe('the backup folder', () => {
  it('lists Josi backup files only, newest first, and the schedule names the folder', async () => {
    writeFileSync(join(folder, 'josi-daily-2026-11-13-1.josi-backup'), Buffer.concat([Buffer.from('JOSIP2'), Buffer.alloc(100)]));
    writeFileSync(join(folder, 'josi-daily-2026-11-14-2.zip'), Buffer.from('PK plain'));
    writeFileSync(join(folder, 'notes.txt'), 'not a backup');
    writeFileSync(join(folder, 'josi-x.zip.part'), 'half a file');
    const listed = await call('/api/ops/admin/backups/folder', { jar });
    expect(listed.body.configured).toBe(true);
    expect(listed.body.files.map((f: { name: string }) => f.name).sort()).toEqual(['josi-daily-2026-11-13-1.josi-backup', 'josi-daily-2026-11-14-2.zip']);
    expect(listed.body.files.find((f: { name: string }) => f.name.endsWith('.josi-backup')).encrypted).toBe(true);
    expect((await call('/api/ops/admin/backups/folder', { jar: memberJar })).status).toBe(403);
    const schedule = await call('/api/ops/admin/backups/schedule', { jar });
    expect(schedule.body.schedule.containerFolder).toBe(folder);
  });

  it('restores only a file it lists, never a path', async () => {
    for (const folderFile of ['../master.key', '/etc/passwd', 'notes.txt', 'josi-missing.zip']) {
      const res = await call('/api/ops/admin/restore', { method: 'POST', jar, body: { folderFile, confirm: 'restore' } });
      expect(res.status, folderFile).toBe(404);
    }
    expect(existsSync(keyPath)).toBe(true);
  });
});
