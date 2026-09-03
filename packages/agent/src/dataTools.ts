// The assistant's window onto connected data: mail, calendar, contacts.
//
// Round-2 item 17 named the gap plainly: "the difference between connected and
// useful". The OAuth plumbing, sealed tokens and per-user capability switches
// all existed; nothing exposed the data to the conversation. These tools do,
// read-only, and the switches stay in charge:
//
//   * OFFERING is decided per turn (`dataToolAvailability`): a tool appears in
//     the model's list only when at least one connected provider has the
//     matching read capability ON right now. Absent tool, absent promise.
//   * EXECUTION re-checks the same capability at call time (`can`). A switch
//     flipped off mid-conversation refuses honestly, in the words of the
//     Connections page, even though the tool was offered when the turn began.
//   * Results are what the provider or the local store actually returned.
//     Empty is reported as empty. There is no path here that invents a row.
//
// Contacts prefer the LOCAL synced store — the sync pipeline exists precisely
// so the assistant does not hammer the People APIs — and fall back to one
// bounded provider read only when the local store has nothing and the switch
// allows it.
import type { Db, MasterKey } from '@josi-ce/core';
import {
  accessTokenFor, can, connectionFor, getEvent, listEvents, loadClient, readContactPage, readMail,
  refusalReason, searchMail,
  type CapabilityState, type ConnectionRow, type OAuthClient, type Provider, type RemoteEvent,
} from '@josi-ce/connectors';
import type { ToolSpec } from './tools.js';

/** How the executor reaches sealed tokens. Optional on the context because
 * the task/reminder tools never need it; a data tool called without it
 * refuses rather than crashing. The key is behind a thunk so it is loaded
 * only when a data tool actually runs. */
export interface ConnectorAccess {
  masterKey: () => MasterKey;
  fetchImpl?: typeof fetch;
}

type Family = 'mail' | 'calendar' | 'contacts';

const FAMILY_CAPABILITY: Record<Family, Record<Provider, string>> = {
  mail: { google: 'google.mail.read', microsoft: 'microsoft.mail.read' },
  calendar: { google: 'google.calendar.read', microsoft: 'microsoft.calendar.read' },
  contacts: { google: 'google.contacts.read', microsoft: 'microsoft.contacts.read' },
};

const FAMILY_LABEL: Record<Family, string> = {
  mail: 'email',
  calendar: 'calendar',
  contacts: 'contacts',
};

const PROVIDERS: Provider[] = ['google', 'microsoft'];

// ----------------------------------------------------------- tool catalogue

export const DATA_TOOLS: ToolSpec[] = [
  {
    def: {
      name: 'search_email',
      description:
        "Search the user's connected mailbox (Gmail or Outlook). Read-only. Returns sender, "
        + 'subject, date and a snippet for up to 10 matches — use read_email with an email_id for '
        + 'the full message. Gmail search operators (from:, subject:, newer_than:) work on Gmail. '
        + 'Report an empty result as no matches; never guess at mail contents.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          limit: { type: 'number', description: 'Max results, up to 10.' },
        },
        required: ['query'],
      },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'read_email',
      description:
        'Read one email in full, by the email_id a search_email result gave. Read-only. Long '
        + 'bodies are truncated and say so.',
      parameters: {
        type: 'object',
        properties: { email_id: { type: 'string', description: 'An email_id from search_email.' } },
        required: ['email_id'],
      },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'query_calendar',
      description:
        "List events on the user's connected calendar in a time range. Read-only. Defaults to the "
        + 'next 7 days when no range is given; use ISO 8601 times for start and end. Good for '
        + '"what\'s my day/week". Use get_event with an event_id for full details.',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'Range start, ISO 8601. Defaults to now.' },
          end: { type: 'string', description: 'Range end, ISO 8601. Defaults to 7 days after start.' },
        },
      },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'get_event',
      description: 'Full details of one calendar event, by the event_id a query_calendar result gave. Read-only.',
      parameters: {
        type: 'object',
        properties: { event_id: { type: 'string', description: 'An event_id from query_calendar.' } },
        required: ['event_id'],
      },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'search_contacts',
      description:
        "Look up people in the user's contacts by name, email or phone. Read-only. Searches the "
        + 'locally synced address book first and falls back to the connected account when the '
        + 'local store is empty. Report no match honestly; never invent a person or a number.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'A name, email address or phone fragment.' } },
        required: ['query'],
      },
    },
    actionClass: null,
  },
];

const TOOLS_BY_FAMILY: Record<Family, string[]> = {
  mail: ['search_email', 'read_email'],
  calendar: ['query_calendar', 'get_event'],
  contacts: ['search_contacts'],
};

export const DATA_TOOL_FAMILY: Map<string, Family> = new Map(
  (Object.entries(TOOLS_BY_FAMILY) as Array<[Family, string[]]>)
    .flatMap(([family, names]) => names.map((n) => [n, family] as [string, Family])),
);

// ------------------------------------------------------------- availability

interface FamilyAccess {
  /** Providers whose read switch is ON right now. */
  allowed: Provider[];
  /** The most useful refusal when none is — written for the model to relay. */
  refusal: string;
}

async function familyAccess(db: Db, userId: string, family: Family): Promise<FamilyAccess> {
  const allowed: Provider[] = [];
  let bestState: CapabilityState | null = null;
  let bestCapability = FAMILY_CAPABILITY[family].google;
  for (const provider of PROVIDERS) {
    const capability = FAMILY_CAPABILITY[family][provider];
    const verdict = await can(db, { ownerUserId: userId, capability });
    if (verdict.allowed) {
      allowed.push(provider);
      continue;
    }
    // The refusal that names the smallest fix wins: an existing connection
    // with the switch off beats "connect an account" — the person already
    // connected one, they just have not enabled this.
    const connected = !!(await connectionFor(db, { ownerUserId: userId, provider }));
    if (connected && (bestState === null || verdict.state === 'off')) {
      bestState = verdict.state;
      bestCapability = capability;
    }
  }
  const refusal = bestState
    ? refusalReason(bestState, bestCapability)
    : `No account with ${FAMILY_LABEL[family]} access is connected. Connect Google or Microsoft on the Connections page first.`;
  return { allowed, refusal };
}

export interface DataToolAvailability {
  /** Specs to offer this turn. */
  specs: ToolSpec[];
  /** For the system prompt: what the assistant can honestly claim. */
  granted: Family[];
  /** For the system prompt: what is off, and the sentence that fixes it. */
  denied: Array<{ what: string; hint: string }>;
}

/** Which data tools this person's switches allow RIGHT NOW.
 *
 * Contacts are also offered when the local store has rows even if every
 * provider switch is off — the rows are already Josi's to search, imported
 * with consent by the sync pipeline. */
export async function dataToolAvailability(db: Db, userId: string): Promise<DataToolAvailability> {
  const specs: ToolSpec[] = [];
  const granted: Family[] = [];
  const denied: DataToolAvailability['denied'] = [];

  for (const family of ['mail', 'calendar', 'contacts'] as Family[]) {
    const access = await familyAccess(db, userId, family);
    let available = access.allowed.length > 0;
    if (!available && family === 'contacts') {
      const [row] = await db.query<{ n: number }>(
        `select count(*)::int as n from contacts where owner_user_id = $1`,
        [userId],
      );
      available = (row?.n ?? 0) > 0;
    }
    if (available) {
      granted.push(family);
      specs.push(...DATA_TOOLS.filter((t) => TOOLS_BY_FAMILY[family].includes(t.def.name)));
    } else {
      denied.push({ what: FAMILY_LABEL[family], hint: access.refusal });
    }
  }
  return { specs, granted, denied };
}

// ---------------------------------------------------------------- execution

interface ProviderSession {
  provider: Provider;
  connection: ConnectionRow;
  client: OAuthClient;
  accessToken: string;
}

const NO_ACCESS = (message: string) => ({ ok: false, error: 'not_enabled', message });

/** Opens a live session per allowed provider — capability re-checked NOW, not
 * trusted from offering time. Returns sessions plus the refusal to use when
 * there are none. */
async function openSessions(
  db: Db,
  access: ConnectorAccess,
  userId: string,
  family: Family,
  only?: Provider,
): Promise<{ sessions: ProviderSession[]; refusal: string }> {
  const verdict = await familyAccess(db, userId, family);
  const wanted = only ? verdict.allowed.filter((p) => p === only) : verdict.allowed;
  const sessions: ProviderSession[] = [];
  const key = access.masterKey();
  for (const provider of wanted) {
    const connection = await connectionFor(db, { ownerUserId: userId, provider });
    if (!connection) continue;
    const client = await loadClient(db, key, provider);
    const accessToken = await accessTokenFor(
      db, key, { connection, client }, { fetchImpl: access.fetchImpl },
    );
    sessions.push({ provider, connection, client, accessToken });
  }
  const refusal = only && verdict.allowed.length && !wanted.length
    ? `Your ${only === 'google' ? 'Google' : 'Microsoft'} ${FAMILY_LABEL[family]} access is not enabled. You can turn it on on the Connections page.`
    : verdict.refusal;
  return { sessions, refusal };
}

/** Ids handed to the model carry the provider, so a later read goes back to
 * the right account without guessing. */
const taggedId = (provider: Provider, id: string) => `${provider}:${id}`;

function untagId(tagged: string): { provider: Provider; id: string } | null {
  const m = /^(google|microsoft):(.+)$/.exec(tagged);
  return m ? { provider: m[1] as Provider, id: m[2] } : null;
}

function eventView(provider: Provider, event: RemoteEvent) {
  return {
    event_id: taggedId(provider, event.sourceId),
    title: event.title,
    start: event.start,
    end: event.end,
    all_day: event.allDay,
    location: event.location,
    organizer: event.organizer,
    attendees: event.attendees,
    status: event.status,
    ...(event.description !== undefined ? { description: event.description } : {}),
  };
}

/** Runs one data tool. The caller has already matched the name against
 * DATA_TOOL_FAMILY; anything else does not belong here. */
export async function executeDataTool(
  db: Db,
  args: { userId: string; access: ConnectorAccess | null },
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const family = DATA_TOOL_FAMILY.get(name);
  if (!family) return { ok: false, error: 'unknown_tool', message: `no tool named ${name}` };

  // Contacts read the local store before they need any provider at all.
  if (name === 'search_contacts') return searchContacts(db, args, input);

  if (!args.access) {
    return { ok: false, error: 'unavailable', message: 'Connected accounts cannot be reached right now. Tell the user their data connections are unavailable at the moment.' };
  }

  switch (name) {
    case 'search_email': {
      const query = String(input.query ?? '').trim();
      if (!query) return { ok: false, error: 'bad_query', message: 'Say what to search for.' };
      const { sessions, refusal } = await openSessions(db, args.access, args.userId, 'mail');
      if (!sessions.length) return NO_ACCESS(refusal);
      const limit = Number.isFinite(Number(input.limit)) ? Number(input.limit) : undefined;
      const emails = [];
      for (const s of sessions) {
        const found = await searchMail(s.provider, { accessToken: s.accessToken, query, limit }, { fetchImpl: args.access.fetchImpl });
        emails.push(...found.map((e) => ({
          email_id: taggedId(s.provider, e.sourceId),
          from: e.from, to: e.to, subject: e.subject, date: e.date, snippet: e.snippet,
        })));
      }
      return {
        ok: true,
        emails,
        ...(emails.length ? {} : { message: 'No email matched that search.' }),
      };
    }

    case 'read_email': {
      const ref = untagId(String(input.email_id ?? ''));
      if (!ref) return { ok: false, error: 'not_found', message: 'There is no email with that id. Use an email_id from search_email.' };
      const { sessions, refusal } = await openSessions(db, args.access, args.userId, 'mail', ref.provider);
      if (!sessions.length) return NO_ACCESS(refusal);
      const s = sessions[0];
      const email = await readMail(s.provider, { accessToken: s.accessToken, id: ref.id }, { fetchImpl: args.access.fetchImpl });
      if (!email) return { ok: false, error: 'not_found', message: 'There is no email with that id.' };
      return {
        ok: true,
        email: {
          email_id: taggedId(s.provider, email.sourceId),
          from: email.from, to: email.to, subject: email.subject, date: email.date,
          body: email.body,
          body_kind: email.bodyKind,
          truncated: email.truncated,
          ...(email.truncated ? { note: 'The body was longer than shown; this is the beginning of it.' } : {}),
        },
      };
    }

    case 'query_calendar': {
      const window = calendarWindow(input);
      if (!window) {
        return { ok: false, error: 'bad_time', message: 'Give start and end as ISO 8601 times, with start before end and a range of at most 92 days.' };
      }
      const { sessions, refusal } = await openSessions(db, args.access, args.userId, 'calendar');
      if (!sessions.length) return NO_ACCESS(refusal);
      const events = [];
      for (const s of sessions) {
        const found = await listEvents(
          s.provider,
          { accessToken: s.accessToken, timeMin: window.start, timeMax: window.end },
          { fetchImpl: args.access.fetchImpl },
        );
        events.push(...found.map((e) => eventView(s.provider, e)));
      }
      events.sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
      return {
        ok: true,
        range: { start: window.start, end: window.end },
        events,
        ...(events.length ? {} : { message: 'The calendar has no events in that range.' }),
      };
    }

    case 'get_event': {
      const ref = untagId(String(input.event_id ?? ''));
      if (!ref) return { ok: false, error: 'not_found', message: 'There is no event with that id. Use an event_id from query_calendar.' };
      const { sessions, refusal } = await openSessions(db, args.access, args.userId, 'calendar', ref.provider);
      if (!sessions.length) return NO_ACCESS(refusal);
      const s = sessions[0];
      const event = await getEvent(s.provider, { accessToken: s.accessToken, id: ref.id }, { fetchImpl: args.access.fetchImpl });
      if (!event) return { ok: false, error: 'not_found', message: 'There is no event with that id.' };
      return { ok: true, event: eventView(s.provider, event) };
    }

    default:
      return { ok: false, error: 'unknown_tool', message: `no tool named ${name}` };
  }
}

/** Default window: now → 7 days out. Explicit ranges are capped at 92 days —
 * a quarter answers every reasonable question and bounds the response. */
function calendarWindow(input: Record<string, unknown>): { start: string; end: string } | null {
  const parse = (v: unknown): Date | null => {
    const s = String(v ?? '').trim();
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const start = parse(input.start) ?? new Date();
  const end = parse(input.end) ?? new Date(start.getTime() + 7 * 86_400_000);
  if (end.getTime() <= start.getTime()) return null;
  if (end.getTime() - start.getTime() > 92 * 86_400_000) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

const CONTACT_RESULT_CAP = 10;

async function searchContacts(
  db: Db,
  args: { userId: string; access: ConnectorAccess | null },
  input: Record<string, unknown>,
): Promise<unknown> {
  const query = String(input.query ?? '').trim();
  if (!query) return { ok: false, error: 'bad_query', message: 'Say who to look for.' };

  // Local first. The sync pipeline filled this table with consent; searching
  // it costs nobody a rate limit.
  const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const local = await db.query<{ id: string; name: string | null; email: string | null; phone: string | null }>(
    `select id, name, email, phone from contacts
     where owner_user_id = $1 and (name ilike $2 or email ilike $2 or phone ilike $2)
     order by updated_at desc limit ${CONTACT_RESULT_CAP}`,
    [args.userId, like],
  );
  if (local.length) {
    return {
      ok: true,
      source: 'local',
      contacts: local.map((c) => ({ contact_id: c.id, name: c.name, email: c.email, phone: c.phone })),
    };
  }

  // Fall back to the provider only when the local store holds NOTHING for
  // this person — an empty search against a populated store is an answer.
  const [any] = await db.query<{ n: number }>(
    `select count(*)::int as n from contacts where owner_user_id = $1`,
    [args.userId],
  );
  if ((any?.n ?? 0) > 0) {
    return { ok: true, contacts: [], message: 'No contact matched that.' };
  }

  if (!args.access) {
    return { ok: true, contacts: [], message: 'No contacts are synced yet, and connected accounts cannot be reached right now.' };
  }
  const { sessions, refusal } = await openSessions(db, args.access, args.userId, 'contacts');
  if (!sessions.length) {
    return { ok: true, contacts: [], message: `No contacts are synced yet. ${refusal}` };
  }

  // One bounded read per provider, filtered here. Reuses the proven contact
  // adapter rather than growing a second provider dialect for search.
  const needle = query.toLowerCase();
  const matches: Array<{ contact_id: string; name: string | null; email: string | null; phone: string | null }> = [];
  for (const s of sessions) {
    let cursor: string | null = null;
    for (let page = 0; page < 2 && matches.length < CONTACT_RESULT_CAP; page++) {
      const result = await readContactPage(
        s.provider,
        { accessToken: s.accessToken, pageCursor: cursor, pageSize: 200 },
        { fetchImpl: args.access.fetchImpl },
      );
      for (const c of result.contacts) {
        if (c.deleted) continue;
        const hay = [c.displayName, ...c.emails, ...c.phones].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(needle)) continue;
        matches.push({
          contact_id: taggedId(s.provider, c.sourceId),
          name: c.displayName,
          email: c.emails[0] ?? null,
          phone: c.phones[0] ?? null,
        });
        if (matches.length >= CONTACT_RESULT_CAP) break;
      }
      cursor = result.nextPageCursor;
      if (!cursor) break;
    }
  }
  return {
    ok: true,
    source: 'provider',
    contacts: matches,
    ...(matches.length ? {} : { message: 'No contact matched that.' }),
  };
}
