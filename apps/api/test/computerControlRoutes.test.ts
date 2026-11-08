import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSession, setPassword } from '@josi-ce/auth';
import { ComputerControl, computerCanonical, computerDeviceId, COMPUTER_CONTROL_VERSION, MasterKey, type Db } from '@josi-ce/core';
import { testDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
let db:Db,server:Server,base:string,owner:string,ownerToken:string,memberToken:string;
const raw=Buffer.alloc(32,49),master=new MasterKey(raw),password='synthetic-Mac-owner-password';
const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64'),deviceId=computerDeviceId(publicKey);
const directory=mkdtempSync(join(tmpdir(),'josi-mac-http-'));
const previous={native:process.env.JOSI_NATIVE_RUNTIME,data:process.env.JOSI_DATA_DIR};
function proof(method:string,body:Record<string,unknown>={}){
  const payload={version:COMPUTER_CONTROL_VERSION,ownerId:owner,deviceId,method,body,nonce:randomUUID(),timestamp:Date.now()};
  return {payload,signature:sign(null,Buffer.from(computerCanonical(payload)),keys.privateKey).toString('base64')};
}
async function call(path='',method='GET',body?:unknown,token=ownerToken){
  const response=await fetch(base+'/api/computer-control'+path,{method,headers:{'content-type':'application/json','x-josi-client':'native',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
}
beforeAll(async()=>{
  process.env.JOSI_NATIVE_RUNTIME='1';process.env.JOSI_DATA_DIR=directory;
  db=await testDb();await ensureWorkspace(db);
  owner=(await createUser(db,{email:'mac-owner@example.test',username:'mac-owner',role:'super_admin'})).id;
  const member=(await createUser(db,{email:'mac-member@example.test',username:'mac-member',role:'member'})).id;
  await setPassword(db,owner,password);ownerToken=(await createSession(db,{userId:owner})).token;memberToken=(await createSession(db,{userId:member})).token;
  server=createApp(db,{cookieSecure:false,appUrl:'http://localhost',masterKeyCheck:{readFile:()=>Buffer.from(raw.toString('base64'))}}).listen(0,'127.0.0.1');
  await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
  if(previous.native===undefined)delete process.env.JOSI_NATIVE_RUNTIME;else process.env.JOSI_NATIVE_RUNTIME=previous.native;
  if(previous.data===undefined)delete process.env.JOSI_DATA_DIR;else process.env.JOSI_DATA_DIR=previous.data;rmSync(directory,{recursive:true,force:true});
});
describe('native Mac control authenticated HTTP path',()=>{
  it('requires owner authentication and protected password plus possession for enrollment',async()=>{
    expect((await call('','GET',undefined,'')).status).toBe(401);
    expect((await call('','GET',undefined,memberToken)).status).toBe(403);
    expect((await call('/enroll','POST',{proof:proof('enroll',{publicKey,platform:'macos',label:'Acceptance Mac'})})).status).toBe(401);
    expect((await call('/enroll','POST',{password,proof:proof('enroll',{publicKey,platform:'macos',label:'Acceptance Mac'})})).status).toBe(200);
    expect((await call()).body.devices[0].stopped).toBe(true);
  });
  it('binds a protected decision to a digest and revision, then leases the exact operation only to this Mac',async()=>{
    const c=new ComputerControl(db,master),taskId=randomUUID();
    expect((await call('/device/presence','POST',{proof:proof('presence',{capabilities:['file.read']})})).status).toBe(200);
    const p=await c.propose(owner,deviceId,taskId,'Read my fixture file',{resume:true,rule:{id:randomUUID(),action:'file.read',scope:{kind:'folder',target:'/private/tmp/mac-fixture'},decision:'allow',duration:{kind:'saved'}}});
    expect((await call('/proposals/'+p.id+'/decision','POST',{approve:true,digest:p.digest})).status).toBe(401);
    expect((await call('/proposals/'+p.id+'/decision','POST',{approve:true,digest:'changed',password})).status).toBe(409);
    expect((await call('/proposals/'+p.id+'/decision','POST',{approve:true,digest:p.digest,password})).status).toBe(200);
    const q=await c.submit(owner,deviceId,taskId,{action:'file.read',scope:{kind:'folder',target:'/private/tmp/mac-fixture'},args:{path:'/private/tmp/mac-fixture/test.txt'}},'one');
    const claimed=await call('/device/next','POST',{proof:proof('next')});expect(claimed.body.request.id).toBe(q.id);
    expect((await call('/device/result','POST',{proof:proof('result',{requestId:randomUUID(),ok:true,result:'forged'})})).status).toBe(409);
    expect((await call('/device/result','POST',{proof:proof('result',{requestId:q.id,ok:true,result:{text:'fixture text'}})})).status).toBe(200);
    expect((await c.result(owner,q.id)).state).toBe('succeeded');
    expect(JSON.stringify((await call()).body)).not.toContain(password);
  });
  it('stops and revokes without a password and rejects the old device key afterwards',async()=>{
    expect((await call('/devices/'+deviceId+'/stop','POST',{})).status).toBe(200);
    expect((await call('/devices/'+deviceId,'DELETE')).status).toBe(200);
    expect((await call('/device/next','POST',{proof:proof('next')})).status).toBe(404);
  });
});
