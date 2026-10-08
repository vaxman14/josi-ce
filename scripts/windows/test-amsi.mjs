// Real explicit requests to Windows' installed antivirus. Test bytes stay in
// memory; no antivirus settings, exclusions or definitions are modified.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativeScanner, NativeScanFailure } from '../../packages/storage/dist/nativeScanner.js';
const base = resolve('artifacts/windows-native');
const scratch = resolve(base, 'test-installations/amsi-temp');
await mkdir(scratch, { recursive: true });
const scanner = nativeScanner({ python: resolve(base, 'tools/python-3.12.15/python/python.exe'),
  adapter: resolve('services/scanner/windows_amsi.py'), scratch });
try {
  const content = Buffer.from('Josi explicit antivirus scan: ordinary clean document.');
  const start = performance.now();
  const first = scanner.scanStatus(content);
  assert.equal(await scanner.scanStatus(content), 'error'); // Bounded concurrent request.
  const clean = await first;
  assert.equal(clean, 'clean', 'The local antivirus did not return a clean result. No clean result is assumed.');
  const eicar = Buffer.from(['X5O!P%@AP[4', '\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''));
  const hash = createHash('sha256').update(eicar).digest('hex');
  assert.equal(await scanner.scanStatus(eicar), 'blocked');
  assert.equal((await scanner.scan(eicar)).clean, false);
  assert.equal(createHash('sha256').update(eicar).digest('hex'), hash);
  assert.deepEqual(await scanner.scan(content), { clean: true });
  const empty = await scanner.scanStatus(Buffer.alloc(0));
  assert.ok(['clean', 'error'].includes(empty)); // Provider may reject a zero-byte request.
  assert.equal(await scanner.scanStatus(Buffer.alloc(32 * 1024 * 1024 + 1)), 'error');
  const missing = nativeScanner({ python: '', adapter: '', scratch });
  assert.equal(await missing.scanStatus(content), 'unavailable');
  await assert.rejects(missing.scan(content), error => error instanceof NativeScanFailure && error.status === 'unavailable');
  const report = { passed: true, provider: 'windows-amsi', explicitAmsiScanBuffer: true,
    clean, realEicarBlocked: true, emptyStatus: empty, sourceBytesUnchanged: true,
    boundedConcurrency: true, byteBound: true, unavailableFailsClosed: true,
    startupAndScanMilliseconds: Math.round(performance.now() - start),
    bundledAntivirus: false, signatureDatabases: false, antivirusSettingsChanged: false,
    serviceIdentityTested: false };
  await writeFile(resolve(base, 'evidence/amsi-spike.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { scanner.close(); }
