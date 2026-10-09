import { connect } from 'node:net';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { ScannerUnavailable, type Scanner } from './gates.js';
export const nativeMac = () => process.platform === 'darwin' && process.env.JOSI_NATIVE_RUNTIME === '1';
export const MAC_SCAN_MESSAGE = 'Document ingestion is blocked. Configure a supported local scanner and verify its health before uploading, indexing or OCR. No scanner is bundled with Josi for macOS.';
function trustedSocket():string {
  const path=process.env.JOSI_SCANNER_SOCKET;
  if(!path||!path.startsWith('/')||/[\x00-\x1f]/.test(path)||realpathSync(path)!==path)throw new ScannerUnavailable(MAC_SCAN_MESSAGE);
  const s=lstatSync(path);
  if(!s.isSocket()||s.uid!==0||(s.mode&0o007))throw new ScannerUnavailable(MAC_SCAN_MESSAGE);
  const k=createRequire(import.meta.url)('koffi'),lib=k.load('/usr/lib/libSystem.B.dylib');
  const get=lib.func('void *acl_get_file(const char *, int)'),entry=lib.func('int acl_get_entry(void *, int, _Out_ void **)'),free=lib.func('int acl_free(void *)'),errno=lib.func('int *__error()');
  for(let p=path;;p=dirname(p)){
    if(p!==path){const d=lstatSync(p);if(!d.isDirectory()||d.isSymbolicLink()||d.uid!==0||(d.mode&0o022))throw new ScannerUnavailable(MAC_SCAN_MESSAGE);}
    k.encode(errno(),'int',0);const acl=get(p,0x100);
    if(!acl){if(k.decode(errno(),'int')!==2)throw new ScannerUnavailable(MAC_SCAN_MESSAGE);}
    else{try{k.encode(errno(),'int',0);if(entry(acl,0,[null])!==-1||k.decode(errno(),'int')!==22)throw new ScannerUnavailable(MAC_SCAN_MESSAGE);}finally{free(acl);}}
    if(p==='/')break;
  }
  return path;
}
/** Supported adapter: an administrator-configured clamd-compatible Unix socket.
 * No engine, definitions, updater, shell command or TCP listener is installed.
 * A successful PING is availability only; every document needs an exact verdict.
 */
export async function scannerExchange(resolvePath:()=>string,bytes?:Buffer):Promise<string>{
  let path:string;try{path=resolvePath();}catch{throw new ScannerUnavailable(MAC_SCAN_MESSAGE);}
  if(bytes&&bytes.length>100*1024*1024)throw new ScannerUnavailable('Document exceeds the scanner bound.');
  return new Promise((resolve,reject)=>{
    const socket=connect({path});let response=Buffer.alloc(0),settled=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(response.toString('utf8').replace(/\0$/,''));};
    const timer=setTimeout(()=>finish(new ScannerUnavailable(MAC_SCAN_MESSAGE)),45000);
    socket.once('error',()=>finish(new ScannerUnavailable(MAC_SCAN_MESSAGE)));
    socket.on('data',part=>{response=Buffer.concat([response,part]);if(response.length>4096)finish(new ScannerUnavailable(MAC_SCAN_MESSAGE));else if(response.includes(0))finish();});
    socket.once('end',()=>{if(!settled)finish(new ScannerUnavailable(MAC_SCAN_MESSAGE));});
    socket.once('connect',()=>{
      if(!bytes){socket.write('zPING\0');return;}
      socket.write('zINSTREAM\0');
      // write() backpressure bounds the queued document data to one chunk.
      let offset=0;
      const send=()=>{while(offset<bytes.length){const n=Math.min(65536,bytes.length-offset),header=Buffer.alloc(4);header.writeUInt32BE(n);socket.write(header);const ready=socket.write(bytes.subarray(offset,offset+n));offset+=n;if(!ready){socket.once('drain',send);return;}}socket.write(Buffer.alloc(4));};send();
    });
  });
}
const exchange=(bytes?:Buffer)=>scannerExchange(trustedSocket,bytes);
export async function macScannerHealth(){
  let available=false;try{available=await exchange()==='PONG';}catch{/* Never infer health from configuration alone. */}
  return {provider:'configured-local-scanner' as const,status:available?'available' as const:'unavailable' as const,checkedAt:new Date().toISOString(),required:true,enforced:true};
}
export const macScanner:Scanner={async scan(bytes){
  if(await exchange()!=='PONG')throw new ScannerUnavailable(MAC_SCAN_MESSAGE);
  const result=await exchange(bytes);
  if(result==='stream: OK')return {clean:true};
  if(/^stream: .+ FOUND$/.test(result))return {clean:false,signature:'Configured scanner blocked this document'};
  throw new ScannerUnavailable(MAC_SCAN_MESSAGE);
}};
export async function requireMacScan(bytes:Buffer){
  if(!nativeMac())return;
  const result=await macScanner.scan(bytes);
  if(!result.clean)throw new ScannerUnavailable('Document ingestion blocked: the configured scanner rejected this file.');
}
