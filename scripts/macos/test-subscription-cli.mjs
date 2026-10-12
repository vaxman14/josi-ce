// Real packaged CLIs in a disposable installation; never uses the owner's login.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, mode = 'status'] = process.argv.slice(2);
assert.ok(root.startsWith('/private/tmp/josi-ce-native-tests-') && /\/acceptance-\d+$/.test(root));
const cfg = JSON.parse(readFileSync(join(root, 'data/config/runtime.json')));
const program = join(root, 'versions', cfg.version);
const { subscriptionEnvironment } = await import(pathToFileURL(join(program, 'app/native/SubscriptionEnvironment.mjs')));
const { codexLoginStatus, claudeAuthStatus, DeviceLogin, ClaudeLogin } = await import(pathToFileURL(join(program, 'app/packages/llm/dist/index.js')));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, subscriptionEnvironment(program, join(root, 'data'), 'web'));
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
