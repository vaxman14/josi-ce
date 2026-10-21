import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDb, testVault, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { createSession } from '../../auth/src/sessions.js';
import { claimDurableTurn, createThread, MasterKey, Secret, submitDurableTurn, type AutomationRuntime } from '@josi-ce/core';
import { loadStoredProvider, type SpawnRunner } from '@josi-ce/llm';
import { runAssistantTurn } from '../src/assistantAgent.js';

let db: TestDb, userId: string, threadId: string;
const key = new MasterKey(Buffer.alloc(32, 13));
beforeEach(async () => {
  db = await testDb();
  userId = (await createUser(db, { email: 'photo@ce.test', username: 'photo', role: 'super_admin' })).id;
  await testVault(db, key);
  threadId = (await createThread(db, { ownerUserId: userId })).id;
  await db.query(`insert into llm_providers(role,provider,model,external_acknowledged,activated_at,probed_at,cap_chat,cap_structured_output,cap_tool_calling,cap_vision,cap_context_tokens)
    values('primary','openai_subscription','test-vision',true,now(),now(),true,true,true,true,8000)`);
});

it.each([{ refused: false, warmup: 6 }, { refused: true, warmup: 0 }])('completes photo work after setup and respects dispatch refusal: %o', async ({ refused, warmup }) => {
  const session = await createSession(db, { userId });
  const accepted = await submitDurableTurn(db, { ownerUserId: userId, sessionId: session.sessionId, threadId, clientMessageId: 'photo-turn', message: 'Fill the first description from its photo.' });
  const turn = (await claimDurableTurn(db, accepted.turn.id))!;
  const ids = { task: randomUUID(), workspace: randomUUID(), observation: randomUUID(), profile: randomUUID(), tab: randomUUID(), photo: randomUUID(), field: randomUUID(), source: randomUUID(), capture: randomUUID() };
  const base64 = Buffer.from('authorized-photo-fixture').toString('base64');
  const stored = (await loadStoredProvider(db, 'primary'))!;
  const beforeDispatch = vi.fn(async () => { if (refused) throw new Error('permission revoked'); });
  const finish = vi.fn(async () => {});
  const execute = vi.fn(async (_context, request) => ({ status: 'succeeded', replayed: false,
    reservation: { id: request.action.kind === 'browser.photo' ? ids.capture : randomUUID(), effectIdentity: ids.observation } }));
  const projectObservation = vi.fn(async (_context, reservation) => {
    expect(reservation).toBe(ids.capture);
    return { expectedPrimary: { providerId: stored.provider, model: stored.model, configurationVersion: stored.updated_at },
      content: () => new Secret(JSON.stringify({ page: { photo: { mediaType: 'image/jpeg', base64 }, ocr: 'CHAIR' } })),
      beforeDispatch, finish };
  });
  const runtime = { inventory: async () => [{ state: 'ready', browserFamilies: ['chrome'], computerUse: false }],
    actionAvailable: true, observationAvailable: true, browserActionAvailable: () => true, computerActionAvailable: false,
    execute, projectObservation } as unknown as AutomationRuntime;
  let calls = 0;
  const runner: SpawnRunner = async call => {
    calls++;
    const step = calls - warmup;
    expect(call.args.join(' ')).not.toContain('mcp_servers');
    expect(call.args).toContain('--output-schema');
    if (step === 2) {
      expect(call.input).toContain('CHAIR');
      expect(call.input).not.toContain(base64);
      expect(call.privateFiles?.find(f => f.name.endsWith('.jpg'))?.base64).toBe(base64);
      await call.beforeStart!();
    } else {
      expect(call.privateFiles?.some(f => f.name.endsWith('.jpg'))).toBe(false);
      expect(call.input).not.toContain('CHAIR');
    }
    const action = { kind: step === 1 ? 'browser.photo' : 'browser.draft', browserProfileId: ids.profile, tabId: ids.tab,
      elementId: step === 1 ? ids.photo : ids.field, sourceReservationId: ids.source, ...(step === 2 ? { text: 'Red chair with four legs.' } : {}) };
    const value = step <= 0 ? { reply: '', tool: { name: 'get_automation_workspaces', arguments: '{}' } } : step <= 2 ? { reply: '', tool: { name: 'browser_control', arguments: JSON.stringify({
      task_id: ids.task, workspace_id: ids.workspace, observation_id: ids.observation, action,
    }) } } : { reply: 'The description is ready for review.', tool: null };
    return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify({ type: 'agent_message', message: JSON.stringify(value) }) };
  };
  const result = await runAssistantTurn({ db, userId, threadId, history: [], inbound: 'Fill the first description from its photo.',
    inboundMessageId: turn.inbound_message_id, durableTurnId: turn.id, durableLeaseToken: turn.lease_token,
    automationRuntime: runtime, registry: { db, masterKey: key, codexRunner: runner } });
  expect(beforeDispatch).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledWith(!refused);
  expect(execute).toHaveBeenCalledTimes(refused ? 1 : 2);
  if (refused) expect(result.refusal).toBeDefined();
  else {
    expect(result.refusal).toBeUndefined();
    expect(execute.mock.calls[1][1].action).toMatchObject({ kind: 'browser.draft', text: 'Red chair with four legs.' });
  }
  const effects = await db.query<{receipt: unknown}>(`select receipt from assistant_turn_effects where turn_id=$1`, [turn.id]);
  expect(effects).toHaveLength(refused ? 1 : 2);
  expect(JSON.stringify(effects)).not.toContain(base64);
  expect(JSON.stringify(effects)).not.toContain('CHAIR');
});

