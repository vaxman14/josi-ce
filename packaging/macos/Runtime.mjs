// Fixed launchd entry. Neither inherited environment nor browser input selects code.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const PROGRAM=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
try {
  if(process.platform!=='darwin'||process.arch!=='arm64')throw Error();
  const [role,configFile,test]=process.argv.slice(2);
  if(!['web','worker','migrate','bootstrap'].includes(role)||![4,5].includes(process.argv.length)||(test&&test!=='--isolated'))throw Error();
  if(realpathSync(process.execPath)!==join(PROGRAM,'node/bin/node'))throw Error();
  const data=resolve(dirname(configFile),'..');
  if(configFile!==join(data,'config/runtime.json'))throw Error();
  const isolated=!!test;
  if(isolated){
    const st=lstatSync(data), marker=JSON.parse(readFileSync(join(data,'isolated-test.json')));
    if(process.getuid()===0||!data.startsWith('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests/')||st.uid!==process.getuid()||(st.mode&0o077)||marker.purpose!=='disposable-native-acceptance')throw Error();
  }else if(data!=='/Library/Application Support/Josi CE Server/data')throw Error();
  const info=lstatSync(configFile);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>8192||info.uid!==(isolated?process.getuid():0)||(info.mode&0o022))throw Error();
  const cfg=JSON.parse(readFileSync(configFile)),meta=JSON.parse(readFileSync(join(PROGRAM,'app/package.json')));
  const keys=['schemaVersion','version','databasePort','apiPort','publicPort','voicePort','controlPort','setupTokenSha256','scannerSocket'];
  if(Object.keys(cfg).sort().join()!==keys.sort().join()||cfg.schemaVersion!==1||!/^\d+\.\d+\.\d+-[a-z0-9.]+$/.test(cfg.version)||!/^[a-f0-9]{64}$/.test(cfg.setupTokenSha256))throw Error();
  const ports=['databasePort','apiPort','publicPort','voicePort','controlPort'].map(k=>cfg[k]);
  if(ports.some(p=>!Number.isInteger(p)||p<1024||p>65535)||new Set(ports).size!==5)throw Error();
  if(typeof cfg.scannerSocket!=='string'||(cfg.scannerSocket&&!cfg.scannerSocket.startsWith('/')))throw Error();
  if(!['migrate','bootstrap'].includes(role)&&cfg.version!==meta.version)throw Error();
  for(const k of Object.keys(process.env))delete process.env[k];
  const secret=join(data,'secrets',role);
  Object.assign(process.env,{
    PATH:join(PROGRAM,'node/bin')+':/usr/bin:/bin',TMPDIR:join(data,'temp',role),
    NODE_ENV:'production',JOSI_NATIVE_RUNTIME:'1',JOSI_VERSION:cfg.version,JOSI_DATA_DIR:data,
    JOSI_STORAGE_ROOT_BASE:join(data,'roots'),JOSI_UPLOAD_DIR:join(data,'chat-attachments'),
    MASTER_KEY_FILE:join(secret,'master-key'),PGPASSWORD_FILE:join(secret,'database-password'),
    DATABASE_URL:`postgresql://josi@127.0.0.1:${cfg.databasePort}/josi`,PGHOST:'127.0.0.1',PGPORT:String(cfg.databasePort),POSTGRES_DB:'josi',POSTGRES_USER:'josi',JOSI_PG_BIN:join(PROGRAM,'postgresql/bin'),
    PORT:String(cfg.apiPort),APP_URL:`http://localhost:${cfg.publicPort}`,WEB_DIR:join(PROGRAM,'app/apps/web/dist'),
    JOSI_SETUP_TOKEN_SHA256:cfg.setupTokenSha256,JOSI_WORKER_HEARTBEAT_FILE:join(data,'state/worker-heartbeat'),
    CODEX_HOME:join(data,'codex'),JOSI_VOICE_HELPER_TOKEN_FILE:join(secret,'voice-control-token'),JOSI_VOICE_HELPER_PORT:String(cfg.controlPort),JOSI_SCANNER_SOCKET:cfg.scannerSocket,
    ...(isolated?{JOSI_NATIVE_ISOLATED_ROOT:data}:{})
  });
  process.chdir(join(PROGRAM,'app'));
  const {readMacSecret}=await import('../packages/core/dist/macosSecrets.js');
  if(role==='bootstrap'){
    const {default:postgres}=await import('postgres');
    const admin=readMacSecret(join(secret,'init-password')).toString().trim(),password=readMacSecret(join(secret,'database-password')).toString().trim();
    if(![admin,password].every(x=>/^[a-f0-9]{64}$/.test(x)))throw Error();
    const sql=postgres({host:'127.0.0.1',port:cfg.databasePort,username:'bootstrap_admin',database:'postgres',password:admin,max:1,onnotice:()=>{}});
    try{await sql.unsafe(`create role josi login nosuperuser nocreatedb nocreaterole noreplication password '${password}'`);await sql.unsafe('create database josi owner josi');await sql.unsafe('alter role bootstrap_admin nologin password null');}finally{await sql.end();}
  }else{
    if(role!=='migrate'){
      const {default:postgres}=await import('postgres');
      const password=readMacSecret(process.env.PGPASSWORD_FILE).toString().trim();
      let ready=false;
      for(let i=0;i<90&&!ready;i++){const sql=postgres({host:'127.0.0.1',port:cfg.databasePort,username:'josi',database:'josi',password,max:1,connect_timeout:1,onnotice:()=>{}});try{const rows=await sql`select count(*)::int as n from _migrations`;ready=rows[0].n>=65;}catch{}finally{await sql.end({timeout:1});}if(!ready)await delay(1000);}
      if(!ready)throw Error();
    }
    await import(pathToFileURL(join(PROGRAM,'app',role==='migrate'?'packages/db/migrate.mjs':`apps/${role==='web'?'api':'worker'}/dist/${role==='web'?'server':'main'}.js`)).href);
  }
}catch{console.error('Josi native runtime refused unsafe, unactivated or unavailable configuration. Preserve installer recovery evidence.');process.exitCode=1;}
