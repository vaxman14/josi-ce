// Owned synthetic SCM acceptance only. No SQL, password or fixture text in argv.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

let sql;
try {
  const [operation, program, data, id] = process.argv.slice(2);
  if (process.platform !== 'win32' || process.argv.length !== 6
      || !['prepare', 'mutate', 'verify', 'cleanup'].includes(operation)
      || !/^[a-f0-9]{32}$/.test(id ?? '')
      || JSON.parse(readFileSync(join(data, 'installation.json'), 'utf8')).installationId !== 'b5a3b94c72624209908a5a965bf6867d'
      || realpathSync(process.execPath).toLowerCase() !== join(program, 'node/JosiRuntime.exe').toLowerCase()) throw new Error();
  const require = createRequire(join(program, 'app/package.json'));
  const postgres = require('postgres');
  const { readWindowsSecret } = require('@josi-ce/core');
  const config = JSON.parse(readFileSync(join(data, 'config/runtime.json'), 'utf8'));
  sql = postgres({ host: '127.0.0.1', port: config.databasePort, username: 'josi', database: 'josi',
    password: readWindowsSecret(join(data, 'secrets/database-password')).toString('ascii'),
    max: 1, connect_timeout: 10, onnotice: () => {} });
  // Only the test's exclusive table and nonce are changed. Existing application
  // tables and credentials are never modified by this fixture.
  if (operation === 'prepare') {
    await sql.unsafe('create table public.josi_native_lifecycle_acceptance (id text primary key, value text not null)');
    await sql`insert into public.josi_native_lifecycle_acceptance values (${id}, 'original')`;
  } else if (operation === 'mutate') {
    await sql`update public.josi_native_lifecycle_acceptance set value = 'changed' where id = ${id}`;
  } else if (operation === 'verify') {
    const rows = await sql`select value from public.josi_native_lifecycle_acceptance where id = ${id}`;
    if (rows.length !== 1 || rows[0].value !== 'original') throw new Error();
    const roles = await sql`select rolsuper, rolcreatedb, rolcreaterole, rolreplication from pg_roles where rolname = current_user`;
    if (roles.length !== 1 || Object.values(roles[0]).some(Boolean)) throw new Error();
  } else {
    const rows = await sql`select id from public.josi_native_lifecycle_acceptance`;
    if (rows.length !== 1 || rows[0].id !== id) throw new Error();
    await sql.unsafe('drop table public.josi_native_lifecycle_acceptance');
  }
  console.log(JSON.stringify({ passed: true, operation }));
} catch {
  console.error('Owned lifecycle fixture failed; retained test material requires recovery.');
  process.exitCode = 1;
} finally { await sql?.end({ timeout: 5 }); }
