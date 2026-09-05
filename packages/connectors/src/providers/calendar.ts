// Reading calendars at Google and Microsoft. Read-only, bounded, and shaped
// for "what's my week": a time-windowed list and a single-event fetch.
//
// Same discipline as mail.ts: one shape in and out, provider error sentences
// never quoted, every request under a timeout, results capped.
import type { Provider } from '../capabilities.js';
import { ConnectorError, type FetchOptions } from '../providers.js';
import { providerRequest, raiseProviderError, str } from './http.js';

export interface RemoteEvent {
  sourceId: string;
  title: string | null;
  /** ISO 8601, or a bare date (YYYY-MM-DD) for an all-day event. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  organizer: string | null;
  /** Addresses only, capped — a 200-person invite list is noise, not context. */
  attendees: string[];
  status: string | null;
  /** Present only on a single-event fetch, and capped. */
  description?: string | null;
}

/** The most events one query returns. A week of a busy calendar fits; a
 * model that wants more narrows the window. */
export const CALENDAR_RESULT_CAP = 25;
const ATTENDEE_CAP = 20;
const DESCRIPTION_CAP = 4_000;

export interface CalendarQueryArgs {
  accessToken: string;
  /** ISO 8601 range, inclusive start, exclusive end. */
  timeMin: string;
  timeMax: string;
  limit?: number;
}

export async function listEvents(
  provider: Provider,
  args: CalendarQueryArgs,
  opts: FetchOptions = {},
): Promise<RemoteEvent[]> {
  const limit = Math.max(1, Math.min(args.limit ?? CALENDAR_RESULT_CAP, CALENDAR_RESULT_CAP));
  return provider === 'google' ? listGoogle(args, limit, opts) : listGraph(args, limit, opts);
}

export async function getEvent(
  provider: Provider,
  args: { accessToken: string; id: string },
  opts: FetchOptions = {},
): Promise<RemoteEvent | null> {
  return provider === 'google' ? getGoogle(args, opts) : getGraph(args, opts);
}

// ------------------------------------------------------------------- Google

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

interface GoogleEvent {
  id?: unknown;
  summary?: unknown;
  status?: unknown;
  location?: unknown;
  description?: unknown;
  start?: { dateTime?: unknown; date?: unknown };
  end?: { dateTime?: unknown; date?: unknown };
  organizer?: { email?: unknown };
  attendees?: Array<{ email?: unknown }>;
}

function fromGoogle(event: GoogleEvent, withDescription: boolean): RemoteEvent | null {
  const sourceId = str(event.id);
  if (!sourceId) return null;
  const allDay = !!str(event.start?.date);
  const out: RemoteEvent = {
    sourceId,
    title: str(event.summary),
    start: str(event.start?.dateTime) ?? str(event.start?.date),
    end: str(event.end?.dateTime) ?? str(event.end?.date),
    allDay,
    location: str(event.location),
    organizer: str(event.organizer?.email),
    attendees: (event.attendees ?? []).map((a) => str(a?.email)).filter(Boolean).slice(0, ATTENDEE_CAP) as string[],
    status: str(event.status),
  };
  if (withDescription) out.description = (str(event.description) ?? '').slice(0, DESCRIPTION_CAP) || null;
  return out;
}

async function listGoogle(args: CalendarQueryArgs, limit: number, opts: FetchOptions): Promise<RemoteEvent[]> {
  const params = new URLSearchParams({
    timeMin: args.timeMin,
    timeMax: args.timeMax,
    // Recurring events expanded into occurrences, in time order — the shape a
    // "what's my week" answer needs; the raw recurrence rule is not.
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(limit),
  });
  const result = await providerRequest(
    `${GCAL_BASE}?${params}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
    opts,
  );
  if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
  return (((result.body as { items?: GoogleEvent[] } | null)?.items) ?? [])
    .map((e) => fromGoogle(e, false))
    .filter(Boolean) as RemoteEvent[];
}

async function getGoogle(args: { accessToken: string; id: string }, opts: FetchOptions): Promise<RemoteEvent | null> {
  const result = await providerRequest(
    `${GCAL_BASE}/${encodeURIComponent(args.id)}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
    opts,
  );
  if (result.status === 404 || result.status === 410) return null;
  if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
  return fromGoogle((result.body ?? {}) as GoogleEvent, true);
}

// ---------------------------------------------------------------- Microsoft

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_EVENT_SELECT = 'id,subject,start,end,isAllDay,location,organizer,attendees,showAs';

interface GraphEvent {
  id?: unknown;
  subject?: unknown;
  isAllDay?: unknown;
  showAs?: unknown;
  start?: { dateTime?: unknown };
  end?: { dateTime?: unknown };
  location?: { displayName?: unknown };
  organizer?: { emailAddress?: { address?: unknown } };
  attendees?: Array<{ emailAddress?: { address?: unknown } }>;
  bodyPreview?: unknown;
}

function fromGraph(event: GraphEvent, withDescription: boolean): RemoteEvent | null {
  const sourceId = str(event.id);
  if (!sourceId) return null;
  const out: RemoteEvent = {
    sourceId,
    title: str(event.subject),
    start: str(event.start?.dateTime),
    end: str(event.end?.dateTime),
    allDay: event.isAllDay === true,
    location: str(event.location?.displayName),
    organizer: str(event.organizer?.emailAddress?.address),
    attendees: (event.attendees ?? [])
      .map((a) => str(a?.emailAddress?.address))
      .filter(Boolean)
      .slice(0, ATTENDEE_CAP) as string[],
    status: str(event.showAs),
  };
  if (withDescription) out.description = (str(event.bodyPreview) ?? '').slice(0, DESCRIPTION_CAP) || null;
  return out;
}

async function listGraph(args: CalendarQueryArgs, limit: number, opts: FetchOptions): Promise<RemoteEvent[]> {
  const params = new URLSearchParams({
    startDateTime: args.timeMin,
    endDateTime: args.timeMax,
    $orderby: 'start/dateTime',
    $top: String(limit),
    $select: GRAPH_EVENT_SELECT,
  });
  const result = await providerRequest(
    `${GRAPH_BASE}/me/calendarView?${params}`,
    {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        // Times come back in one known zone rather than the mailbox's; the
        // tool layer talks ISO/UTC and lets the model phrase it for a person.
        Prefer: 'outlook.timezone="UTC"',
      },
    },
    opts,
  );
  if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
  return (((result.body as { value?: GraphEvent[] } | null)?.value) ?? [])
    .map((e) => fromGraph(e, false))
    .filter(Boolean) as RemoteEvent[];
}

async function getGraph(args: { accessToken: string; id: string }, opts: FetchOptions): Promise<RemoteEvent | null> {
  if (!/^[A-Za-z0-9_=-]{1,512}$/.test(args.id)) {
    throw new ConnectorError('that is not an event id', { category: 'provider_error' });
  }
  const params = new URLSearchParams({ $select: `${GRAPH_EVENT_SELECT},bodyPreview` });
  const result = await providerRequest(
    `${GRAPH_BASE}/me/events/${args.id}?${params}`,
    { headers: { Authorization: `Bearer ${args.accessToken}`, Prefer: 'outlook.timezone="UTC"' } },
    opts,
  );
  if (result.status === 404) return null;
  if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
  return fromGraph((result.body ?? {}) as GraphEvent, true);
}
