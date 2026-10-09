import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const base='/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port';
const lock='packaging/macos/extra-sources.lock.json';const rows=JSON.parse(readFileSync(lock));
const skia=rows.find(x=>x.package==='skia');
const deps=execFileSync('/usr/bin/tar',['-xOf',base+'/source-closure/'+skia.path,'skia-'+skia.version+'/DEPS'],{encoding:'utf8'});
const wanted=new Set(['brotli','expat','freetype','harfbuzz','highway','icu','libjpeg-turbo','libjxl','libpng','libwebp','wuffs','zlib']);
for(const match of deps.matchAll(/"third_party\/externals\/([^"]+)"\s*:\s*"(https:[^"]+)@([a-f0-9]{40})"/g)){
  const [,name,repo,commit]=match;if(!wanted.has(name))continue;
  const path=`native/skia-${name}-${commit}.tar.gz`,existing=rows.find(x=>x.path===path);
  if(existing&&existsSync(base+'/source-closure/'+path)){if(createHash('sha256').update(readFileSync(base+'/source-closure/'+path)).digest('hex')!==existing.sha256)throw Error('Source pin changed');continue;}
  const url=repo.replace(/\.git$/,'')+'/+archive/'+commit+'.tar.gz';
  const response=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error(response.status+' '+url);
  const bytes=Buffer.from(await response.arrayBuffer()),sha256=createHash('sha256').update(bytes).digest('hex');
  writeFileSync(base+'/source-closure/'+path,bytes);rows.push({path,url,sha256,size:bytes.length,package:'skia-'+name,version:commit});
  writeFileSync(lock,JSON.stringify(rows,null,2)+'\n');console.log('Verified Skia source',name,commit);
}
