/** Darwin has no Linux procfs directory paths. Opaque in-process names below
 * resolve only to held descriptors; every mutation uses a *at syscall. */
import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
const held = new Map<string, number>();
let bindings: ReturnType<typeof load> | undefined;
function load() {
  if (process.platform !== 'darwin') throw new Error('Darwin filesystem unavailable');
  const k = createRequire(import.meta.url)('koffi'), l = k.load('/usr/lib/libSystem.B.dylib');
  return { k, openat:l.func('int openat(int, const char *, int, ...)'), close:l.func('int close(int)'),
    dup:l.func('int dup(int)'), mkdirat:l.func('int mkdirat(int, const char *, uint16_t)'),
    unlinkat:l.func('int unlinkat(int, const char *, int)'),
    renameat:l.func('int renameat(int,const char *,int,const char *)'),
    linkat:l.func('int linkat(int,const char *,int,const char *,int)'),
    fdopendir:l.func('void *fdopendir(int)'), readdir:l.func('void *readdir(void *)'),
    closedir:l.func('int closedir(void *)'), errno:l.func('int *__error()') };
}
const api = () => bindings ??= load();
function check(n: number) {
  if(n !== -1) return n;
  const a=api(), e=a.k.decode(a.errno(),'int');
  throw Object.assign(new Error('Descriptor-relative filesystem operation refused'),
    {code:({2:'ENOENT',13:'EACCES',17:'EEXIST',20:'ENOTDIR',28:'ENOSPC',40:'ELOOP',62:'ELOOP'} as Record<number,string>)[e]??'EIO'});
}
function parsed(path:string):[number,string]|undefined {
  if(!path.startsWith('/josi-held/')) return;
  const m=/^\/josi-held\/([a-f0-9-]{36})(?:\/([^/]+))?$/.exec(path);
  if(!m||!held.has(m[1])||m[2]==='.'||m[2]==='..'||m[2]?.includes('\0')) throw new Error('Expired or invalid directory capability');
  return [held.get(m[1])!,m[2]??'.'];
}
const flags=fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|0x01000000;
function fdOpen(path:string, mode:number, permissions=0o600) {
  const p=parsed(path); if(!p) throw new Error('Expected held directory');
  return check(api().openat(p[0],p[1],mode|flags,'int',permissions));
}
export function pinMacDirectory(path:string):{path:string;close():Promise<void>} {
  let fd=-1;
  try {
    if(parsed(path)) fd=fdOpen(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
    else {
      if(!path.startsWith('/')||path.includes('\0')) throw new Error('Absolute directory required');
      const parts=path.split('/').filter(Boolean);
      if(parts.some(p=>p==='.'||p==='..'))throw new Error('Invalid directory');
      // AT_FDCWD is -2 on Darwin. Each subsequent name is relative to a held fd.
      fd=check(api().openat(-2,'/',flags|fs.constants.O_RDONLY|fs.constants.O_DIRECTORY));
      for(const part of parts){const next=check(api().openat(fd,part,flags|fs.constants.O_RDONLY|fs.constants.O_DIRECTORY));api().close(fd);fd=next;}
    }
    const id=randomUUID();held.set(id,fd);fd=-1;
    return {path:'/josi-held/'+id,async close(){const value=held.get(id);if(value!==undefined){held.delete(id);api().close(value);}}};
  }finally{if(fd>=0)api().close(fd);}
}
export async function macOpen(path:string, mode:number, permissions?:number):Promise<FileHandle> {
  if(!parsed(path))return promises.open(path,mode,permissions);
  let fd=fdOpen(path,mode,permissions);
  const live=()=>{if(fd<0)throw new Error('Closed file');return fd;};
  return {
    get fd(){return live();},async stat(){return fs.fstatSync(live());},
    async read(buffer:Buffer,offset:number,length:number,position:number|null){return {bytesRead:fs.readSync(live(),buffer,offset,length,position),buffer};},
    async readFile(options?:any){return fs.readFileSync(live(),options);},
    async writeFile(data:any){if(typeof data==='string'||Buffer.isBuffer(data)){fs.writeFileSync(live(),data);return;}
      for await(const chunk of data)fs.writeFileSync(live(),chunk);},
    async sync(){fs.fsyncSync(live());},async truncate(n=0){fs.ftruncateSync(live(),n);},
    createReadStream(options:any={}){return fs.createReadStream('',{...options,fd:live(),autoClose:false});},
    async close(){if(fd>=0){api().close(fd);fd=-1;}},
  } as unknown as FileHandle;
}
export async function macReadFile(path:string, encoding?:BufferEncoding):Promise<any>{
  if(!parsed(path))return promises.readFile(path,encoding);
  const h=await macOpen(path,fs.constants.O_RDONLY);try{return await h.readFile(encoding);}finally{await h.close();}
}
export const macStat=async(path:string)=>{const p=parsed(path);if(!p)return promises.stat(path);const h=await macOpen(path,fs.constants.O_RDONLY);try{return await h.stat();}finally{await h.close();}};
export async function macReaddir(path:string, options?:{withFileTypes:true}):Promise<any[]> {
  const p=parsed(path);if(!p)return options?promises.readdir(path,options):promises.readdir(path);
  const a=api(), fd=fdOpen(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY), dir=a.fdopendir(fd);
  if(!dir){a.close(fd);throw new Error('Cannot enumerate held directory');}
  const result:any[]=[];
  try{for(;;){a.k.encode(a.errno(),'int',0);const entry=a.readdir(dir);if(!entry){if(a.k.decode(a.errno(),'int'))throw new Error('Directory enumeration failed');break;}
    const header=a.k.decode(entry,'uint8',21) as number[];
    const length=header[18]|(header[19]<<8),type=header[20];
    if(length<1||length>1023)throw new Error('Invalid directory entry');
    const bytes=a.k.decode(entry,'uint8',21+length) as number[];
    const name=Buffer.from(bytes.slice(21)).toString('utf8');if(name==='.'||name==='..')continue;
    result.push(options?{name,isFile:()=>type===8,isDirectory:()=>type===4,isSymbolicLink:()=>type===10}:name);
    if(result.length>10000)throw new Error('Directory enumeration limit exceeded');
  }}finally{a.closedir(dir);}return result;
}
export async function macMkdir(path:string,options?:{mode?:number}){const p=parsed(path);if(!p)return promises.mkdir(path,options);check(api().mkdirat(p[0],p[1],options?.mode??0o700));}
export async function macUnlink(path:string){const p=parsed(path);if(!p)return promises.unlink(path);check(api().unlinkat(p[0],p[1],0));}
export async function macRename(from:string,to:string){const a=parsed(from),b=parsed(to);if(!a&&!b)return promises.rename(from,to);if(!a||!b)throw new Error('Cannot cross capability boundary');check(api().renameat(a[0],a[1],b[0],b[1]));}
export async function macLink(from:string,to:string){const a=parsed(from),b=parsed(to);if(!a&&!b)return promises.link(from,to);if(!a||!b)throw new Error('Cannot cross capability boundary');check(api().linkat(a[0],a[1],b[0],b[1],0));}
