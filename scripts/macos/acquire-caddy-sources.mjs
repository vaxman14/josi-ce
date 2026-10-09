import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
const base='/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port';
mkdirSync(base+'/caddy-sources',{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const escape=s=>s.replace(/[A-Z]/g,c=>'!'+c.toLowerCase());
const rows=[];
for(const line of readFileSync(base+'/caddy-build-info.txt','utf8').split('\n')){
  const [kind,name,version,h1]=line.split('\t');if(kind!=='dep')continue;
  const url=`https://proxy.golang.org/${escape(name)}/@v/${escape(version)}.zip`;
  const filename=name.replaceAll('/','__')+'@'+version+'.zip',path=base+'/caddy-sources/'+filename;
  let bytes;
  if(existsSync(path))bytes=readFileSync(path);
  else{const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error(`${response.status} ${url}`);bytes=Buffer.from(await response.arrayBuffer());}
  const files=unzipSync(bytes);const sum=createHash('sha256');
  for(const name of Object.keys(files).sort()){if(name.includes('\n'))throw Error('Unsafe Go module name');sum.update(`${hash(files[name])}  ${name}\n`);}
  if('h1:'+sum.digest('base64')!==h1)throw Error('Go module content pin mismatch '+name);
  if(!existsSync(path))writeFileSync(path,bytes,{flag:'wx'});
  const notices=Object.keys(files).filter(n=>/(^|\/)(LICENSE|COPYING|NOTICE)([^/]*$)/i.test(n));
  if(!notices.length)throw Error('No license notice '+name);
  rows.push({name,version,url,filename,h1,sha256:hash(bytes),notices});console.log('Verified source and notices',name,version);
}
writeFileSync('packaging/macos/caddy-sources.lock.json',JSON.stringify(rows,null,2)+'\n');
