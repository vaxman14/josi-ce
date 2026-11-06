// What a finished turn read, for the conversation that asked.
//
// Tool receipts stay private by default. This is the deliberate exception: the
// labels a chat card shows under a reply, so a person can see which email,
// event, contact or document an answer came from. Message bodies, snippets and
// provider ids never cross here.

export type TurnSourceKind = 'email' | 'event' | 'contact' | 'document';
export interface TurnSource { tool: string; kind: TurnSourceKind; title: string; detail: string; date: string | null }
export interface TurnActivity { tools: string[]; sources: TurnSource[] }

const MAX_SOURCES = 12;
const text = (value: unknown, limit = 200) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object') : [];

const email = (tool: string, row: Record<string, unknown>): TurnSource =>
  ({ tool, kind: 'email', title: text(row.subject) || '(no subject)', detail: text(row.from), date: text(row.date, 60) || null });
const event = (tool: string, row: Record<string, unknown>): TurnSource =>
  ({ tool, kind: 'event', title: text(row.title) || 'Untitled event', detail: text(row.calendar_name), date: text(row.start, 60) || null });

function sourcesOf(tool: string, result: Record<string, unknown>): TurnSource[] {
  switch (tool) {
    case 'search_email': return rows(result.emails).map((row) => email(tool, row));
    case 'read_email': return rows([result.email]).map((row) => email(tool, row));
    case 'query_calendar': return rows(result.events).map((row) => event(tool, row));
    case 'get_event': return rows([result.event]).map((row) => event(tool, row));
    case 'search_contacts': return rows(result.contacts).map((row) => ({
      tool, kind: 'contact' as const, title: text(row.name) || 'Unnamed',
      detail: [row.email, row.phone].map((value) => text(value)).filter(Boolean).join(' · '), date: null,
    }));
    case 'search_documents': return rows(result.hits).map((row) => ({
      tool, kind: 'document' as const, title: text(row.citation) || 'Document', detail: '', date: null,
    }));
    default: return [];
  }
}

/** Only tools that succeeded, in the order they ran. A read that failed showed
 * the model nothing, so it is no source of anything. */
export function presentTurnActivity(receipts: unknown): TurnActivity {
  const tools: string[] = [];
  const sources: TurnSource[] = [];
  for (const receipt of rows(receipts)) {
    const tool = text(receipt.tool, 80);
    if (!tool) continue;
    const result = receipt.result && typeof receipt.result === 'object' ? receipt.result as Record<string, unknown> : {};
    if (result.ok === false) continue;
    tools.push(tool);
    sources.push(...sourcesOf(tool, result));
  }
  return { tools, sources: sources.slice(-MAX_SOURCES) };
}
