import { describe, expect, it } from 'vitest';
import { prepareCredentialCard, executeCredentialCardTool, CREDENTIAL_CARD_TOOLS, CREDENTIAL_KINDS } from '../src/credentialCardTools.js';
import { findSecret } from '../src/settingsChangeTools.js';
import type { Db } from '@josi-ce/core';

function db(answers: Array<(sql: string, params?: unknown[]) => unknown[] | null>, inserted: unknown[][] = []): Db {
  return { query: async (sql: string, params?: unknown[]) => {
    if (sql.includes('insert into settings_change_proposals')) { inserted.push(params ?? []); return [{ id: 'card-1' }]; }
    for (const answer of answers) { const rows = answer(sql, params); if (rows) return rows; }
    return [];
  } } as unknown as Db;
}
const plain = (role: string) => [
  (sql: string) => sql.includes('from users where id') ? [{ role }] : null,
  (sql: string) => sql.includes('deployment_config') ? [{ domain: 'josi.example.com' }] : null,
  (sql: string) => sql.includes('from llm_providers') ? [{ provider: 'anthropic', model: 'claude-sonnet-4-5', base_url: null }] : null,
];

describe('credential cards', () => {
  it('offers one tool whose schema allows only the catalogue kinds', () => {
    const [tool] = CREDENTIAL_CARD_TOOLS;
    expect(tool.def.name).toBe('request_credential_card');
    const schema = tool.def.parameters as { additionalProperties: boolean; properties: { kind: { enum: string[] } } };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.kind.enum).toEqual([...CREDENTIAL_KINDS]);
  });
  it('builds the Google card with the redirect URI fixed from the address and the secret as a secure field', async () => {
    const card = await prepareCredentialCard(db(plain('super_admin')), 'oauth_client', 'google');
    expect(card).toMatchObject({ scope: 'administrator', method: 'PUT', path: '/admin/connectors/clients/google', fixed: { redirectUri: 'https://josi.example.com/api/connections/google/callback' } });
    expect(card.card.fields.map((f) => [f.key, f.type])).toEqual([['clientId', 'text'], ['clientSecret', 'secret']]);
    expect(card.card.intro).toContain('https://josi.example.com/api/auth/google/callback');
  });
  it('builds a developer token card from the service catalogue, with its extra fields', async () => {
    const github = await prepareCredentialCard(db(plain('member')), 'developer_token', 'github');
    expect(github).toMatchObject({ scope: 'personal', method: 'PUT', path: '/connections/developer/github' });
    expect(github.card.fields.map((f) => f.key)).toEqual(['token']);
    const jira = await prepareCredentialCard(db(plain('member')), 'developer_token', 'jira');
    expect(jira.card.fields.map((f) => f.key)).toEqual(['baseUrl', 'email', 'token']);
  });
  it('fixes the model slot\'s provider and model so the key card cannot switch models', async () => {
    const card = await prepareCredentialCard(db(plain('super_admin')), 'model_api_key', 'primary');
    expect(card.fixed).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5', baseUrl: '', externalAcknowledged: true });
    expect(card.card.fields).toEqual([{ key: 'apiKey', label: 'API key', type: 'secret', required: true }]);
  });
  it('refuses kinds and providers outside the catalogue', async () => {
    await expect(prepareCredentialCard(db(plain('super_admin')), 'oauth_client', 'evilcorp')).rejects.toThrow(/oauth_client needs one of/);
    await expect(prepareCredentialCard(db(plain('super_admin')), 'messaging_channel', 'irc')).rejects.toThrow(/slack|whatsapp/);
    expect(await executeCredentialCardTool(db(plain('super_admin')), 'u1', 'request_credential_card', { kind: 'vault_dump' })).toMatchObject({ ok: false, code: 'unknown_kind' });
  });
  it('records the card as a proposal that carries fields and fixed values, never a secret', async () => {
    const inserted: unknown[][] = [];
    const out = await executeCredentialCardTool(db(plain('super_admin'), inserted), 'u1', 'request_credential_card', { kind: 'oauth_client', provider: 'google' }, 'thread-1') as { ok: boolean; cardId: string; message: string };
    expect(out).toMatchObject({ ok: true, cardId: 'card-1' });
    expect(out.message).toMatch(/card titled "Google application" is open/);
    const [params] = inserted;
    expect(params[0]).toBe('u1'); expect(params[1]).toBe('administrator'); expect(params[2]).toBe('credential_card'); expect(params[8]).toBe('thread-1');
    const body = (params[7] as { value: unknown }).value as { card: { fields: Array<{ key: string }> }; fixed: Record<string, unknown> };
    expect(body.card.fields.map((f) => f.key)).toEqual(['clientId', 'clientSecret']);
    expect(findSecret(body.fixed)).toBeNull();
  });
  it('lets only the owner open administrator cards, and sends an unpermitted member to ask', async () => {
    expect(await executeCredentialCardTool(db(plain('member')), 'u2', 'request_credential_card', { kind: 'oauth_client', provider: 'google' })).toMatchObject({ ok: false, code: 'administrator_only' });
    expect(await executeCredentialCardTool(db(plain('member')), 'u2', 'request_credential_card', { kind: 'developer_token', provider: 'github' })).toMatchObject({ ok: false, code: 'needs_admin_approval' });
    const allowed = db([...plain('member'), (sql) => sql.includes('developer_service_policy') ? [{ mode: 'everyone' }] : null]);
    expect(await executeCredentialCardTool(allowed, 'u2', 'request_credential_card', { kind: 'developer_token', provider: 'github' })).toMatchObject({ ok: true });
    expect(await executeCredentialCardTool(db(plain('super_admin')), 'u1', 'request_credential_card', { kind: 'developer_token', provider: 'github' })).toMatchObject({ ok: true });
  });
});
