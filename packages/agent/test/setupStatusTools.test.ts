import { describe, expect, it } from 'vitest';
import { connectorRequirement, installationOrigin, executeSetupStatusTool, SETUP_STATUS_TOOLS, SETUP_STATUS_PROMPT } from '../src/setupStatusTools.js';
import type { Db } from '@josi-ce/core';

function db(answers: Array<(sql: string, params?: unknown[]) => unknown[] | null>): Db {
  return { query: async (sql: string, params?: unknown[]) => {
    for (const answer of answers) { const rows = answer(sql, params); if (rows) return rows; }
    return [];
  } } as unknown as Db;
}

describe('josi_setup_status', () => {
  it('is a read tool with a bounded schema', () => {
    const [tool] = SETUP_STATUS_TOOLS;
    expect(tool.def.name).toBe('josi_setup_status');
    expect(tool.actionClass).toBeNull();
    const schema = tool.def.parameters as { additionalProperties: boolean; properties: { topic: { enum: string[] } } };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.topic.enum).toContain('connectors');
    expect(SETUP_STATUS_PROMPT).toMatch(/Never answer "check the Josi app"/);
  });
  it('builds the redirect URIs from the installation address, with Google\'s second callback', () => {
    const google = connectorRequirement('google', 'https://josi.example.com');
    expect(google.redirectUris).toEqual(['https://josi.example.com/api/connections/google/callback', 'https://josi.example.com/api/auth/google/callback']);
    expect(connectorRequirement('microsoft', 'https://josi.example.com').redirectUris).toEqual(['https://josi.example.com/api/connections/microsoft/callback']);
    expect(connectorRequirement('nextcloud', 'https://josi.example.com').redirectUris).toEqual([]);
  });
  it('prefers a public https APP_URL, then the stored domain, then the local address', async () => {
    const stored = db([(sql) => sql.includes('deployment_config') ? [{ domain: 'home.example.net' }] : null]);
    expect(await installationOrigin(stored, 'https://josi.example.com')).toMatchObject({ origin: 'https://josi.example.com', mode: 'public' });
    expect(await installationOrigin(stored, 'http://localhost:8080')).toMatchObject({ origin: 'https://home.example.net', publicHttpsBase: 'https://home.example.net', mode: 'public' });
    const none = db([(sql) => sql.includes('deployment_config') ? [{ domain: null }] : null]);
    expect(await installationOrigin(none, 'http://localhost:8080')).toMatchObject({ origin: 'http://localhost:8080', publicHttpsBase: null, mode: 'this_pc' });
    expect(await installationOrigin(none, 'https://10.10.1.5:8443')).toMatchObject({ origin: 'https://10.10.1.5:8443', publicHttpsBase: null, mode: 'network' });
  });
  it('tells the owner what Google needs and shows a member only their own side, never a secret', async () => {
    const rows = (role: string) => db([
      (sql) => sql.includes('from users where id') ? [{ id: 'u1', role }] : null,
      (sql) => sql.includes('deployment_config') ? [{ domain: null }] : null,
      (sql) => sql.includes('from oauth_clients') ? [] : null,
      (sql) => sql.includes('from connections where owner_user_id') ? [{ provider: 'google', account_email: 'me@example.com', status: 'active', last_check_ok: true }] : null,
      (sql) => sql.includes('from developer_connections') ? [{ service: 'github', account_label: 'roman', status: 'active', last_check_ok: true }] : null,
      (sql) => sql.includes('hosted') || sql.includes('heyjosi') ? [] : null,
    ]);
    const owner = await executeSetupStatusTool(rows('super_admin'), 'u1', 'josi_setup_status', { topic: 'connectors' }) as { viewer: string; connectors: { oauth: Array<Record<string, unknown>>; developer: Array<Record<string, unknown>> } };
    expect(owner.viewer).toBe('owner');
    const google = owner.connectors.oauth.find((p) => p.provider === 'google')!;
    expect(google.ready).toBe(false);
    expect(google.needs).toMatch(/client ID and client secret/);
    expect(google.redirectUris).toEqual(['http://localhost:8080/api/connections/google/callback', 'http://localhost:8080/api/auth/google/callback']);
    expect(google.connected).toBe(true);
    const github = owner.connectors.developer.find((d) => d.service === 'github')!;
    expect(github).toMatchObject({ connected: true, account: 'roman', membersMayConnect: 'not_allowed' });

    const member = await executeSetupStatusTool(rows('member'), 'u1', 'josi_setup_status', { topic: 'connectors' }) as { viewer: string; connectors: { oauth: Array<Record<string, unknown>> } };
    expect(member.viewer).toBe('member');
    const mine = member.connectors.oauth.find((p) => p.provider === 'google')!;
    expect(mine.ready).toBeUndefined();
    expect(mine.redirectUris).toBeUndefined();
    expect(mine.connected).toBe(true);
    expect(JSON.stringify(owner) + JSON.stringify(member)).not.toMatch(/secret_enc|credentials_enc|password_enc/);
  });
  it('reports a model slot with what it passed and only "set" for the key', async () => {
    const d = db([
      (sql) => sql.includes('from users where id') ? [{ id: 'u1', role: 'super_admin' }] : null,
      (sql) => sql.includes('from llm_providers') ? [{ role: 'primary', provider: 'anthropic', model: 'claude-sonnet-4-5', base_url: null, activated_at: '2026-11-08', external_acknowledged: true, has_key: true }] : null,
      (sql) => sql.includes('from llm_probe_memory') ? [{ provider: 'anthropic', model: 'claude-sonnet-4-5', base_url: '', probed_at: '2026-11-08', cap_chat: true, cap_structured_output: true, cap_tool_calling: true, cap_vision: true, cap_context_tokens: 200000 }] : null,
      (sql) => sql.includes('security_policy') ? [{ local_only: false }] : null,
    ]);
    const out = await executeSetupStatusTool(d, 'u1', 'josi_setup_status', { topic: 'models' }) as { models: { slots: Array<Record<string, unknown>> } };
    expect(out.models.slots[0]).toMatchObject({ role: 'primary', model: 'claude-sonnet-4-5', active: true, apiKey: 'set', checked: { toolCalling: true, vision: true } });
  });
});
