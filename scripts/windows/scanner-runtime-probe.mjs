// Copied into a private fixture's app directory. No source document or secret
// leaves the test; emit only the verdict from the installed scanner adapter.
import { dirname, join } from 'node:path';
import { nativeScanner } from '@josi-ce/storage';
const program = dirname(dirname(process.execPath));
const scanner = nativeScanner({ python: join(program, 'python/python.exe'),
  adapter: join(program, 'app/services/scanner/windows_amsi.py'),
  scratch: join(process.env.JOSI_DATA_DIR, 'temp/scanner') });
try {
  console.log(JSON.stringify({ status: await scanner.scanStatus(Buffer.from('Josi antivirus availability check.')) }));
} finally { scanner.close(); }
