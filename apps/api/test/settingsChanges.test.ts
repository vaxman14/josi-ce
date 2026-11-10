// Settings changes Josi proposes: what a proposal may carry, and that a sensitive
// one is only approved with the approver's password, checked here on the server.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSession, SESSION_TTL_SECONDS } from '@josi-ce/auth';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { NEVER_BY_ASKING, SETTINGS_AREAS, buildPath, executeSettingsChangeTool, findSecret } from '../../../packages/agent/src/settingsChangeTools.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const password = 'synthetic-owner-password';
const fakeId = '00000000-0000-4000-8000-000000000001';
let db: TestDb, server: Server, base: string, ownerId: string, ownerToken: string, memberId: string, memberToken: string;

const session = async (userId: string) => (await createSession(db, { userId, ip: '127.0.0.1', userAgent: 'test', ttlSeconds: SESSION_TTL_SECONDS })).token;
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-josi-client': 'native', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const propose = (userId: string, area: string, body: Record<string, unknown> = {}, params: Record<string, unknown> = {}) =>
  executeSettingsChangeTool(db, userId, 'propose_josi_setting_change', { area, summary: 'Change this setting as described.', body, params }) as Promise<any>;
const stateOf = async (id: string) => (await db.query<{ state: string }>(`select state from settings_change_proposals where id = $1`, [id]))[0]!.state;

beforeEach(async () => {
  db = await testDb(); await ensureWorkspace(db);
  ownerId = (await createUser(db, { email: 'owner@fixture.test', username: 'owner', role: 'super_admin', password })).id;
  memberId = (await createUser(db, { email: 'member@fixture.test', username: 'member', role: 'member', password: 'synthetic-member-password' })).id;
  ownerToken = await session(ownerId); memberToken = await session(memberId);
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: false });
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('approving a sensitive change', () => {
  it('refuses without a password and changes nothing', async () => {
    const { proposalId } = await propose(ownerId, 'local_only_models', { enabled: true });
    const res = await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: true });
    expect(res.status).toBe(401);
    expect(res.body.apply).toBeUndefined();
    expect(await stateOf(proposalId)).toBe('proposed');
  });

  it('refuses the wrong password', async () => {
    const { proposalId } = await propose(ownerId, 'local_only_models', { enabled: true });
    expect((await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: true, password: 'not-the-password' })).status).toBe(401);
    expect(await stateOf(proposalId)).toBe('proposed');
  });

  it('approves with the right password and hands back the request', async () => {
    const { proposalId } = await propose(ownerId, 'local_only_models', { enabled: true });
    const res = await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: true, password });
    expect(res.status).toBe(200);
    expect(res.body.apply).toEqual({ method: 'PUT', path: '/admin/llm/local-only', body: { enabled: true } });
    expect(await stateOf(proposalId)).toBe('approved');
  });

  it('asks every time: a step-up from a moment ago does not count', async () => {
    expect((await call(ownerToken, 'POST', '/assistant/step-up', { password })).status).toBe(200);
    const { proposalId } = await propose(ownerId, 'local_only_models', { enabled: true });
    expect((await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: true })).status).toBe(401);
  });

  it('locks out repeated guesses, even with the right password afterwards', async () => {
    const { proposalId } = await propose(ownerId, 'local_only_models', { enabled: true });
    let last = 0;
    for (let i = 0; i < 12 && last !== 429; i++) last = (await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: true, password: `guess-${i}` })).status;
    expect(last).toBe(429);
    expect((await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: true, password })).status).toBe(429);
    expect(await stateOf(proposalId)).toBe('proposed');
  });

  it('checks the approver, not the person who asked', async () => {
    await call(ownerToken, 'PUT', '/settings-changes/policy', { memberSettingsChanges: 'super_admin' });
    const { proposalId } = await propose(memberId, 'approval_level', { level: 'automatic' }, { actionClass: 'email_send' });
    expect((await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: true, password: 'synthetic-member-password' })).status).toBe(401);
    expect((await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: true, password })).status).toBe(200);
  });

  it('tells an account with no password what to do, and still refuses', async () => {
    await db.query(`update users set password_hash = null where id = $1`, [ownerId]);
    const { proposalId } = await propose(ownerId, 'local_only_models', { enabled: true });
    const res = await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: true, password: 'anything' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Set a password');
    expect(await stateOf(proposalId)).toBe('proposed');
  });

  it('needs no password to decline', async () => {
    const { proposalId } = await propose(ownerId, 'local_only_models', { enabled: true });
    expect((await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: false })).status).toBe(200);
    expect(await stateOf(proposalId)).toBe('denied');
  });

  it('needs none for a plain change', async () => {
    const { proposalId } = await propose(ownerId, 'workspace', { name: 'Home', timezone: 'America/Los_Angeles' });
    expect((await call(ownerToken, 'POST', `/settings-changes/${proposalId}/decide`, { approve: true })).status).toBe(200);
  });
});

describe('what a proposal may carry', () => {
  it('cannot smuggle a field past a plain area', async () => {
    const result = await propose(ownerId, 'workspace', { name: 'Home', settings: { memberSettingsChanges: 'self' } });
    expect(result.code).toBe('unsupported_field');
  });

  it.each([
    [{ password: 'x' }], [{ apiKey: 'x' }], [{ nested: { client_secret: 'x' } }], [{ list: [{ accessToken: 'x' }] }], [{ note: 'sk-abcdefghijklmnop' }],
  ])('refuses a secret at any depth: %j', async (body) => {
    expect((await propose(ownerId, 'storage_policy', body)).code).toBe('no_secrets');
  });

  it('does not mistake a token count for a secret', () => {
    expect(findSecret({ monthlyTokens: 1000, monthlyCostUsd: 5 })).toBeNull();
  });

  it('refuses an area outside the catalogue', async () => {
    for (const area of ['cardinal_rules', 'vault', 'device_enrollment', 'mfa']) expect((await propose(ownerId, area)).code).toBe('unknown_area');
  });
});

describe('the catalogue', () => {
  const filled = (area: (typeof SETTINGS_AREAS)[number]) => buildPath(area, Object.fromEntries((area.params ?? []).map((name) => [name,
    name === 'role' ? 'primary' : name === 'provider' ? 'slack' : name === 'actionClass' ? 'email_send' : name === 'kind' ? 'soul' : name === 'capability' ? 'mail.read' : name === 'service' ? 'github' : fakeId])));

  it('never reaches secrets, rules, the Vault or device approval', () => {
    for (const area of SETTINGS_AREAS) for (const blocked of NEVER_BY_ASKING) expect(area.path.startsWith(blocked), area.area).toBe(false);
  });

  it('names its fields wherever no password protects it', () => {
    for (const area of SETTINGS_AREAS.filter((a) => !a.sensitive)) expect(area.keys, area.area).toBeDefined();
  });

  it('marks everything that widens what Josi may do as sensitive', () => {
    const plain = SETTINGS_AREAS.filter((a) => !a.sensitive).map((a) => a.area).sort();
    // chat_reasoning only changes how quickly she answers, so it needs no password.
    expect(plain).toEqual(['calendar_source', 'chat_reasoning', 'contact_sync_interval', 'memory_learning', 'personality_profile', 'show_narration', 'workspace'].sort());
  });

  it('points every entry at a route that exists', async () => {
    const missing = await call(ownerToken, 'PUT', '/definitely/not/a/route', {});
    const dead: string[] = [];
    for (const area of SETTINGS_AREAS) {
      const res = await call(ownerToken, area.method, filled(area), area.method === 'DELETE' ? undefined : {});
      if (res.status === missing.status && JSON.stringify(res.body) === JSON.stringify(missing.body)) dead.push(`${area.area} ${area.method} ${area.path}`);
    }
    // Parental Controls is behind its licence, and without one its routes answer
    // exactly as if they weren't there.
    expect(dead.filter((entry) => !entry.startsWith('parental_controls '))).toEqual([]);
  });
});

describe('credential cards', () => {
  it('hands the app the card (fields, fixed values) and never a secret, and lets the proposer apply it', async () => {
    const { executeCredentialCardTool } = await import('../../../packages/agent/src/credentialCardTools.js');
    const opened = await executeCredentialCardTool(db, ownerId, 'request_credential_card', { kind: 'oauth_client', provider: 'google' }, null) as { ok: boolean; cardId: string };
    expect(opened.ok).toBe(true);
    const list = await call(ownerToken, 'GET', '/settings-changes');
    const row = list.body.proposals.find((p: { id: string }) => p.id === opened.cardId);
    expect(row.area).toBe('credential_card');
    expect(row.canApprove).toBe(true);
    expect(row.card.fields.map((f: { key: string; type: string }) => [f.key, f.type])).toEqual([['clientId', 'text'], ['clientSecret', 'secret']]);
    expect(row.card.title).toBe('Google application');
    const decided = await call(ownerToken, 'POST', `/settings-changes/${opened.cardId}/decide`, { approve: true });
    expect(decided.status).toBe(200);
    expect(decided.body.apply).toMatchObject({ method: 'PUT', path: '/admin/connectors/clients/google' });
    expect(String(decided.body.apply.body.redirectUri)).toMatch(/\/api\/connections\/google\/callback$/);
    expect(JSON.stringify(decided.body)).not.toMatch(/clientSecret":"/);
  });
});

