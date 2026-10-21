import { execFileSync, fork } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { windowsPathTrusted } from '@josi-ce/core';

// Real processes, real Job Objects, real ACLs. Requires `npm run build`
// because the fixture and guardian run from compiled output.
const here = dirname(fileURLToPath(import.meta.url));
const guardian = join(here, '../dist/providers/codexVaultGuardian.js');
const windows = process.platform === 'win32';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until(check: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  return check();
}
type Started = { type: 'started'; child: number; grandchild: number; others: number };
function startFixture() {
  const fixture = fork(join(here, 'fixtures/windows-job-fixture.mjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const started = new Promise<Started>((resolve, reject) => {
    fixture.on('message', (value: Started) => { if (value.type === 'started') resolve(value); });
    fixture.on('exit', () => reject(new Error('fixture exited early')));
  });
  return { fixture, started };
}

describe.skipIf(!windows)('Windows subscription supervisor', () => {
  it('owns every descendant and terminates the whole tree', async () => {
    const { fixture, started } = startFixture();
    const tree = await started;
    expect(tree.others).toBeGreaterThanOrEqual(2);
    expect(alive(tree.grandchild)).toBe(true);
    const done = new Promise<{ others: number }>(resolve => fixture.on('message', (value: { type: string; others: number }) => {
      if (value.type === 'terminated') resolve(value);
    }));
    fixture.send('terminate');
    expect((await done).others).toBe(0);
    expect(await until(() => !alive(tree.child) && !alive(tree.grandchild))).toBe(true);
    fixture.kill();
  });

  it('kills the consumer tree when the supervisor itself is killed', async () => {
    const { fixture, started } = startFixture();
    const tree = await started;
    // TerminateProcess on the supervisor only: the job's last handle closes.
    execFileSync(join(process.env.SystemRoot!, 'System32', 'taskkill.exe'), ['/PID', String(fixture.pid), '/F'], { stdio: 'ignore' });
    expect(await until(() => !alive(tree.child) && !alive(tree.grandchild))).toBe(true);
  });

  it('trusts system binaries and refuses a folder other accounts may modify', () => {
    expect(windowsPathTrusted(join(process.env.SystemRoot!, 'System32', 'notepad.exe'))).toBe(true);
    const folder = mkdtempSync(join(tmpdir(), 'josi-trust-'));
    try {
      const file = join(folder, 'tool.exe');
      writeFileSync(file, 'x');
      execFileSync('icacls', [folder, '/grant', '*S-1-5-11:(OI)(CI)M'], { stdio: 'ignore' });
      expect(windowsPathTrusted(file)).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  const codex = process.env.JOSI_TEST_CODEX ?? 'C:\\Dev\\josi-dev\\cli\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  it.skipIf(!existsSync(codex) || !existsSync(guardian))('runs the pinned Codex CLI through the guardian and removes its private home', async () => {
    const child = fork(guardian, [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        ProgramData: process.env.ProgramData, JOSI_SUBSCRIPTION_CONSUMER: 'codex' },
    });
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const renew = setInterval(() => { if (child.connected) child.send({ type: 'renew' }); }, 1000);
      child.on('message', (value: Record<string, unknown>) => {
        if (value.type === 'ready') {
          child.send({ type: 'renew' });
          child.send({ type: 'start', command: codex, args: ['--version'], input: '', auth: null, timeoutMs: 60_000 });
        } else if (value.type === 'result') { clearInterval(renew); resolve(value); }
      });
      child.on('exit', () => { clearInterval(renew); reject(new Error('guardian exited without a result')); });
    });
    expect(result).toMatchObject({ code: 0, stopped: true, cleaned: true, spawnError: false, auth: null });
    expect(String(result.stdout)).toContain('codex-cli 0.152.0');
  }, 60_000);
});
