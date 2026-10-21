// Development counterpart of packaging/windows/DatabaseBootstrap.mjs: same
// statements and secret checks, run from the checkout instead of the installed program.
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { readWindowsSecret } from '@josi-ce/core';

const data = process.argv[2];
let sql;
try {
  const settings = JSON.parse(readFileSync(join(data, 'config/runtime.json'), 'utf8'));
  const initFile = join(data, 'secrets/init-password');
  const admin = readWindowsSecret(initFile, 'database-bootstrap').toString('ascii');
  const application = readWindowsSecret(join(data, 'secrets/database-password')).toString('ascii');
  if (![admin, application].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error('Unexpected secret format');
  sql = postgres({ host: '127.0.0.1', port: settings.databasePort, username: 'bootstrap_admin',
    database: 'postgres', password: admin, max: 1, connect_timeout: 10, onnotice: () => {} });
  // Generated hex only. PostgreSQL utility statements do not bind passwords.
  await sql.unsafe(`create role josi login nosuperuser nocreatedb nocreaterole noreplication password '${application}'`);
  await sql.unsafe('create database josi owner josi');
  await sql.unsafe('alter role bootstrap_admin nologin password null');
  await sql.end(); sql = undefined;
  unlinkSync(initFile);
  console.log('Development database provisioned; bootstrap login revoked.');
} catch (error) {
  console.error('Development database provisioning did not complete:', error.message);
  process.exitCode = 1;
} finally { await sql?.end({ timeout: 5 }); }
