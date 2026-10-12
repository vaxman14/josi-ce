// Real packaged CLIs in a disposable installation; never uses the owner's login.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
process.umask(0o077);
const [root, mode = 'status'] = process.argv.slice(2);
assert.ok(root.startsWith('/private/tmp/josi-ce-native-tests-') && /\/acceptance-\d+$/.test(root));
const cfg = JSON.parse(readFileSync(join(root, 'data/config/runtime.json')));
const program = join(root, 'versions', cfg.version);
const { subscriptionEnvironment } = await import(pathToFileURL(join(program, 'app/native/SubscriptionEnvironment.mjs')));
const { codexLoginStatus, claudeAuthStatus, DeviceLogin, ClaudeLogin, resolveMcpServerPath, openHarnessSession, readExecutedCalls, writeClaudeMcpConfig, codexArgs, childEnvironment } = await import(pathToFileURL(join(program, 'app/packages/llm/dist/index.js')));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, subscriptionEnvironment(program, join(root, 'data'), 'web'));
Object.assign(process.env, { JOSI_NATIVE_RUNTIME: '1', JOSI_NATIVE_ISOLATED_ROOT: join(root, 'data'), JOSI_DATA_DIR: join(root, 'data'), JOSI_STORAGE_ROOT_BASE: join(root, 'data/roots') });
process.env.TMPDIR = join(root, 'data/temp/web');
process.chdir(join(program, 'app'));
assert.match(execFileSync('codex', ['--version'], { encoding: 'utf8' }), /0\.152\.0/);
assert.match(execFileSync('codex', ['exec', '--help'], { encoding: 'utf8' }), /--json/);
assert.match(execFileSync('claude', ['--version'], { encoding: 'utf8' }), /2\.1\.258/);
const codex = await codexLoginStatus({ codexHome: process.env.CODEX_HOME });
const claude = await claudeAuthStatus({ configDir: process.env.CLAUDE_CONFIG_DIR });
assert.equal(codex.installed, true); assert.equal(codex.signedIn, false);
assert.equal(claude.installed, true); assert.equal(claude.signedIn, false);
assert.equal(claude.authMethod, 'none');
// Both service roles must resolve the same durable vendor configuration.
const worker = subscriptionEnvironment(program, join(root, 'data'), 'worker');
assert.equal(worker.CODEX_HOME, process.env.CODEX_HOME);
assert.equal(worker.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
assert.equal(worker.JOSI_MCP_SERVER, process.env.JOSI_MCP_SERVER);
const serverPath = resolveMcpServerPath();
assert.equal(serverPath, join(program, 'app/packages/agent/dist/mcp/server.js'));
// Exercise the real packaged entry through each provider's generated MCP
// command/config, without signing in or making a model request. The calls
// ledger, rather than model prose, proves that record_number actually ran.
for (const provider of ['codex', 'claude']) {
  const session = openHarnessSession({ serverPath, tools: [] });
  try {
    let config;
    if (provider === 'codex') {
      const args = codexArgs('test', session);
      const overrides = args.flatMap((arg, i) => arg === '-c' ? ['-c', args[i + 1]] : []);
      // The official CLI must accept and resolve the exact generated config.
      const resolved = JSON.parse(execFileSync('codex', [...overrides, 'mcp', 'get', 'josi', '--json'], { encoding: 'utf8', env: childEnvironment(), timeout: 15_000 }));
      config = resolved.transport;
    } else {
      config = JSON.parse(readFileSync(writeClaudeMcpConfig(session))).mcpServers.josi;
    }
    assert.equal(config.command, process.execPath);
    assert.deepEqual(config.args, [serverPath]);
    assert.equal(config.env.JOSI_MCP_CONTEXT, session.contextPath);
    assert.equal(config.env.JOSI_NATIVE_RUNTIME, '1');
    assert.equal(config.env.JOSI_DATA_DIR, join(root, 'data'));
    const requests = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'native-acceptance', version: '1' } } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'record_number', arguments: { value: 7 } } },
    ];
    const replies = execFileSync(config.command, config.args, { encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...config.env }, input: requests.map(r => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n' }).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies.find(r => r.id === 1).result.serverInfo.name, 'josi-tools');
    assert.ok(replies.find(r => r.id === 2).result.tools.some(t => t.name === 'record_number'));
    const call = replies.find(r => r.id === 3);
    assert.equal(call.result.isError, false);
    assert.deepEqual(JSON.parse(call.result.content[0].text), { ok: true, recorded: 7 });
    assert.deepEqual(readExecutedCalls(session.callsPath), [{ id: '3', name: 'record_number', input: { value: 7 }, result: { ok: true, recorded: 7 } }]);
  } finally { session.cleanup(); }
}
console.log('PASS native tool server initialization, tool listing and recorded tool execution through Codex and Claude MCP configurations');
if (mode === 'seed') {
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'retention-sentinel.txt'), 'subscription configuration retained', { mode: 0o600 });
} else if (mode === 'retained') {
  assert.equal(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'retention-sentinel.txt'), 'utf8'), 'subscription configuration retained');
} else if (mode === 'login') {
  const attempts = [new DeviceLogin({ codexHome: process.env.CODEX_HOME }), new ClaudeLogin({ configDir: process.env.CLAUDE_CONFIG_DIR })];
  try {
    const openai = await attempts[0].start(45_000);
    assert.equal(openai.state, 'awaiting_approval'); assert.ok(openai.challenge);
    const anthropic = await attempts[1].start(45_000);
    assert.equal(anthropic.state, 'awaiting_code'); assert.ok(anthropic.challenge);
    console.log('PASS official Codex device challenge and Claude Code sign-in link parsed; no account authorized');
  } finally { for (const attempt of attempts) attempt.cancel(); }
}
console.log(`PASS bundled Codex and Claude Code versions, honest signed-out status and durable configuration (${mode})`);
