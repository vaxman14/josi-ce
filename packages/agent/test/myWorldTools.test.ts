import { describe, expect, it } from 'vitest';
import { executeMyWorldTool, MY_WORLD_TOOLS, MY_WORLD_PROMPT } from '../src/myWorldTools.js';
import type { Db } from '@josi-ce/core';

const ITEM = { id: '22222222-2222-4222-8222-222222222222', owner_user_id: 'u1', kind: 'vehicle', label: '2026 Ford Explorer', fields: { color: 'blue' }, dates: {}, secret_keys: [], secrets_enc: null, created_at: '2026-11-08T20:00:00Z', updated_at: '2026-11-08T20:00:00Z' };
function fake() {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: async (sql: string, params: unknown[] = []) => {
    if (/^(insert|update|delete)/i.test(sql.trim())) {
      writes.push({ sql, params });
      if (sql.includes('insert into my_world_items')) return [{ ...ITEM, kind: params[1], label: params[2], fields: (params[3] as { value: unknown }).value, dates: (params[4] as { value: unknown }).value }];
      if (sql.includes('insert into settings_change_proposals')) return [{ id: 'card-9' }];
      if (sql.includes('insert into my_world_memory')) return [{ id: 'line-1', item_id: params[1], content: params[2], source: params[3], created_at: 'now', updated_at: 'now' }];
      if (sql.includes('delete from my_world_items')) return [{ id: params[0] }];
      return [];
    }
    if (sql.includes('from my_world_items where id = $1')) return params[0] === ITEM.id ? [ITEM] : [];
    if (sql.includes('from my_world_items where owner_user_id')) return [ITEM];
    if (sql.includes('from my_world_memory where owner_user_id = $1 and item_id')) return [];
    if (sql.includes('from my_world_memory where owner_user_id')) return [{ id: 'line-1', item_id: ITEM.id, content: 'Vehicle: 2026 Ford Explorer.', source: 'item', created_at: 'now', updated_at: 'now' }];
    return [];
  } } as unknown as Db;
  return { db, writes };
}

describe('My World tools', () => {
  it('offers the seven tools and tells the model the boundary', () => {
    expect(MY_WORLD_TOOLS.map((t) => t.def.name)).toEqual(['my_world_list', 'my_world_add', 'my_world_update', 'my_world_remove', 'my_world_secret_card', 'my_world_note', 'my_world_forget']);
    expect(MY_WORLD_PROMPT).toMatch(/Never ask for, accept, repeat or store a card/);
  });
  it('adds a vehicle from plain facts, writes its Josi-knows line, and names the secrets left to offer', async () => {
    const { db, writes } = fake();
    const out = await executeMyWorldTool(db, 'u1', 'my_world_add', { kind: 'vehicle', label: '2026 Ford Explorer', fields: { make: 'Ford', model: 'Explorer', year: '2026' }, dates: { bought: '2026-11-08' } }) as { ok: boolean; secretFieldsToOffer: Array<{ field: string }> };
    expect(out.ok).toBe(true);
    expect(out.secretFieldsToOffer.map((f) => f.field)).toEqual(['plate', 'vin', 'loanAccount']);
    expect(writes.some((w) => w.sql.includes('insert into my_world_items'))).toBe(true);
    const memory = writes.find((w) => w.sql.includes('insert into my_world_memory'))!;
    expect(String(memory.params[2])).toMatch(/^Vehicle: 2026 Ford Explorer/);
  });
  it('refuses a secret or a long number passed as a plain fact', async () => {
    const { db } = fake();
    expect(await executeMyWorldTool(db, 'u1', 'my_world_add', { kind: 'vehicle', label: 'Explorer', fields: { plate: '8ABC123' } })).toMatchObject({ ok: false, code: 'refused' });
    expect(await executeMyWorldTool(db, 'u1', 'my_world_add', { kind: 'card', label: 'Visa', fields: { notes: '4111111111111111' } })).toMatchObject({ ok: false, code: 'refused' });
    expect(await executeMyWorldTool(db, 'u1', 'my_world_note', { content: 'card 4111 1111 1111 1111' })).toMatchObject({ ok: false, code: 'refused' });
  });
  it('opens a protected card for a secret field that posts to the item, carrying no value', async () => {
    const { db, writes } = fake();
    const out = await executeMyWorldTool(db, 'u1', 'my_world_secret_card', { item_id: ITEM.id, field: 'plate' }, 'thread-1');
    expect(out).toMatchObject({ ok: true, cardId: 'card-9', state: 'card_open' });
    const proposal = writes.find((w) => w.sql.includes('insert into settings_change_proposals'))!;
    expect(proposal.params[1]).toBe('credential_card');
    expect(proposal.params[4]).toBe(`/my-world/items/${ITEM.id}/secrets/plate`);
    const body = (proposal.params[5] as { value: { card: { fields: Array<{ type: string }>; title: string } } }).value;
    expect(body.card.fields).toEqual([{ key: 'value', label: 'License plate', type: 'secret', required: true }]);
    expect(body.card.title).toBe('License plate for 2026 Ford Explorer');
    expect(await executeMyWorldTool(db, 'u1', 'my_world_secret_card', { item_id: ITEM.id, field: 'color' })).toMatchObject({ ok: false, code: 'not_secret' });
  });
  it('lists items without secret values and removes only on an explicit ask', async () => {
    const { db, writes } = fake();
    const list = await executeMyWorldTool(db, 'u1', 'my_world_list', {}) as { items: Array<Record<string, unknown>>; knows: unknown[] };
    expect(list.items[0]).toMatchObject({ label: '2026 Ford Explorer', secretFields: ['plate', 'vin', 'loanAccount'], secretFieldsSet: [] });
    expect(JSON.stringify(list)).not.toContain('secrets_enc');
    expect(await executeMyWorldTool(db, 'u1', 'my_world_remove', { item_id: ITEM.id })).toMatchObject({ ok: true });
    expect(writes.some((w) => w.sql.includes('delete from my_world_items'))).toBe(true);
  });
});
