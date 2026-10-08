import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { runHostChecks, blockingFailures } from '../src/setup/hostChecks.js';

describe.skipIf(process.platform !== 'win32')('native setup antivirus policy', () => {
  let db: TestDb;
  let root: string;
  beforeAll(async () => {
    db = await testDb(); root = await mkdtemp(join(tmpdir(), 'josi-antivirus-setup-'));
    await mkdir(join(root, 'state'));
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  afterEach(() => vi.unstubAllEnvs());
  it.each([false, true])('reports unavailable scanning with required=%s without claiming clean', async required => {
    vi.stubEnv('JOSI_NATIVE_RUNTIME', '1'); vi.stubEnv('JOSI_DATA_DIR', root);
    await db.query('update storage_policy set clamav_enabled = $1 where id = true', [required]);
    const checks = await runHostChecks(db, { masterKey: false, freeBytes: () => 10 * 1024 ** 3 });
    const antivirus = checks.find(check => check.id === 'malware_scanning');
    expect(antivirus).toMatchObject({ status: required ? 'fail' : 'warn', mandatory: required });
    expect(antivirus?.detail).toMatch(/unavailable or failed/);
    expect(blockingFailures(checks).some(check => check.id === 'malware_scanning')).toBe(required);
    expect(JSON.stringify(antivirus)).not.toContain(root);
  });
  it('accepts availability only after a recent explicit worker probe', async () => {
    vi.stubEnv('JOSI_NATIVE_RUNTIME', '1'); vi.stubEnv('JOSI_DATA_DIR', root);
    await db.query('update storage_policy set clamav_enabled = true where id = true');
    await writeFile(join(root, 'state/antivirus.json'), JSON.stringify({ provider: 'windows-amsi', status: 'available', checkedAt: new Date().toISOString() }));
    const checks = await runHostChecks(db, { masterKey: false, freeBytes: () => 10 * 1024 ** 3 });
    expect(checks.find(check => check.id === 'malware_scanning')).toMatchObject({ status: 'pass', mandatory: true });
  });
  it('leaves non-native setup behavior unchanged', async () => {
    vi.stubEnv('JOSI_NATIVE_RUNTIME', '0');
    const checks = await runHostChecks(db, { masterKey: false, freeBytes: () => 10 * 1024 ** 3 });
    expect(checks.some(check => check.id === 'malware_scanning')).toBe(false);
  });
});
