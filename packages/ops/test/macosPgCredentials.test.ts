import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { pgBackupWriter } from '../src/pgWriter.js';

describe.skipIf(process.platform !== 'darwin')('native macOS PostgreSQL credential transport', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  it('uses a protected temporary file and scrubs inherited credentials/options in a real child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'josi-pg-test-'));
    roots.push(root);
    const marker = join(root, 'transport.json');
    // This fixture is a fake pg_dump executable, not a PostgreSQL acceptance test.
    const source = `#!${process.execPath}\n` + `
      const fs = require('node:fs');
      if (process.env.PGPASSWORD || process.env.PGOPTIONS || process.env.PROVIDER_SECRET) process.exit(10);
      const path = process.env.PGPASSFILE;
      if (!path || fs.statSync(path).mode & 0o077) process.exit(11);
      if (fs.readFileSync(path, 'utf8') !== '127.0.0.1:15432:josi:josi:fixture\\\\:credential\\n') process.exit(12);
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ path, args: process.argv.slice(2) }));
      process.stdout.write('select 1;');
    `;
    writeFileSync(join(root, 'pg_dump'), source, { mode: 0o700 });
    vi.stubEnv('JOSI_NATIVE_RUNTIME', '1');
    vi.stubEnv('PGPASSWORD', 'must-not-inherit');
    vi.stubEnv('PGOPTIONS', '-c malicious=1');
    vi.stubEnv('PROVIDER_SECRET', 'must-not-inherit');
    const writer = pgBackupWriter({ host: '127.0.0.1', port: 15432, database: 'josi',
      user: 'josi', password: 'fixture:credential', toolsDirectory: root });
    const destination = join(root, 'backup.gz');
    await writer.write({ kind: 'portable', contents: {} as never, destination });
    expect(gunzipSync(readFileSync(destination)).toString()).toBe('select 1;');
    const transport = JSON.parse(readFileSync(marker, 'utf8'));
    expect(transport.args).toContain('--no-password');
    expect(transport.args.join(' ')).not.toContain('fixture:credential');
    expect(existsSync(transport.path)).toBe(false);
  });
  it('refuses a developer PATH fallback for native backup tools', async () => {
    vi.stubEnv('JOSI_NATIVE_RUNTIME', '1');
    vi.stubEnv('JOSI_PG_BIN', '');
    const writer = pgBackupWriter({ host: '127.0.0.1', port: 15432, database: 'josi', user: 'josi' });
    await expect(writer.write({ kind: 'portable', contents: {} as never, destination: '/never-created' }))
      .rejects.toThrow('bundled database tools');
  });
});
