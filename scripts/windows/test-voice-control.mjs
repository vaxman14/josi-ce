import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateTemporaryDirectory } from '../../packages/core/dist/index.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
process.env.TEMP = join(repo, 'artifacts/windows-native/cache');
process.env.TMP = process.env.TEMP;
const root = privateTemporaryDirectory('josi-voice-control-');
try {
  const child = spawn(join(repo, 'artifacts/windows-native/tools/python-3.12.15/python/python.exe'),
    ['-B', join(repo, 'scripts/windows/test_voice_control.py'), root],
    { stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  process.exitCode = code ?? 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
