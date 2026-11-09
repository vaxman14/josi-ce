// My World from the conversation (docs/JOSI_IS_THE_INTERFACE.md rule 8).
//
// "I just bought a 2026 Ford Explorer" → Josi adds the vehicle with its plain
// facts, congratulates, and offers the follow-ups. Anything secret (plate,
// VIN, loan account) is asked for with a protected card the person types
// into; the model never sees, asks for or repeats such a value. The "Josi
// knows" lines live in their own store and reach the model on every turn
// through `worldContext`, never through the general memory engine.
import { json, WorldError, WORLD_KIND_SPECS, WORLD_KINDS, addWorldMemory, deleteWorldItem, getWorldItem, listWorldItems, listWorldMemory, removeWorldMemory, upsertWorldItem, worldKindSpec, type Db, type WorldItem } from '@josi-ce/core';
import type { ToolSpec } from './tools.js';
import { CREDENTIAL_CARD_AREA } from './credentialCardTools.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const map = { type: 'object', additionalProperties: { type: 'string', maxLength: 300 } } as const;

export const MY_WORLD_TOOLS: ToolSpec[] = [
  { def: { name: 'my_world_list',
    description: 'Read the person\'s World: their people, addresses, vehicles, homes, documents, cards and accounts, with their plain facts and dates, the names of the secret fields that are set (never the values), and the "Josi knows" lines. Also lists the field names each kind takes. Use it before adding or changing, and to answer questions about their life.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: [...WORLD_KINDS] } }, additionalProperties: false } }, actionClass: null },
  { def: { name: 'my_world_add',
    description: 'Add something to the person\'s World when they tell you about their life: a new car, a move, a family member, a passport, a card, an account. Pass only non-secret facts (make, model, year, color, city, relationship, issuer, last four digits). Secret fields (plate, VIN, card or account numbers, document numbers, PINs, codes) are never passed here: after adding, offer them one by one with my_world_secret_card.',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: [...WORLD_KINDS] },
      label: { type: 'string', maxLength: 160, description: 'How the person calls it: "2026 Ford Explorer", "Dana", "Murrieta house", "Chase Sapphire".' },
      fields: { ...map, description: 'Plain facts by field name (see my_world_list for the names each kind takes; other names are kept too).' },
      dates: { ...map, description: 'Dates by name, for example bought, registrationRenews, expires, birthday: YYYY-MM-DD or as said.' },
    }, required: ['kind', 'label'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'my_world_update',
    description: 'Change an item\'s plain facts or dates, or rename it. An empty string removes a field. Secret fields still go through my_world_secret_card.',
    parameters: { type: 'object', properties: {
      item_id: { type: 'string', format: 'uuid', maxLength: 36 }, label: { type: 'string', maxLength: 160 }, fields: map, dates: map,
    }, required: ['item_id'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'my_world_remove',
    description: 'Remove an item from the person\'s World, with its secrets and its "Josi knows" line. Only when they ask for exactly that, naming the item; confirm which item first if there could be two.',
    parameters: { type: 'object', properties: { item_id: { type: 'string', format: 'uuid', maxLength: 36 } }, required: ['item_id'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'my_world_secret_card',
    description: 'Open a protected card in the Josi app for one secret field of an item (plate, VIN, loan account, card number, document number, PIN, gate code). The person types it; it goes to their World in the Vault; you learn only that it was saved. Never ask for the value in chat and never repeat one.',
    parameters: { type: 'object', properties: {
      item_id: { type: 'string', format: 'uuid', maxLength: 36 },
      field: { type: 'string', maxLength: 40, description: 'The secret field name for that kind, from my_world_list (for example plate, vin, number, accountNumber).' },
    }, required: ['item_id', 'field'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'my_world_note',
    description: 'Add one plain sentence to what you know about the person\'s World that no item field holds ("Dana drives the Explorer on weekdays"). Never a number that could be a card, account or document number.',
    parameters: { type: 'object', properties: { content: { type: 'string', maxLength: 600 }, item_id: { type: 'string', format: 'uuid', maxLength: 36 } }, required: ['content'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'my_world_forget',
    description: 'Remove one "Josi knows" line by its id, only when the person asks to forget or correct exactly that fact. Lines built from an item come back when the item changes; remove the item instead when they mean the thing itself.',
    parameters: { type: 'object', properties: { line_id: { type: 'string', format: 'uuid', maxLength: 36 } }, required: ['line_id'], additionalProperties: false } }, actionClass: null },
];
export const MY_WORLD_TOOL_NAMES = new Set(MY_WORLD_TOOLS.map((t) => t.def.name));

export const MY_WORLD_PROMPT = 'My World: when the person tells you something about their life (a purchase, a move, a new family member, a renewal), add it with my_world_add, react like a friend would (congratulate, ask the natural follow-up), and offer the secret fields one at a time through my_world_secret_card ("Want to give me the plate? It goes straight into your World, I never see it."). '
  + 'Never ask for, accept, repeat or store a card, account or document number, VIN, plate, PIN, code or password in chat, even when offered; if one appears in a message, do not repeat it and say it belongs in a protected card. '
  + '"Read my card number back" or any ask to see a secret: it is shown only on the My World page, on screen, behind their password; say so and point them to My World in the menu. You may still use a secret on their behalf through a protected flow that never shows it to you. '
  + 'What you know about their World is listed in this context; answer from it directly. Only the person changes it: remove or correct a fact only when they ask for exactly that.';

const view = (item: WorldItem) => ({ itemId: item.id, kind: item.kind, label: item.label, fields: item.fields, dates: item.dates, secretFieldsSet: item.secretsSet, secretFields: item.secretKeys, updatedAt: item.updatedAt });

export async function executeMyWorldTool(db: Db, userId: string, name: string, input: Record<string, unknown>, threadId: string | null = null) {
  try {
    if (name === 'my_world_list') {
      const kind = typeof input.kind === 'string' ? input.kind : null;
      const items = (await listWorldItems(db, userId)).filter((i) => !kind || i.kind === kind);
      // Which secret fields exist is known without the master key only after a
      // write; the list shows the kind's secret field names regardless.
      return { ok: true, items: items.map(view), knows: (await listWorldMemory(db, userId)).map((l) => ({ lineId: l.id, itemId: l.itemId, content: l.content, source: l.source })),
        kinds: WORLD_KIND_SPECS.map((s) => ({ kind: s.kind, label: s.label, plainFields: s.fields.filter((f) => !f.secret).map((f) => f.key), secretFields: s.fields.filter((f) => f.secret).map((f) => f.key), dates: s.dates.map((d) => d.key) })),
        note: 'Secret values are never returned here and never asked for in chat.' };
    }
    if (name === 'my_world_add' || name === 'my_world_update') {
      const id = name === 'my_world_update' ? String(input.item_id ?? '') : null;
      if (id !== null && !UUID.test(id)) return { ok: false, code: 'bad_item_id' };
      const item = await upsertWorldItem(db, { ownerUserId: userId, id, kind: typeof input.kind === 'string' ? input.kind : undefined, label: typeof input.label === 'string' ? input.label : undefined, fields: input.fields, dates: input.dates, actor: 'chat' });
      const spec = worldKindSpec(item.kind)!;
      const missing = spec.fields.filter((f) => f.secret && !item.secretsSet.includes(f.key));
      return { ok: true, item: view(item), message: `${name === 'my_world_add' ? 'Added' : 'Updated'}: ${item.label}.`,
        secretFieldsToOffer: missing.map((f) => ({ field: f.key, label: f.label })),
        hint: missing.length ? 'Offer these one at a time with my_world_secret_card; never ask for the values in chat.' : undefined };
    }
    if (name === 'my_world_remove') {
      const id = String(input.item_id ?? '');
      if (!UUID.test(id)) return { ok: false, code: 'bad_item_id' };
      const item = await getWorldItem(db, userId, id);
      if (!item) return { ok: false, code: 'not_found', message: 'That item is not in their World.' };
      await deleteWorldItem(db, userId, id);
      return { ok: true, message: `Removed ${item.label} and everything stored with it.` };
    }
    if (name === 'my_world_secret_card') {
      const id = String(input.item_id ?? ''); const field = String(input.field ?? '').trim();
      if (!UUID.test(id)) return { ok: false, code: 'bad_item_id' };
      const item = await getWorldItem(db, userId, id);
      if (!item) return { ok: false, code: 'not_found', message: 'That item is not in their World.' };
      const spec = worldKindSpec(item.kind)!;
      const known = spec.fields.find((f) => f.key === field);
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(field) || (known && !known.secret && !item.secretKeys.includes(field))) return { ok: false, code: 'not_secret', message: `${field} is a plain field: set it with my_world_update.` };
      const label = known?.label ?? field;
      const card = { kind: 'my_world_secret', provider: item.kind, title: `${label} for ${item.label}`, intro: `Type the ${label.toLowerCase()} of ${item.label}. It is sealed into your World in the Vault; Josi never sees it, and it is shown again only on the My World page behind your password.`,
        fields: [{ key: 'value', label, type: 'secret', required: true }], help: { text: 'Only you can read this back, on the My World page.', url: null }, done: `${label} for ${item.label} is in your World.` };
      const path = `/my-world/items/${item.id}/secrets/${encodeURIComponent(field)}`;
      await db.query(`update settings_change_proposals set state = 'expired' where proposer_user_id = $1 and area = $2 and path = $3 and state = 'proposed'`, [userId, CREDENTIAL_CARD_AREA, path]);
      const [row] = await db.query<{ id: string }>(
        `insert into settings_change_proposals(proposer_user_id, scope, area, sensitive, title, summary, method, path, body, thread_id)
         values ($1, 'personal', $2, false, $3, $4, 'PUT', $5, $6, $7) returning id`,
        [userId, CREDENTIAL_CARD_AREA, card.title, card.intro, path, json({ card, fixed: {} }), threadId]);
      return { ok: true, cardId: row.id, state: 'card_open', message: `A protected card for the ${label.toLowerCase()} of ${item.label} is open in the Josi app. Say so and wait; a note here will say when it is saved. Never ask for the value in chat.` };
    }
    if (name === 'my_world_note') {
      const itemId = typeof input.item_id === 'string' && UUID.test(input.item_id) ? input.item_id : null;
      const line = await addWorldMemory(db, { ownerUserId: userId, content: String(input.content ?? ''), itemId, source: 'chat' });
      return { ok: true, lineId: line.id, message: 'Noted in their World.' };
    }
    if (name === 'my_world_forget') {
      const id = String(input.line_id ?? '');
      if (!UUID.test(id)) return { ok: false, code: 'bad_line_id' };
      return (await removeWorldMemory(db, userId, id)) ? { ok: true, message: 'Forgotten.' } : { ok: false, code: 'not_found', message: 'No such line.' };
    }
    return { ok: false, code: 'unknown_tool' };
  } catch (error) {
    if (error instanceof WorldError) return { ok: false, code: 'refused', message: error.message };
    throw error;
  }
}
