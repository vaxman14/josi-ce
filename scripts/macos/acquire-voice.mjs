import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root='/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port';
for(const d of ['wheels','sources','models'])mkdirSync(root+'/'+d,{recursive:true});
const digest=b=>createHash('sha256').update(b).digest('hex');
async function get(url){const r=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw new Error(`${r.status}: ${url}`);return Buffer.from(await r.arrayBuffer());}
async function file(url,path,hash){if(existsSync(path)){if(digest(readFileSync(path))!==hash)throw new Error('Cache mismatch: '+path);return;}const b=await get(url);if(digest(b)!==hash)throw new Error('Hash mismatch');writeFileSync(path,b,{flag:'wx'});}
if(existsSync('packaging/macos/voice-inputs.lock.json')){
  const pinned=JSON.parse(readFileSync('packaging/macos/voice-inputs.lock.json'));
  for(const x of pinned)await file(x.url,root+'/'+(x.kind==='wheel'?'wheels/':'sources/')+x.filename,x.sha256);
  for(const x of JSON.parse(readFileSync('services/voice-box/models.lock.json')).files)await file(x.url,root+'/models/'+x.path.replaceAll('/','__'),x.sha256);
  writeFileSync(root+'/voice-inputs.json',JSON.stringify(pinned,null,2));
  console.log('All locked macOS speech inputs verified');process.exit(0);
}
const entries=[...readFileSync('services/voice-box/requirements.lock','utf8').matchAll(/^([a-z0-9-]+)==([^\s]+) /gm)].map(m=>[m[1],m[2]]);
entries.push(['ctranslate2','4.8.2']);
const records=[];
for(const [name,version] of entries){
  const meta=JSON.parse(await get(`https://pypi.org/pypi/${name}/${version}/json`));
  const wheels=meta.urls.filter(x=>x.filename.endsWith('.whl')&&(/-(py3|py2.py3|cp311)-none-any.whl$/.test(x.filename)||(/macosx_.*(arm64|universal2)/.test(x.filename)&&(/-cp311-/.test(x.filename)||/-cp3[89]-abi3-/.test(x.filename)||/-cp310-abi3-/.test(x.filename)))));
  wheels.sort((a,b)=>Number(b.filename.includes('arm64'))-Number(a.filename.includes('arm64')));
  const source=meta.urls.find(x=>x.packagetype==='sdist');
  const wheel=name==='numpy'?wheels.find(x=>x.filename==='numpy-2.2.6-cp311-cp311-macosx_14_0_arm64.whl'):wheels[0];
  if(!wheel&&name!=='docopt')throw new Error('No reviewed arm64 wheel '+name+' '+version);
  for(const [kind,x] of [['wheel',wheel],['source',source]])if(x){await file(x.url,root+'/'+(kind==='wheel'?'wheels/':'sources/')+x.filename,x.digests.sha256);records.push({name,version,kind,filename:x.filename,url:x.url,sha256:x.digests.sha256,license:meta.info.license_expression||meta.info.license||meta.info.classifiers.filter(x=>x.startsWith('License ::')).join('; ')});}
  console.log('Verified',name,version);
  writeFileSync(root+'/voice-inputs.partial.json',JSON.stringify(records,null,2));
}
const modelURL='https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl';
const model=await get(modelURL);const modelHash=digest(model);if(modelHash!=='1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85')throw Error('English model pin mismatch');writeFileSync(root+'/wheels/en_core_web_sm-3.8.0-py3-none-any.whl',model);
records.push({name:'en-core-web-sm',version:'3.8.0',kind:'wheel',filename:'en_core_web_sm-3.8.0-py3-none-any.whl',url:modelURL,sha256:modelHash,license:'MIT'});
for(const x of JSON.parse(readFileSync('services/voice-box/models.lock.json')).files){await file(x.url,root+'/models/'+x.path.replaceAll('/','__'),x.sha256);console.log('Verified model',x.path);}
writeFileSync(root+'/voice-inputs.json',JSON.stringify(records,null,2));
