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

// ------------------------------------------------------------ dates
// Replies and tool arguments may carry {{date:...}} tokens, filled in at reply
// time in the demo's time zone, so a booking lands in the week being shown:
//   {{date:+3 10:00}}   three days from today at 10:00, as an ISO instant
//   {{date:+1 00:00}}   tomorrow at midnight
//   {{date:+3 dddd}}    the weekday name of that day (Thursday)
//   {{date:+3 date}}    the calendar date (5 November)
const timezone = process.env.JOSI_DEMO_TZ || 'America/Los_Angeles';
function zonedInstant(dayOffset, hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const day = new Date(); day.setUTCDate(day.getUTCDate() + dayOffset);
  const civil = `${day.toISOString().slice(0, 10)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
  const guess = new Date(civil + 'Z');
  const shown = new Date(guess.toLocaleString('en-US', { timeZone: timezone }));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (asUtc.getTime() - shown.getTime()));
}
function fillDates(text) {
  return String(text).replace(/\{\{date:([+-]?\d+) ([^}]+)\}\}/g, (_, offset, what) => {
    const days = Number(offset);
    if (what === 'dddd') return zonedInstant(days, '12:00').toLocaleDateString('en-US', { weekday: 'long', timeZone: timezone });
    if (what === 'date') return zonedInstant(days, '12:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: timezone });
    return zonedInstant(days, what).toISOString();
  });
}
function fillDeep(value) {
  if (typeof value === 'string') return fillDates(value);
  if (Array.isArray(value)) return value.map(fillDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v)]));
  return value;
}

/** What Josi's memory learner should take from a "Remember that ..." turn: the
 * matching reply's `learn` entry gives a fact built from the person's words
 * (its quote must be a substring of the message, so it is the message itself). */
function learnAnswer(system, lastUserText) {
  const match = /the person's latest message:\s*([\s\S]+)$/i.exec(lastUserText || '');
  const message = (match ? match[1] : '').trim();
  if (!message) return null;
  const entry = pickReply(message, 0);
  if (!entry?.learn) return null;
  const found = new RegExp(entry.learn.pattern, 'i').exec(message);
  if (!found) return null;
  const fact = String(entry.learn.fact).replace(/\{\{(\d+)\}\}/g, (_, n) => found[Number(n)] ?? '');
  return { text: JSON.stringify({ facts: [{ fact, quote: found[0], confidence: 0.95 }], correction: null }) };
}

/** Josi's own background model calls (memory learning, conversation notes,
 * improvement review). Each gets a fixed, empty answer so the demo never
 * learns anything or proposes anything between takes, except a "Remember
 * that ..." turn whose reply carries a `learn` entry. */
function internalAnswer(body, system, lastUserText) {
  const s = norm(system);
  if (s.startsWith('you help an assistant called josi remember well')) return learnAnswer(system, lastUserText) ?? { text: '{"facts": [], "correction": null}' };
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
  const internal = internalAnswer(body, system, textOf(lastUser));
  if (internal) return { ...internal, delay: 0, id: 'internal' };

  // Josi re-asks when a reply sounds like an intention with no tool call ("You
  // described what you are about to do, but no tool ran..."). That is not the
  // person speaking: answer for the message before it, with its reply again.
  let userText = textOf(lastUser);
  let nudged = false;
  if (/^you described what you are about to do, but no tool ran/i.test(norm(userText)) && users.length >= 2) {
    userText = textOf(users[users.length - 2]); nudged = true;
  }
  const entry = pickReply(userText, users.length - (nudged ? 1 : 0));
  const delay = Math.max(0, Number(entry.delayMs ?? replay.delayMs ?? 0));
  const perCharacter = Math.max(0, Number(entry.perCharacterMs ?? replay.perCharacterMs ?? 0));
  if (entry.toolCalls && entry.toolCalls.length && !afterTools && !nudged) {
    return { toolCalls: fillDeep(entry.toolCalls), delay, id: entry.id ?? 'reply' };
  }
  // A reply may quote the person's own words through its `learn` pattern: {{1}} is the first group.
  let text = afterTools && entry.afterTools ? entry.afterTools : (entry.reply ?? replay.fallback ?? '');
  if (entry.learn) {
    const found = new RegExp(entry.learn.pattern, 'i').exec(userText);
    if (found) text = text.replace(/\{\{(\d+)\}\}/g, (_, n) => found[Number(n)] ?? '');
  }
  text = fillDates(text);
  return { text, delay: nudged ? 300 : delay + perCharacter * text.length, id: entry.id ?? 'reply' };
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
    if (picked.id === 'fallback') {
      // What nothing matched, so a replay entry can be written for it.
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = messages.filter((m) => m.role === 'user').pop();
      const system = messages.filter((m) => m.role === 'system').map(textOf).join(' ');
      log(`  fallback for user: ${JSON.stringify(textOf(lastUser).slice(0, 200))} | system: ${JSON.stringify(system.slice(0, 120))} | tools after user: ${messages.slice(messages.lastIndexOf(lastUser) + 1).filter((m) => m.role === 'tool').length}`);
    }
    setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(completion(body.model || 'josi-demo', picked)));
    }, picked.delay);
  });
});
server.listen(port, '127.0.0.1', () => log(`josi demo model on http://127.0.0.1:${port}/v1 (replay: ${replayFile})`));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
