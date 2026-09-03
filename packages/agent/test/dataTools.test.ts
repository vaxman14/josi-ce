// The connected-data tools, end to end against the real schema.
//
// No provider is contacted: fetch is a stub returning canned Gmail/Calendar
// payloads. What IS real: the migrations, the connection and capability spine,
// the sealed tokens, the master key, and every gating decision. The cases here
// are the ones item 17 (round 2) exists for — the switch honoured at offering
// time AND execution time, cross-user isolation, and empty reported as empty.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey } from '@josi-ce/core';
import {
  saveClient, setCapability, upsertConnection, type ConnectionRow,
} from '@josi-ce/connectors';
import { executeAssistantTool } from '../src/execute.js';
import { dataToolAvailability } from '../src/dataTools.js';
import { buildCore } from '../src/mcp/server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: TestDb;
let alice: string;
let bob: string;
const key = new MasterKey(Buffer.alloc(32, 7));

const GOOGLE_READ_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
].join(' ');

beforeEach(async () => {
  db = await testDb();
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'super_admin' })).id;
  bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;
  await saveClient(db, key, {
    provider: 'google',
    clientId: 'google-client-id',
    clientSecret: 'google-CLIENT-SECRET',
    redirectUri: 'https://josi.example.test/api/connections/google/callback',
    actorUserId: alice,
  });
});

async function connectGoogle(user: string): Promise<ConnectionRow> {
  return upsertConnection(db, key, {
    ownerUserId: user,
    provider: 'google',
    tokens: {
      accessToken: 'live-access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      grantedScopes: GOOGLE_READ_SCOPES,
    },
    accountEmail: 'a@gmail.test',
    providerAccountId: 'acct-1',
    requestedCapabilities: ['google.mail.read', 'google.calendar.read', 'google.contacts.read'],
  });
}

async function enable(connection: ConnectionRow, capability: string, user = alice): Promise<void> {
  await setCapability(db, { connection, capability, enabled: true, actorUserId: user });
}

/** A Gmail-and-Calendar shaped fetch stub. */
function providerFetch(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const u = String(url);
    urls.push(u);
    let body: unknown = {};
    if (u.includes('gmail') && u.includes('/messages?')) {
      body = { messages: [{ id: 'm1' }] };
    } else if (u.includes('gmail') && u.includes('/messages/m1')) {
      body = {
        id: 'm1',
        snippet: 'lunch thursday?',
        internalDate: '1700000000000',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'ann@example.test' },
            { name: 'To', value: 'roman@example.test' },
            { name: 'Subject', value: 'lunch' },
          ],
          body: { data: Buffer.from('are you free thursday?', 'utf8').toString('base64url') },
        },
      };
    } else if (u.includes('calendar/v3')) {
      body = {
        items: [{
          id: 'ev1',
          summary: 'standup',
          start: { dateTime: '2026-09-04T09:00:00Z' },
          end: { dateTime: '2026-09-04T09:15:00Z' },
        }],
      };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const access = (fetchImpl: typeof fetch) => ({ masterKey: () => key, fetchImpl });

describe('offering follows the switches', () => {
  it('offers nothing when nothing is connected, and names every fix', async () => {
    const out = await dataToolAvailability(db, alice);
    expect(out.specs).toHaveLength(0);
    expect(out.granted).toEqual([]);
    expect(out.denied.map((d) => d.what).sort()).toEqual(['calendar', 'contacts', 'email']);
    expect(out.denied[0].hint).toContain('Connections page');
  });

  it('offers nothing while the switches are off, even with scopes granted', async () => {
    await connectGoogle(alice);
    const out = await dataToolAvailability(db, alice);
    expect(out.specs).toHaveLength(0);
    // The hint now names the SWITCH, not the connection — the person already
    // connected; the smallest fix is enabling.
    const mail = out.denied.find((d) => d.what === 'email');
    expect(mail?.hint).toContain('not turned on');
    expect(mail?.hint).toContain('Connections page');
  });

  it('offers exactly the enabled family', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.mail.read');
    const out = await dataToolAvailability(db, alice);
    expect(out.specs.map((s) => s.def.name).sort()).toEqual(['read_email', 'search_email']);
    expect(out.granted).toEqual(['mail']);
    expect(out.denied.map((d) => d.what).sort()).toEqual(['calendar', 'contacts']);
  });

  it('offers contact search on local rows alone, with every provider switch off', async () => {
    await db.query(
      `insert into contacts (owner_user_id, name, email) values ($1, 'Ann Local', 'ann@example.test')`,
      [alice],
    );
    const out = await dataToolAvailability(db, alice);
    expect(out.specs.map((s) => s.def.name)).toEqual(['search_contacts']);
  });
});

describe('execution re-checks the switch', () => {
  it('reads real mail when the switch is on', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.mail.read');
    const { fetchImpl, urls } = providerFetch();
    const ctx = { userId: alice, threadId: null, connectors: access(fetchImpl) };

    const search = await executeAssistantTool(db, ctx, 'search_email', { query: 'lunch' }) as {
      ok: boolean; emails: Array<{ email_id: string; subject: string | null }>;
    };
    expect(search.ok).toBe(true);
    expect(search.emails).toHaveLength(1);
    expect(search.emails[0].email_id).toBe('google:m1');
    expect(search.emails[0].subject).toBe('lunch');
    // The live token actually travelled to the provider.
    expect(urls.some((u) => u.includes('gmail'))).toBe(true);

    const read = await executeAssistantTool(db, ctx, 'read_email', { email_id: 'google:m1' }) as {
      ok: boolean; email: { body: string; truncated: boolean };
    };
    expect(read.ok).toBe(true);
    expect(read.email.body).toBe('are you free thursday?');
    expect(read.email.truncated).toBe(false);
  });

  it('refuses at EXECUTION time when the switch went off after offering', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.mail.read');
    // Offered…
    expect((await dataToolAvailability(db, alice)).granted).toEqual(['mail']);
    // …then the person flips it off mid-conversation.
    await setCapability(db, { connection, capability: 'google.mail.read', enabled: false, actorUserId: alice });

    const { fetchImpl, urls } = providerFetch();
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(fetchImpl) },
      'search_email', { query: 'lunch' },
    ) as { ok: boolean; error: string; message: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_enabled');
    expect(result.message).toContain('Connections page');
    // And nothing reached the provider.
    expect(urls).toHaveLength(0);
  });

  it("one person's switch grants nothing to another person", async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.mail.read');
    const { fetchImpl, urls } = providerFetch();
    const result = await executeAssistantTool(
      db, { userId: bob, threadId: null, connectors: access(fetchImpl) },
      'search_email', { query: 'lunch' },
    ) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it('refuses honestly when the executor has no way to open tokens', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.mail.read');
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: null },
      'search_email', { query: 'lunch' },
    ) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unavailable');
  });

  it('lists calendar events for the default week window', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.calendar.read');
    const { fetchImpl, urls } = providerFetch();
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(fetchImpl) },
      'query_calendar', {},
    ) as { ok: boolean; events: Array<{ event_id: string; title: string | null }>; range: { start: string; end: string } };
    expect(result.ok).toBe(true);
    expect(result.events[0]).toMatchObject({ event_id: 'google:ev1', title: 'standup' });
    const days = (new Date(result.range.end).getTime() - new Date(result.range.start).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    expect(urls[0]).toContain('singleEvents=true');
  });

  it('reports an empty calendar as empty, never invented', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.calendar.read');
    const empty = (async () => new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(empty) },
      'query_calendar', {},
    ) as { ok: boolean; events: unknown[]; message?: string };
    expect(result.ok).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.message).toContain('no events');
  });

  it('refuses an unreasonable calendar range rather than guessing one', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.calendar.read');
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(providerFetch().fetchImpl) },
      'query_calendar', { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' },
    ) as { ok: boolean; error: string };
    expect(result).toMatchObject({ ok: false, error: 'bad_time' });
  });
});

describe('contacts prefer the local store', () => {
  it('finds a locally synced contact without touching any provider', async () => {
    await db.query(
      `insert into contacts (owner_user_id, name, email, phone) values ($1, 'Ann Chen', 'ann@example.test', '+1 555 0100')`,
      [alice],
    );
    const { fetchImpl, urls } = providerFetch();
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(fetchImpl) },
      'search_contacts', { query: 'ann' },
    ) as { ok: boolean; source: string; contacts: Array<{ name: string | null }> };
    expect(result).toMatchObject({ ok: true, source: 'local' });
    expect(result.contacts[0].name).toBe('Ann Chen');
    expect(urls).toHaveLength(0);
  });

  it("never returns another person's local contacts", async () => {
    await db.query(
      `insert into contacts (owner_user_id, name, email) values ($1, 'Ann Chen', 'ann@example.test')`,
      [alice],
    );
    const result = await executeAssistantTool(
      db, { userId: bob, threadId: null, connectors: null },
      'search_contacts', { query: 'ann' },
    ) as { ok: boolean; contacts: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.contacts).toEqual([]);
  });

  it('reports no match against a populated store without a provider trip', async () => {
    await db.query(
      `insert into contacts (owner_user_id, name) values ($1, 'Somebody Else')`,
      [alice],
    );
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.contacts.read');
    const { fetchImpl, urls } = providerFetch();
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(fetchImpl) },
      'search_contacts', { query: 'ann' },
    ) as { ok: boolean; contacts: unknown[]; message?: string };
    expect(result.contacts).toEqual([]);
    expect(result.message).toContain('No contact matched');
    expect(urls).toHaveLength(0);
  });

  it('falls back to the provider only when the local store is empty and the switch is on', async () => {
    const connection = await connectGoogle(alice);
    await enable(connection, 'google.contacts.read');
    const people = (async (url: RequestInfo | URL) => {
      expect(String(url)).toContain('people.googleapis.com');
      return new Response(JSON.stringify({
        connections: [{
          resourceName: 'people/p1',
          names: [{ displayName: 'Ann Remote' }],
          emailAddresses: [{ value: 'ann@example.test' }],
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const result = await executeAssistantTool(
      db, { userId: alice, threadId: null, connectors: access(people) },
      'search_contacts', { query: 'ann' },
    ) as { ok: boolean; source: string; contacts: Array<{ contact_id: string; name: string | null }> };
    expect(result).toMatchObject({ ok: true, source: 'provider' });
    expect(result.contacts[0]).toMatchObject({ contact_id: 'google:people/p1', name: 'Ann Remote' });
  });
});

describe('the MCP server offers the same catalogue', () => {
  it('lists a data tool the turn offered, and refuses one it did not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-datatools-mcp-'));
    const core = buildCore({
      databaseUrl: null, passwordFile: null, masterKeyPath: null,
      userId: alice, sessionKey: 's1', threadId: null,
      tools: ['search_email', 'read_email'],
      callsPath: join(dir, 'calls.jsonl'),
    }, async () => db);
    const names = core.tools.map((t) => t.name);
    expect(names).toContain('search_email');
    expect(names).toContain('read_email');
    expect(names).not.toContain('query_calendar');
    // Executing an offered tool still re-checks the switch in the database —
    // nothing is enabled for alice here, so the answer is the honest refusal.
    const outcome = await core.execute('search_email', { query: 'x' }, 'c1');
    const parsed = JSON.parse(outcome.text) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(['not_enabled', 'unavailable']).toContain(parsed.error);
  });
});
