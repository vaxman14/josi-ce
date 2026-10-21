import { beforeEach, expect, it, vi } from 'vitest';
import { testDb, testVault, type TestDb } from '../../core/test/helpers.js';
import { MasterKey } from '@josi-ce/core';
import { chat, loadStoredProvider } from '../src/registry.js';
import type { SpawnRunner } from '../src/providers/codexCli.js';

let db: TestDb;
const key = new MasterKey(Buffer.alloc(32, 19));
beforeEach(async () => {
  db = await testDb(); await testVault(db, key);
  await db.query(`insert into llm_providers(role,provider,model,external_acknowledged,activated_at,probed_at,cap_chat)
    values('primary','openai_subscription','vision-test',true,now(),now(),true)`);
});
const result = () => ({ code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ type: 'agent_message', message: '{"reply":"A chair.","tool":null}' }) });
it.each(['success', 'changed', 'local-only', 'duplicate', 'missing'])('pins subscription capture dispatch: %s', async scenario => {
  const stored = (await loadStoredProvider(db, 'primary'))!;
  const beforeDispatch = vi.fn(async () => {});
  const fetchImpl = vi.fn();
  const runner: SpawnRunner = async call => {
    if (scenario === 'changed') await db.query(`update llm_providers set model='changed',updated_at=now() where role='primary'`);
    if (scenario === 'local-only') await db.query('update security_policy set local_only=true where id=true');
    if (scenario !== 'missing') await call.beforeStart!();
    if (scenario === 'duplicate') await call.beforeStart!();
    return result();
  };
  const run = chat({ db, masterKey: key, codexRunner: runner, fetchImpl }, {
    toolExecution: 'caller', messages: [{ role: 'user', content: 'photo', images: [{ mediaType: 'image/jpeg', base64: Buffer.from('photo').toString('base64') }] }],
  }, { oneShotTransmission: true, beforeDispatch, expectedPrimary: { providerId: stored.provider, model: stored.model, configurationVersion: stored.updated_at } });
  if (scenario === 'success') expect((await run).response.text).toBe('A chair.');
  else await expect(run).rejects.toThrow();
  expect(beforeDispatch).toHaveBeenCalledTimes(['success', 'duplicate'].includes(scenario) ? 1 : 0);
  expect(fetchImpl).not.toHaveBeenCalled();
});

