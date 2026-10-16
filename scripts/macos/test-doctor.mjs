// Authenticated checks through the real packaged native API in an isolated
// lifecycle fixture. Never reads or changes the installed server or its users.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = process.argv[2];
assert(root?.startsWith(`/private/tmp/josi-ce-native-tests-${process.getuid()}/`));
assert.equal(JSON.parse(readFileSync(join(root, 'data/isolated-test.json'))).purpose, 'disposable-native-acceptance');
const program = resolve(dirname(process.execPath), '../..');
const require = createRequire(join(program, 'app/package.json'));
const postgres = require('postgres');
const cfg = JSON.parse(readFileSync(join(root, 'data/config/runtime.json')));
const sql = postgres({ host: '127.0.0.1', port: cfg.databasePort, username: 'josi', database: 'josi',
  password: readFileSync(join(root, 'data/secrets/web/database-password'), 'utf8'), max: 1, onnotice: () => {} });
const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');
const base = `http://localhost:${cfg.publicPort}`;
let cookie = `josi_session=${token}`;
let originalSetup;
try {
  const [owner] = await sql`select id from users where email='native-workspace@example.test'`;
  assert(owner, 'Workspace fixture owner must exist first');
  [originalSetup] = await sql`select completed,current_step,completed_at from setup_state where id=true`;
  await sql`update setup_state set completed=true,current_step='done',completed_at=now() where id=true`;
  await sql`insert into sessions(user_id,token_hash,expires_at) values(${owner.id},${tokenHash},now()+interval '5 minutes')`;
  const csrf = await fetch(base + '/api/auth/csrf', { headers: { cookie } });
  const { csrfToken } = await csrf.json();
  cookie += '; ' + csrf.headers.get('set-cookie').split(';')[0];
  // Model an owner who already completed the first-run checklist visit, as in
  // the reported session. Otherwise /app intentionally redirects to it once.
  assert.equal((await fetch(base + '/api/admin/launch-checklist/seen', { method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-josi-csrf': csrfToken }, body: '{}' })).status, 200);
  async function call(path, body) {
    const response = await fetch(base + '/api/admin/doctor' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-josi-csrf': csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  // Reproduce an installer selection that exists before registration succeeds.
  // Only this marked fixture's records are changed; its real service probes
  // and the production authenticated routes must create the connection.
  await sql`delete from folder_mappings where root_id in (select id from storage_roots where container_path='/workspace')`;
  await sql`delete from storage_roots where container_path='/workspace'`;
  await sql`delete from storage_capabilities where user_id=${owner.id}`;
  const discoveryReplies = await Promise.all([0, 1].map(() => fetch(base + '/api/storage/mappings', { headers: { cookie } }).then(response => response.json())));
  assert(discoveryReplies.every(reply => reply.nativeWorkspace.status === 'ready' && reply.mappings.length === 1));
  assert.equal((await sql`select count(*)::int as n from folder_mappings where provider='local'`)[0].n, 1);
  const discovered = discoveryReplies[0].mappings[0];
  const listing = await fetch(base + `/api/workspace/${discovered.id}/list`, { headers: { cookie } }).then(response => response.json());
  assert(listing.entries.some(entry => entry.name === 'chosen.txt'));
  Object.assign(process.env, { JOSI_NATIVE_RUNTIME: '1', JOSI_WORKSPACE_ENABLED: '1', JOSI_WORKSPACE_MODE: 'ro',
    JOSI_WORKSPACE_NATIVE_PATH: cfg.workspace.path, JOSI_WORKSPACE_NATIVE_ID: `${cfg.workspace.dev}:${cfg.workspace.ino}` });
  const { postgresDb } = await import(pathToFileURL(join(program, 'app/packages/core/dist/index.js')));
  const { executeWorkspaceTool } = await import(pathToFileURL(join(program, 'app/packages/agent/dist/workspaceTools.js')));
  const toolDb = postgresDb(sql);
  const toolDiscovery = await executeWorkspaceTool(toolDb, owner.id, 'list_workspace_mappings', {});
  assert.equal(toolDiscovery.mappings[0].mapping_id, discovered.id);
  const toolRead = await executeWorkspaceTool(toolDb, owner.id, 'workspace_read', { mapping_id: discovered.id, path: 'chosen.txt' });
  assert.equal(toolRead.text, 'selected native folder');
  console.log('PASS packaged delayed registration: concurrent authenticated discovery and AI tools expose and read the same selected folder');
  assert.equal((await fetch(base + '/api/admin/doctor')).status, 401);
  const status = await call('');
  assert.equal(status.status, 200);
  assert.equal(status.body.available, true);
  assert.equal(status.body.diagnosis.runtime, 'macos');
  assert.equal(status.body.diagnosis.safeRepairAvailable, false);
  assert.equal(status.body.diagnosis.healthy, true, JSON.stringify(status.body.diagnosis));
  const checks = Object.fromEntries(status.body.diagnosis.checks.map(check => [check.key, check.state]));
  for (const key of ['native_runtime', 'native_worker', 'native_voice', 'migrations', 'direct_health', 'public_health', 'writable_data', 'native_workspace']) {
    assert.equal(checks[key], 'pass', key);
  }
  assert.equal(checks.native_backup_history, 'warn');
  assert(!Object.hasOwn(checks, 'runtime'), 'Native Doctor must not check Docker');
  console.log('PASS authenticated packaged native Doctor: real PostgreSQL, files, worker, speech, proxy and selected workspace');

  const heartbeat = join(root, 'data/state/worker-heartbeat');
  // Pause only this fixture worker in the parent lifecycle test before this
  // fault probe, so a fresh tick cannot race the intentionally stale timestamp.
  const stale = new Date(Date.now() - 120_000);
  utimesSync(heartbeat, stale, stale);
  const failed = await call('/check', {});
  assert.equal(failed.status, 200);
  assert.equal(failed.body.healthy, false);
  assert(failed.body.failed.includes('native_worker'));
  const current = new Date(); utimesSync(heartbeat, current, current);
  assert.equal((await call('/check', {})).body.healthy, true);
  console.log('PASS packaged Doctor detects a stale worker heartbeat and reports recovery after a fresh heartbeat');

  await sql`update update_state set available_version='99.0.0' where id=true`;
  const update = await call('/update');
  assert.equal(update.status, 200);
  assert.equal(update.body.currentVersion, cfg.version);
  assert.equal(update.body.job.applyMode, 'installer');
  assert.equal(update.body.availableVersion, null);
  assert.equal((await call('/update/start', { version: '99.0.0', confirm: 'UPDATE 99.0.0' })).status, 409);
  assert.equal((await sql`select count(*)::int as n from update_runs`)[0].n, 0);
  console.log('PASS packaged native update status ignores container releases and refuses browser installation');

  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, env: { PATH: '/usr/bin:/bin', TMPDIR: join(root, 'data/temp/web'), HOME: root } });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await context.addCookies([{ name: 'josi_session', value: token, url: base, httpOnly: true, sameSite: 'Lax' }]);
    page = await context.newPage();
    await page.goto(base + '/app/workspace');
    await page.getByRole('list', { name: 'Workspace files' }).getByText('chosen.txt').waitFor();
    assert.equal(await page.getByText('No local folders connected.', { exact: true }).count(), 0);
    await page.screenshot({ path: join(root, 'workspace-browser.png'), fullPage: true });
    // A retained configured root with no mapping needs explicit reconnection,
    // rather than silently restoring a user-revoked grant.
    await sql`delete from folder_mappings where root_id in (select id from storage_roots where container_path='/workspace')`;
    await sql`update storage_capabilities set may_map_local=false,coding_enabled=true where user_id=${owner.id}`;
    await page.reload();
    await page.getByRole('button', { name: 'Connect folder', exact: true }).click();
    await page.getByRole('list', { name: 'Workspace files' }).getByText('chosen.txt').waitFor();
    assert.equal((await sql`select coding_enabled from storage_capabilities where user_id=${owner.id}`)[0].coding_enabled, true);
    const reconnected = await executeWorkspaceTool(toolDb, owner.id, 'list_workspace_mappings', {});
    const reread = await executeWorkspaceTool(toolDb, owner.id, 'workspace_read', { mapping_id: reconnected.mappings[0].mapping_id, path: 'chosen.txt' });
    assert.equal(reread.text, 'selected native folder');
    assert.equal(await page.getByRole('button', { name: 'Edit text', exact: true }).count(), 0);
    console.log('PASS packaged Local Workspace auto-selects the connected folder and reconnects a retained native root through the real browser form');
    await page.goto(base + '/admin/diagnostics');
    await page.getByText('Josi looks healthy', { exact: true }).waitFor();
    assert.equal(await page.getByText('Check for updates', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Josi Doctor needs one refresh', { exact: true }).count(), 0);
    assert.equal(await page.getByText(/isolated updater is unavailable/).count(), 0);
    await page.getByRole('button', { name: 'Check system', exact: true }).click();
    await page.getByText('No failures were found. Some items still need attention.', { exact: true }).waitFor();
    await page.getByText(/All \d+ checks/).click();
    await page.screenshot({ path: join(root, 'doctor-browser.png'), fullPage: true });
    assert.equal(await page.getByText('Mac installation', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Docker', { exact: true }).count(), 0);
    await context.close();
    console.log('PASS packaged Doctor browser view, native update notice, expanded real checks and Check system refresh');
  } catch (error) {
    if (page) {
      await page.screenshot({ path: join(root, 'workspace-failure.png'), fullPage: true }).catch(() => {});
      console.error('Disposable browser state:', page.url(), (await page.locator('body').innerText().catch(() => '')).slice(-2400));
    }
    throw error;
  } finally { await browser.close(); }
} finally {
  await sql`delete from sessions where token_hash=${tokenHash}`;
  if (originalSetup) await sql`update setup_state set completed=${originalSetup.completed},current_step=${originalSetup.current_step},completed_at=${originalSetup.completed_at} where id=true`;
  await sql.end();
}
