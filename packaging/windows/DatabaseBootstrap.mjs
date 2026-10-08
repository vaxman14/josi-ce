// Fixed, local, one-shot installer operation. No query or password arguments.
import { readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { readWindowsSecret } from '@josi-ce/core';

let sql;
try {
  if (process.platform !== 'win32' || process.argv.length !== 3) throw new Error();
  const program = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (realpathSync(process.execPath).toLowerCase() !== join(program, 'node/JosiRuntime.exe').toLowerCase()) throw new Error();
  const data = resolve(dirname(process.argv[2]), '..');
  if (process.argv[2] !== join(data, 'config/runtime.json')) throw new Error();
  const settings = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (!Number.isInteger(settings.databasePort) || settings.databasePort < 1024 || settings.databasePort > 65535) throw new Error();
  const initFile = join(data, 'secrets/init-password');
  const admin = readWindowsSecret(initFile, 'database-bootstrap').toString('ascii');
  const application = readWindowsSecret(join(data, 'secrets/database-password')).toString('ascii');
  if (![admin, application].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error();
  sql = postgres({ host: '127.0.0.1', port: settings.databasePort, username: 'bootstrap_admin',
    database: 'postgres', password: admin, max: 1, connect_timeout: 10, onnotice: () => {} });
  // Generated hex only. PostgreSQL utility statements do not bind passwords.
  await sql.unsafe(`create role josi login nosuperuser nocreatedb nocreaterole noreplication password '${application}'`);
  await sql.unsafe('create database josi owner josi');
  await sql.unsafe('alter role bootstrap_admin nologin password null');
  await sql.end(); sql = undefined;
  unlinkSync(initFile);
  console.log('Private application database provisioned; bootstrap login revoked.');
} catch {
  console.error('Private database provisioning did not complete. Installer recovery is required.');
  process.exitCode = 1;
} finally { await sql?.end({ timeout: 5 }); }
