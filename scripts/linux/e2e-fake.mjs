// End-to-end test of the installed headless Josi server on Linux, using only a
// fake account and a fake model. No real credential is needed or used.
//
//   sudo /var/lib/josi/versions/<ver>/node/bin/node scripts/linux/e2e-fake.mjs
//
// Copy the three e2e-fake*.mjs files from scripts/linux together. Runs as root
// on the Josi machine against http://127.0.0.1:<publicPort> (loopback only).
//
// 1. First-run setup through the real /api/setup API (owner, Vault recovery,
//    the model step with the fake OpenAI-compatible model and its five-part
//    probe, SMTP skipped, security, telemetry, review, complete).
// 2. Password sign-in, authenticator enrolment (TOTP computed from the secret
//    the API returns), then password + TOTP sign-in and an authorized request.
// 3. The fake model is the admin's model; the probe's tool check passes.
// 4. A chat turn through /api/assistant/threads/:id/talk, with a real Josi
//    tool call executed by Josi and its result returned to the fake model.
// 5. The bundled Claude Code and Codex CLIs (1.1.1+): run as the service
//    accounts, the MCP tool server starts from JOSI_MCP_SERVER, and Josi's own
//    subscription providers drive both CLIs to the fake backend and through a
//    Josi MCP tool call (see e2e-fake-cli-driver.mjs for the one substitution).
// 6. The instance is left set up. Credentials are written ONLY to
//    /root/josi-e2e-credentials.json (0600) and never printed.
//
// Re-running after setup is done signs in with the saved credentials and
// repeats 2-5. Environment: E2E_FAKE_PORT (default 18999), E2E_SKIP_CLI=1,
// E2E_ONLY_CLI=1 (sign in, then only part 5).
import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_KEY, FAKE_MODEL, RESULT_MARKER, TOOL_MARKER, startFakeModel } from './e2e-fake-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = '/var/lib/josi';
const DATA = `${ROOT}/data`;
const CREDENTIALS = '/root/josi-e2e-credentials.json';
const REPORT = '/root/josi-e2e-report.json';

if (process.platform !== 'linux' || process.getuid() !== 0) {
  console.error('Run as root on the Josi machine: sudo <program>/node/bin/node e2e-fake.mjs');
  process.exit(2);
}

const status = JSON.parse(readFileSync(`${ROOT}/status.json`, 'utf8'));
const runtime = JSON.parse(readFileSync(`${DATA}/config/runtime.json`, 'utf8'));
const PROGRAM = `${ROOT}/versions/${status.version}`;
const BASE = `http://127.0.0.1:${runtime.publicPort}`;
const results = {};
const evidence = {};
const log = (...a) => console.log(...a);
const verdict = (point, outcome, detail) => { results[point] = { outcome, detail }; log(`\n[${outcome}] ${point}: ${detail}`); };
const assert = (cond, message) => { if (!cond) throw new Error(message); };

// ------------------------------------------------------------------ helpers

/** RFC 6238 TOTP, SHA-1, 6 digits, 30 s — what otplib's defaults produce. */
function totp(secretBase32, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch); if (v < 0) continue; bits += v.toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

/** A browser-like client: cookie jar, CSRF header, optional setup token. */
function client(name) {
  const jar = new Map();
  return {
    name, jar,
    async req(method, path, body, { setupToken, expect } = {}) {
      const headers = { Accept: 'application/json', 'User-Agent': 'josi-e2e-fake/1' };
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (jar.has('josi_csrf')) headers['x-josi-csrf'] = jar.get('josi_csrf');
      if (setupToken) headers['x-josi-setup-token'] = setupToken;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';'); const i = pair.indexOf('=');
        const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim();
        if (!v || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
      }
      const text = await res.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
      if (expect && !(Array.isArray(expect) ? expect : [expect]).includes(res.status)) {
        throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)?.slice(0, 400)}`);
      }
      return { status: res.status, json };
    },
  };
}

const saveCredentials = (value) => { writeFileSync(CREDENTIALS, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); chmodSync(CREDENTIALS, 0o600); };
const loadCredentials = () => (existsSync(CREDENTIALS) ? JSON.parse(readFileSync(CREDENTIALS, 'utf8')) : null);
const since = (fake, mark) => fake.requests.slice(mark);

// --------------------------------------------------------------------- main

log(`Josi ${status.version} at ${BASE}; program ${PROGRAM}`);
const fake = await startFakeModel({ port: Number(process.env.E2E_FAKE_PORT ?? 18999), log });
const FAKE_V1 = `${fake.url}/v1`;
log(`fake model on ${fake.url} (model "${FAKE_MODEL}")`);
let creds = loadCredentials();
const browser = client('admin');

try {
  // ---------------------------------------------------------------- 1. setup
  await browser.req('GET', '/auth/csrf', undefined, { expect: 200 });
  const onboarding = await browser.req('GET', '/onboarding/state', undefined, { expect: 200 });
  const setupToken = readFileSync(`${DATA}/secrets/bootstrap/browser-token`, 'utf8').trim();
  let probeFromSetup = null;
  if (!onboarding.json.completed) {
    try {
      // Without the root-only token the setup routes do not exist.
      const refused = await browser.req('GET', '/setup/state');
      assert(refused.status === 404, `setup state without the token answered ${refused.status}`);
      const steps = [];
      for (let guard = 0; guard < 20; guard++) {
        const state = (await browser.req('GET', '/setup/state', undefined, { setupToken, expect: 200 })).json;
        if (state.recoveryPending) {
          const rec = await browser.req('GET', '/setup/vault-recovery', undefined, { setupToken, expect: 200 });
          creds = { ...creds, vaultRecoveryKey: rec.json.key, vaultRecoveryFingerprint: rec.json.fingerprint }; saveCredentials(creds);
          await browser.req('POST', '/setup/vault-recovery-confirmed', {}, { setupToken, expect: 200 });
          steps.push('vault-recovery-confirmed');
          continue;
        }
        const step = state.nextStep;
        if (!step) break;
        let body = {};
        if (step === 'host_checks') {
          const hc = (await browser.req('GET', '/setup/host-checks', undefined, { setupToken, expect: 200 })).json;
          evidence.hostChecks = hc.checks.map((c) => `${c.status}:${c.id}`);
          if (hc.blocking.length) throw new Error(`blocking host checks: ${hc.blocking.join(', ')}`);
        } else if (step === 'owner') {
          if (state.ownerExists) {
            assert(creds?.password, 'an owner exists but /root/josi-e2e-credentials.json is missing');
            body = { resumeOwner: true, identifier: creds.username, password: creds.password };
          } else {
            creds = { purpose: 'Josi E2E test administrator (fake). Created by scripts/linux/e2e-fake.mjs.',
              url: `http://localhost:${runtime.publicPort}`, username: 'e2e-admin', email: 'e2e-admin@josi-e2e.test',
              displayName: 'E2E Admin', password: randomBytes(18).toString('base64url'), createdAt: new Date().toISOString() };
            saveCredentials(creds); // before submitting, so a crash cannot lose them
            body = { email: creds.email, username: creds.username, displayName: creds.displayName, password: creds.password, timezone: 'UTC' };
          }
        } else if (step === 'domain') {
          body = { domain: 'localhost', tlsMode: 'bundled_caddy' };
        } else if (step === 'llm') {
          const models = (await browser.req('POST', '/setup/models', { provider: 'openai_compatible', baseUrl: FAKE_V1, apiKey: FAKE_KEY },
            { setupToken, expect: 200 })).json;
          assert(models.ok && models.models.some((m) => m.id === FAKE_MODEL), `model discovery did not list the fake model: ${JSON.stringify(models)}`);
          const mark = fake.requests.length;
          await browser.req('POST', '/setup/steps/llm', { provider: 'openai_compatible', model: FAKE_MODEL, baseUrl: FAKE_V1, apiKey: FAKE_KEY },
            { setupToken, expect: 200 });
          const verify = (await browser.req('POST', '/setup/verify/llm', {}, { setupToken, expect: 200 })).json;
          probeFromSetup = { verify, requests: since(fake, mark) };
          steps.push('llm');
          continue;
        } else if (step === 'smtp') body = { skip: true };
        else if (step === 'security') body = { folderMappingEnabled: false };
        else if (step === 'telemetry') body = { enabled: false };
        const out = await browser.req('POST', `/setup/steps/${step}`, body, { setupToken, expect: 200 });
        if (out.json.vaultRecovery) {
          creds = { ...creds, vaultRecoveryKey: out.json.vaultRecovery.key, vaultRecoveryFingerprint: out.json.vaultRecovery.fingerprint };
          saveCredentials(creds);
          await browser.req('POST', '/setup/vault-recovery-confirmed', {}, { setupToken, expect: 200 });
          steps.push(`${step}+vault-recovery-confirmed`);
        } else steps.push(step);
      }
      const review = (await browser.req('GET', '/setup/review', undefined, { setupToken, expect: 200 })).json;
      evidence.review = review.items?.map((i) => `${i.key}:${i.status}`);
      const done = await browser.req('POST', '/setup/complete', {}, { setupToken, expect: 200 });
      const after = await browser.req('GET', '/setup/state', undefined, { setupToken });
      const onboarded = await browser.req('GET', '/onboarding/state', undefined, { expect: 200 });
      assert(onboarded.json.completed === true && after.status === 404, 'setup did not close');
      verdict('1 first-run setup', 'PASS', `steps ${steps.join(' > ')}; complete -> 200 at ${done.json.completedAt}; `
        + `/api/setup/state now 404; review ${evidence.review?.join(', ')}; credentials saved to ${CREDENTIALS} (0600)`);
    } catch (error) {
      verdict('1 first-run setup', 'FAIL', error.message);
      throw error;
    }
  } else {
    assert(creds?.password, `setup is already complete and ${CREDENTIALS} is missing; cannot sign in`);
    verdict('1 first-run setup', 'PASS', 'already completed by an earlier run of this script; reusing saved credentials');
  }

  // ---------------------------------------------------------------- 2. login
  try {
    const anonymous = client('anonymous');
    const denied = await anonymous.req('GET', '/auth/me');
    assert(denied.status === 401, `/auth/me without a session answered ${denied.status}`);
    await browser.req('GET', '/auth/csrf', undefined, { expect: 200 });
    let first = await browser.req('POST', '/auth/login', { identifier: creds.username, password: creds.password }, { expect: [200, 202] });
    const notes = [];
    if (first.status === 200) {
      // No authenticator yet: enrol one exactly as the Security page does.
      const setup = await browser.req('POST', '/auth/mfa/setup', {}, { expect: 200 });
      creds = { ...creds, totpSecret: setup.json.secret }; saveCredentials(creds);
      const enabled = await browser.req('POST', '/auth/mfa/enable', { code: totp(creds.totpSecret) }, { expect: 200 });
      creds = { ...creds, mfaRecoveryCodes: enabled.json.recoveryCodes }; saveCredentials(creds);
      notes.push(`password-only login 200, authenticator enrolled (${enabled.json.recoveryCodes?.length} recovery codes saved)`);
      await browser.req('POST', '/auth/logout', {}, { expect: 200 });
      browser.jar.clear();
      await browser.req('GET', '/auth/csrf', undefined, { expect: 200 });
      first = await browser.req('POST', '/auth/login', { identifier: creds.username, password: creds.password }, { expect: [200, 202] });
    }
    assert(first.status === 202 && first.json.mfaRequired && first.json.challenge, `password step did not ask for the authenticator: ${first.status}`);
    const noSession = await browser.req('GET', '/auth/me');
    assert(noSession.status === 401, 'a session existed before the second factor');
    const wrong = await browser.req('POST', '/auth/mfa/verify-login', { challenge: first.json.challenge, code: totp(creds.totpSecret, Date.now() - 600_000) });
    const ok = await browser.req('POST', '/auth/mfa/verify-login', { challenge: first.json.challenge, code: totp(creds.totpSecret) }, { expect: 200 });
    const me = await browser.req('GET', '/auth/me', undefined, { expect: 200 });
    const mfa = await browser.req('GET', '/auth/mfa', undefined, { expect: 200 });
    evidence.user = { id: me.json.user.id, role: me.json.user.role };
    assert(me.json.user.role === 'super_admin' && mfa.json.enabled, 'signed-in user is not the MFA-enabled super admin');
    notes.push(`password -> 202 mfaRequired; /auth/me before TOTP -> 401; stale TOTP -> ${wrong.status}; current TOTP -> 200; `
      + `/auth/me -> 200 role ${me.json.user.role}; /auth/mfa enabled=${mfa.json.enabled}; anonymous /auth/me -> 401`);
    verdict('2 login with password + TOTP', 'PASS', notes.join('; '));
  } catch (error) {
    verdict('2 login with password + TOTP', 'FAIL', error.message);
    throw error;
  }

  // ------------------------------------------------------- 3. the fake model
  if (process.env.E2E_ONLY_CLI !== '1') try {
    let probe; let requests;
    if (probeFromSetup) {
      probe = probeFromSetup.verify.probe; requests = probeFromSetup.requests;
      assert(probeFromSetup.verify.status === 'passed', `setup model check ${probeFromSetup.verify.status}: ${probeFromSetup.verify.detail}`);
    } else {
      const mark = fake.requests.length;
      await browser.req('PUT', '/admin/llm/providers/primary', { provider: 'openai_compatible', model: FAKE_MODEL, baseUrl: FAKE_V1, apiKey: FAKE_KEY }, { expect: 200 });
      const out = (await browser.req('POST', '/admin/llm/providers/primary/probe', {}, { expect: 200 })).json;
      probe = out.result ?? {}; requests = since(fake, mark);
    }
    const llm = (await browser.req('GET', '/admin/llm', undefined, { expect: 200 })).json;
    const steps = (probe.steps ?? []).map((s) => `${s.id}=${s.passed ? 'pass' : 'fail'}`);
    const toolStep = (probe.steps ?? []).find((s) => s.id === 'toolCalling');
    const asked = requests.find((r) => r.answer?.tool?.name === 'record_number');
    evidence.probeRequests = requests.map((r) => `${r.method} ${r.path}${r.answer?.tool ? ` -> tool ${r.answer.tool.name}` : ''}`);
    assert(toolStep?.passed, `tool check did not pass: ${toolStep?.detail}`);
    assert(asked && asked.authorized && asked.seen.tools.includes('record_number'), 'the fake model never received the record_number tool');
    const primary = JSON.stringify(llm).includes(FAKE_MODEL);
    verdict('3 fake model as the admin\'s model', 'PASS', `openai_compatible "${FAKE_MODEL}" at ${FAKE_V1} with a fake key `
      + `(configured via ${probeFromSetup ? 'setup step llm + /setup/verify/llm' : 'PUT /admin/llm/providers/primary + probe'}); `
      + `probe ${steps.join(', ')}; fake server saw ${requests.length} requests incl. chat/completions with tools [record_number] `
      + `answered with a record_number call (Authorization carried the fake key); /admin/llm lists the model: ${primary}`);
  } catch (error) {
    verdict('3 fake model as the admin\'s model', 'FAIL', error.message);
  }

  // ----------------------------------------------------------------- 4. chat
  if (process.env.E2E_ONLY_CLI !== '1') try {
    const thread = (await browser.req('POST', '/assistant/threads', { title: 'E2E fake model test' }, { expect: [200, 201] })).json.thread;
    const mark = fake.requests.length;
    const talk = await browser.req('POST', `/assistant/threads/${thread.id}/talk`,
      { message: `${TOOL_MARKER}: please list my open tasks.`, attachmentIds: [] });
    const reqs = since(fake, mark).filter((r) => r.path === '/chat/completions');
    const callIdx = reqs.findIndex((r) => r.answer?.tool && r.seen.prompt.includes(TOOL_MARKER));
    const call = reqs[callIdx];
    const back = reqs.slice(callIdx + 1).find((r) => r.seen.toolResults.some((t) => t.id === call?.answer.toolCallId));
    evidence.chatRequests = reqs.map((r) => ({ tools: r.seen.tools.length, toolResults: r.seen.toolResults.map((t) => t.id),
      answer: r.answer?.tool ? `tool ${r.answer.tool.name} (${r.answer.toolCallId})` : r.answer?.text?.slice(0, 80) }));
    assert(talk.status === 200, `talk answered ${talk.status}: ${JSON.stringify(talk.json)?.slice(0, 300)}`);
    assert(call, `the fake model was never offered a tool for the marked message (tools seen: ${reqs.map((r) => r.seen.tools.length).join(',')})`);
    assert(back, `no follow-up request carried the result for ${call.answer.toolCallId}`);
    const result = back.seen.toolResults.find((t) => t.id === call.answer.toolCallId);
    assert(String(talk.json.reply ?? '').includes(RESULT_MARKER), `reply did not come from the tool-result turn: ${String(talk.json.reply).slice(0, 200)}`);
    verdict('4 chat with a real Josi tool call', 'PASS', `POST /api/assistant/threads/${thread.id}/talk -> 200; request #${callIdx + 1} offered `
      + `${call.seen.tools.length} Josi tools, fake model called ${call.answer.tool.name} (${call.answer.toolCallId}); Josi executed it and request `
      + `#${reqs.indexOf(back) + 1} carried role=tool for that id with ${JSON.stringify(result.content.slice(0, 160))}; reply: `
      + `${JSON.stringify(String(talk.json.reply).slice(0, 160))}`);
  } catch (error) {
    verdict('4 chat with a real Josi tool call', 'FAIL', `${error.message}; requests: ${JSON.stringify(evidence.chatRequests ?? [])}`);
  }

  // ------------------------------------------------------------ 5. the CLIs
  if (process.env.E2E_SKIP_CLI === '1') verdict('5 Claude Code + Codex CLIs', 'NOT RUN', 'E2E_SKIP_CLI=1');
  else if (!existsSync(`${PROGRAM}/cli/bin/claude`)) verdict('5 Claude Code + Codex CLIs', 'NOT RUN', `${status.version} has no bundled CLIs; needs 1.1.1+`);
  else await cliPart();
} catch (error) {
  log(`\nstopped: ${error.message}`);
} finally {
  await fake.close();
  writeFileSync(REPORT, `${JSON.stringify({ version: status.version, at: new Date().toISOString(), results, evidence,
    fakeRequests: fake.requests.map((r) => ({ at: r.at, method: r.method, path: r.path, authorized: r.authorized, seen: r.seen, answer: r.answer })) }, null, 2)}\n`, { mode: 0o600 });
  log(`\nfull evidence (no secrets): ${REPORT}`);
  log('\n=== summary ===');
  for (const [k, v] of Object.entries(results)) log(`${v.outcome.padEnd(13)} ${k}`);
  log(`6 instance left set up: sign in at http://localhost:${runtime.publicPort} with ${CREDENTIALS}; the model is "${FAKE_MODEL}" `
    + `(loopback fake, not running now) until a real one is configured in Admin -> Model.`);
  process.exitCode = Object.values(results).some((v) => v.outcome === 'FAIL') ? 1 : 0;
}

// ------------------------------------------------------------------ the CLIs
async function cliPart() {
  const snapshot = () => spawnSync('find', [`${DATA}/codex`, `${DATA}/profiles/web`, `${DATA}/profiles/worker`, '/etc/claude-code', '/etc/codex',
    '-printf', '%p %s %T@\n'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort().join('\n');
  const before = snapshot();
  const notes = [];
  let pass = true;
  // a. The binaries, as both service accounts.
  for (const user of ['josi-ce-web', 'josi-ce-worker']) {
    // A throwaway HOME: even `codex --version` writes $HOME/.codex/tmp, and the
    // service profiles must stay as the product left them.
    const home = mkdtempSync(`${DATA}/temp/${user.replace('josi-ce-', '')}/josi-e2e-home-`);
    chownSync(home, Number(execFileSync('id', ['-u', user]).toString()), Number(execFileSync('id', ['-g', user]).toString()));
    try {
      for (const cli of ['claude', 'codex']) {
        // sudo resets HOME to the account's own, so set it inside.
        const r = spawnSync('sudo', ['-u', user, 'env', `HOME=${home}`, `CODEX_HOME=${home}`, `CLAUDE_CONFIG_DIR=${home}`,
          `${PROGRAM}/cli/bin/${cli}`, '--version'], { encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin' }, cwd: '/' });
        notes.push(`${user} ${cli} --version exit ${r.status}: ${(r.stdout || r.stderr).trim().split('\n')[0]}`);
        if (r.status !== 0) pass = false;
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  // b. The web service's environment, built exactly as Runtime.mjs builds it.
  const runtimeSource = readFileSync(`${PROGRAM}/app/native/Runtime.mjs`, 'utf8');
  for (const needle of ["JOSI_MCP_SERVER: join(PROGRAM, 'app/packages/agent/dist/mcp/server.js')", "CLAUDE_CONFIG_DIR: join(data, 'codex', 'claude-code')",
    "HOME: join(data, 'profiles', role)", "join(PROGRAM, 'cli/bin')"]) {
    assert(runtimeSource.includes(needle), `installed Runtime.mjs no longer contains ${needle}`);
  }
  const role = 'web';
  const env = {
    PATH: `${PROGRAM}/node/bin:${PROGRAM}/cli/bin:/usr/bin:/bin`, TMPDIR: `${DATA}/temp/${role}`, HOME: `${DATA}/profiles/${role}`,
    JOSI_MCP_SERVER: `${PROGRAM}/app/packages/agent/dist/mcp/server.js`, CLAUDE_CONFIG_DIR: `${DATA}/codex/claude-code`,
    NODE_ENV: 'production', JOSI_NATIVE_RUNTIME: '1', JOSI_VERSION: runtime.version, JOSI_DATA_DIR: DATA,
    JOSI_STORAGE_ROOT_BASE: `${DATA}/roots`, JOSI_UPLOAD_DIR: `${DATA}/chat-attachments`,
    MASTER_KEY_FILE: `${DATA}/secrets/${role}/master-key`, PGPASSWORD_FILE: `${DATA}/secrets/${role}/database-password`,
    DATABASE_URL: `postgresql://josi@127.0.0.1:${runtime.databasePort}/josi`, PGHOST: '127.0.0.1', PGPORT: String(runtime.databasePort),
    POSTGRES_DB: 'josi', POSTGRES_USER: 'josi', LD_LIBRARY_PATH: `${PROGRAM}/postgresql/lib`, CODEX_HOME: `${DATA}/codex`,
    E2E_PROGRAM: PROGRAM, E2E_FAKE_URL: fake.url, E2E_FAKE_KEY: FAKE_KEY, E2E_TOOL_MARKER: TOOL_MARKER,
    E2E_WHICH: process.env.E2E_WHICH ?? 'claude,codex',
  };
  // c. Run the driver in a transient unit with the web unit's identity and hardening.
  const stage = mkdtempSync(`${DATA}/temp/web/josi-e2e-driver-`);
  copyFileSync(join(HERE, 'e2e-fake-cli-driver.mjs'), join(stage, 'driver.mjs'));
  for (const p of [stage, join(stage, 'driver.mjs')]) chownSync(p, Number(execFileSync('id', ['-u', 'josi-ce-web']).toString()), Number(execFileSync('id', ['-g', 'josi-ce-web']).toString()));
  const mark = fake.requests.length;
  let out;
  try {
    const args = ['--quiet', '--wait', '--pipe', '--collect', '--service-type=exec', '-p', 'User=josi-ce-web', '-p', 'Group=josi-ce-web',
      '-p', 'SupplementaryGroups=josi-ce-app', '-p', 'UMask=0077', '-p', 'NoNewPrivileges=yes', '-p', 'PrivateTmp=yes',
      '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=read-only', '-p', `ReadWritePaths=${DATA}`, '-p', `WorkingDirectory=${PROGRAM}/app`,
      '-p', 'RestrictSUIDSGID=yes', '-p', 'LockPersonality=yes',
      ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), `${PROGRAM}/node/bin/node`, join(stage, 'driver.mjs')];
    // Asynchronous on purpose: the fake model lives in THIS process's event
    // loop, and a synchronous wait would leave every CLI request unanswered.
    const r = await new Promise((resolve) => {
      const child = spawn('systemd-run', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), 900000);
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('E2E_RESULT '));
    if (!line) throw new Error(`driver produced no result (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(-800)}`);
    out = JSON.parse(line.slice('E2E_RESULT '.length));
  } finally { rmSync(stage, { recursive: true, force: true }); }
  evidence.cli = out;
  const reqs = since(fake, mark);
  if (out.fatal) { pass = false; notes.push(`driver fatal: ${out.fatal.slice(0, 400)}`); }
  notes.push(`driver ran as uid ${out.uid} groups ${out.groups}; JOSI_MCP_SERVER=${out.mcpServer} exists=${out.mcpServerExists}, Josi resolves it to ${out.resolvedMcpServer}`);
  const smoke = out.mcpSmoke ?? {};
  const smokeOk = smoke.tools?.includes('record_number') && smoke.executed?.some((c) => c.name === 'josi_health');
  if (!smokeOk) pass = false;
  notes.push(`MCP server started from that path: tools/list ${JSON.stringify(smoke.tools)}, josi_health executed and recorded: ${!!smokeOk}`);
  for (const which of ['claude', 'codex']) {
    const e = out[which] ?? {};
    const api = which === 'claude' ? '/messages' : '/responses';
    const mine = reqs.filter((r) => r.path === api);
    const toolAsk = mine.find((r) => r.answer?.tool);
    const toolBack = mine.find((r) => r.seen?.toolResults?.some((t) => t.id === toolAsk?.answer.toolCallId));
    const probeTool = e.probe?.steps?.find((s) => s.id === 'toolCalling');
    const chatExec = (e.chat?.executedToolCalls ?? []).map((c) => c.name);
    const ok = !!(e.probe?.capabilities?.chat && probeTool?.passed && toolAsk && toolBack && chatExec.includes('josi_health'));
    if (!ok) pass = false;
    const runs = out.runs.filter((r) => r.consumer === which);
    notes.push(`${which}: ${runs.length} CLI runs (exit codes ${runs.map((r) => r.code).join(',')}, Josi args accepted by guardian rule: `
      + `${runs.every((r) => r.argsAcceptedByGuardian)}); fake ${api} got ${mine.length} requests (fake key: ${mine.every((r) => r.authorized)}), `
      + `tool asked: ${toolAsk?.answer.tool.name ?? 'none'}, result returned to model: ${!!toolBack}; Josi probe `
      + `${(e.probe?.steps ?? []).map((s) => `${s.id}=${s.passed ? 'pass' : 'fail'}`).join(' ') || e.probeError}; `
      + `chat reply ${JSON.stringify((e.chat?.text ?? e.chatError ?? '').slice(0, 120))}, executedToolCalls from Josi's calls file ${JSON.stringify(chatExec)}`
      + (ok ? '' : `; last stderr: ${JSON.stringify((runs.at(-1)?.stderrTail ?? '').slice(-400))}`));
  }
  const after = snapshot();
  const b = new Set(before.split('\n')), a = new Set(after.split('\n'));
  const changed = [...[...a].filter((l) => !b.has(l)).map((l) => `+${l}`), ...[...b].filter((l) => !a.has(l)).map((l) => `-${l}`)];
  const clean = !changed.length && !(out.leftoverTemp ?? []).length;
  if (!clean) pass = false;
  notes.push(`CODEX_HOME, CLAUDE_CONFIG_DIR, web/worker profiles, /etc/claude-code, /etc/codex unchanged: ${!changed.length}`
    + `${changed.length ? ` ${JSON.stringify(changed)}` : ''}; leftover temp: ${JSON.stringify(out.leftoverTemp)}`);
  verdict('5 Claude Code + Codex CLIs', pass ? 'PASS' : 'FAIL', `${notes.join('\n  ')}\n  NOTE: driven through Josi's providers with a test runner `
    + 'in place of the Vault guardian; the guardian path itself cannot be pointed at a fake backend (see report).');
}
