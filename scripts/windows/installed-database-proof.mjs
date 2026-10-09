// Read-only acceptance of the owned physical engineering installation.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, unlink, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { compare, normalize } from './logical-dump-compare.mjs';
import { typedNormalize } from './logical-timezone-normalize.mjs';
import { compareScheduler } from './logical-operational-compare.mjs';
const [program, data, root, label] = process.argv.slice(2);
assert.ok(['baseline','after-repair','after-migrate','after-services'].includes(label));
assert.equal((await realpath(process.execPath)).toLowerCase(), join(program,'node/JosiRuntime.exe').toLowerCase());
assert.equal(JSON.parse(await readFile(join(data,'installation.json'),'utf8')).installationId,'b5a3b94c72624209908a5a965bf6867d');
const require=createRequire(join(program,'app/package.json'));
const postgres=require('postgres'), {readWindowsSecret}=require('@josi-ce/core');
const config=JSON.parse(await readFile(join(data,'config/runtime.json'),'utf8'));
const password=readWindowsSecret(join(data,'secrets/database-password'));
let sql, passfile;
try {
  sql=postgres({host:'127.0.0.1',port:config.databasePort,username:'josi',database:'josi',password:password.toString('ascii'),max:1,connect_timeout:10,onnotice:()=>{}});
  const metadata=await sql.begin('read only',async tx=>{
    const [row]=await tx.unsafe(await readFile(join(root,'database-permissions.sql'),'utf8'));
    return Object.values(row)[0];
  });
  assert.equal(metadata.database.owner,'josi');
  const applicationRole=metadata.roles.find(role=>role.name==='josi');
  assert.ok(applicationRole.login && !applicationRole.superuser && !applicationRole.createDb && !applicationRole.createRole && !applicationRole.replication && !applicationRole.bypassRls);
  const historical=JSON.parse(await readFile(join(root,'prior-ownership-acls.json'),'utf8'));
  assert.deepEqual(metadata,historical,'Database ownership or permissions changed: stop without restore');
  const [migration]=await sql`select array_agg(name order by name) as names from public._migrations`;
  const available=(await readdir(join(program,'app/packages/db/migrations'))).filter(name=>name.endsWith('.sql')).sort();
  assert.deepEqual(migration.names,available,'Candidate has unapplied or missing migrations: review before changing live schema');
  passfile=join(root,`${label}-pgpass.conf`);
  await writeFile(passfile,`127.0.0.1:${config.databasePort}:josi:josi:${password.toString('ascii')}\n`,{flag:'wx'});
  const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,SystemDrive:process.env.SystemRoot.slice(0,2),PATH:join(program,'postgresql/bin'),TEMP:root,TMP:root,PGPASSFILE:passfile,PGCONNECT_TIMEOUT:'10',PGCLIENTENCODING:'UTF8',PGTZ:'UTC'};
  const dump=await new Promise((resolve,reject)=>{
    const child=spawn(join(program,'postgresql/bin/pg_dump.exe'),['--no-password','-h','127.0.0.1','-p',String(config.databasePort),'-U','josi','-d','josi','--no-owner','--no-privileges','--clean','--if-exists'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const output=[];let bytes=0;
    const timer=setTimeout(()=>child.kill(),90000);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>128*1024*1024)child.kill();else output.push(chunk);});
    child.stderr.on('data',()=>{});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(output)):reject(new Error('Private logical dump failed'));});
  });
  await writeFile(join(root,`${label}-logical.sql`),dump,{flag:'wx'});
  await writeFile(join(root,`${label}-ownership-acls.json`),JSON.stringify(metadata,null,2),{flag:'wx'});
  const retained=typedNormalize(await readFile(join(root,'retained-logical.sql'))).buffer;
  let current=typedNormalize(dump).buffer,readinessTimestampChanged=false;
  if(label!=='baseline'){
    // API readiness reconciles the same public address at each boot and touches
    // deployment_config.updated_at. Preserve the real dump and compare every
    // other field; only this known operational timestamp may differ.
    const before=normalize(retained).tables.get('public.deployment_config');
    const after=normalize(current).tables.get('public.deployment_config');
    assert.equal(before.columns,after.columns);assert.equal(before.rows.length,1);assert.equal(after.rows.length,1);
    const index=before.columns.split(', ').indexOf('updated_at');assert.ok(index>=0);
    const oldFields=before.rows[0].split('\t'),newFields=after.rows[0].split('\t');
    readinessTimestampChanged=oldFields[index]!==newFields[index];
    newFields[index]=oldFields[index];
    const text=current.toString();
    const header=`COPY public.deployment_config (${after.columns}) FROM stdin;\r\n`;
    assert.equal(text.split(header).length,2);
    current=Buffer.from(text.replace(header+after.rows[0]+'\n',header+newFields.join('\t')+'\n'));
  }
  const comparison=compare(retained,current);
  // A real worker advances scheduler rows and consumes housekeeping jobs.
  // Permit only those two operational tables after the service acceptance;
  // schema, sequences, every other row, and all permissions must still match.
  const scheduler=label==='after-services'?compareScheduler(retained,current):{};
  const result={passed:comparison.exactNormalizedMatch,restrictedRole:true,permissionsUnchanged:true,migrationCount:available.length,expectedOperationalChanges:false,readinessTimestampChanged,ignoredOperationalColumns:readinessTimestampChanged?['public.deployment_config.updated_at']:[],...comparison,...scheduler};
  await writeFile(join(root,`${label}-proof.json`),JSON.stringify(result,null,2),{flag:'wx'});
  assert.ok(result.passed,'Existing schema, rows or sequences differ: stop without restore');
  console.log(JSON.stringify({passed:true,label,permissionsUnchanged:true,migrationCount:available.length,tables:comparison.tablesCompared}));
} catch {
  console.error(`Installed database acceptance failed during ${label}; preserved evidence requires review. No restore was performed.`);
  process.exitCode=1;
} finally {
  password.fill(0);
  await sql?.end({timeout:5});
  if(passfile)await unlink(passfile);
}
