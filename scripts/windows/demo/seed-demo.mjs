// Puts the demo server into its known starting state: finishes first-run
// setup once, then (re)creates the demo account's conversations, folder,
// files and memories exactly as seed.json describes them.
//
//   node scripts/windows/demo/seed-demo.mjs <demoRoot> [--reset]
//
// Without --reset it seeds a fresh server. With --reset it first clears the
// demo account's content in the demo database (through the demo server's
// own Postgres on its own port), then seeds again. The server keeps running
// either way. Only the demo root is touched; the development server's data
// folder is never opened.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const root = resolve(process.argv[2] || process.env.JOSI_DEMO_ROOT || 'C:\\Dev\\josi-demo');
const reset = process.argv.includes('--reset');
const data = join(root, 'data');
const demoFile = join(root, 'demo.json');
const seedFile = process.env.JOSI_DEMO_SEED || join(here, 'seed.json');
const modelPort = Number(process.env.JOSI_DEMO_MODEL_PORT || 18090);

if (/josi-dev[\\/]?$/i.test(root)) { console.error(`refusing to seed ${root}: that is the development server, not the demo`); process.exit(2); }
if (!existsSync(join(data, 'config', 'runtime.json'))) { console.error(`no demo server in ${root}; run New-DemoServer.ps1 first`); process.exit(2); }

const runtime = JSON.parse(readFileSync(join(data, 'config', 'runtime.json'), 'utf8'));
const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
const api = `http://127.0.0.1:${runtime.apiPort}/api`;
const demo = existsSync(demoFile) ? JSON.parse(readFileSync(demoFile, 'utf8')) : {};
demo.version = 1;
demo.root = root; demo.dataDir = data; demo.apiPort = runtime.apiPort; demo.address = `http://localhost:${runtime.apiPort}`;
demo.modelPort = modelPort; demo.repo = repo; demo.node = process.execPath;
demo.account = demo.account ?? { identifier: seed.account.username, password: randomBytes(18).toString('base64url') };
const save = () => writeFileSync(demoFile, JSON.stringify(demo, null, 2) + '\n');
save();

const say = (line) => console.log(`[seed] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- HTTP client
// Setup runs in browser mode (cookies + CSRF); everything after sign-in is the
// native mode the Windows app uses (bearer session, x-josi-client: native).
const jar = new Map();
let csrf = null, bearer = null;
async function call(method, route, body, headers = {}) {
  const h = { accept: 'application/json', ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (bearer) { h['x-josi-client'] = 'native'; h.authorization = `Bearer ${bearer}`; }
  else {
    if (method !== 'GET') {
      if (!csrf) { const c = await call('GET', '/auth/csrf'); csrf = c.csrfToken; }
      h['x-josi-csrf'] = csrf;
    }
    // After the CSRF token, so the cookie it set travels with this request.
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  const res = await fetch(api + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  for (const line of res.headers.getSetCookie?.() ?? []) { const [pair] = line.split(';'); const at = pair.indexOf('='); if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim()); }
  const text = await res.text();
  let value = {}; try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
  if (!res.ok) { const err = new Error(`${method} ${route} -> ${res.status} ${value.error ?? text.slice(0, 200)}`); err.status = res.status; err.body = value; throw err; }
  return value;
}

async function waitForApi() {
  for (let i = 0; i < 120; i++) {
    try { return await call('GET', '/onboarding/state'); } catch { await sleep(500); }
  }
  throw new Error(`the demo API at ${api} did not answer; start it with Start-DemoServer.ps1`);
}

// --------------------------------------------------------------- setup once
async function finishSetup() {
  const bootstrap = JSON.parse(readFileSync(join(data, 'first-run', 'bootstrap.json'), 'utf8'));
  const launch = await call('POST', '/onboarding/launch', {}, { 'x-josi-setup-token': bootstrap.token });
  await call('POST', '/onboarding/consume', { token: launch.token });
  for (let i = 0; i < 24; i++) {
    const state = await call('GET', '/setup/state');
    if (state.completed) return;
    if (state.recoveryPending) { await call('POST', '/setup/vault-recovery-confirmed', {}); continue; }
    const step = state.nextStep ?? '';
    say(`setup step: ${step || 'complete'}`);
    switch (step) {
      case 'host_checks': await call('POST', '/setup/steps/host_checks', {}); break;
      case 'owner': {
        const r = await call('POST', '/setup/steps/owner', { displayName: seed.account.displayName, email: seed.account.email,
          username: seed.account.username, password: demo.account.password, timezone: seed.workspace.timezone });
        if (r.vaultRecovery) await call('POST', '/setup/vault-recovery-confirmed', {});
        break;
      }
      case 'domain': await call('POST', '/setup/steps/domain', { domain: 'localhost', tlsMode: 'external_proxy', acmeEmail: '' }); break;
      case 'llm': {
        await call('POST', '/setup/steps/llm', { provider: 'openai_compatible', model: 'josi-demo', baseUrl: `http://127.0.0.1:${modelPort}/v1` });
        const check = await call('POST', '/setup/verify/llm', {});
        if (check.status !== 'passed') throw new Error(`the replay model did not pass the capability check: ${check.detail ?? JSON.stringify(check)}. Is replay-model.mjs running on port ${modelPort}?`);
        break;
      }
      case 'smtp': await call('POST', '/setup/steps/smtp', { skip: true }); break;
      case 'security': await call('POST', '/setup/steps/security', { folderMappingEnabled: true }); break;
      case 'telemetry': await call('POST', '/setup/steps/telemetry', { enabled: false }); break;
      case 'review': await call('POST', '/setup/steps/review', {}); break;
      // The setup routes disappear once setup completes, so stop reading state here.
      case '': await call('POST', '/setup/complete', {}); return;
      default: throw new Error(`setup asks for a step this script does not know: ${step}`);
    }
  }
  throw new Error('setup did not finish');
}

// ------------------------------------------------------------ reset (SQL)
// Content tables that belong to the demo account. Each is cleared by its owner
// column when it has one; a table missing from this schema is skipped. Vault,
// sessions, persona, storage capability and model settings are kept on
// purpose: they are the account, not its content.
const CONTENT_TABLES = ['work_goal_effects', 'work_goal_events', 'work_goal_outcomes', 'work_goal_plans', 'work_goals', 'automation_work_tasks',
  'assistant_action_states', 'assistant_turn_effects', 'assistant_turns', 'turn_context', 'task_attempts', 'tasks', 'message_citations', 'messages',
  'thread_summaries', 'chat_attachment_usage', 'chat_attachments', 'threads', 'memories', 'memory_suggestions', 'memory_content_keys', 'reminders',
  'approvals', 'holds', 'settings_change_proposals', 'document_embeddings', 'document_segments', 'document_text', 'document_versions', 'documents',
  'processing_jobs', 'folder_mappings', 'calendar_event_links', 'calendar_events', 'contact_links', 'contacts', 'push_deliveries',
  'pc_control_requests', 'pc_control_results', 'pc_control_activity', 'pc_control_presence', 'assistant_insights', 'improvement_proposals',
  'llm_usage', 'workspace_coding_runs', 'workflow_runs', 'custom_api_pending_calls', 'email_attachments', 'email_participants', 'email_messages',
  'email_threads', 'email_sends', 'resource_shares', 'resource_locks'];
async function clearContent(userId) {
  const password = readFileSync(join(data, 'secrets', 'database-password'), 'utf8').trim();
  const sql = postgres({ host: '127.0.0.1', port: runtime.databasePort, username: 'josi', database: 'josi', password, max: 1, onnotice: () => {} });
  try {
    const columns = await sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`;
    const byTable = new Map();
    for (const row of columns) { if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set()); byTable.get(row.table_name).add(row.column_name); }
    let pending = CONTENT_TABLES.filter((t) => byTable.has(t));
    // Foreign keys between content tables decide the order; a delete that is
    // refused is tried again on the next pass once its dependants are gone.
    for (let pass = 0; pass < 6 && pending.length; pass++) {
      const next = [];
      for (const table of pending) {
        const cols = byTable.get(table);
        const column = cols.has('owner_user_id') ? 'owner_user_id' : cols.has('proposer_user_id') ? 'proposer_user_id' : cols.has('user_id') ? 'user_id' : null;
        try {
          if (column) await sql.unsafe(`delete from ${table} where ${column} = $1`, [userId]);
          else await sql.unsafe(`delete from ${table}`);
        } catch (error) { if (pass === 5) say(`could not clear ${table}: ${error.message}`); next.push(table); }
      }
      pending = next;
    }
    // Whole-server leftovers of the demo content.
    for (const table of ['job_queue', 'storage_roots']) if (byTable.has(table)) { try { await sql.unsafe(`delete from ${table}`); } catch (error) { say(`could not clear ${table}: ${error.message}`); } }
    if (byTable.has('pc_control_settings')) {
      const cols = byTable.get('pc_control_settings');
      const sets = ['enabled', 'full_control'].filter((c) => cols.has(c)).map((c) => `${c} = false`);
      if (sets.length) await sql.unsafe(`update pc_control_settings set ${sets.join(', ')}`);
    }
    if (byTable.has('pc_control_policies')) await sql.unsafe(`delete from pc_control_policies`);
    say('demo content cleared');
  } finally { await sql.end({ timeout: 5 }); }
}

// ------------------------------------------------------------------ seeding
async function signIn() {
  const result = await call('POST', '/auth/login', { identifier: demo.account.identifier, password: demo.account.password }, { 'x-josi-client': 'native' });
  if (!result.sessionToken) throw new Error('the demo sign-in returned no session');
  bearer = result.sessionToken;
  demo.userId = result.user.id;
  return result.user;
}

function writeSampleFiles() {
  const folder = join(root, 'sample-files');
  rmSync(folder, { recursive: true, force: true });
  for (const [name, text] of Object.entries(seed.folder.files)) {
    const file = join(folder, ...name.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  // Where the mail sink files every email Josi sends: empty after a reset.
  if (seed.mail) mkdirSync(join(folder, 'mail'), { recursive: true });
  return folder;
}

async function seedFolder(userId) {
  await call('PUT', `/storage/admin/capabilities/${userId}`, { mayMapLocal: true, mayMapCloud: true, mayIndex: true, maxBytes: null, maxFiles: null });
  const folder = writeSampleFiles();
  const existing = (await call('GET', '/storage/mappings')).mappings ?? [];
  for (const m of existing) { try { await call('DELETE', `/storage/mappings/${m.id}`); } catch { /* gone already */ } }
  const registered = await call('POST', '/storage/roots', { path: folder, label: seed.folder.label });
  const created = await call('POST', '/storage/mappings', { provider: 'local', rootId: registered.root.id, relativePath: '', recursive: true });
  const id = created.mapping.id;
  await call('PUT', `/storage/mappings/${id}/indexing`, { enabled: true });
  await call('POST', `/storage/mappings/${id}/sync`, {});
  const total = Object.keys(seed.folder.files).length;
  for (let i = 0; i < 120; i++) {
    const status = await call('GET', `/storage/mappings/${id}/status`);
    if ((status.byState?.indexed ?? 0) + (status.byState?.skipped ?? 0) >= total) { say(`folder indexed: ${status.byState?.indexed ?? 0} of ${total} files`); break; }
    await sleep(500);
  }
  demo.mappingId = id; demo.rootId = registered.root.id; demo.sampleFiles = folder;
}

async function seedMemories() {
  const saved = (await call('GET', '/persona/memories')).memories ?? [];
  for (const m of saved) { try { await call('DELETE', `/persona/memories/${m.id}`); } catch { /* keep going */ } }
  for (const content of seed.memories) await call('POST', '/persona/memories', { content });
  // "automatic": a fact told in a conversation is remembered without review, so a
  // "Remember that ..." beat shows up on the Memory page within the take.
  if (seed.memoryMode) await call('PUT', '/persona/settings', { memoryMode: seed.memoryMode });
  say(`${seed.memories.length} memories saved`);
}

// ---------------------------------------------------- the model in use
/** The primary model goes back to the replay model (a take may have switched
 * it to Ollama with --model). demo.json gets every configuration the app may
 * switch to, with the replay model's port filled in. */
async function seedModels() {
  const fill = (spec) => ({ ...spec, baseUrl: String(spec.baseUrl ?? '').replace('{modelPort}', String(modelPort)) });
  demo.models = Object.fromEntries(Object.entries(seed.models ?? {}).map(([name, spec]) => [name, fill(spec)]));
  const replay = demo.models.replay;
  if (!replay) return;
  const current = await call('GET', '/admin/llm');
  const primary = current.primary ?? {};
  if (primary.provider === replay.provider && primary.model === replay.model && (primary.baseUrl ?? '') === replay.baseUrl && primary.active) { say('primary model: replay (unchanged)'); return; }
  await call('PUT', '/admin/llm/providers/primary', { provider: replay.provider, model: replay.model, baseUrl: replay.baseUrl, externalAcknowledged: false });
  const probe = await call('POST', '/admin/llm/providers/primary/probe', {});
  if (!probe.provider?.active) throw new Error(`the replay model did not pass its capability check: ${probe.result?.fatal ?? 'see the server log'}`);
  say('primary model: replay (restored)');
}

// --------------------------------------------------------- mail server
/** The demo's mail server is the sink started by Start-DemoServer.ps1: every
 * message Josi sends lands as a file in the Demo Files folder. */
async function seedMail() {
  if (!seed.mail) return;
  const mailPort = Number(process.env.JOSI_DEMO_MAIL_PORT || demo.mailPort || 2525);
  const current = await call('GET', '/admin/mail/smtp');
  const profile = (copy) => ({ copyFromSystem: copy, host: copy ? '' : '127.0.0.1', port: mailPort, security: 'none', username: '', password: '', clearPassword: false,
    fromName: seed.mail.fromName, fromAddress: seed.mail.fromAddress });
  await call('PUT', '/admin/mail/smtp', { system: profile(false), communications: profile(true), expected: current.versions });
  say(`mail: every email goes to the sink on 127.0.0.1:${mailPort}`);
}

// ------------------------------------------------------------ calendar
/** A calendar kept on the demo server, with a week of events placed around
 * today so the Calendar page and the booking beat always show something. */
function zoned(dayOffset, hhmm, timezone) {
  // The civil time on that day in the workspace's zone, as an instant.
  const [hh, mm] = hhmm.split(':').map(Number);
  const day = new Date(); day.setUTCDate(day.getUTCDate() + dayOffset);
  const civil = `${day.toISOString().slice(0, 10)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
  const guess = new Date(civil + 'Z');
  const shown = new Date(guess.toLocaleString('en-US', { timeZone: timezone }));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() + (asUtc.getTime() - shown.getTime())).toISOString();
}
async function seedCalendar(userId) {
  if (!seed.calendar) return;
  const local = await call('POST', '/calendar/local', { name: seed.calendar.name });
  const password = readFileSync(join(data, 'secrets', 'database-password'), 'utf8').trim();
  const sql = postgres({ host: '127.0.0.1', port: runtime.databasePort, username: 'josi', database: 'josi', password, max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`delete from calendar_events where owner_user_id = $1 and calendar_id = $2`, [userId, local.calendarId]);
    for (const event of seed.calendar.events) {
      await sql.unsafe(`insert into calendar_events (owner_user_id, calendar_id, title, location, starts_at, ends_at, all_day, timezone, status, sync_state)
        values ($1, $2, $3, $4, $5, $6, false, $7, 'confirmed', 'synced')`,
        [userId, local.calendarId, event.title, event.location ?? null, zoned(event.day, event.start, seed.workspace.timezone), zoned(event.day, event.end, seed.workspace.timezone), seed.workspace.timezone]);
    }
  } finally { await sql.end({ timeout: 5 }); }
  demo.calendar = { sourceId: local.sourceId, calendarId: local.calendarId };
  say(`calendar "${seed.calendar.name}" with ${seed.calendar.events.length} events`);
}

// ----------------------------------------------- the administration pages
async function seedVault() {
  if (!seed.vault?.length) return;
  try {
    await call('POST', '/vault/unlock', { password: demo.account.password });
    const existing = (await call('GET', '/vault')).items ?? [];
    for (const item of seed.vault) {
      if (existing.some((e) => e.service === item.service && e.slot === item.slot)) continue;
      await call('POST', '/vault/items', item);
    }
    await call('PUT', '/vault/box/lock', { locked: true });
    say(`vault: ${seed.vault.length} records`);
  } catch (error) { say(`vault not seeded: ${error.message}`); }
}
async function seedPolicy() {
  for (const rule of seed.approvalPolicy ?? []) {
    try { await call('PUT', `/admin/assistant/approval-policy/${rule.actionClass}`, { maxLevel: rule.maxLevel, confirmRelaxation: true }); }
    catch (error) { say(`approval policy ${rule.actionClass} not set: ${error.message}`); }
  }
}
async function seedUsage(userId) {
  if (!seed.usage?.length) return;
  const password = readFileSync(join(data, 'secrets', 'database-password'), 'utf8').trim();
  const sql = postgres({ host: '127.0.0.1', port: runtime.databasePort, username: 'josi', database: 'josi', password, max: 1, onnotice: () => {} });
  try {
    for (const row of seed.usage) {
      await sql.unsafe(`insert into llm_usage (user_id, provider, model, role, input_tokens, output_tokens, cost_usd, cost_source, latency_ms, purpose, created_at)
        values ($1, 'openai_compatible', 'josi-demo', 'primary', $2, $3, 0, 'none', 850, $4, now() - make_interval(days => $5))`,
        [userId, row.inputTokens, row.outputTokens, row.purpose, row.daysAgo]);
    }
    say(`usage: ${seed.usage.length} model calls on record`);
  } finally { await sql.end({ timeout: 5 }); }
}
async function seedBackup() {
  if (!seed.backup) return;
  try {
    const existing = (await call('GET', '/ops/admin/backups')).backups ?? [];
    if (existing.some((b) => b.state === 'complete')) return;
    await call('POST', '/ops/admin/backups', { kind: 'portable', masterKeyConfirmed: true });
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const list = (await call('GET', '/ops/admin/backups')).backups ?? [];
      if (list.some((b) => b.state === 'complete')) { say('backups: one completed backup'); return; }
      if (list.some((b) => b.state === 'failed')) throw new Error('the backup failed; see the server log');
    }
    say('backups: still running; it will show once finished');
  } catch (error) { say(`backup not seeded: ${error.message}`); }
}

async function seedThreads() {
  demo.threads = [];
  for (const spec of seed.threads) {
    const thread = (await call('POST', '/assistant/threads', { title: spec.title })).thread;
    for (const message of spec.messages) {
      const clientMessageId = randomUUID();
      const accepted = await call('POST', `/assistant/threads/${thread.id}/turns`, { client_message_id: clientMessageId, message, attachment_receipts: [] }, { 'Idempotency-Key': clientMessageId });
      const turnId = accepted.turn.id;
      let status = 'queued';
      for (let i = 0; i < 240 && status !== 'completed' && status !== 'failed'; i++) {
        await sleep(500);
        const turns = (await call('GET', `/assistant/threads/${thread.id}/turns`)).turns ?? [];
        status = turns.find((t) => t.id === turnId)?.status ?? status;
      }
      if (status !== 'completed') throw new Error(`the reply in "${spec.title}" did not finish (status ${status}); check the worker log and the replay model`);
    }
    demo.threads.push({ id: thread.id, title: spec.title });
    say(`conversation seeded: ${spec.title}`);
  }
}

// --------------------------------------------------------------------- run
const state = await waitForApi();
if (!state.completed) { say('finishing first-run setup'); await finishSetup(); }
const user = await signIn();
say(`signed in as ${user.username}`);
if (reset) await clearContent(user.id);
await call('PATCH', '/admin/workspace', { name: seed.workspace.name, timezone: seed.workspace.timezone });
try { await call('PUT', '/admin/pc-control/enabled', { enabled: false }); } catch { /* PC control may be unavailable here */ }
await seedModels();
await seedMail();
await seedFolder(user.id);
await seedMemories();
await seedCalendar(user.id);
await seedThreads();
await seedVault();
await seedPolicy();
await seedUsage(user.id);
await seedBackup();
demo.seededAt = new Date().toISOString();
save();
say(`done. Demo state written to ${demoFile}`);
