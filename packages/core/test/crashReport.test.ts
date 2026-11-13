import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from './helpers.js';
import { ensureWorkspace } from '../../../apps/api/test/fixtures.js';
import {
  buildReport, crashSettings, flushCrashReports, importQueuedReports, listPending, recordReport, scrub, scrubReport, sendReport, setCrashAuto, testerToken,
  type CrashReport,
} from '../src/crashReport.js';

const TOKEN = 't'.repeat(43);
let db: TestDb, dir: string;
beforeEach(async () => {
  db = await testDb(); await ensureWorkspace(db);
  dir = mkdtempSync(join(tmpdir(), 'josi-crash-'));
  process.env.JOSI_TESTER_TOKEN = TOKEN;
  process.env.JOSI_CRASH_QUEUE_DIR = dir;
});
afterEach(() => { delete process.env.JOSI_TESTER_TOKEN; delete process.env.JOSI_CRASH_QUEUE_DIR; delete process.env.JOSI_TESTER_FILE; rmSync(dir, { recursive: true, force: true }); });

const report = (over: Partial<CrashReport> = {}) => scrubReport({ type: 'crash', error: 'TypeError: x is not a function', stack_trace: 'at run (/app/a.js:1:1)', app_version: '1.2.8-beta.31', os: 'Debian 13', ...over });

describe('what is taken out of a report', () => {
  it('removes email addresses, IP addresses, sign-in tokens and home folders', () => {
    const text = scrub([
      'failed for roman@example.com from 10.10.1.239 and 2001:db8:85a3:0:0:8a2e:370:7334',
      'Authorization: Bearer abcdefghijklmnop1234567890',
      'https://x.test/cb?code=4/0AbCdEfGh&state=zzz&ok=1',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
      'key sk-proj-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123',
      'at /home/roman/josi/app.js and /Users/Roman Vaxman/x and C:\\Users\\vaxma\\Desktop\\a.txt and /root/.cache',
      '{"password":"hunter2hunter2","cookie":"sessionabc123"}',
    ].join('\n'));
    for (const secret of ['roman@example.com', '10.10.1.239', '2001:db8', 'abcdefghijklmnop1234567890', '4/0AbCdEfGh', 'eyJhbGci', 'sk-proj-', 'ghp_abc', '/home/roman', 'vaxma', 'hunter2hunter2', 'sessionabc123']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain('[email removed]');
    expect(text).toContain('[ip removed]');
    expect(text).toContain('Authorization: [removed]');
    expect(text).toContain('ok=1');
    expect(text).toContain('~/josi/app.js');
  });

  it('leaves version numbers and ordinary words alone', () => {
    expect(scrub('Josi 1.2.8-beta.31 on Debian 13, Node 24.15.0: ECONNREFUSED at db:5432')).toBe('Josi 1.2.8-beta.31 on Debian 13, Node 24.15.0: ECONNREFUSED at db:5432');
  });

  it('keeps only the known fields of an edited report, scrubbed and cut to size', () => {
    const edited = scrubReport({ type: 'crash', error: 'boom for a@b.co', stack_trace: 's'.repeat(50_000), last_log_lines: Array.from({ length: 500 }, (_, i) => `line ${i} from 192.168.1.5`),
      user_note: 'mail me at me@home.org', chat: 'SECRET CHAT', vault: 'SECRET VAULT', uptime: '12.9' } as never);
    expect(Object.keys(edited).sort()).toEqual(['app_version', 'arch', 'cpu', 'docker_version', 'error', 'gpu', 'last_log_lines', 'model_version', 'os', 'ram', 'stack_trace', 'type', 'uptime', 'user_note', 'vram']);
    expect(JSON.stringify(edited)).not.toMatch(/SECRET|a@b\.co|192\.168|me@home/);
    expect(edited.stack_trace.length).toBeLessThanOrEqual(20_000);
    expect(edited.last_log_lines).toHaveLength(200);
    expect(edited.last_log_lines[199]).toBe('line 499 from [ip removed]');
    expect(edited.uptime).toBe(12);
  });

  it('builds a report from an error with facts about the machine and no chat', async () => {
    const built = await buildReport({ type: 'crash', error: new Error('db down for x@y.zz'), logs: ['one', 'two'], db });
    expect(built).toMatchObject({ type: 'crash', error: 'Error: db down for [email removed]', last_log_lines: ['one', 'two'] });
    expect(built.os.length).toBeGreaterThan(0);
    expect(built.arch.length).toBeGreaterThan(0);
    expect(built.ram).toMatch(/GB$/);
    expect(built.stack_trace).toContain('crashReport.test');
  });
});

describe('keeping and sending reports', () => {
  it('stores a report once for the same failure, and keeps only the newest fifty waiting', async () => {
    expect(await recordReport(db, 'api', report())).toBeTruthy();
    expect(await recordReport(db, 'api', report())).toBeNull();
    expect(await recordReport(db, 'worker', report())).toBeTruthy();
    for (let i = 0; i < 60; i++) await recordReport(db, 'api', report({ error: `error ${i}` }));
    expect((await db.query<{ n: number }>(`select count(*)::int as n from crash_reports where status = 'pending'`))[0].n).toBe(50);
  });

  it('sends the token and the scrubbed report, and tells a refusal from an outage', async () => {
    let seen: any;
    const ok = (async (_u: string, init: RequestInit) => { seen = JSON.parse(String(init.body)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await sendReport(report({ error: 'x for me@a.bc' }), { fetchImpl: ok })).toMatchObject({ ok: true });
    expect(seen.token).toBe(TOKEN);
    expect(seen.error).toBe('x for [email removed]');
    const status = (code: number) => (async () => new Response('{}', { status: code })) as unknown as typeof fetch;
    expect(await sendReport(report(), { fetchImpl: status(403) })).toMatchObject({ ok: false, retry: false, message: 'The tester token was refused.' });
    expect(await sendReport(report(), { fetchImpl: status(429) })).toMatchObject({ ok: false, retry: true });
    expect(await sendReport(report(), { fetchImpl: status(503) })).toMatchObject({ ok: false, retry: true });
    expect(await sendReport(report(), { fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch })).toMatchObject({ ok: false, retry: true });
    expect(await sendReport(report(), { fetchImpl: ok, token: null })).toMatchObject({ ok: false, retry: false });
    expect(await sendReport(report({ stack_trace: 'x' }), { fetchImpl: ok, url: 'http://example.test/r' })).toMatchObject({ ok: true });
  });

  it('sends by itself only when the owner said yes', async () => {
    await recordReport(db, 'api', report());
    let calls = 0;
    const ok = (async () => { calls++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await crashSettings(db)).toEqual({ auto: null, tokenPresent: true });
    expect(await flushCrashReports(db, { fetchImpl: ok })).toBe(0);
    await setCrashAuto(db, false);
    expect(await flushCrashReports(db, { fetchImpl: ok })).toBe(0);
    expect(calls).toBe(0);
    await setCrashAuto(db, true);
    expect((await crashSettings(db)).auto).toBe(true);
    expect(await flushCrashReports(db, { fetchImpl: ok })).toBe(1);
    expect(calls).toBe(1);
    expect(await listPending(db)).toEqual([]);
    expect((await db.query<{ status: string }>('select status from crash_reports'))[0].status).toBe('sent');
  });

  it('keeps a report waiting while offline, backs off, and gives up on a refused token', async () => {
    await setCrashAuto(db, true);
    await recordReport(db, 'api', report({ error: 'first' }));
    const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await flushCrashReports(db, { fetchImpl: offline })).toBe(0);
    const [waiting] = await db.query<{ status: string; attempts: number; wait: number }>(`select status, attempts, extract(epoch from next_try_at - now())::int as wait from crash_reports`);
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1 });
    expect(waiting.wait).toBeGreaterThan(30);
    // Not due again yet.
    let calls = 0;
    expect(await flushCrashReports(db, { fetchImpl: (async () => { calls++; return new Response('{}'); }) as unknown as typeof fetch })).toBe(0);
    expect(calls).toBe(0);
    await db.query(`update crash_reports set next_try_at = now()`);
    expect(await flushCrashReports(db, { fetchImpl: (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch })).toBe(0);
    expect((await db.query<{ status: string; last_error: string }>('select status, last_error from crash_reports'))[0]).toEqual({ status: 'failed', last_error: 'The tester token was refused.' });
  });

  it('gives up after eight tries', async () => {
    await setCrashAuto(db, true);
    await recordReport(db, 'api', report());
    const down = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    for (let i = 0; i < 8; i++) { await db.query(`update crash_reports set next_try_at = now() where status = 'pending'`); await flushCrashReports(db, { fetchImpl: down }); }
    expect((await db.query<{ status: string; attempts: number }>('select status, attempts from crash_reports'))[0]).toEqual({ status: 'failed', attempts: 8 });
  });
});

describe('the tester token', () => {
  it('comes from the environment or from the file the installer wrote, and is not guessed', () => {
    expect(testerToken()).toBe(TOKEN);
    delete process.env.JOSI_TESTER_TOKEN;
    expect(testerToken()).toBeNull();
    const file = join(dir, 'tester.json');
    writeFileSync(file, JSON.stringify({ token: 'f'.repeat(40) }));
    process.env.JOSI_TESTER_FILE = file;
    expect(testerToken()).toBe('f'.repeat(40));
    writeFileSync(file, JSON.stringify({ token: 'short' }));
    expect(testerToken()).toBeNull();
  });
});

describe('a report that could not reach the database', () => {
  it('is imported from its file on the next start, scrubbed, and the file is removed', async () => {
    writeFileSync(join(dir, '1-a.json'), JSON.stringify({ type: 'crash', error: 'boom from me@x.yz', stack_trace: 'at /home/roman/a.js' }));
    writeFileSync(join(dir, 'note.txt'), 'not a report');
    expect(await importQueuedReports(db, 'api')).toBe(1);
    const [row] = await listPending(db);
    expect(row.report.error).toBe('boom from [email removed]');
    expect(row.report.stack_trace).toBe('at ~/a.js');
    expect(readdirSync(dir)).toEqual(['note.txt']);
  });
});
