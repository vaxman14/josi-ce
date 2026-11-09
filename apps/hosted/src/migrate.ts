// Applies apps/hosted/supabase/migrations in order. Run it with `npm run migrate`
// from this folder, or `node dist/migrate.js`.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectFromEnv, type Db } from '@josi-ce/core';

export const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
const LOCK = 7482915;

/** One statement at a time, because PGlite's parameterised path takes only one
 * and this way both drivers run the same code in the same transaction. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let at = 0, start = 0;
  while (at < sql.length) {
    const two = sql.slice(at, at + 2);
    if (two === '--') { const end = sql.indexOf('\n', at); at = end < 0 ? sql.length : end; continue; }
    if (two === '$$') { const end = sql.indexOf('$$', at + 2); at = end < 0 ? sql.length : end + 2; continue; }
    if (sql[at] === "'") { at++; while (at < sql.length && sql[at] !== "'") at++; at++; continue; }
    if (sql[at] === ';') { out.push(sql.slice(start, at)); start = at + 1; }
    at++;
  }
  out.push(sql.slice(start));
  // A piece of nothing but comments is no statement.
  return out.filter(piece => piece.replace(/--.*$/gm, '').trim());
}

export async function runMigrations(db: Db, dir = MIGRATIONS): Promise<string[]> {
  if (!db.transaction) throw new Error('Migrations need transactions');
  await db.query('create schema if not exists heyjosi');
  await db.query('create table if not exists heyjosi.schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  await db.query('alter table heyjosi.schema_migrations enable row level security');
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
    await db.transaction(async tx => {
      // Two boots at once must not both apply a file. A transaction-scoped lock
      // because a Supabase pooler may hand each transaction a different session.
      await tx.query('select pg_advisory_xact_lock($1::bigint)', [LOCK]);
      if ((await tx.query('select 1 from heyjosi.schema_migrations where name = $1', [file])).length) return;
      for (const statement of splitStatements(readFileSync(join(dir, file), 'utf8'))) await tx.query(statement);
      await tx.query('insert into heyjosi.schema_migrations (name) values ($1)', [file]);
      applied.push(file);
    });
  }
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { db, close, describe } = await connectFromEnv(process.env, { max: 1 });
  const applied = await runMigrations(db);
  console.log(`${describe}: ${applied.length ? `applied ${applied.join(', ')}` : 'already up to date'}`);
  await close();
}
