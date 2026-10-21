import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDb } from './helpers.js';
import { currentAutomationModelCandidate, requireCurrentAutomationModel } from '../src/automationModelTargets.js';
import { claimDurableTurn, failDurableTurn, listTaskRunsFor, submitDurableTurn } from '../src/mobile.js';

it('registers only a named, checked ChatGPT destination and invalidates a changed configuration', async () => {
  const db = await testDb(), id = randomUUID();
  await db.query(`insert into llm_providers(role,provider,model,external_acknowledged,activated_at,probed_at,cap_chat)
    values('primary','openai_subscription','',true,now(),now(),true)`);
  expect(await currentAutomationModelCandidate(db, 'primary', id)).toBeNull();
  await db.query(`update llm_providers set model='test-vision' where role='primary'`);
  const candidate = (await currentAutomationModelCandidate(db, 'primary', id))!;
  expect(candidate.providerId).toBe('openai_subscription');
  await requireCurrentAutomationModel(db, candidate);
  await db.query(`update llm_providers set model='another-model',updated_at=now() where role='primary'`);
  await expect(requireCurrentAutomationModel(db, candidate)).rejects.toThrow(/changed/);
});

it('lists a failed conversation request even when no goal or task was created, only for its owner', async () => {
  const db = await testDb();
  const [u] = await db.query<{id:string}>(`insert into users(email,username,role) values('failed@ce.test','failed','member') returning id`);
  const [t] = await db.query<{id:string}>(`insert into threads(owner_user_id,title) values($1,'Photo descriptions') returning id`, [u.id]);
  const [s] = await db.query<{id:string}>(`insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 day') returning id`, [u.id, randomUUID()]);
  const accepted = await submitDurableTurn(db, { ownerUserId: u.id, sessionId: s.id, threadId: t.id, clientMessageId: 'before-goal', message: 'Describe the photos' });
  const turn = (await claimDurableTurn(db, accepted.turn.id))!;
  await failDurableTurn(db, { turnId: turn.id, leaseToken: turn.lease_token, code: 'provider_error', retryable: true });
  expect(await db.query('select id from tasks')).toHaveLength(0);
  expect(await listTaskRunsFor(db, { ownerUserId: u.id })).toEqual([expect.objectContaining({ id: turn.id, thread_title: 'Photo descriptions', status: 'failed', error_code: 'provider_error' })]);
  expect(await listTaskRunsFor(db, { ownerUserId: randomUUID() })).toEqual([]);
});

