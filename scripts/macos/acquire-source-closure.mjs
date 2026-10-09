import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
const base='/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function bytes(url){const r=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error(r.status+' '+url);return Buffer.from(await r.arrayBuffer());}
async function acquire(row){const path=base+'/source-closure/'+row.path;mkdirSync(dirname(path),{recursive:true});const b=existsSync(path)?readFileSync(path):await bytes(row.url);if(sha(b)!==row.sha256)throw Error('Source hash mismatch '+row.path);if(!existsSync(path))writeFileSync(path,b,{flag:'wx'});}
const rows=JSON.parse(readFileSync('services/voice-box/sources.lock.json')).files.filter(x=>!x.path.startsWith('debian/'));
let cursor=0;
await Promise.all(Array.from({length:6},async()=>{while(cursor<rows.length){const row=rows[cursor++];await acquire(row);console.log('Verified',row.path);}}));
if(existsSync('packaging/macos/extra-sources.lock.json')){
  for(const row of JSON.parse(readFileSync('packaging/macos/extra-sources.lock.json')))await acquire(row);
  console.log('All locked additional source materials verified');process.exit(0);
}
const extra=[];
for(const [name,version,repo] of [['@napi-rs/canvas','0.1.80','Brooooooklyn/canvas'],['@node-rs/argon2','2.2.0','napi-rs/node-rs'],['libheif-js','1.23.2','catdad-experiments/libheif-js']]){
  const meta=JSON.parse(await bytes(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`));
  if(!/^[a-f0-9]{40}$/.test(meta.gitHead))throw Error('No immutable source commit '+name);
  const url=`https://codeload.github.com/${repo}/tar.gz/${meta.gitHead}`,b=await bytes(url);
  const row={path:'native/'+name.replaceAll('/','__')+'-'+version+'.tar.gz',url,sha256:sha(b),size:b.length,package:name,version,commit:meta.gitHead,license:meta.license};
  await acquire(row);extra.push(row);
}
for(const [repo,tag] of [['microsoft/onnxruntime','v1.22.1'],['google/flatbuffers','v25.12.19']]){
  const url=`https://codeload.github.com/${repo}/tar.gz/${tag}`,b=await bytes(url);
  const row={path:'native/'+repo.replaceAll('/','__')+'-'+tag+'.tar.gz',url,sha256:sha(b),size:b.length,package:repo,version:tag};
  await acquire(row);extra.push(row);
}
writeFileSync('packaging/macos/extra-sources.lock.json',JSON.stringify(extra,null,2)+'\n');
