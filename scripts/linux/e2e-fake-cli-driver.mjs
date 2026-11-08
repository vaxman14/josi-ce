// Runs INSIDE a josi-ce-web sandbox (started by e2e-fake.mjs through
// systemd-run with the web unit's user, groups and hardening, and the
// environment Runtime.mjs gives the web service). Drives Josi's OWN installed
// subscription providers (claudeCliProvider / codexCliProvider from the
// installed program's packages/llm/dist) and Josi's own capability probe
// against the fake backend.
//
// The single substitution: the Vault guardian runner. Production hands the CLI
// a Vault-stored vendor login in a fresh private home and a fixed environment
// that cannot be redirected to another endpoint (see the report). This runner
// builds that same private home and environment, and adds only the endpoint
// redirect (ANTHROPIC_BASE_URL for Claude Code; a model_provider in the private
// CODEX_HOME for Codex) plus a fake credential. Josi's argument lists, MCP
// configuration, prompt rendering, result parsing and calls-file accounting are
// all the installed code, unmodified.
//
// Prints one line `E2E_RESULT <json>` on stdout.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROGRAM = process.env.E2E_PROGRAM;
const FAKE_URL = process.env.E2E_FAKE_URL;
const FAKE_KEY = process.env.E2E_FAKE_KEY;
const WHICH = (process.env.E2E_WHICH ?? 'claude,codex').split(',');
const MARKER = process.env.E2E_TOOL_MARKER ?? 'E2E_CALL_TOOL';
const llm = await import(pathToFileURL(join(PROGRAM, 'app/packages/llm/dist/index.js')).href);
const policy = await import(pathToFileURL(join(PROGRAM, 'app/packages/llm/dist/providers/claudeVaultPolicy.js')).href);

const result = { uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
  mcpServer: process.env.JOSI_MCP_SERVER, mcpServerExists: existsSync(process.env.JOSI_MCP_SERVER ?? ''),
  resolvedMcpServer: llm.resolveMcpServerPath(), runs: [] };


/** The guardian's private home and environment (codexVaultGuardian.ts), plus
 * the redirect. Returns a SpawnRunner. */
function runnerFor(consumer, label) {
  return async ({ command, args, input, env: _ignored, timeoutMs, privateFiles }) => {
    const dir = mkdtempSync(join(process.env.TMPDIR, `josi-e2e-${consumer}-`));
    mkdirSync(join(dir, 'work'), { mode: 0o700 });
    for (const f of privateFiles ?? []) writeFileSync(join(dir, 'work', f.name), Buffer.from(f.base64, 'base64'), { mode: 0o600 });
    const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', NO_COLOR: '1', CI: '1', HOME: dir, TMPDIR: dir, TMP: dir,
      TEMP: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_DATA_HOME: dir };
    let finalArgs = args;
    // The guardian's own acceptance rule for these arguments (codexVaultGuardian.ts validStart).
    const accepted = consumer === 'claude' ? policy.validClaudeSubscriptionArgs(args)
      : !args.some((a) => /cli_auth_credentials_store|forced_login_method|chatgpt_base_url|model_provider|openai_base_url|api_key|auth\.json/i.test(a));
    if (consumer === 'claude') {
      Object.assign(env, { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: FAKE_KEY,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_BASE_URL: FAKE_URL });                                  // <- the redirect
    } else {
      env.CODEX_HOME = dir;
      // No ChatGPT auth.json: with one, Codex 0.152 also contacts OpenAI
      // (token refresh, ChatGPT apps MCP) whatever the model provider is. A
      // custom provider with a fake key in its env_key keeps every byte on
      // loopback. Josi's real path writes the Vault's ChatGPT auth.json here.
      env.E2E_FAKE_MODEL_KEY = FAKE_KEY;
      writeFileSync(join(dir, 'config.toml'), [                          // <- the redirect
        'model_provider = "e2efake"',
        '[model_providers.e2efake]',
        'name = "E2E fake backend"',
        `base_url = "${FAKE_URL}/v1"`,
        'wire_api = "responses"',
        'env_key = "E2E_FAKE_MODEL_KEY"',
        '',
      ].join('\n'), { mode: 0o600 });
      // The guardian's fixed prefix.
      finalArgs = ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', ...args];
    }
    const run = { label, consumer, command, args: finalArgs, argsAcceptedByGuardian: accepted, code: null, stdoutTail: '', stderrTail: '' };
    result.runs.push(run);
    try {
      return await new Promise((resolve) => {
        const child = spawn(command, finalArgs, { env, cwd: join(dir, 'work'), stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('error', (e) => { clearTimeout(timer); run.spawnError = String(e); resolve({ code: null, stdout, stderr: String(e), timedOut }); });
        child.on('close', (code) => {
          clearTimeout(timer);
          Object.assign(run, { code, timedOut, stdoutTail: stdout.slice(-1500), stderrTail: stderr.slice(-1500) });
          resolve({ code, stdout, stderr, timedOut });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** The tool server on its own: start it from JOSI_MCP_SERVER exactly as the
 * CLIs are told to, and ask it for its tool list and one call. */
async function mcpSmoke() {
  const session = llm.openHarnessSession({ serverPath: llm.resolveMcpServerPath(), tools: [] });
  try {
    const child = spawn(process.execPath, [session.serverPath], { env: { PATH: process.env.PATH, ...session.serverEnvironment },
      stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = [];
    let buf = '';
    child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { replies.push(JSON.parse(l)); } catch {} } });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'josi-e2e', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'josi_health', arguments: { message: 'e2e-mcp-smoke' } } });
    const deadline = Date.now() + 15000;
    while (replies.filter((r) => r.id).length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    child.kill();
    return { tools: replies.find((r) => r.id === 2)?.result?.tools?.map((t) => t.name) ?? null,
      call: replies.find((r) => r.id === 3)?.result ?? null, executed: llm.readExecutedCalls(session.callsPath) };
  } finally { session.cleanup(); }
}

try {
  result.mcpSmoke = await mcpSmoke();
  const tmpBefore = readdirSync(process.env.TMPDIR).filter((n) => n.startsWith('josi-'));
  for (const which of WHICH) {
    const command = join(PROGRAM, 'cli/bin', which);
    const model = which === 'claude' ? (process.env.E2E_CLAUDE_MODEL ?? 'claude-e2e-fake-model') : (process.env.E2E_CODEX_MODEL ?? 'e2e-fake-model');
    const make = (label) => which === 'claude'
      ? llm.claudeCliProvider({ model, command, runner: runnerFor('claude', label), timeoutMs: 120000 })
      : llm.codexCliProvider({ model, command, runner: runnerFor('codex', label), timeoutMs: 120000 });
    const entry = { which, model };
    result[which] = entry;
    try {
      // Josi's own five-part capability probe, the same one setup runs.
      const probe = await llm.probeProvider(make('probe'));
      entry.probe = { capabilities: probe.capabilities, steps: probe.steps.map((s) => ({ id: s.id, passed: s.passed, detail: s.detail })),
        fatal: probe.fatal ?? null };
    } catch (error) { entry.probeError = String(error?.message ?? error); }
    try {
      // One chat turn offering a tool, the way the assistant loop does.
      const reply = await make('chat').chat({
        messages: [{ role: 'user', content: `${MARKER}: check the Josi tool server.` }],
        tools: [{ name: 'josi_health', description: 'Echo a message back.', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }],
      });
      entry.chat = { text: reply.text, toolCalls: reply.toolCalls, executedToolCalls: reply.executedToolCalls ?? [] };
    } catch (error) { entry.chatError = String(error?.message ?? error); }
  }
  result.leftoverTemp = readdirSync(process.env.TMPDIR).filter((n) => n.startsWith('josi-') && !tmpBefore.includes(n));
} catch (error) {
  result.fatal = String(error?.stack ?? error);
}
console.log(`E2E_RESULT ${JSON.stringify(result)}`);
