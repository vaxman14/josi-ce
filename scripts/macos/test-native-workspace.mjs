import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root=process.argv[2],mode=process.argv[3];
assert(root.startsWith('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests/'));
assert.equal(JSON.parse(readFileSync(join(root,'data/isolated-test.json'))).purpose,'disposable-native-acceptance');
const program=resolve(dirname(process.execPath),'../..'),require=createRequire(join(program,'app/package.json'));
const postgres=require('postgres'),cfg=JSON.parse(readFileSync(join(root,'data/config/runtime.json')));
const sql=postgres({host:'127.0.0.1',port:cfg.databasePort,username:'josi',database:'josi',password:readFileSync(join(root,'data/secrets/web/database-password'),'utf8'),max:1,onnotice:()=>{}});
try {
  if(mode==='seed') {
    await sql`insert into users(email,username,role) values('native-workspace@example.test','fixture_owner','super_admin')`;
  } else if(mode==='verify') {
    const [row]=await sql`select m.id,m.owner_user_id,r.container_path,r.writable,r.enabled from folder_mappings m join storage_roots r on r.id=m.root_id where r.container_path='/workspace'`;
    assert(row && row.enabled && !row.writable);
    Object.assign(process.env,{JOSI_NATIVE_RUNTIME:'1',JOSI_WORKSPACE_ENABLED:'1',JOSI_WORKSPACE_NATIVE_PATH:cfg.workspace.path,JOSI_WORKSPACE_NATIVE_ID:`${cfg.workspace.dev}:${cfg.workspace.ino}`,JOSI_STORAGE_ROOT_BASE:join(root,'data/roots')});
    const {workspaceRead,workspaceChange}=await import(pathToFileURL(join(program,'app/packages/storage/dist/localWorkspace.js')));
    const db={query:(text,args=[])=>sql.unsafe(text,args)};
    const file=await workspaceRead(db,row.owner_user_id,row.id,'chosen.txt');assert.equal(file.data.toString(),'selected native folder');
    await assert.rejects(workspaceChange(db,row.owner_user_id,row.id,{operation:'create',path:'unauthorized.txt',content:'refuse'}),/not authorized/);
    console.log('PASS real native server /workspace mapping, selected-folder read and write refusal');
  } else if(mode==='declined') {
    assert.equal((await sql`select count(*)::int as n from storage_roots where container_path='/workspace' and enabled=true`)[0].n,0);
    console.log('PASS real server workspace decline disables discovery');
  } else throw Error('Unknown test mode');
} finally { await sql.end(); }
