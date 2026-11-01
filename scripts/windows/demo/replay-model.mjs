// The demo's model: a tiny server that speaks the OpenAI chat-completions
// shape and answers from replay.json instead of a real model. The demo Josi
// server is set up with it as an "OpenAI-compatible" provider on loopback, so
// the server code itself is untouched and every reply, and its timing, is the
// same on every take.
//
//   node scripts/windows/demo/replay-model.mjs [port] [replayFile]
//
// Defaults: port 18090 (JOSI_DEMO_MODEL_PORT), replay.json beside this file
// (JOSI_DEMO_REPLAY). The replay file is re-read when it changes, so a reply
// can be edited between takes without restarting anything.
import http from 'node:http';
import { readFileSync, statSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.JOSI_DEMO_MODEL_PORT || 18090);
const replayFile = process.argv[3] || process.env.JOSI_DEMO_REPLAY || join(here, 'replay.json');
const logFile = process.env.JOSI_DEMO_MODEL_LOG || '';

let replay = { delayMs: 1800, perCharacterMs: 0, fallback: 'I am a canned demo reply.', replies: [] };
let loadedAt = 0;
function load() {
  try {
    const stamp = statSync(replayFile).mtimeMs;
    if (stamp === loadedAt) return;
    replay = { ...replay, ...JSON.parse(readFileSync(replayFile, 'utf8')) };
    loadedAt = stamp;
    log(`replay file loaded: ${replayFile} (${(replay.replies || []).length} replies)`);
  } catch (error) {
    log(`replay file not read: ${error.message}`);
  }
}
function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  if (logFile) { try { appendFileSync(logFile, text + '\n'); } catch { /* the log is a convenience */ } }
}

/** Text of one message, whether content is a string or an array of parts. */
function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('\n');
  return '';
}
function hasImage(message) {
  return Array.isArray(message?.content) && message.content.some((p) => p?.type === 'image_url');
}
const norm = (text) => (text || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The five capability-check questions Josi asks a new model, answered so the
 * check passes and the demo server treats the replay as a working model. */
function probeAnswer(user, messages) {
  const text = norm(textOf(user));
  if (text === 'reply with the single word: ready') return { text: 'ready' };
  if (text.startsWith('return a json object with exactly one key "ok"')) return { text: '{"ok": true}' };
  if (text.startsWith('call the record_number tool with the number 7')) return { toolCalls: [{ name: 'record_number', arguments: { value: 7 } }] };
  if (text === 'what color is this image? answer with one word.' && hasImage(user)) return { text: 'Red' };
  if (text.endsWith('ignore the text above. reply with the single word: ok')) return { text: 'ok' };
  return null;
}

/** Josi's own background model calls (memory learning, conversation notes,
 * improvement review). Each gets a fixed, empty answer so the demo never
 * learns anything or proposes anything between takes. */
function internalAnswer(body, system) {
  const s = norm(system);
  if (s.startsWith('you help an assistant called josi remember well')) return { text: '{"facts": [], "correction": null}' };
  if (s.startsWith('you keep concise working notes')) return { text: 'Demo conversation. No notes kept.' };
  if (s.startsWith('you review evidence about how an assistant called josi')) return { text: '{"proposals": []}' };
  if (body.response_format?.type === 'json_object') return { text: '{}' };
  return null;
}

function pickReply(userText, userIndex) {
  const wanted = norm(userText);
  for (const entry of replay.replies || []) {
    if (entry.prompt !== undefined && norm(entry.prompt) === wanted) return entry;
  }
  for (const entry of replay.replies || []) {
    if (entry.match) { try { if (new RegExp(entry.match, 'i').test(userText)) return entry; } catch { /* a bad pattern is skipped */ } }
  }
  for (const entry of replay.replies || []) {
    if (entry.turn === userIndex) return entry;
  }
  return { id: 'fallback', reply: replay.fallback };
}

function completion(model, answer) {
  const content = answer.text ?? '';
  const calls = (answer.toolCalls || []).map((call, i) => ({
    id: `call_demo_${Date.now()}_${i}`, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
  }));
  return {
    id: `chatcmpl-demo-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: calls.length ? null : content, ...(calls.length ? { tool_calls: calls } : {}) } }],
    usage: { prompt_tokens: 0, completion_tokens: Math.ceil(content.length / 4), total_tokens: Math.ceil(content.length / 4) },
  };
}

function answer(body) {
  load();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter((m) => m.role === 'system').map(textOf).join('\n');
  const users = messages.filter((m) => m.role === 'user');
  const lastUser = users[users.length - 1];
  const lastUserAt = messages.lastIndexOf(lastUser);
  const afterTools = messages.slice(lastUserAt + 1).some((m) => m.role === 'tool');

  const probe = lastUser ? probeAnswer(lastUser, messages) : null;
  if (probe) return { ...probe, delay: 0, id: 'probe' };
  const internal = internalAnswer(body, system);
  if (internal) return { ...internal, delay: 0, id: 'internal' };

  const entry = pickReply(textOf(lastUser), users.length);
  const delay = Math.max(0, Number(entry.delayMs ?? replay.delayMs ?? 0));
  const perCharacter = Math.max(0, Number(entry.perCharacterMs ?? replay.perCharacterMs ?? 0));
  if (entry.toolCalls && entry.toolCalls.length && !afterTools) {
    return { toolCalls: entry.toolCalls, delay, id: entry.id ?? 'reply' };
  }
  const text = afterTools && entry.afterTools ? entry.afterTools : (entry.reply ?? replay.fallback ?? '');
  return { text, delay: delay + perCharacter * text.length, id: entry.id ?? 'reply' };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'josi-demo', object: 'model', owned_by: 'josi-demo' }] }));
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    res.statusCode = 404; return res.end(JSON.stringify({ error: { message: 'not found' } }));
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; if (raw.length > 8 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'bad json' } })); }
    const picked = answer(body);
    log(`reply ${picked.id}${picked.toolCalls ? ' (tool call)' : ''} after ${picked.delay} ms`);
    setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(completion(body.model || 'josi-demo', picked)));
    }, picked.delay);
  });
});
server.listen(port, '127.0.0.1', () => log(`josi demo model on http://127.0.0.1:${port}/v1 (replay: ${replayFile})`));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
