// The cap under real concurrency. PGlite serves one connection, so its version of
// these tests can't race. This one needs a real Postgres and runs only when
// HOSTED_TEST_DATABASE_URL is set: each call below takes its own connection, and
// only the row locks stand between them and overspending.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserve, settle, sweepReservations, usageFor, type ModelRow } from '../src/ai/allowance.js';
import { aiPool } from '../src/plans.js';
import { Harness, completion, realDatabaseUrl } from './helpers.js';

describe.skipIf(!realDatabaseUrl())('on a real Postgres', () => {
  let h: Harness;
  beforeAll(async () => { h = await new Harness().start(); });
  afterAll(() => h.stop());

  async function setup(includedMicros: number) {
    const customer = await h.aiCustomer();
    const pool = (await aiPool(h.ctx, customer.account.id))!;
    await h.db.query('update heyjosi.allowance_periods set included_micros = $2 where household_id = $1', [pool.householdId, includedMicros]);
    const [server] = await h.db.query<{ id: string }>('select id from heyjosi.servers where account_id = $1', [customer.account.id]);
    const [model] = await h.db.query<ModelRow>(`select * from heyjosi.models where id = 'gpt-5.6-luna'`);
    return { ...customer, pool, serverId: server!.id, model: model! };
  }

  it('grants exactly what fits when 300 reservations race', async () => {
    const { account, pool, serverId, model } = await setup(50_000);
    const results = await Promise.all(Array.from({ length: 300 }, () => reserve(h.ctx, { pool, accountId: account.id, serverId, model, amount: 1000 })));
    expect(results.filter(result => result.ok)).toHaveLength(50);
    expect((await usageFor(h.ctx, account.id)).reserved).toBe(50_000);
  });

  it('holds a member cap under the same race', async () => {
    const { account, pool, serverId, model } = await setup(5_000_000);
    await h.db.query('update heyjosi.household_members set cap_micros = 7000 where account_id = $1', [account.id]);
    const results = await Promise.all(Array.from({ length: 100 }, () => reserve(h.ctx, { pool, accountId: account.id, serverId, model, amount: 1000 })));
    expect(results.filter(result => result.ok)).toHaveLength(7);
  });

  it('never goes over with reserving, settling and sweeping all racing, and never deadlocks', async () => {
    const { account, pool, serverId, model } = await setup(200_000);
    let granted = 0;
    const worker = async () => {
      for (let i = 0; i < 15; i++) {
        const held = await reserve(h.ctx, { pool, accountId: account.id, serverId, model, amount: 3000 });
        if (!held.ok) continue;
        granted++;
        // Some settle low, some unknown, and each is settled twice at once.
        const outcome = i % 3 === 0 ? { kind: 'unknown' as const } : { kind: 'settled' as const, model, inputTokens: 5000, outputTokens: 1000 };
        await Promise.all([settle(h.ctx, held.id, outcome), settle(h.ctx, held.id, { kind: 'expired' }), sweepReservations(h.ctx)]);
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    const usage = await usageFor(h.ctx, account.id);
    expect(granted).toBeGreaterThan(30);
    expect(usage.reserved).toBe(0);
    expect(usage.spent).toBeLessThanOrEqual(200_000);
    const [rows] = await h.db.query<{ total: unknown; n: unknown }>('select coalesce(sum(charged_micros), 0) as total, count(*) as n from heyjosi.usage_rows where account_id = $1', [account.id]);
    expect(Number(rows!.total)).toBe(usage.spent);
    expect(Number(rows!.n)).toBe(granted);
  });

  it('holds end to end through the gateway', async () => {
    const { account, token, pool } = await setup(0);
    const body = { messages: [{ role: 'user', content: 'hello' }], max_tokens: 1000 };
    const per = Math.ceil(((JSON.stringify(body).length + 512) * 200_000 + 1000 * 1_200_000) / 1_000_000);
    await h.db.query('update heyjosi.allowance_periods set included_micros = $2 where household_id = $1', [pool.householdId, per * 8]);
    let upstream = 0;
    h.openai = async sent => {
      upstream++;
      await new Promise(resolve => setTimeout(resolve, 50));
      // Costs its whole bound, so eight is the most that can ever be paid for.
      return new Response(JSON.stringify(completion(sent, JSON.stringify(body).length + 512, 1000)), { headers: { 'content-type': 'application/json' } });
    };
    const statuses = (await Promise.all(Array.from({ length: 60 }, () => h.chat(token, body)))).map(res => res.status);
    const usage = await usageFor(h.ctx, account.id);
    expect(statuses.filter(status => status === 200)).toHaveLength(8);
    expect(statuses.filter(status => status === 402)).toHaveLength(52);
    expect(upstream).toBe(8);
    expect(usage.reserved).toBe(0);
    expect(usage.spent).toBeLessThanOrEqual(per * 8);
  });
});
