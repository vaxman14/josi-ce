// A fake model backend for the Josi Linux end-to-end test. Loopback only, fake
// key, no vendor reached. It speaks just enough of three wire formats:
//
//   * OpenAI chat completions (Josi's `openai_compatible` provider)  /v1/chat/completions
//   * Anthropic Messages, streaming and not (Claude Code CLI)          /v1/messages
//   * OpenAI Responses, streaming (Codex CLI)                          /v1/responses
//
// One small "brain" decides the answer for all three, so every path is held to
// the same behaviour: when a tool is offered and the prompt asks for one, it
// answers with a tool call; when a tool result comes back it says so, quoting
// the result. Every request is recorded so the test can assert on what Josi
// (or the CLI) actually sent.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export const FAKE_MODEL = 'E2E fake model';
export const FAKE_KEY = 'sk-e2e-fake-key-not-a-real-credential';
export const TOOL_MARKER = 'E2E_CALL_TOOL';
export const RESULT_MARKER = 'E2E_TOOL_RESULT_SEEN';
// Real Josi tools that are read-only and need no arguments, best first.
const PREFERRED_TOOLS = ['list_open_tasks', 'list_reminders', 'list_task_types', 'get_provider_status',
  'list_josi_settings', 'josi_health'];

const text = (v) => typeof v === 'string' ? v : Array.isArray(v)
  ? v.map((p) => typeof p === 'string' ? p : (p?.text ?? (typeof p?.content === 'string' ? p.content : ''))).join('\n') : '';

/** Normalise a request of any of the three dialects. */
function normalise(api, body) {
  const out = { api, tools: [], toolResults: [], hasImage: false, prompt: '', jsonMode: false };
  if (api === 'chat') {
    out.tools = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean);
    out.jsonMode = !!body.response_format;
    for (const m of body.messages ?? []) {
      if (m.role === 'tool') out.toolResults.push({ id: m.tool_call_id, content: text(m.content) });
      if (Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')) out.hasImage = true;
      // A new user turn starts over: earlier turns' tool results are history.
      if (m.role === 'user') { out.prompt = text(m.content); out.toolResults = []; }
    }
  } else if (api === 'messages') {
    out.tools = (body.tools ?? []).map((t) => t.name).filter(Boolean);
    for (const m of body.messages ?? []) {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      for (const b of blocks) {
        if (b.type === 'tool_result') out.toolResults.push({ id: b.tool_use_id, content: text(b.content) });
        if (b.type === 'image') out.hasImage = true;
      }
      if (m.role === 'user') {
        const t = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        if (t) out.prompt = t;
      }
    }
  } else {
    // Codex 0.152 groups MCP tools as {type:'namespace', name:'mcp__josi', tools:[...]}.
    const walk = (tools) => tools.flatMap((t) => t.type === 'namespace'
      ? walk(t.tools ?? []).map((n) => `${t.name}${t.name.endsWith('_') ? '' : '__'}${n}`) : [t.name]);
    out.tools = walk(body.tools ?? []).filter(Boolean);
    const input = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : (body.input ?? []);
    for (const item of input) {
      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        out.toolResults.push({ id: item.call_id, content: text(item.output) });
      }
      if (item.type === 'message' || item.role) {
        const parts = Array.isArray(item.content) ? item.content : [{ type: 'input_text', text: item.content }];
        if (parts.some((p) => p.type === 'input_image')) out.hasImage = true;
        if (item.role === 'user') {
          const t = parts.filter((p) => p.type === 'input_text' || p.type === 'text').map((p) => p.text).join('\n');
          if (t) out.prompt = t;
        }
      }
    }
  }
  return out;
}

/** The decision: a tool call or a text answer. */
function decide(n) {
  if (n.toolResults.length) {
    const last = n.toolResults.at(-1);
    return { text: `${RESULT_MARKER}: ${last.content.slice(0, 300)}` };
  }
  const find = (name) => n.tools.find((t) => t === name || t.endsWith(`__${name}`) || t.endsWith(`_${name}`));
  // "E2E_TOOL:<name>:<json input>" asks for one exact tool call (scripts/linux/e2e-pc.mjs).
  const exact = /E2E_TOOL:([a-z_]+):(\{.*\})\s*$/s.exec(n.prompt);
  if (exact) {
    const hit = find(exact[1]);
    if (!hit) return { text: `E2E_TOOL_NOT_OFFERED ${exact[1]}; offered: ${n.tools.join(',')}` };
    return { tool: { name: hit, input: JSON.parse(exact[2]) } };
  }
  if (/record_number/.test(n.prompt) && find('record_number')) {
    return { tool: { name: find('record_number'), input: { value: 7 } } };
  }
  if (n.prompt.includes(TOOL_MARKER) && n.tools.length) {
    for (const want of PREFERRED_TOOLS) {
      const hit = find(want);
      if (hit) return { tool: { name: hit, input: want === 'josi_health' ? { message: 'e2e' } : {} } };
    }
  }
  if (n.hasImage) return { text: 'red' };
  if (n.jsonMode || /JSON object with exactly one key "ok"/.test(n.prompt)) return { text: '{"ok": true}' };
  if (/single word: ready/.test(n.prompt)) return { text: 'ready' };
  if (/single word: ok/.test(n.prompt)) return { text: 'ok' };
  return { text: 'Hello from the E2E fake model.' };
}

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  return (event, data) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}

function answerChat(res, body, d) {
  const id = `chatcmpl-${randomUUID()}`;
  const call = d.tool ? { id: `call_${randomUUID().slice(0, 8)}`, type: 'function',
    function: { name: d.tool.name, arguments: JSON.stringify(d.tool.input) } } : null;
  const message = { role: 'assistant', content: d.text ?? null, ...(call ? { tool_calls: [call] } : {}) };
  const finish = call ? 'tool_calls' : 'stop';
  if (body.stream) {
    const send = sse(res);
    send(null, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant',
      ...(d.text ? { content: d.text } : {}), ...(call ? { tool_calls: [{ index: 0, ...call }] } : {}) }, finish_reason: null }] });
    send(null, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    res.end('data: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  }
  return call ? { toolCallId: call.id } : {};
}

function answerMessages(res, body, d) {
  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const block = d.tool ? { type: 'tool_use', id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`, name: d.tool.name, input: d.tool.input }
    : { type: 'text', text: d.text };
  const stop = d.tool ? 'tool_use' : 'end_turn';
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (body.stream) {
    const send = sse(res);
    send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
    if (d.tool) {
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(d.tool.input) } });
    } else {
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d.text } });
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [block],
      stop_reason: stop, stop_sequence: null, usage }));
  }
  return d.tool ? { toolCallId: block.id } : {};
}

function answerResponses(res, body, d) {
  const id = `resp_${randomUUID().replace(/-/g, '')}`;
  const item = d.tool
    ? { type: 'function_call', id: `fc_${randomUUID().slice(0, 8)}`, call_id: `call_${randomUUID().slice(0, 8)}`,
      name: d.tool.name, arguments: JSON.stringify(d.tool.input), status: 'completed' }
    : { type: 'message', id: `msg_${randomUUID().slice(0, 8)}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: d.text, annotations: [] }] };
  // A namespaced tool comes back as name + namespace, as Codex sent it.
  if (d.tool && (body.tools ?? []).some((t) => t.type === 'namespace')) {
    for (const ns of body.tools.filter((t) => t.type === 'namespace')) {
      if (d.tool.name.startsWith(ns.name)) { item.namespace = ns.name; item.name = d.tool.name.slice(ns.name.length).replace(/^__/, ''); }
    }
  }
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };
  const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'completed' };
  if (body.stream === false) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...response, output: [item], usage }));
  } else {
    const send = sse(res);
    send('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    send('response.output_item.added', { type: 'response.output_item.added', output_index: 0,
      item: d.tool ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } });
    if (!d.tool) {
      send('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: d.text });
    }
    send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
    send('response.completed', { type: 'response.completed', response: { ...response, output: [item], usage } });
    res.end();
  }
  return d.tool ? { toolCallId: item.call_id } : {};
}

/** Start the server. Resolves to { url, requests, close }. */
export function startFakeModel({ port = 0, host = '127.0.0.1', log = () => {} } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    // E2E_MODEL_DELAY_MS makes the model slow, so a test can watch the live status.
    req.on('end', () => setTimeout(() => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unparsed: raw.slice(0, 200) }; }
      const path = (req.url ?? '').split('?')[0].replace(/^\/v1(?=\/)/, '');
      const auth = req.headers.authorization ?? req.headers['x-api-key'] ?? '';
      const record = { at: new Date().toISOString(), method: req.method, path, url: req.url,
        userAgent: req.headers['user-agent'] ?? '', authorized: String(auth).includes(FAKE_KEY), body };
      requests.push(record);
      try {
        if (req.method === 'GET' && path === '/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model', owned_by: 'e2e' }],
            models: [{ slug: FAKE_MODEL, id: FAKE_MODEL }] }));
          return;
        }
        if (!record.authorized && req.method === 'POST') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'authentication_error', code: 'invalid_api_key', message: 'fake key required' } }));
          return;
        }
        if (req.method === 'POST' && path === '/messages/count_tokens') {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":10}'); return;
        }
        const api = path === '/chat/completions' ? 'chat' : path === '/messages' ? 'messages' : path === '/responses' ? 'responses' : null;
        if (req.method !== 'POST' || !api) {
          res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"not_found"}}'); return;
        }
        const n = normalise(api, body);
        const d = decide(n);
        record.seen = { api, tools: n.tools, toolResults: n.toolResults, hasImage: n.hasImage, prompt: n.prompt.slice(-200) };
        record.answer = d;
        const extra = api === 'chat' ? answerChat(res, body, d) : api === 'messages' ? answerMessages(res, body, d) : answerResponses(res, body, d);
        Object.assign(record.answer, extra);
        log(`[fake-model] ${api} tools=${n.tools.length} results=${n.toolResults.length} -> ${d.tool ? `tool ${d.tool.name}` : JSON.stringify(d.text.slice(0, 60))}`);
      } catch (error) {
        record.error = String(error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    }, Number(process.env.E2E_MODEL_DELAY_MS ?? 0)));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      resolve({ url: `http://${host}:${actual}`, port: actual, requests,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }) });
    });
  });
}

// Standalone: `node e2e-fake-model.mjs [port]` for manual poking.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeModel({ port: Number(process.argv[2] ?? 18999), log: console.log });
  console.log(`fake model listening on ${fake.url}`);
}
