// End-to-end test of PC control on an installed headless Josi server, through
// real chat turns. Run e2e-fake.mjs first (it sets up the instance with a fake
// account and the fake model); then, as root on the Josi machine:
//
//   sudo /var/lib/josi/versions/<ver>/node/bin/node scripts/linux/e2e-pc.mjs
//
// The fake model calls exactly the tool each message names
// ("E2E_TOOL:<name>:<json>"), so every step goes model -> Josi -> PC Control
// -> josi-pc.service -> the machine, and back:
//
//  1. pc_get_permissions lists this server's PC service (linux-...), unpaired.
//  2. propose_josi_setting_change pc_control_enabled; the owner approves the
//     card with the password (what the web card does), which pairs the service.
//  3. The service announces itself; readiness is all green.
//  4. pc_environment: the chosen Linux user, shells, the hidden screen.
//  5. pc_run_command asks once; the owner allows it; uname runs as that user.
//  6. pc_write_file then pc_read_file in the user's home.
//  7. pc_terminal_open / input / read / close: state survives between inputs.
//  8. desktop_list_windows + desktop_screenshot of Josi's own Chrome.
//  9. browser_open_page https://example.com in Josi's Chrome, read back.
//
// Uses /root/josi-e2e-credentials.json from e2e-fake.mjs; prints no secret.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { FAKE_KEY, FAKE_MODEL, startFakeModel } from './e2e-fake-model.mjs';

if (process.platform !== 'linux' || process.getuid() !== 0) { console.error('Run as root on the Josi machine.'); process.exit(2); }
const ROOT = '/var/lib/josi', DATA = `${ROOT}/data`, CREDENTIALS = '/root/josi-e2e-credentials.json';
const runtime = JSON.parse(readFileSync(`${DATA}/config/runtime.json`, 'utf8'));
const BASE = `http://127.0.0.1:${runtime.publicPort}`;
const install = existsSync('/etc/josi/install.json') ? JSON.parse(readFileSync('/etc/josi/install.json', 'utf8')) : {};
const USER = install.pcControlUser;
const HOME = USER ? `/home/${USER}` : null;
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
async function req(method, path, body, expect) {
  const headers = { Accept: 'application/json', 'User-Agent': 'josi-e2e-pc/1' };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (jar.has('josi_csrf')) headers['x-josi-csrf'] = jar.get('josi_csrf');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim(); if (!v) jar.delete(k); else jar.set(k, v); }
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  if (expect && !(Array.isArray(expect) ? expect : [expect]).includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)?.slice(0, 400)}`);
  return { status: res.status, json };
}

const creds = JSON.parse(readFileSync(CREDENTIALS, 'utf8'));
const fake = await startFakeModel({ port: Number(process.env.E2E_FAKE_PORT ?? 18999) });
let thread;
/** One chat turn that makes the fake model call `tool` with `input`; returns
 * the tool's result as Josi gave it to the model. While the turn runs, the
 * test plays the owner: it allows any PC request waiting for approval, as
 * tapping Allow on the chat card does (password for high-risk ones). */
const approved = [];
async function call(tool, input) {
  const mark = fake.requests.length;
  const turn = req('POST', `/assistant/threads/${thread.id}/talk`, { message: `Please do this. E2E_TOOL:${tool}:${JSON.stringify(input)}`, attachmentIds: [] });
  let done = false; turn.finally(() => { done = true; });
  for (let i = 0; i < 600; i++) {
    // A picture rides after the tool message, so look for the last tool message, not the last message.
    const seen = fake.requests.slice(mark).map(r => (r.body?.messages ?? []).filter(m => m.role === 'tool')).find(ms => ms.length && ms.at(-1).tool_call_id && fake.requests.slice(mark).some(q => JSON.stringify(q.answer ?? '').includes(ms.at(-1).tool_call_id)));
    if (seen) { await turn.catch(() => {}); const content = seen.at(-1).content; const text = typeof content === 'string' ? content : JSON.stringify(content); try { return JSON.parse(text); } catch { return { raw: text }; } }
    if (done) { const r = await turn; throw new Error(`${tool}: the turn ended without a tool result: ${JSON.stringify(r.json).slice(0, 300)}`); }
    if (pcId) {
      const state = (await req('GET', `/admin/pc-control?pcId=${pcId}`)).json;
      for (const waiting of (state?.requests ?? []).filter(q => (q.state === undefined || q.state === 'pending') && !approved.includes(q.id))) {
        approved.push(waiting.id);
        await req('POST', `/admin/pc-control/requests/${waiting.id}/decision?pcId=${pcId}`, { approve: true, password: creds.password }, 200);
        log(`   (owner allowed: ${waiting.description})`);
      }
    }
    await sleep(500);
  }
  throw new Error(`no tool result for ${tool}`);
}
const unwrap = r => r?.result?.result ?? r?.result ?? r;
const settled = (tool, input) => call(tool, input);

let pcId;
try {
  await req('GET', '/auth/csrf', undefined, 200);
  const first = await req('POST', '/auth/login', { identifier: creds.username, password: creds.password }, [200, 202]);
  if (first.status === 202) await req('POST', '/auth/mfa/verify-login', { challenge: first.json.challenge, code: totp(creds.totpSecret) }, 200);
  const llm = JSON.stringify((await req('GET', '/admin/llm', undefined, 200)).json);
  assert(llm.includes(FAKE_MODEL), 'the fake model is not the active model; run e2e-fake.mjs first');
  thread = (await req('POST', '/assistant/threads', { title: 'E2E PC control' }, [200, 201])).json.thread;
  log(`signed in; thread ${thread.id}; PC control user ${USER ?? '(none)'}`);
} catch (error) { console.error('cannot start:', error.message); await fake.close?.(); process.exit(1); }

async function step(name, fn) { try { verdict(name, true, await fn()); } catch (error) { verdict(name, false, error.message); } }

await step('1 the server is listed for chat', async () => {
  const out = await call('pc_get_permissions', {});
  const device = (out.devices ?? []).find(d => d.pcId.startsWith('linux-'));
  assert(device, 'no linux- PC in ' + JSON.stringify(out.devices));
  pcId = device.pcId;
  return `${pcId} paired=${device.paired} enabled=${device.enabled}; readiness: ${out.readiness?.summary}`;
});
await step('2 one chat card turns control on and pairs the server', async () => {
  const out = await call('propose_josi_setting_change', { area: 'pc_control_enabled', summary: 'Let Josi work on this server.', params: { pcId }, body: { enabled: true } });
  const list = (await req('GET', '/settings-changes', undefined, 200)).json.proposals;
  const card = list.find(p => p.area === 'pc_control_enabled' && p.state === 'proposed' && p.canApprove);
  assert(card, 'no pc_control_enabled card: ' + JSON.stringify(out).slice(0, 200));
  await req('POST', `/settings-changes/${card.id}/pc-apply`, { password: creds.password }, 200);
  return `card ${card.id} approved with the password: "${card.summary.split('\n')[1] ?? card.summary}"`;
});
await step('3 the PC service pairs and announces itself', async () => {
  for (let i = 0; i < 40; i++) {
    const ready = (await req('GET', `/admin/pc-control/readiness?pcId=${pcId}`, undefined, 200)).json;
    if (ready.facts?.pcPresence?.ok) return `${ready.summary} (${Object.entries(ready.facts).map(([k, f]) => `${k}=${f.ok}`).join(', ')})`;
    await sleep(1000);
  }
  throw new Error('presence never came; journalctl -u josi-pc');
});
await step('4 pc_environment', async () => {
  const env = unwrap(await settled('pc_environment', { pc_id: pcId }));
  assert(env.kind === 'desktop_environment' && env.user === USER, 'unexpected environment: ' + JSON.stringify(env).slice(0, 300));
  return `user ${env.user}, home ${env.home}, ${env.os}, shells ${Object.keys(env.shells).join('/')}, desktop: ${env.desktop?.session}`;
});
await step('5 a command, approved once', async () => {
  const out = unwrap(await settled('pc_run_command', { command: 'uname -sr && id -un && pwd', working_folder: HOME, pc_id: pcId }));
  assert(out.kind === 'desktop_command' && out.exitCode === 0 && out.stdout.includes(USER), 'command result: ' + JSON.stringify(out).slice(0, 300));
  return `exit ${out.exitCode} in ${out.durationMs} ms: ${out.stdout.trim().replace(/\n/g, ' | ')}`;
});
await step('6 write and read a file', async () => {
  const path = `${HOME}/josi-e2e.txt`, text = `written by Josi at ${new Date().toISOString()}\n`;
  const wrote = unwrap(await settled('pc_write_file', { path, content: text, pc_id: pcId }));
  assert(wrote.kind === 'desktop_file_written', 'write: ' + JSON.stringify(wrote).slice(0, 300));
  const read = unwrap(await settled('pc_read_file', { path, pc_id: pcId }));
  assert(read.text === text, 'read back: ' + JSON.stringify(read).slice(0, 300));
  return `${path}: ${wrote.bytes} bytes written, read back identical (sha256 ${read.sha256.slice(0, 12)}…)`;
});
await step('7 a persistent terminal', async () => {
  const open = unwrap(await settled('pc_terminal_open', { working_folder: HOME, shell: 'bash', timeout_seconds: 120, pc_id: pcId }));
  assert(open.kind === 'desktop_terminal' && open.running, 'open: ' + JSON.stringify(open).slice(0, 300));
  const id = open.sessionId;
  await settled('pc_terminal_input', { session_id: id, text: 'export JOSI_E2E=kept\r', pc_id: pcId });
  const echo = unwrap(await settled('pc_terminal_input', { session_id: id, text: 'echo "value=$JOSI_E2E cols=$(tput cols)"\r', pc_id: pcId }));
  await sleep(500);
  const read = unwrap(await settled('pc_terminal_read', { session_id: id, cursor: 0, pc_id: pcId }));
  const all = (echo.output ?? '') + (read.output ?? '');
  await settled('pc_terminal_close', { session_id: id, pc_id: pcId });
  assert(all.includes('value=kept'), 'the variable did not survive: ' + all.slice(-300));
  return `bash pty: ${all.match(/value=kept cols=\d+/)?.[0]}`;
});
await step('8 windows and a screenshot of Josi\'s Chrome', async () => {
  const list = unwrap(await settled('desktop_list_windows', { pc_id: pcId }));
  const chrome = (list.windows ?? []).find(w => /chrom(e|ium)/i.test(w.application));
  assert(chrome, 'no Chrome window: ' + JSON.stringify(list).slice(0, 300));
  const shot = unwrap(await settled('desktop_screenshot', { window_id: chrome.windowId, application: chrome.application, pc_id: pcId }));
  assert(shot.kind === 'desktop_screenshot' && shot.width > 0, 'screenshot: ' + JSON.stringify(shot).slice(0, 300));
  return `${list.windows.length} window(s); "${chrome.title}" pictured at ${shot.width}x${shot.height}`;
});
await step('9 Josi\'s browser opens and reads a page', async () => {
  const out = await settled('browser_open_page', { url: 'https://example.com/' });
  const page = unwrap(out);
  assert(/example/i.test(JSON.stringify(page)), 'page: ' + JSON.stringify(out).slice(0, 400));
  return `title "${page.title}", ${page.url}, ${String(page.text ?? '').length} characters of text`;
});

await fake.close?.();
const failed = results.filter(r => !r.ok).length;
log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
