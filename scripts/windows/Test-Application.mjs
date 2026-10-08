// Real, private, relocated API/worker/PostgreSQL/Caddy test. No SCM installation
// or claims of physical microphone, reboot, or complete release acceptance.
import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { privateTemporaryDirectory } from '../../packages/core/dist/index.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = join(repo, 'artifacts/windows-native');
const build = JSON.parse(await readFile(join(base, 'evidence/application-build.json'), 'utf8'));
const runtimes = JSON.parse(await readFile(join(base, 'evidence/runtime-build.json'), 'utf8'));
process.env.TEMP = join(base, 'test-installations'); process.env.TMP = process.env.TEMP;
const fixture = privateTemporaryDirectory('josi-app-');
const program = join(fixture, 'program'), data = join(fixture, 'data'), logs = join(fixture, 'logs');
for (const folder of ['config', 'secrets', 'temp/web', 'temp/worker', 'temp/migrate', 'temp/scanner',
  'temp/probe', 'temp/voice', 'temp/voice-control', 'voice/gateway', 'voice/control',
  'chat-attachments', 'roots', 'versions', 'snapshots', 'transactions', 'backups', 'diagnostics', 'state', 'codex']) {
  await mkdir(join(data, folder), { recursive: true });
}
await mkdir(logs);
console.log('Relocating the compiled payload and private runtimes.');
await cp(build.payload, program, { recursive: true });
await cp(runtimes.payload, program, { recursive: true });
const node = join(program, 'node/JosiRuntime.exe'), pg = join(program, 'postgresql/bin');
const launcher = join(program, 'app/native/Runtime.mjs'), configuration = join(data, 'config/runtime.json');
const clean = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
  ProgramData: process.env.ProgramData, ProgramFiles: process.env.ProgramFiles,
  COMSPEC: join(process.env.SystemRoot, 'System32/cmd.exe'),
  PATH: join(process.env.SystemRoot, 'System32'), TEMP: join(data, 'temp/probe'), TMP: join(data, 'temp/probe') };
const processes = [];
function start(command, args, label, environment = clean) {
  const out = openSync(join(logs, `${label}.out`), 'w'), err = openSync(join(logs, `${label}.err`), 'w');
  try {
    const child = spawn(command, args, { cwd: program, env: environment, windowsHide: true, stdio: ['ignore', out, err] });
    child.done = new Promise((done, reject) => {
      child.on('error', reject); child.on('exit', (code, signal) => done({ code, signal }));
    });
    // Retain the rejection handler even if startup fails before the final wait.
    child.done.catch(() => {});
    processes.push(child);
    return child;
  } finally { closeSync(out); closeSync(err); }
}
async function run(command, args, label, environment = clean) {
  const child = start(command, args, label, environment);
  const outcome = await Promise.race([child.done, delay(90000, undefined, { ref: false }).then(() => ({ timeout: true }))]);
  if (outcome.timeout) child.kill();
  assert.equal(outcome.code, 0, `${label} failed; inspect the private fixture logs.`);
}
async function port() {
  const server = createServer();
  await new Promise((done, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', done); });
  const number = server.address().port;
  await new Promise(done => server.close(done));
  return number;
}
async function until(check, label, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  do { if (await check()) return; await delay(200); } while (Date.now() < deadline);
  throw new Error(`${label} timed out; inspect the private fixture logs.`);
}
const databasePort = await port(), apiPort = await port(), entryPort = await port();
assert.equal(new Set([databasePort, apiPort, entryPort]).size, 3);
const setupToken = randomBytes(32).toString('hex'), adminPassword = randomBytes(32).toString('hex');
const dbPassword = randomBytes(32).toString('hex'), masterKey = randomBytes(32).toString('hex');
const voiceToken = randomBytes(32).toString('hex'), controlToken = randomBytes(32).toString('hex');
const initPassword = join(data, 'secrets/init-password');
await writeFile(initPassword, adminPassword, { flag: 'wx' });
await writeFile(join(data, 'secrets/database-password'), dbPassword, { flag: 'wx' });
await writeFile(join(data, 'secrets/master-key'), masterKey, { flag: 'wx' });
await writeFile(join(data, 'secrets/voice-control-token'), controlToken, { flag: 'wx' });
await writeFile(join(data, 'voice/gateway/token'), voiceToken, { flag: 'wx' });
await writeFile(join(data, 'voice/gateway/settings.json'), JSON.stringify({ model: 'base.en', voice: 'af_heart',
  threshold: 0.5, silenceMs: 700, speed: 1, device: 'cpu' }));
// SCM start/stop is tested separately after installation. Start the actual
// control entry point with speech disabled so it need not control a fake service.
await writeFile(join(data, 'voice/control/state.json'), JSON.stringify({ enabled: false }));
await writeFile(configuration, JSON.stringify({ schemaVersion: 1, version: build.version,
  databasePort, apiPort, publicUrl: `http://127.0.0.1:${entryPort}`,
  setupTokenSha256: createHash('sha256').update(setupToken).digest('hex') }));
const cluster = join(data, 'database');
const require = createRequire(join(program, 'app/package.json'));
const postgres = require('postgres');
let admin, sql, databaseStarted = false;
try {
  for (const number of [18081, 18082]) {
    const test = createServer();
    await new Promise((done, reject) => { test.once('error', reject); test.listen(number, '127.0.0.1', done); });
    await new Promise(done => test.close(done));
  }
  await run(join(pg, 'initdb.exe'), ['-D', cluster, '-U', 'bootstrap_admin', `--pwfile=${initPassword}`,
    '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C'], 'initdb');
  await writeFile(join(cluster, 'postgresql.auto.conf'), ["listen_addresses='127.0.0.1'", `port=${databasePort}`,
    "password_encryption='scram-sha-256'", "log_statement='none'", "log_min_error_statement='panic'",
    'log_parameter_max_length_on_error=0', 'logging_collector=off'].join('\n') + '\n');
  await run(join(pg, 'pg_ctl.exe'), ['start', '-D', cluster, '-l', join(logs, 'database.log'), '-w', '-t', '30'], 'database-start');
  databaseStarted = true;
  admin = postgres({ host: '127.0.0.1', port: databasePort, username: 'bootstrap_admin',
    database: 'postgres', password: adminPassword, max: 1, onnotice: () => {} });
  // Generated hexadecimal value only; PostgreSQL CREATE ROLE cannot bind the
  // password as a query parameter. SQL statements are never logged or returned.
  await admin.unsafe(`create role josi login nosuperuser nocreatedb nocreaterole noreplication password '${dbPassword}'`);
  await admin.unsafe('create database josi owner josi');
  await admin.end(); admin = undefined;
  await run(node, [launcher, 'migrate', configuration], 'migrations');
  const retainedConfiguration = JSON.parse(await readFile(configuration, 'utf8'));
  await writeFile(configuration, JSON.stringify({ ...retainedConfiguration, version: '0.0.1-native.baseline' }));
  await run(node, [launcher, 'migrate', configuration], 'upgrade-migrations-before-activation');
  for (const role of ['web', 'worker']) {
    const refused = start(node, [launcher, role, configuration], `unactivated-${role}`);
    assert.equal((await refused.done).code, 1, 'Unactivated long-lived writers must be refused.');
  }
  await writeFile(configuration, JSON.stringify(retainedConfiguration));
  sql = postgres({ host: '127.0.0.1', port: databasePort, username: 'josi', database: 'josi',
    password: dbPassword, max: 1, onnotice: () => {} });
  const [job] = await sql`insert into job_queue(kind,payload,run_at) values ('approvals.expire','{}',now()-interval '1 minute') returning id`;
  const poisoned = { ...clean, PATH: 'C:\\does-not-exist', MASTER_KEY: 'must-not-be-inherited',
    DATABASE_URL: 'postgresql://invalid@127.0.0.1:1/invalid', PGOPTIONS: '-c default_transaction_read_only=on' };
  const api = start(node, [launcher, 'web', configuration], 'api', poisoned);
  const worker = start(node, [launcher, 'worker', configuration], 'worker', poisoned);
  await until(async () => {
    if (api.exitCode !== null) throw new Error('The packaged API exited; inspect its fixture log.');
    try { return (await fetch(`http://127.0.0.1:${apiPort}/ready`)).status === 200; } catch { return false; }
  }, 'API readiness');
  await until(async () => (await sql`select status from job_queue where id=${job.id}`)[0]?.status === 'done', 'Real background job');
  assert.equal(worker.exitCode, null);
  const antivirus = JSON.parse(await readFile(join(data, 'state/antivirus.json'), 'utf8'));
  assert.deepEqual(Object.keys(antivirus).sort(), ['checkedAt', 'provider', 'status']);
  assert.equal(antivirus.provider, 'windows-amsi');
  assert.ok(['available', 'error', 'unavailable'].includes(antivirus.status), 'The worker must record an honest explicit probe result.');
  assert.ok(Date.now() - Date.parse(antivirus.checkedAt) < 60_000);
  const caddyfile = join(data, 'config/Caddyfile');
  await writeFile(caddyfile, `{\n admin off\n auto_https off\n}\nhttp://127.0.0.1:${entryPort} {\n bind 127.0.0.1\n reverse_proxy 127.0.0.1:${apiPort}\n}\n`);
  const proxy = start(join(program, 'caddy/caddy.exe'), ['run', '--config', caddyfile, '--adapter', 'caddyfile'], 'proxy',
    { ...clean, APPDATA: join(data, 'proxy'), LOCALAPPDATA: join(data, 'proxy') });
  const url = `http://127.0.0.1:${entryPort}`;
  await until(async () => { try { return (await fetch(`${url}/ready`)).status === 200; } catch { return false; } }, 'Proxy readiness');
  assert.match(await (await fetch(url)).text(), /<html/);
  assert.equal((await fetch(`${url}/api/setup/state`)).status, 404);
  const setup = await fetch(`${url}/api/setup/state`, { headers: { 'x-josi-setup-token': setupToken } });
  assert.equal(setup.status, 200);
  assert.equal((await fetch(`${url}/api/tasks`)).status, 503);
  await copyFile(join(repo, 'scripts/windows/application-runtime-probe.mjs'), join(program, 'app/runtime-probe.mjs'));
  await run(node, [join(program, 'app/runtime-probe.mjs'), join(base, 'evidence/ocr-fixture.png')], 'runtime-probe', {
    ...clean, JOSI_NATIVE_RUNTIME: '1', JOSI_DATA_DIR: data, JOSI_UPLOAD_DIR: join(data, 'chat-attachments'),
    MASTER_KEY_FILE: join(data, 'secrets/master-key'), PGPASSWORD_FILE: join(data, 'secrets/database-password'),
    DATABASE_URL: `postgresql://josi@127.0.0.1:${databasePort}/josi`,
  });
  const probe = JSON.parse((await readFile(join(logs, 'runtime-probe.out'), 'utf8')).trim());
  assert.equal(probe.passed, true);
  const python = join(program, 'python/python.exe'), pythonEntry = join(program, 'app/native/PythonRuntime.py');
  const voice = start(python, ['-I', '-B', pythonEntry, 'voice', configuration], 'voice', poisoned);
  const control = start(python, ['-I', '-B', pythonEntry, 'voice-control', configuration], 'voice-control', poisoned);
  await run(python, ['-I', '-B', join(repo, 'scripts/windows/test_voice_gateway.py')], 'voice-probe',
    { ...clean, JOSI_TEST_PROGRAM_ROOT: program, JOSI_TEST_DATA_ROOT: data });
  await run(python, ['-I', '-B', join(repo, 'scripts/windows/voice_spike.py')], 'voice-dependency-probe',
    { ...clean, JOSI_TEST_PROGRAM_ROOT: program });
  await until(async () => { try {
    return (await fetch('http://127.0.0.1:18082/status', { headers: { Authorization: `Bearer ${controlToken}` } })).status === 200;
  } catch { return false; } }, 'Packaged voice control');
  assert.equal((await fetch('http://127.0.0.1:18082/status')).status, 401);
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$ports=@(${databasePort},${apiPort},${entryPort},18081,18082); Get-NetTCPConnection -State Listen | Where-Object {$ports -contains $_.LocalPort} | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`], 'listeners');
  const listeners = JSON.parse(await readFile(join(logs, 'listeners.out'), 'utf8'));
  assert.equal(listeners.length, 5);
  assert.ok(listeners.every(listener => listener.LocalAddress === '127.0.0.1'));
  await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -like ($env:JOSI_PROCESS_ROOT+'\\*')} | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
    'processes', { ...clean, JOSI_PROCESS_ROOT: program });
  const observed = JSON.parse(await readFile(join(logs, 'processes.out'), 'utf8'));
  for (const child of [api, worker, proxy, voice, control]) assert.ok(observed.some(p => p.ProcessId === child.pid));
  assert.ok(observed.filter(p => p.Name === 'postgres.exe').length >= 2);
  assert.ok(observed.every(p => p.ExecutablePath.startsWith(program)));
  await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `Get-Process -Id @(${observed.map(p => p.ProcessId).join(',')}) | ForEach-Object {$processId=$_.Id; $_.Modules | ForEach-Object {[pscustomobject]@{processId=$processId;name=$_.ModuleName;path=$_.FileName}}} | ConvertTo-Json -Compress`], 'modules');
  const modules = JSON.parse(await readFile(join(logs, 'modules.out'), 'utf8'));
  const microsoftSecurity = join(process.env.ProgramData, 'Microsoft/Windows Defender/Platform').toLowerCase() + '\\';
  const antivirusModules = modules.filter(module => module.path.toLowerCase().startsWith(microsoftSecurity)
    && /^(mpoav|mpclient)\.dll$/i.test(module.name));
  await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$items=$env:JOSI_AV_MODULES | ConvertFrom-Json; @(foreach($item in $items){$sig=Get-AuthenticodeSignature -LiteralPath $item.path; [pscustomobject]@{path=$item.path;status=[string]$sig.Status;microsoft=($sig.SignerCertificate.Subject -match 'Microsoft')}}) | ConvertTo-Json -Compress`],
    'antivirus-module-signatures', { ...clean, JOSI_AV_MODULES: JSON.stringify(antivirusModules) });
  const antivirusSignatures = [].concat(JSON.parse((await readFile(join(logs, 'antivirus-module-signatures.out'), 'utf8')).trim() || '[]'));
  assert.equal(antivirusSignatures.length, antivirusModules.length);
  assert.ok(antivirusSignatures.every(item => item.status === 'Valid' && item.microsoft === true), 'An installed antivirus library lacks a trusted Microsoft signature');
  for (const module of modules) {
    const path = module.path.toLowerCase();
    assert.ok(path.startsWith(program.toLowerCase() + '\\') || path.startsWith(process.env.SystemRoot.toLowerCase() + '\\')
      || antivirusSignatures.some(item => item.path.toLowerCase() === path), 'A runtime loaded a non-private library');
    if (/^(vcruntime140(?:_1)?|msvcp140|vcomp140)\.dll$/i.test(module.name)) {
      assert.ok(path.startsWith(program.toLowerCase() + '\\'), 'A global C++ runtime was used');
    }
  }
  for (const file of await readdir(logs)) {
    const contents = await readFile(join(logs, file), 'utf8');
    for (const secret of [setupToken, adminPassword, dbPassword, masterKey, voiceToken, controlToken]) assert.ok(!contents.includes(secret), 'A fixture log exposed a secret');
  }
  // Exercise the actual fixed maintenance entry with application writers
  // stopped. PostgreSQL remains running, as required for the SQL snapshot.
  for (const child of [api, worker, proxy, voice, control]) if (child.exitCode === null) child.kill();
  await Promise.all([api, worker, proxy, voice, control].map(child => child.done));
  const fixturePaths = ['chat-attachments/cli-acceptance.bin', 'roots/cli-acceptance.txt', 'versions/cli-acceptance.bin'];
  for (const path of fixturePaths) await writeFile(join(data, path), 'Native CLI recovery fixture.', { flag: 'wx' });
  const snapshotId = randomBytes(16).toString('hex'), restoreAttempt = randomBytes(16).toString('hex');
  const snapshotEntry = join(program, 'app/native/Snapshot.mjs');
  const baselineDomain = (await sql`select domain from deployment_config where id=true`)[0].domain;
  await run(node, [snapshotEntry, 'create', configuration, snapshotId], 'snapshot-create');
  const snapshot = JSON.parse((await readFile(join(logs, 'snapshot-create.out'), 'utf8')).trim());
  assert.equal(snapshot.id, snapshotId);
  assert.equal(snapshot.files, fixturePaths.length);
  await sql`update deployment_config set domain='cli-mutation.example.test'`;
  for (const path of fixturePaths) await writeFile(join(data, path), 'Deliberate fixture mutation.');
  await run(node, [snapshotEntry, 'verify', configuration, snapshotId, snapshot.manifestSha256], 'snapshot-verify');
  assert.equal(JSON.parse((await readFile(join(logs, 'snapshot-verify.out'), 'utf8')).trim()).verified, true);
  assert.equal((await sql`select domain from deployment_config where id=true`)[0].domain, 'cli-mutation.example.test');
  await run(node, [snapshotEntry, 'restore', configuration, snapshotId, snapshot.manifestSha256, restoreAttempt], 'snapshot-restore');
  assert.equal(JSON.parse((await readFile(join(logs, 'snapshot-restore.out'), 'utf8')).trim()).permissionsPending, true);
  assert.equal((await sql`select domain from deployment_config where id=true`)[0].domain, baselineDomain);
  for (const path of fixturePaths) assert.equal(await readFile(join(data, path), 'utf8'), 'Native CLI recovery fixture.');
  const evidence = { passed: true, recordedAt: new Date().toISOString(), version: build.version,
    fixture, applicationSourceHash: build.sourceInventorySha256, probe, listeners, processes: observed, modules,
    apiReady: true, proxyReady: true, realWorkerJobCompleted: true, firstRunTokenEnforced: true,
    inheritedHostileEnvironmentIgnored: true, logsExcludeGeneratedSecrets: true,
    explicitWorkerAntivirusProbe: antivirus,
    installedAntivirusModuleSignatures: antivirusSignatures,
    fixedSnapshotCliCreateVerifyRestore: true, snapshotVerificationDidNotMutateSql: true,
    migrationsBeforeActivation: true, unactivatedWritersRefused: true,
    privateRuntimePathsObserved: true, privateLoadedLibrariesObserved: true, runtimeInventoryHash: runtimes.inventorySha256,
    privatePythonGatewayAndControl: true, realVoiceInference: true, servicesInstalled: false, signed: false,
    browserSetupCompleted: false, physicalMicrophone: false, releaseAccepted: false };
  await writeFile(join(base, 'evidence/application-runtime.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('Packaged API, worker, database, proxy, OCR, native password hashing, private files and setup authorization passed.');
} finally {
  await sql?.end().catch(() => {}); await admin?.end().catch(() => {});
  for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.allSettled(processes.map(child => child.done));
  if (databaseStarted) await run(join(pg, 'pg_ctl.exe'), ['stop', '-D', cluster, '-m', 'fast', '-w', '-t', '30'], 'database-stop');
  // Keep logs and the private test database for evidence, but remove only the
  // credential files this fixture created. No unrelated installation is touched.
  for (const name of ['init-password', 'database-password', 'master-key', 'voice-control-token']) await rm(join(data, 'secrets', name), { force: true });
  await rm(join(data, 'voice/gateway/token'), { force: true });
}
