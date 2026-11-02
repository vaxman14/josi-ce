// What the assistant may do with no Google or Microsoft account connected: the
// calendar kept on this server, and email through the installation's own mail
// server. Both go through the same switches and the same approval gate.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testVault, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey } from '@josi-ce/core';
import { connectLocalCalendar, createInternalEvent } from '@josi-ce/connectors';
import { dataToolAvailability, executeDataTool, writeActionCapabilities } from '../src/dataTools.js';

let db: TestDb; let alice: string; let bob: string;
const key = new MasterKey(Buffer.alloc(32, 9));

beforeEach(async () => {
  db = await testDb();
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'super_admin' })).id;
  bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;
  await testVault(db, key);
});

describe('without a connected account', () => {
  it('offers nothing to write until a mail server or a local calendar exists', async () => {
    expect([...await writeActionCapabilities(db, alice)]).toEqual([]);
    expect((await dataToolAvailability(db, alice)).granted).toEqual([]);
  });

  it('the installation mail server makes email_send available to everyone', async () => {
    await db.query(`insert into smtp_profiles (kind, host, port, security, from_name, from_address) values ('system', '127.0.0.1', 2525, 'none', 'Josi', 'josi@demo.local')`);
    expect([...await writeActionCapabilities(db, alice)]).toEqual([]);  // the system profile alone sends sign-in mail only
    await db.query(`insert into smtp_profiles (kind, copy_from_system, from_name, from_address) values ('communications', true, 'Josi', 'josi@demo.local')`);
    expect([...await writeActionCapabilities(db, alice)]).toEqual(['email_send']);
    expect([...await writeActionCapabilities(db, bob)]).toEqual(['email_send']);
  });

  it('a local calendar makes calendar_write available and query_calendar read it', async () => {
    const local = await connectLocalCalendar(db, { ownerUserId: alice, name: 'Dana' });
    await createInternalEvent(db, { ownerUserId: alice, originId: local.originId,
      event: { title: 'Design review', start: '2026-11-05T18:00:00Z', end: '2026-11-05T18:30:00Z' } });
    expect([...await writeActionCapabilities(db, alice)]).toEqual(['calendar_write']);
    expect([...await writeActionCapabilities(db, bob)]).toEqual([]);
    expect((await dataToolAvailability(db, alice)).granted).toEqual(['calendar']);
    const result = await executeDataTool(db, { userId: alice, access: null }, 'query_calendar',
      { start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z' }) as { ok: boolean; events: Array<{ title: string; provider: string; calendar_name: string }>; coverage_warning?: string };
    expect(result.ok).toBe(true);
    expect(result.coverage_warning).toBeUndefined();
    expect(result.events.map((e) => [e.title, e.provider, e.calendar_name])).toEqual([['Design review', 'local', 'Dana']]);
    const other = await executeDataTool(db, { userId: bob, access: null }, 'query_calendar',
      { start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z' }) as { ok: boolean };
    expect(other.ok).toBe(false);
  });
});
