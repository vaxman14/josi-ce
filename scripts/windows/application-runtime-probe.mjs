// Copied into the isolated application fixture so module resolution can reach
// ONLY that payload. This file is not installed with the product.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { hash, verify } from '@node-rs/argon2';
import { connectFromEnv, loadMasterKey } from '@josi-ce/core';
import { writeAttachment, readAttachment, removeAttachment, extractRichSegments, nativeScanner } from '@josi-ce/storage';
import nodemailer from 'nodemailer';

const key = loadMasterKey();
assert.equal(key.reveal().length, 32);
const password = randomUUID();
assert.equal(await verify(await hash(password), password), true);
const { db, close } = await connectFromEnv();
try {
  const [role] = await db.query('select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname=current_user');
  assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  const [migrations] = await db.query('select count(*)::integer as count from _migrations');
  assert.ok(migrations.count >= 63);
  const id = randomUUID(), body = Buffer.from('Packaged artifact — café');
  await writeAttachment(id, body);
  assert.deepEqual(await readAttachment(id), body);
  await removeAttachment(id);
  const segments = await extractRichSegments({ extension: 'png', bytes: await readFile(process.argv[2]), ocrImages: true });
  assert.match(segments.map(s => s.content).join(' '), /JOSI WINDOWS OCR 314159/);
  // Exercise the updated mail dependency without contacting or sending to anyone.
  const result = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
    from: 'test@example.test', to: 'fixture@example.test', subject: 'Native MIME fixture', text: 'café',
  });
  assert.match(result.message.toString(), /Subject: Native MIME fixture/);
  const program = dirname(dirname(process.execPath));
  const scanner = nativeScanner({ python: join(program, 'python/python.exe'),
    adapter: join(program, 'app/services/scanner/windows_amsi.py'),
    scratch: join(process.env.JOSI_DATA_DIR, 'temp/scanner') });
  try {
    assert.deepEqual(await scanner.scan(Buffer.from('A packaged clean document.')), { clean: true });
    const eicar = Buffer.from(['X5O!P%@AP[4', '\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''));
    const verdict = await scanner.scan(eicar);
    assert.equal(verdict.clean, false);
    assert.match(verdict.signature, /Windows antivirus/);
  } finally { scanner.close(); }
  console.log(JSON.stringify({ passed: true, executable: process.execPath, nativePasswordHash: true,
    privateMasterKey: true, restrictedDatabaseRole: true, migrations: migrations.count,
    artifactWriteReadDelete: true, realOcr: true, realMalwareScanner: true, mimeRenderingWithoutSending: true }));
} finally { await close(); }
