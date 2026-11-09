// "My World": the person's life, in the Vault, fed by chat.
//
// docs/JOSI_IS_THE_INTERFACE.md rule 8. Two layers, both the person's:
//   - items: typed records (people, addresses, vehicles, homes, documents,
//     cards, accounts) whose non-secret facts are plain and whose secret
//     fields are sealed with the owner's Vault box key. A secret value leaves
//     this module only through `revealWorldSecret`, which the page calls
//     behind the person's password; nothing here ever hands one to a model.
//   - memory: the "Josi knows" lines, in their own table, written only by the
//     My World flows. The general memory engine does not know this table.
import type { Db } from './db.js';
import { json } from './db.js';
import { appendEvent } from './events.js';
import type { MasterKey } from './masterKey.js';
import { Secret } from './sealing.js';
import { openForOwner, sealForOwner } from './vault.js';

export const WORLD_KINDS = ['person', 'address', 'vehicle', 'property', 'document', 'card', 'account', 'other'] as const;
export type WorldKind = (typeof WORLD_KINDS)[number];
export interface WorldField { key: string; label: string; secret: boolean; hint?: string }
export interface WorldKindSpec { kind: WorldKind; label: string; plural: string; fields: WorldField[]; dates: Array<{ key: string; label: string }>; sentence: string }

/** The one description of each kind: the page builds its forms from it, the
 * tools validate against it, and the default sensitivity comes from it. */
export const WORLD_KIND_SPECS: readonly WorldKindSpec[] = [
  { kind: 'person', label: 'Person', plural: 'People', sentence: '{label} is {relationship}',
    fields: [{ key: 'relationship', label: 'Relationship', secret: false, hint: 'daughter, spouse, friend' }, { key: 'phone', label: 'Phone', secret: false }, { key: 'email', label: 'Email', secret: false }, { key: 'notes', label: 'Notes', secret: false },
      { key: 'ssn', label: 'Social security number', secret: true }, { key: 'idNumber', label: 'ID number', secret: true }],
    dates: [{ key: 'birthday', label: 'Birthday' }, { key: 'anniversary', label: 'Anniversary' }] },
  { kind: 'address', label: 'Address', plural: 'Addresses', sentence: '{label}: {street}, {city}',
    fields: [{ key: 'street', label: 'Street', secret: false }, { key: 'city', label: 'City', secret: false }, { key: 'state', label: 'State or region', secret: false }, { key: 'postalCode', label: 'Postal code', secret: false }, { key: 'country', label: 'Country', secret: false }, { key: 'notes', label: 'Notes', secret: false },
      { key: 'gateCode', label: 'Gate code', secret: true }, { key: 'alarmCode', label: 'Alarm code', secret: true }],
    dates: [{ key: 'since', label: 'Living here since' }] },
  { kind: 'vehicle', label: 'Vehicle', plural: 'Vehicles', sentence: 'Owns {label}',
    fields: [{ key: 'make', label: 'Make', secret: false }, { key: 'model', label: 'Model', secret: false }, { key: 'year', label: 'Year', secret: false }, { key: 'color', label: 'Color', secret: false }, { key: 'insurer', label: 'Insurer', secret: false }, { key: 'notes', label: 'Notes', secret: false },
      { key: 'plate', label: 'License plate', secret: true }, { key: 'vin', label: 'VIN', secret: true }, { key: 'loanAccount', label: 'Loan account', secret: true }],
    dates: [{ key: 'bought', label: 'Bought' }, { key: 'registrationRenews', label: 'Registration renews' }, { key: 'insuranceRenews', label: 'Insurance renews' }] },
  { kind: 'property', label: 'Home or property', plural: 'Homes and properties', sentence: 'Has {label}',
    fields: [{ key: 'address', label: 'Address', secret: false }, { key: 'type', label: 'Type', secret: false, hint: 'house, apartment, rental' }, { key: 'lender', label: 'Lender or landlord', secret: false }, { key: 'notes', label: 'Notes', secret: false },
      { key: 'loanAccount', label: 'Mortgage or lease account', secret: true }, { key: 'gateCode', label: 'Gate code', secret: true }, { key: 'alarmCode', label: 'Alarm code', secret: true }],
    dates: [{ key: 'bought', label: 'Bought or moved in' }, { key: 'leaseEnds', label: 'Lease ends' }, { key: 'insuranceRenews', label: 'Insurance renews' }] },
  { kind: 'document', label: 'Passport or ID', plural: 'Passports and IDs', sentence: 'Holds {label}',
    fields: [{ key: 'type', label: 'Type', secret: false, hint: 'passport, driver license, ID card' }, { key: 'country', label: 'Issuing country', secret: false }, { key: 'holder', label: 'Holder', secret: false }, { key: 'notes', label: 'Notes', secret: false },
      { key: 'number', label: 'Document number', secret: true }],
    dates: [{ key: 'issued', label: 'Issued' }, { key: 'expires', label: 'Expires' }] },
  { kind: 'card', label: 'Card', plural: 'Cards', sentence: 'Has {label}',
    fields: [{ key: 'issuer', label: 'Bank or issuer', secret: false }, { key: 'network', label: 'Network', secret: false, hint: 'Visa, Mastercard, Amex' }, { key: 'lastFour', label: 'Last four digits', secret: false }, { key: 'notes', label: 'Notes', secret: false },
      { key: 'number', label: 'Card number', secret: true }, { key: 'cvv', label: 'Security code', secret: true }, { key: 'pin', label: 'PIN', secret: true }],
    dates: [{ key: 'expires', label: 'Expires' }] },
  { kind: 'account', label: 'Account', plural: 'Accounts', sentence: 'Has {label}',
    fields: [{ key: 'institution', label: 'Bank or company', secret: false }, { key: 'type', label: 'Type', secret: false, hint: 'checking, loan, utility' }, { key: 'holder', label: 'Holder', secret: false }, { key: 'notes', label: 'Notes', secret: false },
      { key: 'accountNumber', label: 'Account number', secret: true }, { key: 'routingNumber', label: 'Routing number', secret: true }, { key: 'pin', label: 'PIN', secret: true }, { key: 'password', label: 'Password', secret: true }],
    dates: [{ key: 'opened', label: 'Opened' }, { key: 'renews', label: 'Renews' }] },
  { kind: 'other', label: 'Something else', plural: 'Other', sentence: '{label}',
    fields: [{ key: 'what', label: 'What it is', secret: false }, { key: 'notes', label: 'Notes', secret: false }, { key: 'secret', label: 'Secret', secret: true }],
    dates: [{ key: 'date', label: 'Date' }, { key: 'renews', label: 'Renews' }] },
];
const SPEC = new Map(WORLD_KIND_SPECS.map((s) => [s.kind, s]));
export function worldKindSpec(kind: string): WorldKindSpec | null { return SPEC.get(kind as WorldKind) ?? null; }
export function isWorldKind(value: unknown): value is WorldKind { return typeof value === 'string' && SPEC.has(value as WorldKind); }
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const LOOKS_SECRET = /^\d[\d\s-]{11,}$/;

export class WorldError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export interface WorldItem {
  id: string; ownerUserId: string; kind: WorldKind; label: string;
  fields: Record<string, string>; dates: Record<string, string>;
  secretKeys: string[]; secretsSet: string[]; createdAt: string; updatedAt: string;
}
interface Row { id: string; owner_user_id: string; kind: WorldKind; label: string; fields: Record<string, string>; dates: Record<string, string>; secret_keys: string[]; secrets_enc: string | null; created_at: string; updated_at: string }

function cleanMap(value: unknown, max = 300): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!KEY.test(key)) throw new WorldError(400, `"${key}" is not a usable field name.`);
    if (raw === null || raw === undefined || raw === '') continue;
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
    if (text === null) throw new WorldError(400, `"${key}" must be text.`);
    if (text.length > max) throw new WorldError(400, `"${key}" is too long.`);
    out[key] = text;
  }
  return out;
}

/** Secret keys for an item: the kind's defaults unless the person changed them. */
function secretKeysFor(kind: WorldKind, stored: string[] | null | undefined): string[] {
  if (stored && stored.length) return stored;
  return SPEC.get(kind)!.fields.filter((f) => f.secret).map((f) => f.key);
}

/** The guard rule 5 and rule 8 rest on: a secret key never arrives as a plain
 * field, and a plain field that looks like a long number is refused too, so a
 * card number pasted into "notes" does not end up in the clear. */
export function refuseSecrets(kind: WorldKind, fields: Record<string, string>, secretKeys: string[]): void {
  for (const [key, value] of Object.entries(fields)) {
    if (secretKeys.includes(key)) throw new WorldError(400, `"${key}" is a secret field for this ${kind}: it is entered through a protected card, never written in the clear.`);
    if (LOOKS_SECRET.test(value) && key !== 'phone') throw new WorldError(400, `"${key}" looks like a card, account or document number. Those go into a secret field through a protected card.`);
  }
}

async function secretsOf(db: Db, masterKey: MasterKey | null, row: Row): Promise<Record<string, string>> {
  if (!row.secrets_enc || !masterKey) return {};
  try { return (await openForOwner<{ values: Record<string, string> }>(db, masterKey, row.owner_user_id, row.secrets_enc)).values ?? {}; }
  catch { return {}; }
}
function view(row: Row, secretsSet: string[]): WorldItem {
  return { id: row.id, ownerUserId: row.owner_user_id, kind: row.kind, label: row.label, fields: row.fields ?? {}, dates: row.dates ?? {},
    secretKeys: secretKeysFor(row.kind, row.secret_keys), secretsSet, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Every item, with which secret fields are set (never their values). The
 * master key is needed only to know which secrets exist; without it the list
 * still works and `secretsSet` is empty. */
export async function listWorldItems(db: Db, ownerUserId: string, masterKey: MasterKey | null = null): Promise<WorldItem[]> {
  const rows = await db.query<Row>('select * from my_world_items where owner_user_id = $1 order by kind, created_at', [ownerUserId]);
  const out: WorldItem[] = [];
  for (const row of rows) out.push(view(row, Object.keys(await secretsOf(db, masterKey, row))));
  return out;
}

export async function getWorldItem(db: Db, ownerUserId: string, id: string, masterKey: MasterKey | null = null): Promise<WorldItem | null> {
  const [row] = await db.query<Row>('select * from my_world_items where id = $1 and owner_user_id = $2', [id, ownerUserId]);
  return row ? view(row, Object.keys(await secretsOf(db, masterKey, row))) : null;
}

/** Adds or changes an item's plain facts. Secret values are refused here. The
 * item's "Josi knows" line is rebuilt from the result. */
export async function upsertWorldItem(db: Db, args: { ownerUserId: string; id?: string | null; kind?: string; label?: string; fields?: unknown; dates?: unknown; actor: 'chat' | 'page'; masterKey?: MasterKey | null }): Promise<WorldItem> {
  let existing: Row | null = null;
  if (args.id) {
    [existing] = await db.query<Row>('select * from my_world_items where id = $1 and owner_user_id = $2', [args.id, args.ownerUserId]);
    if (!existing) throw new WorldError(404, 'That item is not in this World.');
  }
  const kind = existing?.kind ?? args.kind;
  if (!isWorldKind(kind)) throw new WorldError(400, `Choose one of ${WORLD_KINDS.join(', ')}.`);
  const label = (typeof args.label === 'string' ? args.label.trim() : existing?.label ?? '').slice(0, 160);
  if (!label) throw new WorldError(400, 'Give it a name, such as "2026 Ford Explorer" or "Dana".');
  const incomingFields = cleanMap(args.fields);
  const incomingDates = cleanMap(args.dates, 40);
  const secretKeys = secretKeysFor(kind, existing?.secret_keys);
  refuseSecrets(kind, incomingFields, secretKeys);
  const fields = { ...(existing?.fields ?? {}), ...incomingFields };
  const dates = { ...(existing?.dates ?? {}), ...incomingDates };
  for (const [key, value] of Object.entries(args.fields && typeof args.fields === 'object' ? args.fields as Record<string, unknown> : {})) if (value === null || value === '') delete fields[key];
  for (const [key, value] of Object.entries(args.dates && typeof args.dates === 'object' ? args.dates as Record<string, unknown> : {})) if (value === null || value === '') delete dates[key];
  const [row] = existing
    ? await db.query<Row>('update my_world_items set label = $3, fields = $4, dates = $5 where id = $1 and owner_user_id = $2 returning *', [existing.id, args.ownerUserId, label, json(fields), json(dates)])
    : await db.query<Row>('insert into my_world_items (owner_user_id, kind, label, fields, dates) values ($1, $2, $3, $4, $5) returning *', [args.ownerUserId, kind, label, json(fields), json(dates)]);
  const item = view(row, Object.keys(await secretsOf(db, args.masterKey ?? null, row)));
  await rebuildItemLine(db, item);
  await appendEvent(db, { actorUserId: args.ownerUserId, actor: 'user', kind: existing ? 'my_world.item_updated' : 'my_world.item_added', subjectType: 'my_world_item', subjectId: row.id, payload: { kind, by: args.actor } });
  return item;
}

export async function deleteWorldItem(db: Db, ownerUserId: string, id: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>('delete from my_world_items where id = $1 and owner_user_id = $2 returning id', [id, ownerUserId]);
  if (rows.length) await appendEvent(db, { actorUserId: ownerUserId, actor: 'user', kind: 'my_world.item_removed', subjectType: 'my_world_item', subjectId: id, payload: {} });
  return rows.length > 0;
}

export async function setWorldSensitivity(db: Db, ownerUserId: string, id: string, secretKeys: unknown): Promise<WorldItem> {
  if (!Array.isArray(secretKeys) || secretKeys.some((k) => typeof k !== 'string' || !KEY.test(k))) throw new WorldError(400, 'List the field names that are secret.');
  const [row] = await db.query<Row>('update my_world_items set secret_keys = $3 where id = $1 and owner_user_id = $2 returning *', [id, ownerUserId, secretKeys]);
  if (!row) throw new WorldError(404, 'That item is not in this World.');
  // A field that just became secret must not stay in the clear.
  const fields = { ...(row.fields ?? {}) }; let changed = false;
  for (const key of secretKeys as string[]) if (key in fields) { delete fields[key]; changed = true; }
  const final = changed ? (await db.query<Row>('update my_world_items set fields = $3 where id = $1 and owner_user_id = $2 returning *', [id, ownerUserId, json(fields)]))[0] : row;
  return view(final, []);
}

/** Writes one secret field, sealed with the owner's box key. The value comes
 * from a protected card or the page, never from a model. */
export async function setWorldSecret(db: Db, masterKey: MasterKey, args: { ownerUserId: string; id: string; key: string; value: Secret }): Promise<WorldItem> {
  if (!KEY.test(args.key)) throw new WorldError(400, 'That is not a usable field name.');
  if (args.value.isEmpty) throw new WorldError(400, 'Enter the value.');
  const [row] = await db.query<Row>('select * from my_world_items where id = $1 and owner_user_id = $2 for update', [args.id, args.ownerUserId]);
  if (!row) throw new WorldError(404, 'That item is not in this World.');
  const values = await secretsOf(db, masterKey, row);
  values[args.key] = args.value.reveal();
  const secretKeys = secretKeysFor(row.kind, row.secret_keys);
  if (!secretKeys.includes(args.key)) secretKeys.push(args.key);
  const fields = { ...(row.fields ?? {}) }; delete fields[args.key];
  const [updated] = await db.query<Row>('update my_world_items set secrets_enc = $3, secret_keys = $4, fields = $5 where id = $1 and owner_user_id = $2 returning *',
    [args.id, args.ownerUserId, await sealForOwner(db, masterKey, args.ownerUserId, { values }), secretKeys, json(fields)]);
  const item = view(updated, Object.keys(values));
  await rebuildItemLine(db, item);
  await appendEvent(db, { actorUserId: args.ownerUserId, actor: 'user', kind: 'my_world.secret_set', subjectType: 'my_world_item', subjectId: args.id, payload: { key: args.key } });
  return item;
}

export async function clearWorldSecret(db: Db, masterKey: MasterKey, args: { ownerUserId: string; id: string; key: string }): Promise<WorldItem> {
  const [row] = await db.query<Row>('select * from my_world_items where id = $1 and owner_user_id = $2 for update', [args.id, args.ownerUserId]);
  if (!row) throw new WorldError(404, 'That item is not in this World.');
  const values = await secretsOf(db, masterKey, row);
  delete values[args.key];
  const sealed = Object.keys(values).length ? await sealForOwner(db, masterKey, args.ownerUserId, { values }) : null;
  const [updated] = await db.query<Row>('update my_world_items set secrets_enc = $3 where id = $1 and owner_user_id = $2 returning *', [args.id, args.ownerUserId, sealed]);
  const item = view(updated, Object.keys(values));
  await rebuildItemLine(db, item);
  return item;
}

/** The one way a secret value comes out: for the page, behind the person's
 * password, logged. Callers show it on screen only. */
export async function revealWorldSecret(db: Db, masterKey: MasterKey, args: { ownerUserId: string; id: string; key: string; actorUserId: string }): Promise<Secret> {
  const [row] = await db.query<Row>('select * from my_world_items where id = $1 and owner_user_id = $2', [args.id, args.ownerUserId]);
  if (!row) throw new WorldError(404, 'That item is not in this World.');
  const values = await secretsOf(db, masterKey, row);
  if (!(args.key in values)) throw new WorldError(404, 'That field is not set.');
  await appendEvent(db, { actorUserId: args.actorUserId, actor: 'user', kind: 'my_world.secret_revealed', subjectType: 'my_world_item', subjectId: args.id, payload: { key: args.key } });
  return new Secret(values[args.key]);
}

// ------------------------------------------------------------ Josi knows

export interface WorldMemoryLine { id: string; itemId: string | null; content: string; source: 'item' | 'chat' | 'page'; createdAt: string; updatedAt: string }
interface MemoryRow { id: string; item_id: string | null; content: string; source: 'item' | 'chat' | 'page'; created_at: string; updated_at: string }
const lineView = (r: MemoryRow): WorldMemoryLine => ({ id: r.id, itemId: r.item_id, content: r.content, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at });

function when(iso: string): string {
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return iso.slice(0, 10); }
}
/** The sentence Josi keeps about an item: its facts in the clear, and the
 * names (only) of the secret fields that are set. */
export function describeWorldItem(item: WorldItem): string {
  const spec = SPEC.get(item.kind)!;
  const facts = spec.fields.filter((f) => !f.secret && item.fields[f.key] && !['notes'].includes(f.key)).map((f) => `${f.label.toLowerCase()} ${item.fields[f.key]}`);
  const extra = Object.entries(item.fields).filter(([k]) => !spec.fields.some((f) => f.key === k)).map(([k, v]) => `${k} ${v}`);
  const dates = spec.dates.filter((d) => item.dates[d.key]).map((d) => `${d.label.toLowerCase()} ${item.dates[d.key]}`);
  const secrets = item.secretsSet.map((k) => spec.fields.find((f) => f.key === k)?.label.toLowerCase() ?? k);
  let line = `${spec.label}: ${item.label}`;
  if (item.kind === 'person' && item.fields.relationship) line = `${item.label} is ${item.fields.relationship}`;
  const detail = [...facts.filter((f) => !(item.kind === 'person' && f.startsWith('relationship'))), ...extra, ...dates];
  if (detail.length) line += ` (${detail.join('; ')})`;
  if (item.fields.notes) line += `. ${item.fields.notes}`;
  line += `. Added ${when(item.createdAt)}.`;
  if (secrets.length) line += ` ${secrets.length === 1 ? 'The' : 'The'} ${secrets.join(', ')} ${secrets.length === 1 ? 'is' : 'are'} in My World, behind the password.`;
  return line.slice(0, 600);
}
async function rebuildItemLine(db: Db, item: WorldItem): Promise<void> {
  const content = describeWorldItem(item);
  const [existing] = await db.query<{ id: string }>(`select id from my_world_memory where owner_user_id = $1 and item_id = $2 and source = 'item'`, [item.ownerUserId, item.id]);
  if (existing) await db.query('update my_world_memory set content = $2 where id = $1', [existing.id, content]);
  else await db.query(`insert into my_world_memory (owner_user_id, item_id, content, source) values ($1, $2, $3, 'item')`, [item.ownerUserId, item.id, content]);
}

export async function listWorldMemory(db: Db, ownerUserId: string): Promise<WorldMemoryLine[]> {
  return (await db.query<MemoryRow>('select id, item_id, content, source, created_at, updated_at from my_world_memory where owner_user_id = $1 order by created_at', [ownerUserId])).map(lineView);
}
export async function addWorldMemory(db: Db, args: { ownerUserId: string; content: string; itemId?: string | null; source: 'chat' | 'page' }): Promise<WorldMemoryLine> {
  const content = args.content.trim().slice(0, 600);
  if (content.length < 3) throw new WorldError(400, 'Write the fact in a sentence.');
  if (LOOKS_SECRET.test(content) || /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{2,4}\b/.test(content)) throw new WorldError(400, 'That looks like a number that belongs in a secret field, not in what Josi knows.');
  if (args.itemId) {
    const [item] = await db.query('select id from my_world_items where id = $1 and owner_user_id = $2', [args.itemId, args.ownerUserId]);
    if (!item) throw new WorldError(404, 'That item is not in this World.');
  }
  const [row] = await db.query<MemoryRow>('insert into my_world_memory (owner_user_id, item_id, content, source) values ($1, $2, $3, $4) returning id, item_id, content, source, created_at, updated_at', [args.ownerUserId, args.itemId ?? null, content, args.source]);
  return lineView(row);
}
export async function updateWorldMemory(db: Db, ownerUserId: string, id: string, content: string): Promise<WorldMemoryLine> {
  const text = content.trim().slice(0, 600);
  if (text.length < 3) throw new WorldError(400, 'Write the fact in a sentence.');
  const [row] = await db.query<MemoryRow>(`update my_world_memory set content = $3, source = case when source = 'item' then 'page' else source end where id = $1 and owner_user_id = $2 returning id, item_id, content, source, created_at, updated_at`, [id, ownerUserId, text]);
  if (!row) throw new WorldError(404, 'That line is not in this World.');
  return lineView(row);
}
export async function removeWorldMemory(db: Db, ownerUserId: string, id: string): Promise<boolean> {
  return (await db.query('delete from my_world_memory where id = $1 and owner_user_id = $2 returning id', [id, ownerUserId])).length > 0;
}

/** The block the assistant reads on every turn. Facts only; the words make
 * the boundary explicit so a model never goes looking for the values. */
export async function worldContext(db: Db, ownerUserId: string): Promise<string> {
  const lines = await listWorldMemory(db, ownerUserId);
  if (!lines.length) return '';
  return 'My World (what this person has told you about their life; kept apart from general memory, changed only by them or by the My World tools). '
    + 'Secret fields named here exist in their World but their values are never available to you: when one is needed, say it is in My World behind their password and offer to open it; never ask them to type or read it in chat.\n'
    + lines.map((l) => `- ${l.content}${l.itemId ? ` [item ${l.itemId}]` : ''}`).join('\n');
}
