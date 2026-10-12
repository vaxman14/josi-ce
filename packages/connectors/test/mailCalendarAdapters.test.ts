// The mail and calendar read adapters, against canned provider payloads.
//
// No provider is contacted. What these tests pin down is the part that costs
// somebody their data or their privacy when it drifts: the URL each dialect is
// asked with, the caps, the truncation honesty, and the rule that a provider's
// error SENTENCE never travels — only a code-shaped identifier.
import { describe, expect, it } from 'vitest';
import {
  ConnectorError, MAIL_BODY_CAP, MAIL_SEARCH_CAP,
  createEvent, deleteEvent, getEvent, listEvents, readMail, searchMail, updateEvent,
} from '../src/index.js';

type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown };

function fetchStub(handler: Handler): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(url));
    const out = handler(String(url), init);
    return new Response((out.status ?? 200) === 204 ? null : JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('gmail search', () => {
  const gmailMeta = (id: string, subject: string) => ({
    id,
    snippet: `snippet of ${id}`,
    internalDate: '1700000000000',
    payload: {
      headers: [
        { name: 'From', value: 'Ann <ann@example.test>' },
        { name: 'To', value: 'roman@example.test, other@example.test' },
        { name: 'Subject', value: subject },
      ],
    },
  });

  it('lists ids then fetches metadata, and returns the summary shape', async () => {
    const { fetchImpl, urls } = fetchStub((url) => {
      if (url.includes('/messages?')) return { body: { messages: [{ id: 'm1' }, { id: 'm2' }] } };
      if (url.includes('/messages/m1')) return { body: gmailMeta('m1', 'invoice') };
      if (url.includes('/messages/m2')) return { body: gmailMeta('m2', 'lunch') };
      return { status: 500 };
    });
    const found = await searchMail('google', { accessToken: 'tok', query: 'from:ann' }, { fetchImpl });
    expect(urls[0]).toContain('q=from%3Aann');
    expect(urls[1]).toContain('format=metadata');
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      sourceId: 'm1',
      from: 'Ann <ann@example.test>',
      subject: 'invoice',
      snippet: 'snippet of m1',
    });
    expect(found[0].to).toEqual(['roman@example.test', 'other@example.test']);
    expect(found[0].date).toBe(new Date(1700000000000).toISOString());
  });

  it('caps the result count whatever the caller asked for', async () => {
    const { fetchImpl, urls } = fetchStub((url) => {
      if (url.includes('/messages?')) {
        return { body: { messages: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}` })) } };
      }
      return { body: gmailMeta('x', 'x') };
    });
    await searchMail('google', { accessToken: 'tok', query: 'x', limit: 999 }, { fetchImpl });
    expect(urls[0]).toContain(`maxResults=${MAIL_SEARCH_CAP}`);
    // One list call + at most CAP metadata calls.
    expect(urls.length).toBeLessThanOrEqual(1 + MAIL_SEARCH_CAP);
  });

  it('skips a message deleted between list and fetch instead of failing the search', async () => {
    const { fetchImpl } = fetchStub((url) => {
      if (url.includes('/messages?')) return { body: { messages: [{ id: 'gone' }, { id: 'm2' }] } };
      if (url.includes('/messages/gone')) return { status: 404, body: {} };
      return { body: gmailMeta('m2', 'still here') };
    });
    const found = await searchMail('google', { accessToken: 'tok', query: 'x' }, { fetchImpl });
    expect(found.map((f) => f.sourceId)).toEqual(['m2']);
  });

  it('never quotes the provider error sentence, only a code', async () => {
    const { fetchImpl } = fetchStub(() => ({
      status: 400,
      body: { error: { status: 'FAILED_PRECONDITION', message: 'mail from ann@secret.test rejected' } },
    }));
    const err = await searchMail('google', { accessToken: 'tok', query: 'x' }, { fetchImpl })
      .then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err!.message).toContain('FAILED_PRECONDITION');
    expect(err!.message).not.toContain('secret.test');
  });
});

describe('gmail read', () => {
  it('prefers the text/plain part and reports its kind', async () => {
    const { fetchImpl } = fetchStub(() => ({
      body: {
        id: 'm1',
        snippet: 's',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [{ name: 'Subject', value: 'hello' }],
          parts: [
            { mimeType: 'text/html', body: { data: b64url('<b>hi</b>') } },
            { mimeType: 'text/plain', body: { data: b64url('hi in plain text') } },
          ],
        },
      },
    }));
    const email = await readMail('google', { accessToken: 'tok', id: 'm1' }, { fetchImpl });
    expect(email?.body).toBe('hi in plain text');
    expect(email?.bodyKind).toBe('text');
    expect(email?.truncated).toBe(false);
  });

  it('truncates a long body and says so', async () => {
    const long = 'a'.repeat(MAIL_BODY_CAP + 500);
    const { fetchImpl } = fetchStub(() => ({
      body: { id: 'm1', payload: { mimeType: 'text/plain', headers: [], body: { data: b64url(long) } } },
    }));
    const email = await readMail('google', { accessToken: 'tok', id: 'm1' }, { fetchImpl });
    expect(email?.body).toHaveLength(MAIL_BODY_CAP);
    expect(email?.truncated).toBe(true);
  });

  it('answers null for a message that does not exist', async () => {
    const { fetchImpl } = fetchStub(() => ({ status: 404, body: {} }));
    expect(await readMail('google', { accessToken: 'tok', id: 'nope' }, { fetchImpl })).toBeNull();
  });
});

describe('graph mail', () => {
  it('searches with a quoted phrase and maps the summary shape', async () => {
    const { fetchImpl, urls } = fetchStub(() => ({
      body: {
        value: [{
          id: 'AAMkAG=',
          subject: 'quarterly numbers',
          receivedDateTime: '2026-09-01T10:00:00Z',
          bodyPreview: 'the numbers are',
          from: { emailAddress: { address: 'cfo@example.test', name: 'CFO' } },
          toRecipients: [{ emailAddress: { address: 'roman@example.test' } }],
        }],
      },
    }));
    const found = await searchMail('microsoft', { accessToken: 'tok', query: 'quarterly "numbers"' }, { fetchImpl });
    expect(urls[0]).toContain('%24search=');
    expect(urls[0]).toContain('%24top=10');
    expect(found[0]).toMatchObject({
      sourceId: 'AAMkAG=',
      from: 'CFO <cfo@example.test>',
      subject: 'quarterly numbers',
      date: '2026-09-01T10:00:00Z',
    });
  });

  it('refuses an id that is not id-shaped before any URL is built', async () => {
    const { fetchImpl, urls } = fetchStub(() => ({ body: {} }));
    const err = await readMail('microsoft', { accessToken: 'tok', id: '../me/otherMailbox' }, { fetchImpl })
      .then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(urls).toHaveLength(0);
  });
});

describe('google calendar', () => {
  const googleEvent = {
    id: 'ev1',
    summary: 'standup',
    status: 'confirmed',
    location: 'meet',
    description: 'notes '.repeat(1000),
    start: { dateTime: '2026-09-03T09:00:00-07:00' },
    end: { dateTime: '2026-09-03T09:15:00-07:00' },
    organizer: { email: 'boss@example.test' },
    attendees: [{ email: 'a@example.test' }, { email: 'b@example.test' }],
  };

  it('asks for expanded single events in time order, capped', async () => {
    const { fetchImpl, urls } = fetchStub(() => ({ body: { items: [googleEvent] } }));
    const events = await listEvents('google', {
      accessToken: 'tok',
      timeMin: '2026-09-01T00:00:00.000Z',
      timeMax: '2026-09-08T00:00:00.000Z',
      limit: 999,
    }, { fetchImpl });
    expect(urls[0]).toContain('singleEvents=true');
    expect(urls[0]).toContain('orderBy=startTime');
    expect(urls[0]).toContain('maxResults=250');
    expect(events[0]).toMatchObject({
      sourceId: 'ev1', title: 'standup', allDay: false, organizer: 'boss@example.test',
    });
    // A list result carries no description; the single fetch does.
    expect(events[0].description).toBeUndefined();
  });

  it('targets a selected secondary calendar', async () => {
    const { fetchImpl, urls } = fetchStub(() => ({ body: { items: [googleEvent] } }));
    await listEvents('google', { accessToken: 'tok', calendarId: 'shared@example.test', timeMin: 'a', timeMax: 'b' }, { fetchImpl });
    expect(urls[0]).toContain('/calendars/shared%40example.test/events');
  });

  it('marks an all-day event and keeps its bare date', async () => {
    const { fetchImpl } = fetchStub(() => ({
      body: { items: [{ id: 'ev2', summary: 'offsite', start: { date: '2026-09-05' }, end: { date: '2026-09-06' } }] },
    }));
    const [event] = await listEvents('google', {
      accessToken: 'tok', timeMin: 'a', timeMax: 'b',
    }, { fetchImpl });
    expect(event).toMatchObject({ allDay: true, start: '2026-09-05', end: '2026-09-06' });
  });

  it('fetches one event with a capped description, and null when gone', async () => {
    const { fetchImpl } = fetchStub((url) => (url.includes('ev1') ? { body: googleEvent } : { status: 404, body: {} }));
    const event = await getEvent('google', { accessToken: 'tok', id: 'ev1' }, { fetchImpl });
    expect(event?.description).toBeTruthy();
    expect(event!.description!.length).toBeLessThanOrEqual(4000);
    expect(event!.descriptionTruncated).toBe(true);
    expect(await getEvent('google', { accessToken: 'tok', id: 'gone' }, { fetchImpl })).toBeNull();
  });
});

describe('graph calendar', () => {
  it('uses calendarView with a UTC preference and maps the shape', async () => {
    const { fetchImpl, urls } = fetchStub((_url, init) => {
      expect((init?.headers as Record<string, string>).Prefer).toContain('UTC');
      return {
        body: {
          value: [{
            id: 'gv1',
            subject: 'review',
            isAllDay: false,
            showAs: 'busy',
            start: { dateTime: '2026-09-03T16:00:00.0000000' },
            end: { dateTime: '2026-09-03T17:00:00.0000000' },
            location: { displayName: 'Teams' },
            organizer: { emailAddress: { address: 'pm@example.test' } },
            attendees: [{ emailAddress: { address: 'roman@example.test' } }],
          }],
        },
      };
    });
    const events = await listEvents('microsoft', {
      accessToken: 'tok', timeMin: '2026-09-01T00:00:00Z', timeMax: '2026-09-08T00:00:00Z',
    }, { fetchImpl });
    expect(urls[0]).toContain('calendarView');
    expect(events[0]).toMatchObject({ sourceId: 'gv1', title: 'review', status: 'busy', location: 'Teams' });
  });

  it('refuses an event id that is not id-shaped', async () => {
    const { fetchImpl, urls } = fetchStub(() => ({ body: {} }));
    await expect(getEvent('microsoft', { accessToken: 'tok', id: 'not/an/id?x=1' }, { fetchImpl }))
      .rejects.toBeInstanceOf(ConnectorError);
    expect(urls).toHaveLength(0);
  });
});

describe('calendar mutations',()=>{
 const timed={title:'DST review',allDay:false,start:'2026-11-01T08:30:00.000Z',end:'2026-11-01T10:30:00.000Z',timezone:'America/Los_Angeles',location:'Room / 1',description:'Notes'};
 it('creates Google events with a stable id and exact encoded calendar URL',async()=>{let init:RequestInit|undefined;const {fetchImpl,urls}=fetchStub((_url,i)=>{init=i;return{body:{id:'stableevent',etag:'v1',summary:'DST review',start:{dateTime:timed.start},end:{dateTime:timed.end}}};});const event=await createEvent('google',{accessToken:'tok',calendarId:'shared/a@example.test',event:timed,idempotencyKey:'123e4567-e89b-42d3-a456-426614174000'},{fetchImpl});expect(urls[0]).toContain('/calendars/shared%2Fa%40example.test/events?sendUpdates=none');expect(init?.method).toBe('POST');const body=JSON.parse(String(init?.body));expect(body).toMatchObject({id:'123e4567e89b42d3a456426614174000',summary:'DST review',start:{dateTime:timed.start,timeZone:timed.timezone},location:'Room / 1'});expect(event.version).toBe('v1');});
 it('converges a retried Google create on its deterministic event id',async()=>{let calls=0;const {fetchImpl,urls}=fetchStub(()=>++calls===1?{status:409}:{body:{id:'123e4567e89b42d3a456426614174000',etag:'v1',start:{date:'2026-09-01'},end:{date:'2026-09-02'}}});const event=await createEvent('google',{accessToken:'tok',calendarId:'chosen',event:{...timed,allDay:true,start:'2026-09-01',end:'2026-09-02'},idempotencyKey:'123e4567-e89b-42d3-a456-426614174000'},{fetchImpl});expect(event.sourceId).toBe('123e4567e89b42d3a456426614174000');expect(urls).toHaveLength(2);});
 it('updates and deletes Google with concurrency and all-day semantics',async()=>{const seen:RequestInit[]=[];const {fetchImpl,urls}=fetchStub((_url,init)=>{seen.push(init??{});return init?.method==='DELETE'?{status:204}:{body:{id:'event/id',etag:'v2',summary:'Offsite',start:{date:'2026-09-05'},end:{date:'2026-09-07'}}};});const allDay={...timed,title:'Offsite',allDay:true,start:'2026-09-05',end:'2026-09-07'};await updateEvent('google',{accessToken:'tok',calendarId:'cal/a',id:'event/id',event:allDay,version:'v1'},{fetchImpl});await deleteEvent('google',{accessToken:'tok',calendarId:'cal/a',id:'event/id',version:'v2'},{fetchImpl});expect(urls.every(url=>url.includes('/calendars/cal%2Fa/events/event%2Fid'))).toBe(true);expect(urls.every(url=>url.includes('sendUpdates=all'))).toBe(true);expect((seen[0].headers as any)['If-Match']).toBe('v1');expect(JSON.parse(String(seen[0].body)).start).toEqual({date:'2026-09-05'});expect(seen[1].method).toBe('DELETE');});
 it('uses Graph transactionId, named-zone wall times, encoded calendar and If-Match',async()=>{const seen:RequestInit[]=[];const {fetchImpl,urls}=fetchStub((_url,init)=>{seen.push(init??{});return init?.method==='DELETE'?{status:204}:{body:{id:'AAMkAG=',changeKey:'legacy-change-key','@odata.etag':'ck2',subject:'DST review',start:{dateTime:'2026-11-01T01:30:00'},end:{dateTime:'2026-11-01T02:30:00'}}};});await createEvent('microsoft',{accessToken:'tok',calendarId:'cal/id',event:timed,idempotencyKey:'123e4567-e89b-42d3-a456-426614174000'},{fetchImpl});await updateEvent('microsoft',{accessToken:'tok',calendarId:'cal/id',id:'AAMkAG=',event:timed,version:'ck1'},{fetchImpl});await deleteEvent('microsoft',{accessToken:'tok',calendarId:'cal/id',id:'AAMkAG=',version:'ck2'},{fetchImpl});expect(urls[0]).toContain('/calendars/cal%2Fid/events');const created=JSON.parse(String(seen[0].body));expect(created.transactionId).toBe('123e4567-e89b-42d3-a456-426614174000');expect(created.start).toEqual({dateTime:'2026-11-01T01:30:00',timeZone:'America/Los_Angeles'});expect((seen[1].headers as any)['If-Match']).toBe('ck1');});
 it('preserves omitted descriptions and makes delete retries converge on absent',async()=>{const bodies:any[]=[];let status=200;const {fetchImpl}=fetchStub((_url,init)=>{if(init?.body)bodies.push(JSON.parse(String(init.body)));return status===404?{status:404}:{body:{id:'event',etag:'v2',subject:'event',start:{dateTime:'2026-09-01T10:00:00'},end:{dateTime:'2026-09-01T11:00:00'}}};});const preserved={...timed};delete (preserved as any).description;await updateEvent('google',{accessToken:'tok',calendarId:'c',id:'event',event:preserved,version:'v1'},{fetchImpl});expect(bodies[0]).not.toHaveProperty('description');await updateEvent('microsoft',{accessToken:'tok',calendarId:'c',id:'event',event:preserved,version:'v1'},{fetchImpl});expect(bodies[1]).not.toHaveProperty('body');status=404;await expect(deleteEvent('google',{accessToken:'tok',calendarId:'c',id:'event',version:'v2'},{fetchImpl})).resolves.toBeUndefined();await expect(deleteEvent('microsoft',{accessToken:'tok',calendarId:'c',id:'event',version:'v2'},{fetchImpl})).resolves.toBeUndefined();});
 it('translates optimistic concurrency failures without leaking provider text',async()=>{const {fetchImpl}=fetchStub(()=>({status:412,body:{error:{message:'secret event data'}}}));await expect(updateEvent('google',{accessToken:'tok',calendarId:'c',id:'e',event:timed,version:'old'},{fetchImpl})).rejects.toThrow('changed or was removed');});
});

describe('complete calendar windows',()=>{
 it('follows Google pages and retains recurrence instance IDs',async()=>{
  let calls=0;const {fetchImpl,urls}=fetchStub(()=>({body:++calls===1?{items:[{id:'series_20260308',start:{dateTime:'2026-03-08T09:00:00Z'}}],nextPageToken:'next'}:{items:[{id:'series_20260309',start:{dateTime:'2026-03-09T09:00:00Z'}}]}}));
  const events=await listEvents('google',{accessToken:'tok',calendarId:'chosen',timeMin:'a',timeMax:'b',limit:1000},{fetchImpl});expect(events.map(e=>e.sourceId)).toEqual(['series_20260308','series_20260309']);expect(urls[1]).toContain('pageToken=next');expect(urls.every(u=>u.includes('/calendars/chosen/'))).toBe(true);
 });
 it('refuses busy windows instead of returning a misleading partial calendar',async()=>{
  const {fetchImpl}=fetchStub(()=>({body:{items:[{id:'a'}],nextPageToken:'more'}}));await expect(listEvents('google',{accessToken:'tok',timeMin:'a',timeMax:'b',limit:1},{fetchImpl})).rejects.toThrow('shorter range');
 });
 it('marks Graph UTC instants and recovers all-day civil dates in their original zone',async()=>{
  const {fetchImpl}=fetchStub(()=>({body:{value:[{id:'timed',start:{dateTime:'2026-03-08T10:00:00.0000000'},end:{dateTime:'2026-03-08T11:00:00.0000000'}},{id:'all-day',isAllDay:true,originalStartTimeZone:'Pacific/Auckland',originalEndTimeZone:'Pacific/Auckland',start:{dateTime:'2026-03-07T11:00:00.0000000'},end:{dateTime:'2026-03-08T11:00:00.0000000'}}]}}));const rows=await listEvents('microsoft',{accessToken:'tok',timeMin:'a',timeMax:'b'},{fetchImpl});expect(rows[0].start).toBe('2026-03-08T10:00:00.0000000Z');expect(rows[1]).toMatchObject({start:'2026-03-08',end:'2026-03-09',allDay:true});
 });
 it('re-reads unknown Windows-zone all-day events in their provider timezone',async()=>{let calls=0;const {fetchImpl}=fetchStub((_url,init)=>{calls++;if(calls===1)return{body:{value:[{id:'india-day',isAllDay:true,originalStartTimeZone:'India Standard Time',originalEndTimeZone:'India Standard Time',start:{dateTime:'2026-03-07T18:30:00'},end:{dateTime:'2026-03-08T18:30:00'}}]}};expect((init?.headers as any).Prefer).toContain('India Standard Time');expect((init?.headers as any).Authorization).toBe('Bearer tok');return{body:{id:'india-day',isAllDay:true,originalStartTimeZone:'India Standard Time',originalEndTimeZone:'India Standard Time',start:{dateTime:'2026-03-08T00:00:00'},end:{dateTime:'2026-03-09T00:00:00'}}};});const rows=await listEvents('microsoft',{accessToken:'tok',timeMin:'a',timeMax:'b',calendarId:'calendar'},{fetchImpl});expect(calls).toBe(2);expect(rows[0]).toMatchObject({start:'2026-03-08',end:'2026-03-09',allDay:true});
 });
 it('does not forward authorization to a hostile Graph pagination host',async()=>{
  const {fetchImpl,urls}=fetchStub(()=>({body:{value:[],'@odata.nextLink':'https://attacker.test/page'}}));await expect(listEvents('microsoft',{accessToken:'tok',timeMin:'a',timeMax:'b'},{fetchImpl})).rejects.toThrow();expect(urls).toHaveLength(1);
 });
});
