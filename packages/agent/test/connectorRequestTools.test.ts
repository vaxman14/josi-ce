import { describe, expect, it } from 'vitest';
import { executeConnectorRequestTool, announceConnectorRequests, CONNECTOR_REQUEST_TOOLS } from '../src/connectorRequestTools.js';
import type { Db } from '@josi-ce/core';

interface Fake { db: Db; inserted: unknown[][]; updates: string[]; messages: string[] }
function fake(role: string, extra: Array<(sql: string, params?: unknown[]) => unknown[] | null> = []): Fake {
  const inserted: unknown[][] = [], updates: string[] = [], messages: string[] = [];
  const db = { query: async (sql: string, params?: unknown[]) => {
    if (sql.includes('insert into settings_change_proposals')) { inserted.push(params ?? []); return [{ id: '11111111-1111-4111-8111-111111111111' }]; }
    if (sql.startsWith('update settings_change_proposals')) { updates.push(sql.includes("'approved'") ? 'approved' : sql.includes("'applied'") ? 'applied' : sql.includes("'denied'") ? 'denied' : 'other'); return [{ id: 'x' }]; }
    if (sql.includes('insert into messages') || sql.includes('insert into thread_messages')) { messages.push(String(params?.[2] ?? '')); return [{ id: 'm' }]; }
    for (const answer of extra) { const rows = answer(sql, params); if (rows) return rows; }
    if (sql.includes('from users where id = $1 and role')) return role === 'super_admin' ? [{ id: 'u1' }] : [];
    if (sql.includes('select role, username from users')) return [{ role, username: role === 'super_admin' ? 'roman' : 'dana' }];
    if (sql.includes('developer_service_policy')) return [];
    if (sql.includes('developer_service_allowed_users')) return [];
    return [];
  } } as unknown as Db;
  return { db, inserted, updates, messages };
}

describe('member connector requests', () => {
  it('offers request, decide and revoke tools, all read-class', () => {
    expect(CONNECTOR_REQUEST_TOOLS.map((t) => t.def.name)).toEqual(['request_connector_access', 'decide_connector_request', 'revoke_connector_access']);
    for (const t of CONNECTOR_REQUEST_TOOLS) expect(t.actionClass).toBeNull();
  });
  it('needs no approval for OAuth providers or for the owner', async () => {
    const member = fake('member');
    expect(await executeConnectorRequestTool(member.db, 'u2', 'request_connector_access', { connector: 'google' })).toMatchObject({ ok: true, approvalNeeded: false });
    const owner = fake('super_admin');
    expect(await executeConnectorRequestTool(owner.db, 'u1', 'request_connector_access', { connector: 'github' })).toMatchObject({ ok: true, approvalNeeded: false });
    expect(owner.inserted).toHaveLength(0);
  });
  it('records a member\'s GitHub request as a week-long administrator proposal that names the person', async () => {
    const member = fake('member');
    const out = await executeConnectorRequestTool(member.db, 'u2', 'request_connector_access', { connector: 'github', reason: 'school project' }, 'thread-9') as { ok: boolean; approvalNeeded: boolean; requestId: string };
    expect(out).toMatchObject({ ok: true, approvalNeeded: true, requestId: '11111111-1111-4111-8111-111111111111' });
    const [params] = member.inserted;
    expect(params[0]).toBe('u2'); expect(params[1]).toBe('member_connector_request');
    expect(String(params[3])).toMatch(/dana asks to connect their own GitHub account/); expect(String(params[3])).toContain('school project');
    expect(params[4]).toBe('/admin/developer-services/github/allow');
    expect((params[5] as { value: unknown }).value).toEqual({ userId: 'u2' });
    expect(params[6]).toBe('thread-9');
  });
  it('does not ask twice while a request is waiting', async () => {
    const member = fake('member', [(sql) => sql.includes("state = 'proposed' and expires_at > now()") && sql.includes('proposer_user_id = $1') ? [{ id: 'old', created_at: '2026-11-07' }] : null]);
    expect(await executeConnectorRequestTool(member.db, 'u2', 'request_connector_access', { connector: 'github' })).toMatchObject({ ok: true, approvalNeeded: true, requestId: 'old', state: 'waiting' });
    expect(member.inserted).toHaveLength(0);
  });
  it('lets only the owner decide, and tells the member in their conversation', async () => {
    const pending = (sql: string) => sql.includes('p.area = $2') && sql.includes('p.id = $1')
      ? [{ id: '11111111-1111-4111-8111-111111111111', proposer_user_id: 'u2', proposer: 'dana', path: '/admin/developer-services/github/allow', body: {}, thread_id: 'thread-9', state: 'proposed', title: 'GitHub access for dana' }] : null;
    const member = fake('member', [pending]);
    expect(await executeConnectorRequestTool(member.db, 'u2', 'decide_connector_request', { request_id: '11111111-1111-4111-8111-111111111111', approve: true })).toMatchObject({ ok: false, code: 'owner_only' });
    const owner = fake('super_admin', [pending, (sql) => sql.includes('insert into developer_service_policy') || sql.includes('insert into developer_service_allowed_users') ? [] : null]);
    const out = await executeConnectorRequestTool(owner.db, 'u1', 'decide_connector_request', { request_id: '11111111-1111-4111-8111-111111111111', approve: true });
    expect(out).toMatchObject({ ok: true, state: 'applied' });
    expect(owner.updates).toEqual(['approved', 'applied']);
    const denied = fake('super_admin', [pending]);
    expect(await executeConnectorRequestTool(denied.db, 'u1', 'decide_connector_request', { request_id: '11111111-1111-4111-8111-111111111111', approve: false, note: 'not yet' })).toMatchObject({ ok: true, state: 'denied' });
    expect(denied.updates).toEqual(['denied']);
  });
  it('announces waiting requests to the owner only', async () => {
    const owner = fake('super_admin', [(sql) => sql.includes("p.state = 'proposed' and p.expires_at > now()") ? [{ id: 'r1', proposer: 'dana', summary: 'dana asks to connect their own GitHub account to Josi.', created_at: 'now' }] : null]);
    expect(await announceConnectorRequests(owner.db, 'u1')).toMatch(/\[request_id r1\] dana asks to connect/);
    expect(await announceConnectorRequests(fake('member').db, 'u2')).toBe('');
  });
});
