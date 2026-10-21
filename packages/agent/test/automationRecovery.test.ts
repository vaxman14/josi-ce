import { expect, it } from 'vitest';
import { automationDiscovery } from '../src/automationTools.js';
import { automationBlockerFromReceipts, type AutomationRuntime, type Db } from '@josi-ce/core';

const runtime = (state: string | null) => ({ inventory: async () => state ? [{ state }] : [],
  actionAvailable: true, observationAvailable: true }) as unknown as AutomationRuntime;

it.each([
  [null, 'no_workspaces'], ['offline', 'device_offline'], ['paused', 'human_takeover'],
  ['needs_local_consent', 'local_consent_required'],
])('returns an actionable discovery blocker for %s', async (state, code) => {
  const result = await automationDiscovery(runtime(state), 'owner');
  expect(result.controlAvailable).toBe(false);
  expect(result.blocker?.code).toBe(code);
  expect(result.blocker?.message).toMatch(/Automation|automation/);
});
it('distinguishes locked Vault and failed discovery from disconnected hardware', async () => {
  const locked = { query: async () => [{ locked: true }] } as unknown as Db;
  expect((await automationDiscovery(runtime('ready'), 'owner', locked)).blocker?.code).toBe('vault_locked');
  const broken = { inventory: async () => { throw Error('internal diagnostic must stay private'); } } as unknown as AutomationRuntime;
  const result = await automationDiscovery(broken, 'owner');
  expect(result.blocker?.code).toBe('status_unavailable');
  expect(JSON.stringify(result)).not.toContain('internal diagnostic');
});
it('a ready workspace clears older blockers, without granting operation permissions', async () => {
  const result = await automationDiscovery(runtime('ready'), 'owner');
  expect(result.blocker).toBeNull();
  expect(automationBlockerFromReceipts([
    { tool: 'get_automation_workspaces', result: { blocker: { code: 'no_workspaces' } } },
    { tool: 'get_automation_workspaces', result },
  ])).toBeNull();
});
