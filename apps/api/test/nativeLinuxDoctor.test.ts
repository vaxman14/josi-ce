import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeLinuxDoctor } from '../src/http/nativeLinuxDoctor.js';

function setup() {
  const data = mkdtempSync(join(tmpdir(), 'josi-linux-doctor-'));
  mkdirSync(join(data, 'state'));
  const env = { JOSI_DATA_DIR: data, JOSI_VERSION: '1.1.0' } as NodeJS.ProcessEnv;
  return { data, helper: nativeLinuxDoctor({ db: {} as never, masterKey: false, env, checkTimeoutMs: 2_000, sleep: async () => {} }) };
}

describe('native Linux updater bridge', () => {
  it('reports package mode and the running version before any check', async () => {
    const { helper } = setup();
    const reply = await helper('/update/status');
    expect(reply.status).toBe(200);
    expect(reply.data).toMatchObject({ state: 'idle', currentVersion: '1.1.0', applyMode: 'package', available: null });
  });

  it('passes through what the root updater recorded', async () => {
    const { data, helper } = setup();
    writeFileSync(join(data, 'state/update-status.json'), JSON.stringify({ state: 'idle', checkedAt: '2026-11-07T10:00:00Z',
      lastCheckOk: true, available: { version: '1.1.1', name: 'Josi 1.1.1' }, currentVersion: '9.9.9' }));
    const reply = await helper('/update/status');
    expect(reply.data).toMatchObject({ currentVersion: '1.1.0', lastCheckOk: true, available: { version: '1.1.1' } });
  });

  it('starts an update only by leaving a request for root', async () => {
    const { data, helper } = setup();
    const reply = await helper('/update/start', { operation: 'update', version: '1.1.1', confirm: 'UPDATE 1.1.1' });
    expect(reply.status).toBe(202);
    expect(reply.data).toMatchObject({ state: 'running', targetVersion: '1.1.1' });
    expect(JSON.parse(readFileSync(join(data, 'state/update-request'), 'utf8'))).toEqual({ operation: 'update', version: '1.1.1' });
    expect((await helper('/update/start', { version: '1.1.1; rm -rf /' })).status).toBe(400);
  });

  it('waits for the updater to answer a check, and says so when it does not', async () => {
    const { data, helper } = setup();
    const status = join(data, 'state/update-status.json');
    writeFileSync(status, JSON.stringify({ state: 'idle' }));
    utimesSync(status, new Date(1_000), new Date(1_000));
    expect((await helper('/update/check')).status).toBe(504);
    expect(existsSync(join(data, 'state/update-request'))).toBe(true);

    let polls = 0;
    const answering = nativeLinuxDoctor({ db: {} as never, masterKey: false, env: { JOSI_DATA_DIR: data, JOSI_VERSION: '1.1.0' } as NodeJS.ProcessEnv,
      checkTimeoutMs: 5_000, sleep: async () => {
        if (++polls === 2) writeFileSync(status, JSON.stringify({ state: 'idle', lastCheckOk: true, available: { version: '1.1.1' } }));
      } });
    const reply = await answering('/update/check');
    expect(reply.status).toBe(200);
    expect(reply.data).toMatchObject({ available: { version: '1.1.1' } });
  });

  it('refuses repairs from the browser', async () => {
    const { helper } = setup();
    expect((await helper('/doctor/repair', {})).status).toBe(409);
  });
});
