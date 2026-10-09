import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createRequire} from 'node:module';
const root=process.argv[2];
assert(root.startsWith('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests/'));
assert.equal(JSON.parse(readFileSync(join(root,'data/isolated-test.json'))).purpose,'disposable-native-acceptance');
const program=resolve(dirname(process.execPath),'../..'),require=createRequire(join(program,'app/package.json'));
const postgres=require('postgres'),cfg=JSON.parse(readFileSync(join(root,'data/config/runtime.json')));
const sql=postgres({host:'127.0.0.1',port:cfg.databasePort,username:'josi',database:'josi',password:readFileSync(join(root,'data/secrets/web/database-password'),'utf8'),max:1,onnotice:()=>{}});
try{
  assert.equal((await sql`select count(*)::int as n from _migrations`)[0].n,65);
  if(process.argv[3]==='seed'){
    await sql`create table native_acceptance_sentinel(value text not null)`;
    await sql`insert into native_acceptance_sentinel values ('retained across cold rollback and upgrade')`;
  }
  assert.equal((await sql`select value from native_acceptance_sentinel`)[0].value,'retained across cold rollback and upgrade');
  console.log('PASS 65 migrations and retained database sentinel');
}finally{await sql.end();}
