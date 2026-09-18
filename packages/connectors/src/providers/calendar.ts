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
  descriptionTruncated?: boolean;
  /** Opaque provider concurrency token, returned only by a detail/mutation. */
  version?: string | null;
}

export interface CalendarEventMutation {
  title: string;
  allDay: boolean;
  /** Timed values are ISO instants. All-day values are bare, end-exclusive dates. */
  start: string;
  end: string;
  timezone: string;
  location?: string | null;
  /** Undefined on update means preserve the provider's existing body. */
  description?: string | null;
}

export interface RemoteCalendar {
  sourceId: string;
  name: string;
  color: string | null;
  primary: boolean;
  writable: boolean;
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
  calendarId?: string;
}

export async function listEvents(
  provider: Provider,
  args: CalendarQueryArgs,
  opts: FetchOptions = {},
): Promise<RemoteEvent[]> {
  const limit = Math.max(1, Math.min(args.limit ?? CALENDAR_RESULT_CAP, 1000));
  return provider === 'google' ? listGoogle(args, limit, opts) : listGraph(args, limit, opts);
}

export async function getEvent(
  provider: Provider,
  args: { accessToken: string; id: string; calendarId?: string },
  opts: FetchOptions = {},
): Promise<RemoteEvent | null> {
  return provider === 'google' ? getGoogle(args, opts) : getGraph(args, opts);
}

export async function createEvent(
  provider: Provider,
  args: { accessToken: string; calendarId: string; event: CalendarEventMutation; idempotencyKey: string },
  opts: FetchOptions = {},
): Promise<RemoteEvent> {
  return provider === 'google' ? createGoogle(args, opts) : createGraph(args, opts);
}

export async function updateEvent(
  provider: Provider,
  args: { accessToken: string; calendarId: string; id: string; event: CalendarEventMutation; version?: string | null },
  opts: FetchOptions = {},
): Promise<RemoteEvent> {
  return provider === 'google' ? updateGoogle(args, opts) : updateGraph(args, opts);
}

export async function deleteEvent(
  provider: Provider,
  args: { accessToken: string; calendarId: string; id: string; version?: string | null },
  opts: FetchOptions = {},
): Promise<void> {
  return provider === 'google' ? deleteGoogle(args, opts) : deleteGraph(args, opts);
}

/** Discover every calendar below one account. Provider pagination is followed
 * to exhaustion; there is no product-imposed account/calendar count. */
export async function listCalendars(
  provider: Provider,
  args: { accessToken: string },
  opts: FetchOptions = {},
): Promise<RemoteCalendar[]> {
  return provider === 'google' ? listGoogleCalendars(args, opts) : listGraphCalendars(args, opts);
}

// ------------------------------------------------------------------- Google

const GCAL_ROOT = 'https://www.googleapis.com/calendar/v3';
const googleEventsUrl = (calendarId = 'primary') => `${GCAL_ROOT}/calendars/${encodeURIComponent(calendarId)}/events`;

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
  etag?: unknown;
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
  if (withDescription) {
    const description=str(event.description)??'';
    out.description = description.slice(0, DESCRIPTION_CAP) || null;
    out.descriptionTruncated = description.length > DESCRIPTION_CAP;
    out.version = str(event.etag);
  }
  return out;
}

function googleEventBody(event: CalendarEventMutation, id?: string, create = false) {
  return {
    ...(id ? { id } : {}), summary: event.title,
    location: event.location ?? '',
    ...((create || event.description !== undefined) ? { description: event.description ?? '' } : {}),
    start: event.allDay ? { date: event.start } : { dateTime: event.start, timeZone: event.timezone },
    end: event.allDay ? { date: event.end } : { dateTime: event.end, timeZone: event.timezone },
  };
}

function mutationHeaders(accessToken: string, version?: string | null): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(version ? { 'If-Match': version } : {}) };
}

async function createGoogle(args: { accessToken:string; calendarId:string; event:CalendarEventMutation; idempotencyKey:string }, opts: FetchOptions): Promise<RemoteEvent> {
  const providerId = args.idempotencyKey.toLowerCase().replace(/[^a-v0-9]/g, '').slice(0, 64);
  if (providerId.length < 5) throw new ConnectorError('that is not an idempotency key', { category:'provider_error' });
  const result = await providerRequest(`${googleEventsUrl(args.calendarId)}?sendUpdates=none`, { method:'POST', headers:mutationHeaders(args.accessToken), body:JSON.stringify(googleEventBody(args.event,providerId,true)) }, opts);
  if (result.status === 409) {
    const existing = await getGoogle({accessToken:args.accessToken,calendarId:args.calendarId,id:providerId},opts);
    if (existing) return existing;
  }
  if (result.status < 200 || result.status >= 300) raiseProviderError(result.status,result.body);
  const event=fromGoogle((result.body??{}) as GoogleEvent,true);
  if(!event) throw new ConnectorError('the provider returned an invalid event',{category:'provider_error'});
  return event;
}

async function updateGoogle(args:{accessToken:string;calendarId:string;id:string;event:CalendarEventMutation;version?:string|null},opts:FetchOptions):Promise<RemoteEvent>{
  const result=await providerRequest(`${googleEventsUrl(args.calendarId)}/${encodeURIComponent(args.id)}?sendUpdates=all`,{method:'PATCH',headers:mutationHeaders(args.accessToken,args.version),body:JSON.stringify(googleEventBody(args.event))},opts);
  if(result.status===404||result.status===410||result.status===412)throw new ConnectorError('This event changed or was removed. Refresh and try again.',{category:'provider_error',status:result.status});
  if(result.status<200||result.status>=300)raiseProviderError(result.status,result.body);
  const event=fromGoogle((result.body??{}) as GoogleEvent,true);if(!event)throw new ConnectorError('the provider returned an invalid event',{category:'provider_error'});return event;
}

async function deleteGoogle(args:{accessToken:string;calendarId:string;id:string;version?:string|null},opts:FetchOptions):Promise<void>{
  const result=await providerRequest(`${googleEventsUrl(args.calendarId)}/${encodeURIComponent(args.id)}?sendUpdates=all`,{method:'DELETE',headers:mutationHeaders(args.accessToken,args.version)},opts);
  if(result.status===404||result.status===410)return;
  if(result.status===412)throw new ConnectorError('This event changed. Refresh and try again.',{category:'provider_error',status:result.status});
  if(result.status!==204&&result.status!==200)raiseProviderError(result.status,result.body);
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
  const out: RemoteEvent[] = [];
  let token = '';
  const seen = new Set<string>();
  do {
    if (token) params.set('pageToken', token);
    params.set('maxResults', String(Math.min(250, limit-out.length)));
    const result = await providerRequest(`${googleEventsUrl(args.calendarId)}?${params}`, { headers: { Authorization: `Bearer ${args.accessToken}` } }, opts);
    if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
    const body = (result.body ?? {}) as { items?: GoogleEvent[]; nextPageToken?: string };
    out.push(...(body.items ?? []).map(e=>fromGoogle(e,false)).filter((e):e is RemoteEvent=>!!e));
    token = body.nextPageToken ?? '';
    if (token && (seen.has(token) || out.length >= limit)) throw new ConnectorError('Calendar range is too busy. Choose a shorter range to retrieve all events.', {category:'provider_error'});
    seen.add(token);
  } while (token);
  return out;

}

async function getGoogle(args: { accessToken: string; id: string; calendarId?: string }, opts: FetchOptions): Promise<RemoteEvent | null> {
  const result = await providerRequest(
    `${googleEventsUrl(args.calendarId)}/${encodeURIComponent(args.id)}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
    opts,
  );
  if (result.status === 404 || result.status === 410) return null;
  if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
  return fromGoogle((result.body ?? {}) as GoogleEvent, true);
}


async function listGoogleCalendars(args: { accessToken: string }, opts: FetchOptions): Promise<RemoteCalendar[]> {
  const out: RemoteCalendar[] = [];
  let token = '';
  do {
    const params = new URLSearchParams({ maxResults: '250' });
    if (token) params.set('pageToken', token);
    const result = await providerRequest(`${GCAL_ROOT}/users/me/calendarList?${params}`, {
      headers: { Authorization: `Bearer ${args.accessToken}` },
    }, opts);
    if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
    const body = (result.body ?? {}) as { items?: Array<Record<string, unknown>>; nextPageToken?: unknown };
    for (const item of body.items ?? []) {
      const sourceId = str(item.id); const name = str(item.summaryOverride) ?? str(item.summary);
      if (sourceId && name) out.push({ sourceId, name, color: str(item.backgroundColor), primary: item.primary === true, writable: item.accessRole === 'owner' || item.accessRole === 'writer' });
    }
    token = str(body.nextPageToken) ?? '';
  } while (token);
  return out;
}

// ---------------------------------------------------------------- Microsoft

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_EVENT_SELECT = 'id,subject,start,end,isAllDay,location,organizer,attendees,showAs,changeKey,originalStartTimeZone,originalEndTimeZone';

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
  body?: { content?: unknown };
  changeKey?: unknown;
  '@odata.etag'?: unknown;
  originalStartTimeZone?: unknown;
  originalEndTimeZone?: unknown;
}

// Graph returns UTC wall times without a suffix even with the UTC preference.
const WINDOWS_ZONES:Record<string,string>={
  'Pacific Standard Time':'America/Los_Angeles','Mountain Standard Time':'America/Denver',
  'Central Standard Time':'America/Chicago','Eastern Standard Time':'America/New_York',
  'GMT Standard Time':'Europe/London','W. Europe Standard Time':'Europe/Berlin',
  'New Zealand Standard Time':'Pacific/Auckland','Tokyo Standard Time':'Asia/Tokyo',UTC:'UTC',
};
function graphTime(value: unknown, allDay: boolean, originalZone?:unknown, civilDirect=false): string | null {
  const date = str(value); if (!date) return null;
  if (allDay) {
    if(civilDirect)return date.slice(0,10);
    const requested=str(originalZone);const zone=requested?(WINDOWS_ZONES[requested]??requested):null;
    if(zone){try{const instant=new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(date)?date:`${date}Z`);if(Number.isFinite(instant.getTime())){const p=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(instant);const part=(t:string)=>p.find(x=>x.type===t)!.value;return `${part('year')}-${part('month')}-${part('day')}`;}}catch{/* Keep the provider's civil date for an unknown Windows timezone. */}}
    return date.slice(0,10);
  }
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(date) ? date : `${date}Z`;
}

function fromGraph(event: GraphEvent, withDescription: boolean, civilDirect=false): RemoteEvent | null {
  const sourceId = str(event.id);
  if (!sourceId) return null;
  const out: RemoteEvent = {
    sourceId,
    title: str(event.subject),
    start: graphTime(event.start?.dateTime, event.isAllDay === true, event.originalStartTimeZone, civilDirect),
    end: graphTime(event.end?.dateTime, event.isAllDay === true, event.originalEndTimeZone, civilDirect),
    allDay: event.isAllDay === true,
    location: str(event.location?.displayName),
    organizer: str(event.organizer?.emailAddress?.address),
    attendees: (event.attendees ?? [])
      .map((a) => str(a?.emailAddress?.address))
      .filter(Boolean)
      .slice(0, ATTENDEE_CAP) as string[],
    status: str(event.showAs),
  };
  if (withDescription) {
    const description=str(event.body?.content)??str(event.bodyPreview)??'';
    out.description = description.slice(0, DESCRIPTION_CAP) || null;
    out.descriptionTruncated = description.length > DESCRIPTION_CAP;
    out.version = str(event['@odata.etag']) ?? str(event.changeKey);
  }
  return out;
}

function graphDateTime(value:string,timezone:string){
  const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new ConnectorError('that is not an event time',{category:'provider_error'});
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const p=(type:string)=>parts.find(x=>x.type===type)!.value;
  return {dateTime:`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}`,timeZone:timezone};
}
function graphEventBody(event:CalendarEventMutation,transactionId?:string,create=false){
  return {subject:event.title,isAllDay:event.allDay,
    start:event.allDay?{dateTime:`${event.start}T00:00:00`,timeZone:event.timezone}:graphDateTime(event.start,event.timezone),
    end:event.allDay?{dateTime:`${event.end}T00:00:00`,timeZone:event.timezone}:graphDateTime(event.end,event.timezone),
    location:{displayName:event.location??''},
    ...((create||event.description!==undefined)?{body:{contentType:'text',content:event.description??''}}:{}),
    ...(transactionId?{transactionId}:{}),
  };
}
function graphEventUrl(calendarId:string,id?:string){return `${GRAPH_BASE}/me/calendars/${encodeURIComponent(calendarId)}/events${id?`/${encodeURIComponent(id)}`:''}`;}
function graphDetailUrl(calendarId:string|undefined,id:string){return calendarId?graphEventUrl(calendarId,id):`${GRAPH_BASE}/me/events/${encodeURIComponent(id)}`;}
function graphOriginalZone(event:GraphEvent){return str(event.originalStartTimeZone);}
function graphZoneNeedsRefetch(event:GraphEvent){const requested=graphOriginalZone(event);if(event.isAllDay!==true||!requested||WINDOWS_ZONES[requested])return false;try{new Intl.DateTimeFormat('en',{timeZone:requested});return false;}catch{return true;}}
async function refetchGraphCivil(event:GraphEvent,accessToken:string,calendarId:string|undefined,withDescription:boolean,opts:FetchOptions){const id=str(event.id),zone=graphOriginalZone(event);if(!id||!zone||!/^[A-Za-z0-9 _./()+-]{1,100}$/.test(zone))throw new ConnectorError('the provider returned an invalid all-day timezone',{category:'provider_error'});const params=new URLSearchParams({$select:`${GRAPH_EVENT_SELECT}${withDescription?',bodyPreview,body':''}`});const result=await providerRequest(`${graphDetailUrl(calendarId,id)}?${params}`,{headers:{Authorization:`Bearer ${accessToken}`,Prefer:`outlook.timezone="${zone}"`}},opts);if(result.status<200||result.status>=300)raiseProviderError(result.status,result.body);return fromGraph((result.body??{}) as GraphEvent,withDescription,true);}
function assertGraphId(id:string){if(!/^[A-Za-z0-9_=-]{1,512}$/.test(id))throw new ConnectorError('that is not an event id',{category:'provider_error'});}

async function createGraph(args:{accessToken:string;calendarId:string;event:CalendarEventMutation;idempotencyKey:string},opts:FetchOptions):Promise<RemoteEvent>{
  const result=await providerRequest(graphEventUrl(args.calendarId),{method:'POST',headers:mutationHeaders(args.accessToken),body:JSON.stringify(graphEventBody(args.event,args.idempotencyKey,true))},opts);
  if(result.status<200||result.status>=300)raiseProviderError(result.status,result.body);
  const event=fromGraph((result.body??{}) as GraphEvent,true);if(!event)throw new ConnectorError('the provider returned an invalid event',{category:'provider_error'});return event;
}
async function updateGraph(args:{accessToken:string;calendarId:string;id:string;event:CalendarEventMutation;version?:string|null},opts:FetchOptions):Promise<RemoteEvent>{
  assertGraphId(args.id);const result=await providerRequest(graphEventUrl(args.calendarId,args.id),{method:'PATCH',headers:mutationHeaders(args.accessToken,args.version),body:JSON.stringify(graphEventBody(args.event))},opts);
  if(result.status===404||result.status===412)throw new ConnectorError('This event changed or was removed. Refresh and try again.',{category:'provider_error',status:result.status});
  if(result.status<200||result.status>=300)raiseProviderError(result.status,result.body);
  const event=fromGraph((result.body??{}) as GraphEvent,true);if(!event)throw new ConnectorError('the provider returned an invalid event',{category:'provider_error'});return event;
}
async function deleteGraph(args:{accessToken:string;calendarId:string;id:string;version?:string|null},opts:FetchOptions):Promise<void>{
  assertGraphId(args.id);const result=await providerRequest(graphEventUrl(args.calendarId,args.id),{method:'DELETE',headers:mutationHeaders(args.accessToken,args.version)},opts);
  if(result.status===404)return;
  if(result.status===412)throw new ConnectorError('This event changed. Refresh and try again.',{category:'provider_error',status:result.status});
  if(result.status!==204&&result.status!==200)raiseProviderError(result.status,result.body);
}

async function listGraph(args: CalendarQueryArgs, limit: number, opts: FetchOptions): Promise<RemoteEvent[]> {
  const params = new URLSearchParams({
    startDateTime: args.timeMin,
    endDateTime: args.timeMax,
    $orderby: 'start/dateTime',
    $top: String(limit),
    $select: GRAPH_EVENT_SELECT,
  });
  let url: string | null = `${GRAPH_BASE}/me/${args.calendarId ? `calendars/${encodeURIComponent(args.calendarId)}/` : ''}calendarView?${params}`;
  const out: RemoteEvent[] = []; const seen = new Set<string>();
  while (url) {
    if (seen.has(url)) throw new ConnectorError('Calendar pagination did not advance. Retry with a shorter range.', {category:'provider_error'});
    seen.add(url);
    const result = await providerRequest(url, {headers:{Authorization:`Bearer ${args.accessToken}`,Prefer:'outlook.timezone="UTC"'}}, opts);
    if (result.status < 200 || result.status >= 300) raiseProviderError(result.status,result.body);
    const body = (result.body ?? {}) as {value?:GraphEvent[]; '@odata.nextLink'?:string};
    const page=await Promise.all((body.value??[]).map(e=>graphZoneNeedsRefetch(e)?refetchGraphCivil(e,args.accessToken,args.calendarId,false,opts):Promise.resolve(fromGraph(e,false))));
    out.push(...page.filter((e):e is RemoteEvent=>!!e));
    const next = body['@odata.nextLink'];
    if(next && (!next.startsWith(`${GRAPH_BASE}/`) || out.length >= limit)) throw new ConnectorError('Calendar range is too busy. Choose a shorter range to retrieve all events.', {category:'provider_error'});
    url = next ?? null;
  }
  return out;

}

async function getGraph(args: { accessToken: string; id: string; calendarId?: string }, opts: FetchOptions): Promise<RemoteEvent | null> {
  assertGraphId(args.id);
  const params = new URLSearchParams({ $select: `${GRAPH_EVENT_SELECT},bodyPreview,body` });
  const result = await providerRequest(
    `${GRAPH_BASE}/me/${args.calendarId ? `calendars/${encodeURIComponent(args.calendarId)}/` : ''}events/${encodeURIComponent(args.id)}?${params}`,
    { headers: { Authorization: `Bearer ${args.accessToken}`, Prefer: 'outlook.timezone="UTC"' } },
    opts,
  );
  if (result.status === 404) return null;
  if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
  const raw=(result.body??{}) as GraphEvent;
  return graphZoneNeedsRefetch(raw)?refetchGraphCivil(raw,args.accessToken,args.calendarId,true,opts):fromGraph(raw,true);
}


async function listGraphCalendars(args: { accessToken: string }, opts: FetchOptions): Promise<RemoteCalendar[]> {
  const out: RemoteCalendar[] = [];
  let url: string | null = `${GRAPH_BASE}/me/calendars?$top=100&$select=id,name,color,canEdit,isDefaultCalendar`;
  while (url) {
    const result = await providerRequest(url, { headers: { Authorization: `Bearer ${args.accessToken}` } }, opts);
    if (result.status < 200 || result.status >= 300) raiseProviderError(result.status, result.body);
    const body = (result.body ?? {}) as { value?: Array<Record<string, unknown>>; '@odata.nextLink'?: unknown };
    for (const item of body.value ?? []) {
      const sourceId = str(item.id); const name = str(item.name);
      if (sourceId && name) out.push({ sourceId, name, color: str(item.color), primary: item.isDefaultCalendar === true, writable: item.canEdit === true });
    }
    const next = str(body['@odata.nextLink']);
    url = next?.startsWith(`${GRAPH_BASE}/`) ? next : null;
  }
  return out;
}
