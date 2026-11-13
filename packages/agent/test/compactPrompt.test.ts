// The compact prompt for a small model on the person's own hardware: how big
// a request is, that its start does not change from one request to the next,
// and what the person is told when a request does not fit.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testVault, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey, createThread, json } from '@josi-ce/core';
import { measureRequest, contextOverflow, describePromptSize } from '@josi-ce/llm';
import { runAssistantTurn, selectCompactTools, compactHistory, TASK_TOOLS } from '../src/index.js';

let db: TestDb;
let alice: string;
const key = new MasterKey(Buffer.alloc(32, 3));
const resolve = async () => ['10.0.0.5'];

let requests: any[] = [];
let chatReply: () => Response = () => ok({ content: 'ok' });
/** What the pretend Ollama says the model's context is. */
let numCtx: number | null = 24576;

const ok = (message: unknown) => new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 0, completion_tokens: 2 } }),
  { status: 200, headers: { 'content-type': 'application/json' } });

const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: numCtx ? [{ name: 'josi-small', context_length: numCtx }] : [] }), { status: 200 });
  if (u.endsWith('/api/show')) return new Response(JSON.stringify({ parameters: '', model_info: { 'qwen.context_length': 262144 } }), { status: 200 });
  if (u.endsWith('/chat/completions')) { requests.push(JSON.parse(String(init?.body ?? '{}'))); return chatReply(); }
  return new Response('{}', { status: 404 });
}) as unknown as typeof fetch;

async function configure(config: Record<string, string> = {}): Promise<void> {
  await db.query(
    `insert into llm_providers (role, provider, model, base_url, external_acknowledged, activated_at, probed_at,
        cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens, provider_config)
     values ('primary', 'openai_compatible', 'josi-small', 'http://box.test:11434/v1', false, now(), now(), true, true, true, 8000, $1)
     on conflict (role) do update set provider_config = excluded.provider_config`, [json(config)]);
}

async function turn(over: Record<string, unknown> = {}) {
  const thread = (over.threadId as string) ?? (await createThread(db, { ownerUserId: alice })).id;
  return runAssistantTurn({ db, registry: { db, masterKey: key, fetchImpl, resolve }, userId: alice, threadId: thread, history: [], inbound: 'hello', ...over } as any);
}

const sizeOf = (body: any) => measureRequest({
  system: body.messages[0].role === 'system' ? body.messages[0].content : '',
  tools: (body.tools ?? []).map((t: any) => t.function),
  messages: body.messages.filter((m: any) => m.role !== 'system').map((m: any) => ({ role: m.role === 'tool' ? 'user' : m.role, content: typeof m.content === 'string' ? m.content : '' })),
});

beforeEach(async () => {
  db = await testDb();
  requests = []; numCtx = 24576; chatReply = () => ok({ content: 'ok' });
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'super_admin' })).id;
  await testVault(db, key);
});

describe('how big a request is', () => {
  it('sends a fraction of the full prompt to a local model with a small context', async () => {
    await configure({ prompt: 'full' });
    await turn({ inbound: 'Remind me tomorrow at 9 to call the dentist' });
    const full = sizeOf(requests[0]);
    requests = [];
    await configure({});
    await turn({ inbound: 'Remind me tomorrow at 9 to call the dentist' });
    const compact = sizeOf(requests[0]);
    console.log(`FULL    ${describePromptSize(full)}`);
    console.log(`COMPACT ${describePromptSize(compact)}; tools offered: ${requests[0].tools.map((t: any) => t.function.name).join(', ')}`);
    expect(full.total).toBeGreaterThan(9000);
    expect(compact.total).toBeLessThan(5000);
    // The reminder tools are there; the unrelated ones are not.
    const names = requests[0].tools.map((t: any) => t.function.name);
    expect(names).toContain('schedule_reminder');
    expect(names).not.toContain('workspace_propose_code');
    expect(names).not.toContain('my_world_secret_card');
  });

  it('stays compact for plain conversation, with a few everyday tools', async () => {
    await configure({});
    await turn({ inbound: 'hello there' });
    const size = sizeOf(requests[0]);
    console.log(`COMPACT plain ${describePromptSize(size)}; tools: ${requests[0].tools.map((t: any) => t.function.name).join(', ')}`);
    expect(size.total).toBeLessThan(2500);
  });

  it('uses the full prompt when the model server reports a large context', async () => {
    numCtx = 131072;
    await configure({});
    await turn();
    expect(requests[0].tools.length).toBeGreaterThan(30);
  });

  it('asks the model not to think unless the operator left it to the model', async () => {
    await configure({});
    await turn();
    expect(requests[0].reasoning_effort).toBe('none');
    requests = [];
    await configure({ thinking: 'model' });
    await turn();
    expect(requests[0].reasoning_effort).toBeUndefined();
  });
});

describe('a start that does not change', () => {
  it('keeps the instructions and tools byte for byte the same across requests, with the time at the end', async () => {
    await configure({});
    await turn({ inbound: 'hello there', now: new Date('2026-11-12T10:00:00Z') });
    await turn({ inbound: 'hello again', now: new Date('2026-11-13T18:30:00Z') });
    const [a, b] = requests;
    expect(a.messages[0].content).toBe(b.messages[0].content);
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    // Nothing about the date in the instructions; it rides on the last message.
    expect(a.messages[0].content).not.toMatch(/2026/);
    expect(a.messages.at(-1).content).toMatch(/\[Context from Josi/);
    expect(a.messages.at(-1).content).toMatch(/2026/);
    expect(a.messages.at(-1).content.startsWith('hello there')).toBe(true);
  });

  it('keeps earlier messages unchanged when the next one arrives', async () => {
    await configure({});
    const history = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}` }));
    await turn({ history, inbound: 'next' });
    await turn({ history: [...history, { role: 'user', content: 'next' }, { role: 'assistant', content: 'ok' }], inbound: 'and another' });
    const before = requests[0].messages.slice(0, 9);
    expect(requests[1].messages.slice(0, 9)).toEqual(before);
  });

  it('drops old history in blocks, not one message at a time', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: 'x'.repeat(400) }));
    const a = compactHistory(history);
    const b = compactHistory([...history, { role: 'user', content: 'x'.repeat(400) }, { role: 'assistant', content: 'x'.repeat(400) }]);
    expect(a.length).toBeLessThan(history.length);
    expect((history.length - a.length) % 6).toBe(0);
    expect(b[0]).toEqual(a[0] ?? b[0]);
  });
});

describe('picking tools by what was asked', () => {
  const all = TASK_TOOLS.map((t) => t.def);
  it('follows a follow-up back to the topic before it', () => {
    const picked = selectCompactTools(all, ['and the day after?', 'what reminders do I have tomorrow', '']).tools.map((t) => t.name);
    expect(picked).toContain('list_reminders');
  });
  it('goes by the person\'s words, not by the text of what they attached', async () => {
    await configure({});
    const ocr = 'Text read by OCR from the attached picture invoice.png. You were NOT shown the picture itself.\n\n[page 1, confidence 89%]\nINVOICE 2026-1184 open the browser page, run the program, connect the account, email the calendar file';
    await turn({ inbound: `What is the total due on this invoice?\n\n${ocr}`, readByOcr: ['invoice.png'] });
    const names = requests[0].tools.map((t: any) => t.function.name);
    expect(names.some((n: string) => /^(browser_|desktop_|pc_)/.test(n))).toBe(false);
    expect(sizeOf(requests[0]).total).toBeLessThan(2500);
  });
  it('keeps the browser, the desktop and the PC apart', () => {
    const names = (text: string) => selectCompactTools([
      { name: 'browser_open_page', description: '', parameters: {} }, { name: 'desktop_click', description: '', parameters: {} },
      { name: 'pc_run_command', description: '', parameters: {} }], [text]).tools.map((t) => t.name);
    expect(names('open example.com and read it')).toEqual(['browser_open_page']);
    expect(names('take a screenshot of the desktop')).toEqual(['desktop_click']);
    expect(names('run the command df -h on the server')).toEqual(['pc_run_command']);
    expect(names('what is on page 2?')).toEqual([]);
  });
  it('offers a tool the message names outright', () => {
    const picked = selectCompactTools(all, ['Please do this. E2E_TOOL:list_open_tasks:{}']).tools.map((t) => t.name);
    expect(picked).toContain('list_open_tasks');
  });
  it('keeps names, required fields and allowed values when it shortens a tool', () => {
    const picked = selectCompactTools(all, ['remind me']).tools.find((t) => t.name === 'schedule_reminder')!;
    const original = all.find((t) => t.name === 'schedule_reminder')!;
    expect(Object.keys((picked.parameters as any).properties)).toEqual(Object.keys((original.parameters as any).properties));
    expect((picked.parameters as any).required).toEqual((original.parameters as any).required);
    expect(JSON.stringify(picked).length).toBeLessThanOrEqual(JSON.stringify(original).length);
  });
});

describe('a request that does not fit', () => {
  it('reads both numbers out of the model server\'s answer', () => {
    expect(contextOverflow(JSON.stringify({ error: { message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 14700, n_ctx: 8192 } })))
      .toEqual({ contextTokens: 8192, requestTokens: 14700 });
    expect(contextOverflow(JSON.stringify({ error: { message: 'request exceeds the available context size', type: 'invalid_request_error' } })))
      .toEqual({ contextTokens: null, requestTokens: null });
    expect(contextOverflow(JSON.stringify({ error: { message: 'model not found', type: 'not_found' } }))).toBeNull();
  });

  it('tells the person the two sizes and what to do, not a generic failure', async () => {
    numCtx = null;
    await configure({ prompt: 'full' });
    chatReply = () => new Response(JSON.stringify({ error: { message: 'request exceeds the available context size', type: 'exceed_context_size_error', n_prompt_tokens: 14700, n_ctx: 8192 } }), { status: 400 });
    const result = await turn();
    expect(result.refusal?.reason).toBe('context_overflow');
    expect(result.refusal?.message).toMatch(/14,700 tokens/);
    expect(result.refusal?.message).toMatch(/8,192 tokens/);
    expect(result.refusal?.message).toMatch(/num_ctx/);
    expect(result.refusal?.message).toMatch(/compact prompt/);
    // And remembers the context the server named.
    const [row] = await db.query<{ settings: any }>('select settings from workspace where id = true');
    expect(row.settings.modelContext.tokens).toBe(8192);
  });

  it('does not send a request it already knows is too large', async () => {
    numCtx = 4096;
    await configure({ prompt: 'full' });
    const result = await turn();
    expect(result.refusal?.reason).toBe('context_overflow');
    expect(result.refusal?.message).toMatch(/4,096 tokens/);
    expect(requests).toHaveLength(0);
  });
});

describe('text read from a picture', () => {
  it('says so in the reply even when the model does not', async () => {
    await configure({});
    chatReply = () => ok({ content: 'The total due is $128.37.' });
    const result = await turn({ inbound: 'what is the total?\n\nText read by OCR from the attached picture invoice.png...', readByOcr: ['invoice.png'] });
    expect(result.reply).toMatch(/^I read the text in this image\./);
    expect(result.reply).toMatch(/128\.37/);
  });
});
