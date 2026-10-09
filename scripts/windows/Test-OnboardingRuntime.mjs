// Only new, disposable data and ephemeral loopback listeners. Never SCM, the
// installed cluster, fixed voice ports, SQL restore, or a real owner account.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { privateTemporaryDirectory } from '../../packages/core/dist/index.js';

const base=resolve('artifacts/windows-native');
const app=JSON.parse(await readFile(join(base,'evidence/application-build.json'),'utf8'));
const runtime=JSON.parse(await readFile(join(base,'evidence/runtime-build.json'),'utf8'));
process.env.TEMP=join(base,'test-installations'); process.env.TMP=process.env.TEMP;
const fixture=privateTemporaryDirectory('onboarding-runtime-');
const program=join(fixture,'program'), data=join(fixture,'data'), logs=join(fixture,'logs');
for(const dir of ['config','secrets','temp/migrate','temp/web','temp/probe','chat-attachments','roots','state','codex'])await mkdir(join(data,dir),{recursive:true});
await mkdir(logs); await cp(app.payload,program,{recursive:true});
for(const name of ['node','postgresql'])await cp(join(runtime.payload,name),join(program,name),{recursive:true});
const node=join(program,'node/JosiRuntime.exe'), pg=join(program,'postgresql/bin'), entry=join(program,'app/native/Runtime.mjs');
const config=join(data,'config/runtime.json'), cluster=join(data,'database');
const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,COMSPEC:join(process.env.SystemRoot,'System32/cmd.exe'),
 PATH:join(process.env.SystemRoot,'System32'),TEMP:join(data,'temp/probe'),TMP:join(data,'temp/probe'),ProgramData:process.env.ProgramData,ProgramFiles:process.env.ProgramFiles};
const children=[];
function start(command,args,label){
 const child=spawn(command,args,{env,cwd:program,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const chunks=[];let bytes=0;for(const pipe of [child.stdout,child.stderr])pipe.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024)child.kill();else chunks.push(chunk);});
 child.done=new Promise((done,reject)=>{child.on('error',reject);child.on('exit',async code=>{await writeFile(join(logs,label+'.log'),Buffer.concat(chunks));done(code);});});
 child.done.catch(()=>{});children.push(child);return child;
}
async function run(command,args,label){const child=start(command,args,label);const result=await Promise.race([child.done,delay(90000,undefined,{ref:false}).then(()=>-1)]);if(result===-1)child.kill();assert.equal(result,0,`${label} failed; inspect the private fixture log.`);}
async function port(){const s=createServer();await new Promise((done,reject)=>{s.on('error',reject);s.listen(0,'127.0.0.1',done);});const p=s.address().port;await new Promise(done=>s.close(done));return p;}
const databasePort=await port(),apiPort=await port();assert.notEqual(databasePort,15432);assert.notEqual(apiPort,18080);
const initPassword=randomBytes(32).toString('hex'),dbPassword=randomBytes(32).toString('hex'),master=randomBytes(32).toString('hex'),bootstrap=randomBytes(32).toString('hex');
for(const [name,value]of [['init-password',initPassword],['database-password',dbPassword],['master-key',master]])await writeFile(join(data,'secrets',name),value,{flag:'wx'});
const configuration={schemaVersion:1,version:app.version,databasePort,apiPort,publicUrl:'http://localhost:8080',setupTokenSha256:createHash('sha256').update(bootstrap).digest('hex')};
await writeFile(config,JSON.stringify(configuration));
const require=createRequire(join(program,'app/package.json')), postgres=require('postgres');
let db,admin,browser,started=false;const url=`http://127.0.0.1:${apiPort}`;
try{
 await run(join(pg,'initdb.exe'),['-D',cluster,'-U','bootstrap_admin',`--pwfile=${join(data,'secrets/init-password')}`,'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C'],'initdb');
 await writeFile(join(cluster,'postgresql.auto.conf'),`listen_addresses='127.0.0.1'\nport=${databasePort}\npassword_encryption='scram-sha-256'\nlog_statement='none'\nlog_min_error_statement='panic'\nlog_parameter_max_length_on_error=0\n`);
 await run(join(pg,'pg_ctl.exe'),['start','-D',cluster,'-l',join(logs,'database.log'),'-w','-t','30'],'database-start');started=true;
 admin=postgres({host:'127.0.0.1',port:databasePort,username:'bootstrap_admin',database:'postgres',password:initPassword,max:1,onnotice:()=>{}});
 await admin.unsafe(`create role josi login nosuperuser nocreatedb nocreaterole noreplication password '${dbPassword}'`);
 await admin.unsafe('create database josi owner josi');await admin.end();admin=undefined;
 db=postgres({host:'127.0.0.1',port:databasePort,username:'josi',database:'josi',password:dbPassword,max:1,onnotice:()=>{}});
 // Apply the unchanged .5 schema in this fresh private cluster, then exercise
 // the current migration runner against retained rows and permissions.
 await db.unsafe('create table _migrations(name text primary key,applied_at timestamptz not null default now())');
 const migrationRoot=join(program,'app/packages/db/migrations');
 const migrationFiles=(await readdir(migrationRoot)).filter(name=>name.endsWith('.sql')).sort();
 const baselineFiles=migrationFiles.filter(name=>Number(name.slice(0,4))<=63);
 assert.equal(baselineFiles.length,63);
 for(const name of baselineFiles)await db.begin(async tx=>{await tx.unsafe(await readFile(join(migrationRoot,name),'utf8'));await tx`insert into _migrations(name) values(${name})`;});
 await db.unsafe("create table onboarding_fixture_sentinel(id integer primary key,value text); insert into onboarding_fixture_sentinel values(1,'Preserved disposable onboarding data')");
 const priorRows=await db`select * from onboarding_fixture_sentinel order by id`;
 const priorPermissions=await db`select table_name,grantee,privilege_type from information_schema.role_table_grants where table_schema='public' order by table_name,grantee,privilege_type`;
 const priorOwnership=await db`select tablename,tableowner from pg_tables where schemaname='public' order by tablename`;
 const originalTables=priorOwnership.map(row=>row.tablename);
 const protectedHash=createHash('sha256').update(await readFile(join(data,'secrets/master-key'))).digest('hex');
 await writeFile(config,JSON.stringify({...configuration,version:'0.1.78-native.5'}));
 await run(node,[entry,'migrate',config],'upgrade-migrations-before-activation');
 const [migrations]=await db`select count(*)::int as count from _migrations`;assert.equal(migrations.count,migrationFiles.length);
 const refused=start(node,[entry,'web',config],'unactivated-web');assert.equal(await refused.done,1);
 assert.deepEqual(await db`select * from onboarding_fixture_sentinel order by id`,priorRows);
 const currentPermissions=await db`select table_name,grantee,privilege_type from information_schema.role_table_grants where table_schema='public' order by table_name,grantee,privilege_type`;
 assert.deepEqual(currentPermissions.filter(row=>originalTables.includes(row.table_name)),Array.from(priorPermissions));
 const currentOwnership=await db`select tablename,tableowner from pg_tables where schemaname='public' order by tablename`;
 assert.deepEqual(currentOwnership.filter(row=>originalTables.includes(row.tablename)),Array.from(priorOwnership));
 const newTables=['pc_control_activity','pc_control_policies','pc_control_requests','pc_control_settings'];
 assert.deepEqual(currentOwnership.filter(row=>!originalTables.includes(row.tablename)),newTables.map(tablename=>({tablename,tableowner:'josi'})));
 const ownerPrivileges=['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'];
 assert.deepEqual(currentPermissions.filter(row=>!originalTables.includes(row.table_name)),newTables.flatMap(table_name=>ownerPrivileges.map(privilege_type=>({table_name,grantee:'josi',privilege_type}))));
 assert.equal(createHash('sha256').update(await readFile(join(data,'secrets/master-key'))).digest('hex'),protectedHash);
 await writeFile(config,JSON.stringify(configuration));
 const web=start(node,[entry,'web',config],'web');
 const deadline=Date.now()+30000;let ready=false;
 while(Date.now()<deadline){if(web.exitCode!==null)throw new Error('Packaged API stopped');try{ready=(await fetch(url+'/ready')).status===200;}catch{}if(ready)break;await delay(200);}
 assert.ok(ready);
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext();let external=0;
 await context.route('**/*',route=>{if(route.request().url().startsWith(url+'/'))return route.continue();external++;return route.abort();});
 const issue=async()=>{
   const csrfResponse=await context.request.get(url+'/api/auth/csrf');const {csrfToken}=await csrfResponse.json();
   const response=await context.request.post(url+'/api/onboarding/launch',{headers:{'x-josi-csrf':csrfToken,'x-josi-setup-token':bootstrap},data:{}});
   assert.equal(response.status(),200);return(await response.json()).token;
 };
 const token=await issue();const page=await context.newPage();
 await page.goto(url+'/setup#handoff='+token);
 await page.getByRole('button',{name:'Continue',exact:true}).waitFor();
 assert.equal(page.url(),url+'/setup');
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('josi_setup_handoff')),null);
 const cookie=(await context.cookies()).find(c=>c.name==='josi_setup_session');assert.ok(cookie.httpOnly);assert.equal(cookie.sameSite,'Strict');
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByLabel('Username',{exact:true}).fill('fixture-owner');
 await page.getByLabel('Email',{exact:true}).fill('fixture@example.test');
 await page.getByLabel('Password',{exact:true}).fill('Disposable-owner-password-2026');
 await page.getByRole('button',{name:/Create.*account/i}).click();
 await page.getByText('Save your Vault recovery key',{exact:true}).waitFor();
 const [vaultBefore]=await db`select master_key_enc,recovery_master_enc,recovery_key_hash from vault_state where id=true`;
 await page.reload();await page.getByText('Save your Vault recovery key',{exact:true}).waitFor();
 await page.getByRole('button',{name:'I saved it — continue setup'}).click();
 await page.getByText('Save your Vault recovery key',{exact:true}).waitFor({state:'hidden'});
 const [vaultAfter]=await db`select master_key_enc,recovery_master_enc,recovery_key_hash,pending_setup_recovery_enc,recovery_confirmed_at from vault_state where id=true`;
 assert.equal(vaultAfter.pending_setup_recovery_enc,null);assert.ok(vaultAfter.recovery_confirmed_at);
 for(const name of Object.keys(vaultBefore))assert.equal(vaultAfter[name],vaultBefore[name]);
 await browser.close();browser=undefined;
 // Reopening the desktop launcher creates a fresh link for the same DB state.
 browser=await chromium.launch({channel:'chrome',headless:true});const reopened=await browser.newContext();
 const csrf=await reopened.request.get(url+'/api/auth/csrf');const {csrfToken}=await csrf.json();
 const launch=await reopened.request.post(url+'/api/onboarding/launch',{headers:{'x-josi-csrf':csrfToken,'x-josi-setup-token':bootstrap},data:{}});
 const newToken=(await launch.json()).token;assert.notEqual(newToken,token);
 const resumed=await reopened.newPage();await resumed.goto(url+'/setup#handoff='+newToken);
 await resumed.getByText('Language model',{exact:true}).first().waitFor();assert.equal(resumed.url(),url+'/setup');
 const [owners]=await db`select count(*)::int as count from users`;assert.equal(owners.count,1);
 assert.deepEqual(await db`select * from onboarding_fixture_sentinel order by id`,priorRows);
 assert.equal(external,0);
 for(const file of await readdir(logs)){const contents=await readFile(join(logs,file),'utf8');for(const secret of [initPassword,dbPassword,master,bootstrap,token,newToken])assert.ok(!contents.includes(secret),'Private fixture log exposed a capability');}
 const report={passed:true,candidate:app.version,sourceInventorySha256:app.sourceInventorySha256,fixture,apiReady:true,
   cleanInstallMigrations:migrationFiles.length,upgradeBeforeActivation:true,unactivatedWriterRefused:true,rowsPermissionsSecretsPreserved:true,
   existingTableOwnershipPreserved:true,additiveTables:newTables,newTableGrantsOwnerOnly:true,
   realHeadlessChrome:true,tokenScrubbed:true,tokenNotStoredInBrowserStorage:true,httpOnlySetupSession:true,
   ownerCreatedOnce:true,recoveryPresentationResumed:true,recoveryWrapsUnchanged:true,pendingRecoveryClearedOnConfirmation:true,
   freshLinkResumesModelStep:true,logsExcludeCapabilities:true,externalRequests:external,servicesModified:false,installed:false,
   nativeDefaultBrowserPhysicalTested:false,completeModelProviderPhysicalTested:false};
 await writeFile(join(base,'evidence/onboarding-runtime.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:true,candidate:app.version,fixture}));
}finally{
 await browser?.close().catch(()=>{});await db?.end().catch(()=>{});await admin?.end().catch(()=>{});
 for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();await Promise.allSettled(children.map(c=>c.done));
 if(started)await run(join(pg,'pg_ctl.exe'),['stop','-D',cluster,'-m','fast','-w','-t','30'],'database-stop');
 for(const name of ['init-password','database-password','master-key'])await rm(join(data,'secrets',name),{force:true});
}
