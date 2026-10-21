// Real supervisor, disposable synthetic login and inert CLI. Never reads a user login.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secret } from '../../packages/core/dist/index.js';
import { startVaultCodex } from '../../packages/llm/dist/providers/codexVaultRuntime.js';

const directory = await mkdtemp(join(tmpdir(), 'josi-photo-supervisor-check-'));
const command = join(directory, 'fixture-cli');
const auth = new Secret(JSON.stringify({ auth_mode: 'chatgpt',
  tokens: { id_token: 'synthetic-id', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } }));
try {
  await writeFile(command, '#!' + process.execPath + '\n' + `
    const fs = require('node:fs'), path = require('node:path');
    const photo = fs.readFileSync('josi-image-0.jpg');
    const schema = JSON.parse(fs.readFileSync('josi-response.schema.json','utf8'));
    if (photo.toString() !== 'synthetic photo' || schema.type !== 'object') process.exit(2);
    if ((fs.statSync('josi-image-0.jpg').mode & 0o777) !== 0o600) process.exit(3);
    if ((fs.statSync(process.cwd()).mode & 0o777) !== 0o700) process.exit(4);
    if (process.env.OPENAI_API_KEY) process.exit(5);
    process.stdin.resume();
    process.stdin.on('end', () => console.log(JSON.stringify({ home: process.env.CODEX_HOME })));
  `, { mode: 0o700 });
  for (const refuse of [false, true]) {
    let checked = 0, finished = 0, abandoned = 0;
    const store = { consumer: 'codex', begin: async () => ({ lease: { id: 'synthetic' }, projection: auth }),
      requireCurrent: async () => {}, finish: async (_lease, value) => { assert.equal(value.reveal(), auth.reveal()); finished++; },
      abandon: async () => { abandoned++; } };
    const run = await startVaultCodex(store, { operation: 'chat', command, args: [], input: 'synthetic prompt', timeoutMs: 10_000,
      beforeStart: async () => { checked++; if (refuse) throw new Error('synthetic permission refusal'); },
      privateFiles: [
        { name: 'josi-image-0.jpg', base64: Buffer.from('synthetic photo').toString('base64') },
        { name: 'josi-response.schema.json', base64: Buffer.from('{"type":"object"}').toString('base64') },
      ] });
    const result = await run.result;
    assert.equal(checked, 1); assert.equal(finished, 1); assert.equal(abandoned, 0);
    assert.equal(run.consumerStopped(), true);
    if (refuse) { assert.equal(result.cancelled, true); assert.equal(result.stdout, ''); }
    else {
      assert.equal(result.code, 0); assert.equal(result.spawnError, false);
      const { home } = JSON.parse(result.stdout);
      await assert.rejects(access(home), { code: 'ENOENT' });
    }
  }
  console.log('PASS: private image/schema permissions, one dispatch gate, refusal before launch, cleanup after process closure; synthetic CLI only.');
} finally { await rm(directory, { recursive: true, force: true }); }

