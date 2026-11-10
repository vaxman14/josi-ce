// End-to-end test of "you sign in for Josi" on an installed server
// (docs/LIVE_SIGN_IN.md). Run after e2e-fake.mjs and e2e-pc.mjs (they leave the
// instance set up with the fake model and the PC service paired and on), as
// root on the Josi machine:
//
//   sudo /var/lib/josi/versions/<ver>/node/bin/node scripts/linux/e2e-signin.mjs
//
// The fake model calls request_sign_in; then this script plays the person:
//  1. browser: a card opens a live view of Josi's hidden Chrome; a real frame
//     arrives; the person navigates to a local login page, types a username
//     and a password, and presses Enter. The local site must receive exactly
//     what was typed, from the real Chrome, through xdotool.
//  2. terminal: a card runs a command with a visible and a silent prompt; the
//     person answers both; output and exit code come back.
//  3. the typed secrets appear nowhere on the server: not in the messages, the
//     proposals, the model's requests, or the service logs.
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { FAKE_MODEL, startFakeModel } from './e2e-fake-model.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0) { console.error('Run as root on the Josi machine.'); process.exit(2); }
const ROOT = '/var/lib/josi', DATA = `${ROOT}/data`, CREDENTIALS = '/root/josi-e2e-credentials.json';
const runtime = JSON.parse(readFileSync(`${DATA}/config/runtime.json`, 'utf8'));
const BASE = `http://127.0.0.1:${runtime.publicPort}`;
const SECRET_WEB = 'hunter2-web-secret', SECRET_TERM = 'topsecret9', USER = 'alice-e2e';
const results = [];
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const verdict = (step, ok, detail) => { results.push({ step, ok }); log(`\n[${ok ? 'PASS' : 'FAIL'}] ${step}: ${detail}`); };
const assert = (cond, message) => { if (!cond) throw new Error(message); };

function totp(secretBase32, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) { const v = alphabet.indexOf(ch); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest(), o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
const jar = new Map();
async function raw(method, path, body) {
  const headers = { Accept: '*/*', 'User-Agent': 'josi-e2e-signin/1' };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (jar.has('josi_csrf')) headers['x-josi-csrf'] = jar.get('josi_csrf');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim(); if (!v) jar.delete(k); else jar.set(k, v); }
  return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
}
const req = async (method, path, body, expect) => {
  const r = await raw(method, path, body);
  let json = null; try { json = JSON.parse(r.buffer.toString('utf8')); } catch { /* not json */ }
  if (expect && !(Array.isArray(expect) ? expect : [expect]).includes(r.status)) throw new Error(`${method} ${path} -> ${r.status} ${r.buffer.toString('utf8').slice(0, 300)}`);
  return { status: r.status, json };
};

const creds = JSON.parse(readFileSync(CREDENTIALS, 'utf8'));
const fake = await startFakeModel({ port: Number(process.env.E2E_FAKE_PORT ?? 18999) });
let thread;
async function call(tool, input) {
  const mark = fake.requests.length;
  const turn = req('POST', `/assistant/threads/${thread.id}/talk`, { message: `Please do this. E2E_TOOL:${tool}:${JSON.stringify(input)}`, attachmentIds: [] });
  for (let i = 0; i < 240; i++) {
    const seen = fake.requests.slice(mark).map(r => (r.body?.messages ?? []).filter(m => m.role === 'tool')).find(ms => ms.length && fake.requests.slice(mark).some(q => JSON.stringify(q.answer ?? '').includes(ms.at(-1).tool_call_id)));
    if (seen) { await turn.catch(() => {}); const c = seen.at(-1).content; const t = typeof c === 'string' ? c : JSON.stringify(c); try { return JSON.parse(t); } catch { return { raw: t }; } }
    await sleep(500);
  }
  throw new Error(`no tool result for ${tool}`);
}
async function cardFor(title) {
  const list = (await req('GET', '/settings-changes', undefined, 200)).json.proposals;
  const card = list.find(p => p.area === 'sign_in_card' && p.state === 'proposed' && p.title === title);
  assert(card, `no open sign-in card titled ${title}`);
  assert(card.card?.kind === 'sign_in' && card.canApprove, 'the card is not shaped for the app');
  return card;
}
async function pollOutput(id, until, ms = 30000) {
  let cursor = 0, text = '', last = null; const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = (await req('GET', `/live-signin/sessions/${id}/output?after=${cursor}&wait=2000`, undefined, 200)).json;
    cursor = r.cursor; text += r.data; last = r;
    if (until(text, r)) return { text, last };
  }
  throw new Error('the terminal never showed what was expected; saw: ' + JSON.stringify(text.slice(-300)));
}
async function frame(id, after, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await raw('GET', `/live-signin/sessions/${id}/frame?after=${after}&wait=3000`);
    if (r.status === 200) return { seq: Number(r.headers.get('x-frame-seq')), width: Number(r.headers.get('x-frame-width')), height: Number(r.headers.get('x-frame-height')), jpeg: r.buffer };
    if (r.status === 410) throw new Error('the session ended: ' + r.buffer.toString('utf8').slice(0, 200));
  }
  throw new Error('no new picture within ' + ms + ' ms');
}

// A local login page the real Chrome can reach.
const received = [];
const site = createServer((request, response) => {
  if (request.method === 'POST') {
    let body = ''; request.on('data', d => { body += d; });
    request.on('end', () => { received.push(Object.fromEntries(new URLSearchParams(body))); response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>Signed in</h1>'); });
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>E2E login</title><body style="font:28px sans-serif"><h1>E2E login</h1><form method="post"><input name="user" autofocus placeholder="user"><br><input name="pass" type="password" placeholder="password"><br><button>Sign in</button></form></body>');
  }
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}/login`;

try {
  await req('GET', '/auth/csrf', undefined, 200);
  const first = await req('POST', '/auth/login', { identifier: creds.username, password: creds.password }, [200, 202]);
  if (first.status === 202) await req('POST', '/auth/mfa/verify-login', { challenge: first.json.challenge, code: totp(creds.totpSecret) }, 200);
  assert(JSON.stringify((await req('GET', '/admin/llm', undefined, 200)).json).includes(FAKE_MODEL), 'the fake model is not active; run e2e-fake.mjs first');
  thread = (await req('POST', '/assistant/threads', { title: 'E2E sign-in' }, [200, 201])).json.thread;
  const pcs = (await req('GET', '/admin/pc-control/local', undefined, 200)).json;
  assert(pcs.executors?.[0]?.connected, 'the PC service is not connected; run e2e-pc.mjs first');
} catch (error) { console.error('cannot start:', error.message); process.exit(1); }

async function step(name, fn) { try { verdict(name, true, await fn()); } catch (error) { verdict(name, false, error.message); } }

await step('1 a browser card opens a live view of Josi\'s own Chrome', async () => {
  const out = await call('request_sign_in', { mode: 'browser', title: 'Local test site', why: 'to prove the live view works' });
  assert(out.ok && out.state === 'card_open', 'tool answered ' + JSON.stringify(out).slice(0, 300));
  const card = await cardFor('Local test site');
  const opened = (await req('POST', '/live-signin/sessions', { cardId: card.id }, 200)).json;
  assert(opened.kind === 'browser', 'wrong session kind');
  globalThis.SESSION = opened.id;
  const picture = await frame(opened.id, 0, 30000);
  assert(picture.jpeg[0] === 0xff && picture.jpeg[1] === 0xd8, 'the first picture is not a JPEG');
  assert(picture.width > 200 && picture.height > 200, 'the picture has no size');
  return `first picture ${picture.width}x${picture.height}, ${picture.jpeg.length} bytes`;
});

await step('2 the person types a login into the real Chrome through the live view', async () => {
  const id = globalThis.SESSION;
  let seq = (await frame(id, 0)).seq;
  const send = events => req('POST', `/live-signin/sessions/${id}/input`, { events }, 200);
  // Focus Josi's Chrome, open the page by its address bar, then type into the form.
  await send([{ t: 'click', x: 300, y: 5 }]);
  await sleep(300);
  await send([{ t: 'key', key: 'ctrl+l' }]); await sleep(300);
  await send([{ t: 'text', text: SITE }, { t: 'key', key: 'Return' }]);
  const changed = await frame(id, seq, 20000); seq = changed.seq;
  await sleep(2500);
  await send([{ t: 'text', text: USER }, { t: 'key', key: 'Tab' }, { t: 'text', text: SECRET_WEB }, { t: 'key', key: 'Return' }]);
  for (let i = 0; i < 40 && !received.length; i++) await sleep(500);
  assert(received.length === 1, 'the site received nothing');
  assert(received[0].user === USER && received[0].pass === SECRET_WEB, 'the site received ' + JSON.stringify(received[0]));
  return `the local site received the username and password typed through the view (${received.length} POST)`;
});

await step('3 Done settles the card and leaves one note for Josi', async () => {
  const id = globalThis.SESSION;
  await req('POST', `/live-signin/sessions/${id}/end`, { outcome: 'done' }, 200);
  const list = (await req('GET', '/settings-changes', undefined, 200)).json.proposals;
  assert(!list.some(p => p.area === 'sign_in_card' && p.title === 'Local test site' && p.state === 'proposed'), 'the card is still open');
  const history = (await req('GET', `/assistant/threads/${thread.id}?recent=1`, undefined, 200)).json.messages;
  const note = history.filter(m => m.direction === 'out').map(m => m.body).find(b => /finished the sign-in "Local test site"/.test(b));
  assert(note, 'no note in the thread');
  assert((await raw('GET', `/live-signin/sessions/${id}/frame?after=0&wait=0`)).status === 410, 'the session is still readable');
  return 'card applied, note written, session gone';
});

await step('4 a terminal card runs the exact command and takes the person\'s answers', async () => {
  const command = 'read -p "name: " n; read -sp "secret: " s; echo; echo "len=${#s} name=$n"; exit 3';
  const out = await call('request_sign_in', { mode: 'terminal', title: 'Local test login', why: 'to prove the login terminal works', command });
  assert(out.ok, 'tool answered ' + JSON.stringify(out).slice(0, 300));
  const card = await cardFor('Local test login');
  assert(card.card.command === command && card.card.runAs, 'the card must show the exact command and who it runs as');
  const session = (await req('POST', '/live-signin/sessions', { cardId: card.id }, 200)).json;
  const send = events => req('POST', `/live-signin/sessions/${session.id}/input`, { events }, 200);
  await pollOutput(session.id, t => t.includes('name: '));
  await send([{ t: 'resize', cols: 100, rows: 30 }, { t: 'data', data: 'bob\r' }]);
  await pollOutput(session.id, t => t.includes('secret: '));
  await send([{ t: 'data', data: SECRET_TERM + '\r' }]);
  const done = await pollOutput(session.id, (t, r) => t.includes('len=') && r.running === false);
  assert(done.text.includes(`len=${SECRET_TERM.length} name=bob`), 'unexpected output ' + JSON.stringify(done.text.slice(-200)));
  assert(done.last.exitCode === 3, 'exit code ' + done.last.exitCode);
  assert(!done.text.includes(SECRET_TERM), 'the silent prompt echoed the secret');
  await req('POST', `/live-signin/sessions/${session.id}/end`, { outcome: 'done' }, 200);
  return `the command ran as ${card.card.runAs}, both prompts were answered, exit code 3`;
});

await step('5 what was typed is nowhere on the server', async () => {
  const sql = `select (select count(*) from messages where body like '%${SECRET_WEB}%' or body like '%${SECRET_TERM}%') + (select count(*) from settings_change_proposals where body::text like '%${SECRET_WEB}%' or body::text like '%${SECRET_TERM}%' or summary like '%${SECRET_WEB}%')`;
  const psql = `${ROOT}/versions/${JSON.parse(readFileSync(`${ROOT}/status.json`, 'utf8')).version}/postgresql/bin/psql`;
  const password = readFileSync(`${DATA}/secrets/web/database-password`, 'utf8').trim();
  const hits = Number(execFileSync(psql, ['-h', '127.0.0.1', '-p', String(runtime.databasePort), '-U', 'josi', '-d', 'josi', '-t', '-A', '-c', sql],
    { env: { PGPASSWORD: password, LD_LIBRARY_PATH: `${ROOT}/versions/${JSON.parse(readFileSync(`${ROOT}/status.json`, 'utf8')).version}/postgresql/lib` }, encoding: 'utf8' }).trim());
  assert(hits === 0, `${hits} database rows contain a typed secret`);
  const requests = JSON.stringify(fake.requests.map(r => r.body));
  assert(!requests.includes(SECRET_WEB) && !requests.includes(SECRET_TERM), 'a typed secret reached the model');
  const logs = execFileSync('journalctl', ['--no-pager', '--since', '-30min', '-o', 'cat'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert(!logs.includes(SECRET_WEB) && !logs.includes(SECRET_TERM), 'a typed secret is in the service logs');
  return 'not in the database, the model\'s requests or the service logs';
});

site.close(); await fake.close?.();
const failed = results.filter(r => !r.ok).length;
log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
