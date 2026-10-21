// Validate the pinned real CLI's image/schema wire format against a local fixture.
// No vendor endpoint, real login or real photo participates.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexArgs, extractReply } from '../../packages/llm/dist/providers/codexCli.js';
import { codexTurnSchema } from '../../packages/llm/dist/providers/codexTurn.js';

const command = process.argv[2];
assert.ok(command?.startsWith('/'), 'Pass the absolute bundled Codex binary path');
const directory = await mkdtemp(join(tmpdir(), 'josi-codex-wire-check-'));
let observed, calls = 0;
const value = '{"reply":"Synthetic fixture response.","tool":null}';
const server = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part;
  if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
  observed = JSON.parse(body); calls++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: value, annotations: [] }] };
  for (const [type, payload] of [
    ['response.created', { response: { id: 'resp_fixture', status: 'in_progress', output: [] } }],
    ['response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
    ['response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: value }],
    ['response.output_item.done', { output_index: 0, item }],
    ['response.completed', { response: { id: 'resp_fixture', status: 'completed', output: [item],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }],
  ]) res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n');
  res.end();
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const schema = codexTurnSchema({ messages: [], tools: [] });
  await writeFile(join(directory, 'schema.json'), JSON.stringify(schema), { mode: 0o600 });
  await writeFile(join(directory, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=', 'base64'), { mode: 0o600 });
  const args = codexArgs('gpt-5-codex', null, ['image.png'], 'schema.json');
  args.splice(args.length - 1, 0, '-c', 'model_provider="fixture"',
    '-c', 'model_providers.fixture.name="Local test fixture"',
    '-c', 'model_providers.fixture.base_url="http://127.0.0.1:' + port + '/v1"',
    '-c', 'model_providers.fixture.wire_api="responses"',
    '-c', 'model_providers.fixture.requires_openai_auth=false');
  const child = spawn(command, args, { cwd: directory, env: {
    PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory, TMPDIR: directory,
    NO_COLOR: '1', CI: '1', LANG: 'en_US.UTF-8',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.stdin.end('Return exactly the required JSON response for this synthetic image test.');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  clearTimeout(timeout);
  assert.equal(code, 0, stderr);
  assert.equal(extractReply(stdout), value);
  assert.equal(calls, 1);
  assert.equal(observed.text.format.type, 'json_schema');
  assert.deepEqual(observed.text.format.schema, schema);
  assert.ok(observed.input.some(item => item.content?.some(part => part.type === 'input_image' && part.image_url.startsWith('data:image/'))),
    JSON.stringify(observed.input) + '\n' + stderr);
  assert.ok(!JSON.stringify(observed.tools).includes('mcp__josi'));
  console.log('PASS: real bundled CLI transmitted a real image block and strict JSON schema to the local fixture and returned the structured step. No live model inference tested.');
} finally { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }

