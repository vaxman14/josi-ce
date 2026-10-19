import { expect, it } from 'vitest';
import { matchesControlTarget, type ActionProposal, type ControlLease } from '../src/index.js';

it('binds observations and actions to the same owner, goal, workspace, and control generation', () => {
  const identity = { serverId: 'server-a', userId: 'owner-a', deviceId: 'device-a', workspaceId: 'workspace-a' };
  const lease: ControlLease = { ...identity, sessionId: 'session-a', goalId: 'goal-a', generation: 4, holder: 'agent', expiresAt: '2026-10-19T20:00:00Z' };
  const proposal: ActionProposal = {
    ...identity, version: 1, id: 'action-a', goalId: lease.goalId, attemptId: 'attempt-a',
    controlSessionId: lease.sessionId, controlGeneration: lease.generation, sequence: 1,
    observation: { ...identity, id: 'observation-a', controlGeneration: lease.generation, targetId: 'tab-a', targetRevision: 7, capturedAt: '2026-10-19T19:59:00Z' },
    authority: { recordId: 'vault-rule-a', version: 3, digest: 'digest-reference', epoch: 9 },
    action: { kind: 'browser.observe', browserProfileId: 'profile-a', tabId: 'tab-a' }, expiresAt: lease.expiresAt,
  };
  expect(matchesControlTarget(proposal, lease)).toBe(true);
  for (const key of ['serverId', 'userId', 'deviceId', 'workspaceId'] as const) {
    expect(matchesControlTarget({ ...proposal, [key]: 'different' }, lease)).toBe(false);
    expect(matchesControlTarget({ ...proposal, observation: { ...proposal.observation, [key]: 'different' } }, lease)).toBe(false);
  }
  expect(matchesControlTarget({ ...proposal, goalId: 'different' }, lease)).toBe(false);
  expect(matchesControlTarget({ ...proposal, controlSessionId: 'different' }, lease)).toBe(false);
  expect(matchesControlTarget({ ...proposal, controlGeneration: 3 }, lease)).toBe(false);
  expect(matchesControlTarget({ ...proposal, observation: { ...proposal.observation, controlGeneration: 3 } }, lease)).toBe(false);
  expect(matchesControlTarget(proposal, { ...lease, holder: 'human' })).toBe(false);
  expect(matchesControlTarget(proposal, { ...lease, generation: 5 })).toBe(false);
});
