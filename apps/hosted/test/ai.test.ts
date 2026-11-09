import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chargeMicros, costMicros, reserve, settle, sweepReservations, usageFor, type ModelRow } from '../src/ai/allowance.js';
import { aiPool } from '../src/plans.js';
import { Harness, completion } from './helpers.js';

let h: Harness;
beforeAll(async () => { h = await new Harness().start(); });
afterAll(() => h.stop());

const USER = [{ role: 'user', content: 'hello there' }];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const answer = (input = 10, output = 5) => { h.openai = body => json(completion(body, input, output)); };

async function household(accountId: string): Promise<string> {
  return (await h.db.query<{ household_id: string }>('select household_id from heyjosi.household_members where account_id = $1', [accountId]))[0]!.household_id;
}

/** Leaves a household with a set amount of included allowance and no top-ups. */
async function setPool(accountId: string, micros: number): Promise<void> {
  await h.db.query('update heyjosi.allowance_periods set included_micros = $2, included_spent_micros = 0, topup_spent_micros = 0 where household_id = $1', [await household(accountId), micros]);
}

async function topUp(accountId: string, usd: number): Promise<void> {
  const res = await h.webhook({ id: h.id('evt_'), type: 'checkout.session.completed', data: { object: { id: h.id('cs_'), mode: 'payment', payment_status: 'paid', amount_total: usd * 100, metadata: { kind: 'top_up', account_id: accountId, household_id: await household(accountId), usd: String(usd) } } } });
  expect(res.status).toBe(200);
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('timed out waiting');
}

const openReservations = async (accountId: string) => (await h.db.query('select 1 from heyjosi.reservations where account_id = $1 and state = \'open\'', [accountId])).length;

function sse(events: Array<Record<string, unknown> | string>, done = true): Response {
  const text = events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

const delta = (content: string) => ({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content } }], usage: null });
const usageChunk = (input: number, output: number) => ({ id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });

const MODEL = { input_micros_per_million: 200_000, output_micros_per_million: 1_200_000, multiplier: 1 } as unknown as ModelRow;

describe('the sums', () => {
  it('costs Luna and Sol at their prices, rounding up', () => {
    expect(costMicros(MODEL, 1_000_000, 0)).toBe(200_000);
    expect(costMicros(MODEL, 0, 1_000_000)).toBe(1_200_000);
    expect(costMicros(MODEL, 1, 0)).toBe(1);
    expect(costMicros({ ...MODEL, input_micros_per_million: 5_000_000, output_micros_per_million: 30_000_000 }, 1000, 1000)).toBe(35_000);
  });

  it('applies the multiplier, and holds it at one or more', () => {
    expect(chargeMicros({ ...MODEL, multiplier: '2.500' }, 1_000_000, 0)).toBe(500_000);
    expect(chargeMicros({ ...MODEL, multiplier: 0.5 }, 1_000_000, 0)).toBe(200_000);
  });

  it('doesn\'t lose precision on big numbers', () => {
    expect(costMicros({ ...MODEL, output_micros_per_million: 30_000_000 }, 0, 4_000_000_000)).toBe(120_000_000_000);
  });

  it('has a table that refuses a multiplier under one and an enabled model with no upstream', async () => {
    await expect(h.db.query(`update heyjosi.models set multiplier = 0.5 where id = 'gpt-5.6-luna'`)).rejects.toThrow();
    await expect(h.db.query(`update heyjosi.models set enabled = true where id = 'astra'`)).rejects.toThrow();
  });
});

describe('the seed', () => {
  it('holds the models as agreed', async () => {
    const rows = await h.db.query<Record<string, unknown>>('select id, label, upstream_id, enabled, is_default, multiplier::float8 as multiplier, input_micros_per_million, output_micros_per_million from heyjosi.models order by id');
    expect(rows.map(row => ({ ...row, input_micros_per_million: row.input_micros_per_million === null ? null : Number(row.input_micros_per_million), output_micros_per_million: row.output_micros_per_million === null ? null : Number(row.output_micros_per_million) }))).toEqual([
      { id: 'astra', label: 'Astra', upstream_id: null, enabled: false, is_default: false, multiplier: 1, input_micros_per_million: null, output_micros_per_million: null },
      { id: 'gpt-5.6-luna', label: 'Luna', upstream_id: 'gpt-5.6-luna', enabled: true, is_default: true, multiplier: 1, input_micros_per_million: 200000, output_micros_per_million: 1200000 },
      { id: 'gpt-5.6-sol', label: 'Sol', upstream_id: 'gpt-5.6-sol', enabled: true, is_default: false, multiplier: 1, input_micros_per_million: 5000000, output_micros_per_million: 30000000 },
      { id: 'gpt-5.6-terra', label: 'Terra', upstream_id: 'gpt-5.6-terra', enabled: false, is_default: false, multiplier: 1, input_micros_per_million: 2000000, output_micros_per_million: 12000000 },
    ]);
  });
});

describe('who may call', () => {
  it('refuses no token and a wrong token', async () => {
    expect((await fetch(`${h.base}/ai/v1/models`)).status).toBe(401);
    const res = await h.chat('hj_ai_wrong', { messages: USER });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_api_key');
  });

  it('refuses a token whose plan lapsed, with nothing sent upstream', async () => {
    const account = await h.account();
    const sub = await h.subscribe(account.id, 'connect_ai');
    const { FakeServerKey } = await import('./helpers.js');
    const server = new FakeServerKey(h);
    await server.link(account.browser);
    const { aiToken } = await server.sync() as { aiToken: string };
    h.subs.get(sub)!.status = 'canceled';
    await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.deleted', data: { object: { id: sub } } });
    h.calls = [];
    const res = await h.chat(aiToken, { messages: USER });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('josi_plan_required');
    expect(h.calls).toEqual([]);
  });

  it('lists enabled models with the token', async () => {
    const { token } = await h.aiCustomer();
    const res = await fetch(`${h.base}/ai/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await res.json()) as { data: Array<{ id: string }> }).data.map(model => model.id)).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol']);
  });
});

describe('choosing a model', () => {
  it('defaults to Luna and uses the owner\'s key', async () => {
    const { token } = await h.aiCustomer();
    answer();
    h.calls = [];
    expect((await h.chat(token, { messages: USER })).status).toBe(200);
    const call = h.calls.find(item => item.url.endsWith('/chat/completions'))!;
    expect(JSON.parse(call.body).model).toBe('gpt-5.6-luna');
    expect(call.headers.authorization).toBe('Bearer fixture-openai-key');
    expect(call.body).not.toContain(token);
  });

  it('refuses unknown and disabled models plainly, and never swaps', async () => {
    const { token } = await h.aiCustomer();
    h.calls = [];
    for (const [model, code] of [['gpt-9', 'model_not_found'], ['gpt-5.6-terra', 'model_not_available'], ['astra', 'model_not_available']] as const) {
      const res = await h.chat(token, { model, messages: USER });
      expect(res.status).toBe(400);
      const { error } = await res.json() as { error: { code: string; message: string } };
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(10);
    }
    expect(h.calls).toEqual([]);
  });
});

describe('what reaches OpenAI', () => {
  it('forces the output ceiling and keeps conversations out of OpenAI storage', async () => {
    const { token } = await h.aiCustomer();
    const sent: Array<Record<string, unknown>> = [];
    h.openai = body => { sent.push(body); return json(completion(body, 1, 1)); };
    await h.chat(token, { messages: USER });
    await h.chat(token, { messages: USER, max_tokens: 10_000_000 });
    await h.chat(token, { messages: USER, max_completion_tokens: 50 });
    expect(sent.map(body => body.max_completion_tokens)).toEqual([16_384, 16_384, 50]);
    expect(sent.every(body => body.store === false && body.max_tokens === undefined)).toBe(true);
  });

  it('refuses anything with a cost the reservation can\'t bound', async () => {
    const { token } = await h.aiCustomer();
    const refused: Array<Record<string, unknown>> = [
      { messages: USER, web_search_options: {} }, { messages: USER, audio: { voice: 'x' } }, { messages: USER, modalities: ['audio'] }, { messages: USER, prediction: {} }, { messages: USER, service_tier: 'priority' },
      { messages: USER, n: 4 }, { messages: USER, store: true }, { messages: USER, tools: [{ type: 'web_search' }] }, { messages: USER, max_tokens: -1 }, { messages: USER, max_tokens: 1.5 },
      { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] }, { messages: [{ role: 'user', content: [{ type: 'file', file: {} }] }] }, { messages: [{ role: 'assistant', audio: { id: 'a' } }] },
      { messages: [] }, { messages: 'hi' },
    ];
    h.calls = [];
    for (const body of refused) expect((await h.chat(token, body)).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('refuses a body that isn\'t JSON, and one that\'s too large', async () => {
    const { token } = await h.aiCustomer();
    const post = (body: string) => fetch(`${h.base}/ai/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
    expect((await post('not json')).status).toBe(400);
    expect((await post('[]')).status).toBe(400);
    expect((await post(JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(5_000_000) }] }))).status).toBe(413);
  });
});

describe('the hard cap', () => {
  it('reserves the worst case, then settles to what it really cost', async () => {
    const { account, token } = await h.aiCustomer();
    let during = 0;
    h.openai = async body => { during = (await usageFor(h.ctx, account.id)).reserved; return json(completion(body, 1000, 500)); };
    const res = await h.chat(token, { messages: USER, max_tokens: 600 });
    expect(res.status).toBe(200);
    const bytes = JSON.stringify({ messages: USER, max_tokens: 600 }).length;
    expect(during).toBe(Math.ceil(((bytes + 512) * 200_000 + 600 * 1_200_000) / 1_000_000));
    const usage = await usageFor(h.ctx, account.id);
    expect(usage).toMatchObject({ reserved: 0, spent: 800, allowance: 12_000_000, remaining: 12_000_000 - 800, accountSpent: 800 });
    const [row] = await h.db.query<Record<string, unknown>>('select input_tokens, output_tokens, cost_micros, charged_micros, outcome from heyjosi.usage_rows where account_id = $1', [account.id]);
    expect(Object.values(row!).map(value => typeof value === 'string' && value !== 'settled' ? Number(value) : value)).toEqual([1000, 500, 800, 800, 'settled']);
  });

  it('says why with a 402, and sends nothing to OpenAI', async () => {
    const { account, token } = await h.aiCustomer();
    await setPool(account.id, 1000);
    h.calls = [];
    const res = await h.chat(token, { messages: USER });
    expect(res.status).toBe(402);
    const { error } = await res.json() as { error: Record<string, string> };
    expect(error.type).toBe('allowance_exhausted');
    expect(error.code).toBe('josi_allowance_exhausted');
    expect(error.message).toMatch(/top-up/);
    expect(h.calls).toEqual([]);
    expect((await usageFor(h.ctx, account.id)).reserved).toBe(0);
  });

  it('lets a smaller request through where a bigger one is refused', async () => {
    const { account, token } = await h.aiCustomer();
    answer(1, 1);
    await setPool(account.id, 3000);
    expect((await h.chat(token, { messages: USER })).status).toBe(402);
    expect((await h.chat(token, { messages: USER, max_tokens: 100 })).status).toBe(200);
  });

  it('counts every image, inline ones too', async () => {
    const { account, token } = await h.aiCustomer();
    let during = 0;
    h.openai = async body => { during = (await usageFor(h.ctx, account.id)).reserved; return json(completion(body, 1, 1)); };
    const content = [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'https://example.test/a.png' } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
    const body = { messages: [{ role: 'user', content }], max_tokens: 1 };
    await h.chat(token, body);
    expect(during).toBe(Math.ceil(((JSON.stringify(body).length + 512 + 80_000) * 200_000 + 1_200_000) / 1_000_000));
  });

  it('draws Sol faster than Luna for the same tokens', async () => {
    const { account, token } = await h.aiCustomer();
    answer(1000, 1000);
    await h.chat(token, { messages: USER, max_tokens: 2000 });
    const luna = (await usageFor(h.ctx, account.id)).spent;
    await h.chat(token, { model: 'gpt-5.6-sol', messages: USER, max_tokens: 2000 });
    expect((await usageFor(h.ctx, account.id)).spent - luna).toBe(35_000);
    expect(luna).toBe(1400);
  });

  it('charges cost times multiplier', async () => {
    const { account, token } = await h.aiCustomer();
    await h.db.query(`update heyjosi.models set multiplier = 2 where id = 'gpt-5.6-sol'`);
    answer(1000, 1000);
    await h.chat(token, { model: 'gpt-5.6-sol', messages: USER, max_tokens: 2000 });
    await h.db.query(`update heyjosi.models set multiplier = 1 where id = 'gpt-5.6-sol'`);
    expect((await usageFor(h.ctx, account.id)).spent).toBe(70_000);
    const [row] = await h.db.query<{ cost_micros: unknown; charged_micros: unknown }>('select cost_micros, charged_micros from heyjosi.usage_rows where account_id = $1', [account.id]);
    expect([Number(row!.cost_micros), Number(row!.charged_micros)]).toEqual([35_000, 70_000]);
  });

  it('never lets many parallel calls past the cap', async () => {
    const { account, token } = await h.aiCustomer();
    // Room for about six reservations, and every call settles at its full bound.
    const per = Math.ceil(((JSON.stringify({ messages: USER, max_tokens: 1000 }).length + 512) * 200_000 + 1000 * 1_200_000) / 1_000_000);
    await setPool(account.id, Math.floor(per * 6.5));
    let upstream = 0, inFlight = 0, peak = 0;
    h.openai = async body => {
      upstream++; inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 30));
      inFlight--;
      return json(completion(body, 512 + 40, 1000));
    };
    const results = await Promise.all(Array.from({ length: 40 }, () => h.chat(token, { messages: USER, max_tokens: 1000 })));
    const counts = results.reduce<Record<number, number>>((all, res) => ({ ...all, [res.status]: (all[res.status] ?? 0) + 1 }), {});
    const usage = await usageFor(h.ctx, account.id);
    expect(counts[200]).toBe(upstream);
    expect(counts[200]! + counts[402]!).toBe(40);
    expect(peak).toBeGreaterThan(1);
    expect(usage.reserved).toBe(0);
    expect(usage.spent).toBeLessThanOrEqual(usage.allowance);
    expect(upstream * 1_200_000 / 1000).toBeLessThanOrEqual(usage.allowance);
  });

  it('never lets parallel calls past a member\'s cap or the pool, when calls all end at the bound', async () => {
    const { account, token } = await h.aiCustomer();
    await setPool(account.id, 5_000_000);
    await h.db.query('update heyjosi.household_members set cap_micros = 40000 where account_id = $1', [account.id]);
    h.openai = async body => { await new Promise(resolve => setTimeout(resolve, 20)); return json({ ...completion(body, 0, 0), usage: undefined }); };
    const results = await Promise.all(Array.from({ length: 20 }, () => h.chat(token, { messages: USER, max_tokens: 10_000 })));
    const usage = await usageFor(h.ctx, account.id);
    expect(results.filter(res => res.status === 200).length).toBeGreaterThan(0);
    expect(usage.accountSpent).toBeLessThanOrEqual(40_000);
  });

  it('holds running calls against the pool: a second call can\'t spend the same room', async () => {
    const { account, token } = await h.aiCustomer();
    const per = Math.ceil(((JSON.stringify({ messages: USER, max_tokens: 1000 }).length + 512) * 200_000 + 1000 * 1_200_000) / 1_000_000);
    await setPool(account.id, per + 10);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.openai = async body => { await gate; return json(completion(body, 1, 1)); };
    const first = h.chat(token, { messages: USER, max_tokens: 1000 });
    await until(async () => await openReservations(account.id) === 1);
    expect((await h.chat(token, { messages: USER, max_tokens: 1000 })).status).toBe(402);
    release();
    expect((await first).status).toBe(200);
    expect((await h.chat(token, { messages: USER, max_tokens: 1000 })).status).toBe(200);
  });

  it('keeps the customer inside the cap even if a real bill passes the bound', async () => {
    const { account, token } = await h.aiCustomer();
    const before = h.logs.length;
    answer(50_000_000, 0);
    const res = await h.chat(token, { messages: USER, max_tokens: 10 });
    expect(res.status).toBe(200);
    const [row] = await h.db.query<{ amount_micros: unknown }>('select amount_micros from heyjosi.reservations where account_id = $1', [account.id]);
    expect((await usageFor(h.ctx, account.id)).spent).toBe(Number(row!.amount_micros));
    expect(h.logs.slice(before).join()).toContain('ai_over_reservation');
  });
});

describe('when OpenAI doesn\'t give a number', () => {
  it('charges the full reservation when a reply has no usage', async () => {
    const { account, token } = await h.aiCustomer();
    h.openai = body => json({ ...completion(body, 1, 1), usage: undefined });
    await h.chat(token, { messages: USER, max_tokens: 100 });
    const [row] = await h.db.query<{ amount_micros: unknown }>('select amount_micros from heyjosi.reservations where account_id = $1', [account.id]);
    expect((await usageFor(h.ctx, account.id)).spent).toBe(Number(row!.amount_micros));
    expect(await h.db.query(`select outcome from heyjosi.usage_rows where account_id = $1`, [account.id])).toEqual([{ outcome: 'unknown' }]);
  });

  it('charges the full reservation when the connection dies mid-call', async () => {
    const { account, token } = await h.aiCustomer();
    h.openai = () => { throw new TypeError('fetch failed'); };
    expect((await h.chat(token, { messages: USER, max_tokens: 100 })).status).toBe(502);
    const usage = await usageFor(h.ctx, account.id);
    expect(usage.spent).toBeGreaterThan(0);
    expect(usage.reserved).toBe(0);
  });

  it('charges nothing when the call provably never left', async () => {
    const { account, token } = await h.aiCustomer();
    h.openai = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    expect((await h.chat(token, { messages: USER })).status).toBe(502);
    expect(await usageFor(h.ctx, account.id)).toMatchObject({ spent: 0, reserved: 0 });
  });

  it('charges nothing when OpenAI refuses the call, and hides its wording unless it helps', async () => {
    const { account, token } = await h.aiCustomer();
    h.openai = () => json({ error: { message: 'Rate limit reached for organization org-secret' } }, 429);
    const busy = await h.chat(token, { messages: USER });
    expect(busy.status).toBe(429);
    expect(await busy.text()).not.toContain('org-secret');
    h.openai = () => json({ error: { message: 'Incorrect API key sk-fixture' } }, 401);
    const auth = await h.chat(token, { messages: USER });
    expect(auth.status).toBe(502);
    expect(await auth.text()).not.toContain('sk-fixture');
    h.openai = () => json({ error: { message: 'Unsupported value: temperature', code: 'unsupported_value' } }, 400);
    const bad = await h.chat(token, { messages: USER, temperature: 0.2 });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Unsupported value');
    expect(await usageFor(h.ctx, account.id)).toMatchObject({ spent: 0, reserved: 0 });
  });
});

describe('streams', () => {
  it('passes the stream through and settles to its usage chunk', async () => {
    const { account, token } = await h.aiCustomer();
    let sent: Record<string, unknown> = {};
    h.openai = body => { sent = body; return sse([delta('Hel'), delta('lo'), usageChunk(100, 50)]); };
    const res = await h.chat(token, { messages: USER, stream: true, max_tokens: 100 });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('Hel');
    expect(text).toContain('[DONE]');
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(await usageFor(h.ctx, account.id)).toMatchObject({ spent: 80, reserved: 0 });
  });

  it('hides the usage chunk from a client that didn\'t ask for it, and shows it to one that did', async () => {
    const { token } = await h.aiCustomer();
    h.openai = () => sse([delta('hi'), usageChunk(10, 5)]);
    expect(await (await h.chat(token, { messages: USER, stream: true })).text()).not.toContain('prompt_tokens');
    expect(await (await h.chat(token, { messages: USER, stream: true, stream_options: { include_usage: true } })).text()).toContain('prompt_tokens');
  });

  it('copes with events split across network chunks, multi-byte text included', async () => {
    const { account, token } = await h.aiCustomer();
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(delta('héllo 🌙'))}\n\ndata: ${JSON.stringify(usageChunk(100, 50))}\n\ndata: [DONE]\n\n`);
    h.openai = () => new Response(new ReadableStream({ start(controller) { for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7)); controller.close(); } }));
    const text = await (await h.chat(token, { messages: USER, stream: true })).text();
    expect(text).toContain('héllo 🌙');
    expect((await usageFor(h.ctx, account.id)).spent).toBe(80);
  });

  it('charges in full when a stream ends with no usage', async () => {
    const { account, token } = await h.aiCustomer();
    h.openai = () => sse([delta('partial')], false);
    await (await h.chat(token, { messages: USER, stream: true, max_tokens: 100 })).text();
    const [row] = await h.db.query<{ amount_micros: unknown }>('select amount_micros from heyjosi.reservations where account_id = $1', [account.id]);
    expect((await usageFor(h.ctx, account.id)).spent).toBe(Number(row!.amount_micros));
  });

  it('charges in full when the upstream stream breaks', async () => {
    const { account, token } = await h.aiCustomer();
    h.openai = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta('x'))}\n\n`)); }, pull(controller) { controller.error(new Error('cut')); } }));
    const res = await h.chat(token, { messages: USER, stream: true, max_tokens: 100 });
    await res.text().catch(() => '');
    await until(async () => await openReservations(account.id) === 0);
    const [row] = await h.db.query<{ amount_micros: unknown }>('select amount_micros from heyjosi.reservations where account_id = $1', [account.id]);
    expect((await usageFor(h.ctx, account.id)).spent).toBe(Number(row!.amount_micros));
  });

  it('stops OpenAI and charges in full when the client vanishes', async () => {
    const { account, token } = await h.aiCustomer();
    let aborted = false;
    h.openai = (_body, init) => {
      init.signal!.addEventListener('abort', () => { aborted = true; });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta('x'))}\n\n`)); init.signal!.addEventListener('abort', () => controller.error(new Error('aborted'))); },
      }));
    };
    const client = new AbortController();
    const res = await h.chat(token, { messages: USER, stream: true, max_tokens: 100 }, { signal: client.signal });
    await res.body!.getReader().read();
    client.abort();
    await until(async () => await openReservations(account.id) === 0);
    expect(aborted).toBe(true);
    const [row] = await h.db.query<{ amount_micros: unknown }>('select amount_micros from heyjosi.reservations where account_id = $1', [account.id]);
    expect((await usageFor(h.ctx, account.id)).spent).toBe(Number(row!.amount_micros));
  });

  it('keeps streams under the cap too', async () => {
    const { account, token } = await h.aiCustomer();
    const per = Math.ceil(((JSON.stringify({ messages: USER, stream: true, max_tokens: 1000 }).length + 512) * 200_000 + 1000 * 1_200_000) / 1_000_000);
    await setPool(account.id, per * 3);
    h.openai = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return sse([delta('x')], false); };
    const results = await Promise.all(Array.from({ length: 10 }, async () => { const res = await h.chat(token, { messages: USER, stream: true, max_tokens: 1000 }); await res.text(); return res.status; }));
    expect(results.filter(status => status === 200)).toHaveLength(3);
    const usage = await usageFor(h.ctx, account.id);
    expect(usage.spent).toBeLessThanOrEqual(usage.allowance);
  });
});

describe('abandoned reservations', () => {
  it('expire by the sweep and are charged in full, once', async () => {
    const { account } = await h.aiCustomer();
    const pool = (await aiPool(h.ctx, account.id))!;
    const [server] = await h.db.query<{ id: string }>('select id from heyjosi.servers where account_id = $1', [account.id]);
    const [model] = await h.db.query<ModelRow>(`select * from heyjosi.models where id = 'gpt-5.6-luna'`);
    const held = await reserve(h.ctx, { pool, accountId: account.id, serverId: server!.id, model: model!, amount: 5000 });
    expect(held.ok).toBe(true);
    expect(await sweepReservations(h.ctx)).toBe(0);
    h.advance(16 * 60_000);
    expect(await sweepReservations(h.ctx)).toBeGreaterThan(0);
    h.advance(-16 * 60_000);
    expect(await usageFor(h.ctx, account.id)).toMatchObject({ spent: 5000, reserved: 0 });
    // A settle arriving late finds the reservation already closed.
    await settle(h.ctx, (held as { id: string }).id, { kind: 'released' });
    await settle(h.ctx, (held as { id: string }).id, { kind: 'unknown' });
    expect((await usageFor(h.ctx, account.id)).spent).toBe(5000);
    expect(await h.db.query(`select outcome from heyjosi.usage_rows where account_id = $1`, [account.id])).toEqual([{ outcome: 'expired' }]);
  });
});

describe('top-ups', () => {
  it('add to the pool and are spent after the included allowance', async () => {
    const { account, token } = await h.aiCustomer();
    await setPool(account.id, 1000);
    expect((await h.chat(token, { messages: USER })).status).toBe(402);
    await topUp(account.id, 10);
    expect((await usageFor(h.ctx, account.id)).remaining).toBe(10_001_000);
    answer(0, 2000);
    expect((await h.chat(token, { messages: USER })).status).toBe(200);
    const usage = await usageFor(h.ctx, account.id);
    expect(usage).toMatchObject({ allowance: 1000, topUps: 10_000_000, spent: 2400, remaining: 10_001_000 - 2400 });
    const [row] = await h.db.query<{ topup_micros: unknown }>('select topup_micros from heyjosi.households where id = $1', [await household(account.id)]);
    expect(Number(row!.topup_micros)).toBe(10_000_000 - 1400);
  });

  it('don\'t expire with the period, while the included allowance does', async () => {
    const { account } = await h.aiCustomer();
    await topUp(account.id, 20);
    const [sub] = await h.db.query<{ id: string }>('select id from heyjosi.subscriptions where account_id = $1', [account.id]);
    const stripeSub = h.subs.get(sub!.id)!;
    await h.db.query('update heyjosi.allowance_periods set included_spent_micros = included_micros where household_id = $1', [await household(account.id)]);
    expect((await usageFor(h.ctx, account.id)).remaining).toBe(20_000_000);
    stripeSub.current_period_start += 30 * 86_400; stripeSub.current_period_end += 30 * 86_400;
    await h.webhook({ id: h.id('evt_'), type: 'invoice.paid', data: { object: { subscription: sub!.id } } });
    expect(await usageFor(h.ctx, account.id)).toMatchObject({ allowance: 12_000_000, spent: 0, remaining: 32_000_000 });
  });

  it('can\'t be drawn while the plan is off, but stay for when it returns', async () => {
    const account = await h.account();
    const sub = await h.subscribe(account.id, 'connect_ai');
    await topUp(account.id, 10);
    h.subs.get(sub)!.status = 'canceled';
    await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.deleted', data: { object: { id: sub } } });
    expect(await aiPool(h.ctx, account.id)).toBeNull();
    expect((await usageFor(h.ctx, account.id)).remaining).toBe(0);
    h.subs.get(sub)!.status = 'active';
    await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.updated', data: { object: { id: sub } } });
    expect((await usageFor(h.ctx, account.id)).remaining).toBe(22_000_000);
  });
});

describe('households', () => {
  async function join(owner: Awaited<ReturnType<Harness['aiCustomer']>>) {
    const member = await h.account();
    expect((await owner.account.browser.post('/api/household/invite', { email: member.email })).status).toBe(202);
    const accepted = await member.browser.post('/api/household/accept', { token: h.lastToken(member.email) });
    expect(accepted.status).toBe(200);
    const { FakeServerKey } = await import('./helpers.js');
    const server = new FakeServerKey(h);
    await server.link(member.browser);
    const { aiToken } = await server.sync() as { aiToken: string };
    return { member, server, token: aiToken };
  }

  it('shares one pool, with AI on a member\'s server but no relay', async () => {
    const owner = await h.aiCustomer();
    const { member, server, token } = await join(owner);
    expect(await server.sync()).toMatchObject({ plan: 'free', grant: null, aiBaseUrl: 'https://heyjosi.test/ai/v1' });
    answer(1000, 500);
    await h.chat(owner.token, { messages: USER });
    await h.chat(token, { messages: USER });
    expect((await usageFor(h.ctx, owner.account.id)).spent).toBe(1600);
    expect(await usageFor(h.ctx, member.id)).toMatchObject({ spent: 1600, accountSpent: 800 });
  });

  it('enforces a member\'s cap while the owner carries on', async () => {
    const owner = await h.aiCustomer();
    const { member, token } = await join(owner);
    expect((await member.browser.post(`/api/household/members/${member.id}/cap`, { capUsd: 1 })).status).toBe(403);
    expect((await owner.account.browser.post(`/api/household/members/${member.id}/cap`, { capUsd: 0.05 })).status).toBe(200);
    answer(1000, 500);
    expect((await h.chat(token, { messages: USER, max_tokens: 100 })).status).toBe(200);
    const big = await h.chat(token, { messages: USER, max_tokens: 16_000 });
    expect(big.status).toBe(200);
    await h.db.query('update heyjosi.household_members set cap_micros = 1000 where account_id = $1', [member.id]);
    const refused = await h.chat(token, { messages: USER, max_tokens: 100 });
    expect(refused.status).toBe(402);
    const { error } = await refused.json() as { error: { code: string; message: string } };
    expect(error.code).toBe('josi_allowance_exhausted');
    expect(error.message).toMatch(/cap/);
    expect((await h.chat(owner.token, { messages: USER, max_tokens: 100 })).status).toBe(200);
  });

  it('counts a member\'s running calls against their cap', async () => {
    const owner = await h.aiCustomer();
    const { member, token } = await join(owner);
    const per = Math.ceil(((JSON.stringify({ messages: USER, max_tokens: 1000 }).length + 512) * 200_000 + 1000 * 1_200_000) / 1_000_000);
    await h.db.query('update heyjosi.household_members set cap_micros = $2 where account_id = $1', [member.id, per + 5]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.openai = async body => { await gate; return json(completion(body, 1, 1)); };
    const first = h.chat(token, { messages: USER, max_tokens: 1000 });
    await until(async () => await openReservations(member.id) === 1);
    expect((await h.chat(token, { messages: USER, max_tokens: 1000 })).status).toBe(402);
    release();
    await first;
  });

  it('takes the member\'s own yes, for the invited email only', async () => {
    const owner = await h.aiCustomer();
    const invited = await h.account(), stranger = await h.account();
    await owner.account.browser.post('/api/household/invite', { email: invited.email });
    const token = h.lastToken(invited.email);
    expect((await stranger.browser.post('/api/household/accept', { token })).status).toBe(400);
    expect(await aiPool(h.ctx, stranger.id)).toBeNull();
  });

  it('only lets the payer invite, and a member can leave', async () => {
    const owner = await h.aiCustomer();
    const { member, token } = await join(owner);
    expect((await member.browser.post('/api/household/invite', { email: 'x@example.test' })).status).toBe(403);
    expect((await member.browser.post(`/api/household/members/${member.id}/remove`, {})).status).toBe(200);
    expect((await h.chat(token, { messages: USER })).status).toBe(402);
    expect((await owner.account.browser.post(`/api/household/members/${owner.account.id}/remove`, {})).status).toBe(409);
  });

  it('cuts members off when the owner stops paying', async () => {
    const account = await h.account();
    const sub = await h.subscribe(account.id, 'connect_ai');
    const { FakeServerKey } = await import('./helpers.js');
    const ownerServer = new FakeServerKey(h);
    await ownerServer.link(account.browser);
    const { aiToken } = await ownerServer.sync() as { aiToken: string };
    const { token } = await join({ account, server: ownerServer, token: aiToken });
    h.subs.get(sub)!.status = 'canceled';
    await h.webhook({ id: h.id('evt_'), type: 'customer.subscription.deleted', data: { object: { id: sub } } });
    expect((await h.chat(token, { messages: USER })).status).toBe(402);
  });
});

describe('what the gateway keeps', () => {
  it('stores and logs no prompt or response', async () => {
    const { token } = await h.aiCustomer();
    const before = h.logs.length;
    const secretPrompt = 'my-very-private-question-xyzzy', secretAnswer = 'my-very-private-answer-plugh';
    h.openai = body => json({ ...completion(body, 10, 5), choices: [{ index: 0, message: { role: 'assistant', content: secretAnswer } }] });
    await (await h.chat(token, { messages: [{ role: 'user', content: secretPrompt }] })).text();
    h.openai = () => sse([delta(secretAnswer), usageChunk(10, 5)]);
    await (await h.chat(token, { messages: [{ role: 'user', content: secretPrompt }], stream: true })).text();
    h.openai = () => json({ error: { message: secretPrompt } }, 500);
    await (await h.chat(token, { messages: [{ role: 'user', content: secretPrompt }] })).text();
    const everything = (await h.dump()) + h.logs.slice(before).join();
    expect(everything).not.toContain(secretPrompt);
    expect(everything).not.toContain(secretAnswer);
  });
});

describe('a refused call', () => {
  it('leaves the room free for the very next try', async () => {
    const { account, token } = await h.aiCustomer();
    const body = { messages: USER, max_tokens: 1000 };
    const per = Math.ceil(((JSON.stringify(body).length + 512) * 200_000 + 1000 * 1_200_000) / 1_000_000);
    await setPool(account.id, per);
    h.openai = () => json({ error: { message: 'busy' } }, 429);
    expect((await h.chat(token, body)).status).toBe(429);
    answer(1, 1);
    expect((await h.chat(token, body)).status).toBe(200);
  });
});
