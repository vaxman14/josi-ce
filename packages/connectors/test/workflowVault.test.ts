import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { MasterKey, initializeVault, recoverVault, setVaultLock, seal, isVaultCredentialReference, VaultLockedError, type Db } from '@josi-ce/core';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { saveWorkflowIntegration, discoverWorkflows, disconnectWorkflowIntegration, requestWorkflowRun, executeWorkflowRun, verifyWorkflowCallback, type WorkflowIntegration } from '../src/workflows.js';
import { prepareWorkflowCredentials } from '../src/workflowVault.js';

const key = new MasterKey(Buffer.alloc(32, 73));
let db: TestDb, owner: string, recovery: string;
const credentialOk: typeof fetch = async () => new Response(JSON.stringify({ data: [] }));
const catalog: typeof fetch = async () => new Response(JSON.stringify({ data: [{ id: 'report', name: 'Report' }] }));
beforeEach(async () => {
  db = await testDb();
  [{ id: owner }] = await db.query<{ id: string }>("insert into users(email,username,role) values('workflow@fixture.test','workflow','super_admin') returning id");
  recovery = (await initializeVault(db, key, owner)).recoveryKey.reveal();
});
const options = () => ({ provider: 'n8n' as const, name: 'Office', baseUrl: 'https://n8n.fixture.test', token: 'synthetic-workflow-token', actorUserId: owner, fetchImpl: credentialOk });
const save = () => saveWorkflowIntegration(db, key, options());
const current = async (id: string) => (await db.query<WorkflowIntegration>('select * from workflow_integrations where id=$1', [id]))[0];
const items = () => db.query("select id from vault_items where service='workflow.n8n'");
async function pendingRun() {
  const integration = await save();
  const [workflow] = await discoverWorkflows(db, key, integration, catalog);
  workflow.execution_ref = '/webhook/report';
  await db.query("update workflow_definitions set exposed=true,execution_ref='/webhook/report' where integration_id=$1", [integration.id]);
  await db.query('update workflow_integrations set enabled=true where id=$1', [integration.id]);
  const run = await requestWorkflowRun(db, key, { integration, workflow, ownerUserId: owner, input: {} });
  return { integration, workflow, run };
}

describe('workflow Vault authority', () => {
  it('keeps a stable callback verifier through token rotation and recovers both canonical secrets', async () => {
    const original = await save();
    const rotated = await saveWorkflowIntegration(db, key, { ...options(), token: 'synthetic-replacement' });
    expect(rotated.id).toBe(original.id); expect(rotated.callbackSecret).toBe(original.callbackSecret);
    expect(isVaultCredentialReference(rotated.credentials_enc)).toBe(true);
    expect(isVaultCredentialReference(rotated.callback_secret_enc)).toBe(true);
    expect(await items()).toHaveLength(2);
    const replacement = new MasterKey(Buffer.alloc(32, 74));
    await recoverVault(db, replacement, recovery, owner);
    const resolved = await prepareWorkflowCredentials(db, replacement, rotated);
    expect(resolved.credentials.token).toBe('synthetic-replacement');
    expect(resolved.callbackSecret).toBe(original.callbackSecret);
    const timestamp = String(Math.floor(Date.now() / 1000)), raw = '{}';
    const signature = createHmac('sha256', original.callbackSecret).update(`${timestamp}.${raw}`).digest('hex');
    expect(await verifyWorkflowCallback(db, replacement, rotated, raw, signature, timestamp)).toBe(true);
  });

  it.each(['master', 'box'])('blocks %s-locked discovery without changing health or starting a provider request', async kind => {
    const integration = await save();
    await db.query('update workflow_integrations set enabled=true where id=$1', [integration.id]);
    await setVaultLock(db, { ...(kind === 'master' ? { master: true } : { ownerUserId: owner }), locked: true, actorUserId: owner });
    const fetchImpl = vi.fn(catalog);
    await expect(discoverWorkflows(db, key, integration, fetchImpl)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(saveWorkflowIntegration(db, key, { ...options(), fetchImpl })).rejects.toBeInstanceOf(VaultLockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await current(integration.id)).toMatchObject({ enabled: true, status: 'active', last_check_ok: true });
  });

  it('leaves a locked approval pending, then executes once after unlock under competing decisions', async () => {
    const { run } = await pendingRun();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ executionId: 'fixture-execution' })));
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    await expect(executeWorkflowRun(db, key, { runId: run.id, ownerUserId: owner, approve: true, fetchImpl })).rejects.toBeInstanceOf(VaultLockedError);
    expect((await db.query('select status from workflow_runs'))[0].status).toBe('pending');
    expect(fetchImpl).not.toHaveBeenCalled();
    await setVaultLock(db, { master: true, locked: false, actorUserId: owner });
    const results = await Promise.allSettled([1, 2].map(() => executeWorkflowRun(db, key, { runId: run.id, ownerUserId: owner, approve: true, fetchImpl })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails without dispatch when the Vault locks immediately after the approval claim', async () => {
    const { run } = await pendingRun(); let injected = false;
    const raced: Db = { ...db, query: async (sql, args) => {
      const result = await db.query(sql, args);
      if (!injected && sql.includes("update workflow_runs r set status='running'")) {
        injected = true; await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
      }
      return result as never;
    } };
    const fetchImpl = vi.fn(credentialOk);
    await expect(executeWorkflowRun(raced, key, { runId: run.id, ownerUserId: owner, approve: true, fetchImpl })).rejects.toBeInstanceOf(VaultLockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.query('select status,error_category from workflow_runs'))[0]).toEqual({ status: 'failed', error_category: 'credential_unavailable' });
  });

  it('requires a new approval when private-network access changes after the proposal', async () => {
    const { integration, run } = await pendingRun();
    await db.query('update workflow_integrations set allow_private_network=true where id=$1', [integration.id]);
    const fetchImpl = vi.fn(credentialOk);
    await expect(executeWorkflowRun(db, key, { runId: run.id, ownerUserId: owner, approve: true, fetchImpl })).rejects.toThrow(/changed/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.query('select status,error_category from workflow_runs'))[0]).toEqual({ status: 'denied', error_category: 'authorization_changed' });
  });

  it('migrates a legacy pair atomically and refuses a substituted callback reference', async () => {
    const original = await save();
    await db.query('delete from vault_items');
    await db.query('update workflow_integrations set credentials_enc=$2,callback_secret_enc=$3 where id=$1', [original.id, seal(key, { token: 'legacy-token' }), seal(key, { secret: 'legacy-callback' })]);
    const prepared = await prepareWorkflowCredentials(db, key, await current(original.id));
    expect(prepared.credentials.token).toBe('legacy-token'); expect(prepared.callbackSecret).toBe('legacy-callback');
    expect(await items()).toHaveLength(2);
    const other = await saveWorkflowIntegration(db, key, { ...options(), name: 'Other' });
    await db.query('update workflow_integrations set callback_secret_enc=$2 where id=$1', [original.id, other.callback_secret_enc]);
    await expect(prepareWorkflowCredentials(db, key, await current(original.id))).rejects.toThrow(/context/);
  });

  it('rolls back a newly reserved integration and both keys if the second Vault write fails', async () => {
    await db.exec("create function reject_callback() returns trigger as $$ begin if new.slot like '%.callback' then raise exception 'synthetic callback failure'; end if; return new; end; $$ language plpgsql; create trigger reject_callback before insert on vault_items for each row execute function reject_callback();");
    await expect(save()).rejects.toThrow('synthetic callback failure');
    expect(await items()).toHaveLength(0);
    expect(await db.query('select id from workflow_integrations')).toHaveLength(0);
  });

  it('rolls back migration when replacing the pair of references fails', async () => {
    const original = await save(); await db.query('delete from vault_items');
    const legacy = seal(key, { token: 'legacy-token' });
    await db.query('update workflow_integrations set credentials_enc=$2,callback_secret_enc=$3 where id=$1', [original.id, legacy, seal(key, { secret: 'legacy-callback' })]);
    await db.exec("create function reject_workflow() returns trigger as $$ begin raise exception 'synthetic workflow failure'; end; $$ language plpgsql; create trigger reject_workflow before update on workflow_integrations for each row execute function reject_workflow();");
    await expect(prepareWorkflowCredentials(db, key, await current(original.id))).rejects.toThrow('synthetic workflow failure');
    expect(await items()).toHaveLength(0); expect((await current(original.id)).credentials_enc).toBe(legacy);
  });

  it.each([false, true])('discards late discovery success/failure after reconnect (failure=%s)', async failure => {
    const original = await save();
    const fetchImpl: typeof fetch = async () => {
      await saveWorkflowIntegration(db, key, { ...options(), token: 'replacement' });
      if (failure) throw new Error('synthetic outage');
      return catalog('https://fixture.test');
    };
    await expect(discoverWorkflows(db, key, original, fetchImpl)).rejects.toThrow();
    expect(await db.query('select external_id from workflow_definitions')).toHaveLength(0);
    expect(await current(original.id)).toMatchObject({ status: 'active', last_check_ok: true });
  });

  it('rolls back a proposal whose audit fails and disconnects both keys while locked', async () => {
    const { integration, workflow } = await pendingRun();
    await db.query('delete from workflow_runs');
    await db.exec("create function reject_request() returns trigger as $$ begin if new.kind='workflow.run_requested' then raise exception 'synthetic request failure'; end if; return new; end; $$ language plpgsql; create trigger reject_request before insert on events for each row execute function reject_request();");
    await expect(requestWorkflowRun(db, key, { integration: await current(integration.id), workflow, ownerUserId: owner, input: {} })).rejects.toThrow('synthetic request failure');
    expect(await db.query('select id from workflow_runs')).toHaveLength(0);
    await setVaultLock(db, { master: true, locked: true, actorUserId: owner });
    await disconnectWorkflowIntegration(db, integration.id);
    expect(await items()).toHaveLength(0);
    expect(await current(integration.id)).toMatchObject({ status: 'disconnected', credentials_enc: '', callback_secret_enc: '' });
  });
});
