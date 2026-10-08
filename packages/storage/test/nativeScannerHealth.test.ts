import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { link, mkdir, mkdtemp, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeScannerHealth } from '../src/nativeScannerHealth.js';

describe.skipIf(process.platform !== 'win32')('Windows antivirus availability evidence', () => {
  let root: string;
  let record: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'josi-antivirus-health-'));
    await mkdir(join(root, 'state'));
    record = join(root, 'state/antivirus.json');
    vi.stubEnv('JOSI_NATIVE_RUNTIME', '1');
    vi.stubEnv('JOSI_DATA_DIR', root);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    // A freshly created test root is the only recursive cleanup target.
    if (root) await rm(root, { recursive: true, force: true });
  });
  const unavailable = { provider: 'windows-amsi', status: 'unavailable', checkedAt: null };
  async function publish(status: string, checkedAt = new Date().toISOString(), extra = {}) {
    await writeFile(record, JSON.stringify({ provider: 'windows-amsi', status, checkedAt, ...extra }));
  }
  it('reports a missing probe as unavailable', async () => {
    expect(await nativeScannerHealth()).toEqual(unavailable);
  });
  it.each(['available', 'error', 'unavailable'])('preserves a recent %s probe without inventing a document verdict', async status => {
    const checkedAt = new Date().toISOString();
    await publish(status, checkedAt);
    expect(await nativeScannerHealth()).toEqual({ provider: 'windows-amsi', status, checkedAt });
  });
  it.each([-16 * 60_000, 2 * 60_000])('rejects stale or future availability (%s ms)', async offset => {
    await publish('available', new Date(Date.now() + offset).toISOString());
    expect(await nativeScannerHealth()).toEqual(unavailable);
  });
  it('rejects malformed, extra, oversized and unknown-provider evidence', async () => {
    for (const bytes of ['null', '[]', '{', 'x'.repeat(4097)]) {
      await writeFile(record, bytes);
      expect(await nativeScannerHealth()).toEqual(unavailable);
    }
    for (const extra of [{ provider: 'unknown' }, { status: 'clean' }, { checkedAt: 'invalid' }, { document: 'private' }]) {
      await publish('available', new Date().toISOString(), extra);
      expect(await nativeScannerHealth()).toEqual(unavailable);
    }
  });
  it('rejects hardlinks and junction ancestors while preserving outside bytes', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    const source = join(outside, 'antivirus.json');
    await writeFile(source, JSON.stringify({ provider: 'windows-amsi', status: 'available', checkedAt: new Date().toISOString() }));
    await link(source, record);
    expect(await nativeScannerHealth()).toEqual(unavailable);
    await rm(record);
    await rmdir(join(root, 'state'));
    await symlink(outside, join(root, 'state'), 'junction');
    expect(await nativeScannerHealth()).toEqual(unavailable);
    await rmdir(join(root, 'state'));
  });
});
