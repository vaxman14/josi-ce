// Real bundled OCR inference; no downloaded language data or writable cache.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { extractRichSegments } from '../../packages/storage/dist/extract.js';

const evidence = resolve('artifacts/windows-native/evidence');
const bytes = await readFile(resolve(evidence, 'ocr-fixture.png'));
const segments = await extractRichSegments({ extension: 'png', bytes, ocrImages: true });
const text = segments?.map((s) => s.content).join(' ');
assert.match(text ?? '', /JOSI WINDOWS OCR 314159/);
assert.equal(await extractRichSegments({ extension: 'png', bytes }), null);
const report = {
  recordedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  runtime: process.version, passed: true, engine: 'bundled Tesseract.js',
  fixtureSha256: createHash('sha256').update(bytes).digest('hex'), text,
  optInPreserved: true, installedService: false,
};
await writeFile(resolve(evidence, 'ocr-spike.json'), JSON.stringify(report, null, 2) + '\n');
console.log('Real bundled OCR and opt-in boundary passed.');
