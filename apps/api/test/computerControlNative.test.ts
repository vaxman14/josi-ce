import { afterAll, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSession, setPassword } from '@josi-ce/auth';
import { ComputerControl, MasterKey } from '@josi-ce/core';
import { executeComputerTool } from '../../../packages/agent/src/computerControlTools.js';
import { testDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

let server:Server|undefined, child:ChildProcess|undefined, directory:string|undefined;
const previous={native:process.env.JOSI_NATIVE_RUNTIME,data:process.env.JOSI_DATA_DIR};
afterAll(async()=>{
  if(child&&child.exitCode===null)child.kill('SIGTERM');
  if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  if(directory)rmSync(directory,{recursive:true,force:true});
  if(previous.native===undefined)delete process.env.JOSI_NATIVE_RUNTIME;else process.env.JOSI_NATIVE_RUNTIME=previous.native;
  if(previous.data===undefined)delete process.env.JOSI_DATA_DIR;else process.env.JOSI_DATA_DIR=previous.data;
});

it.runIf(process.platform==='darwin')('executes a scoped chat-tool file round trip through real Swift proofs, native authority and authenticated HTTP',async()=>{
  directory=mkdtempSync('/private/tmp/josi-native-http-');
  process.env.JOSI_NATIVE_RUNTIME='1';process.env.JOSI_DATA_DIR=directory;
  const binary=join(directory,'native-probe');
  const compilation=spawnSync('xcrun',['swiftc','-swift-version','6','-parse-as-library',
    '-module-cache-path',join(directory,'compiler-cache'),
    ...['Sources/Wire.swift','Sources/ComputerAuthority.swift','Sources/ComputerFiles.swift','Tests/ComputerHTTPProbe.swift'].map(p=>resolve('apps/macos-native',p)),
    '-o',binary],{encoding:'utf8',timeout:45000});
  expect(compilation.status,compilation.stderr).toBe(0);
  const db=await testDb();await ensureWorkspace(db);
  const raw=Buffer.alloc(32,93),master=new MasterKey(raw),c=new ComputerControl(db,master);
  const owner=(await createUser(db,{email:'swift-native@example.test',username:'swift-native',role:'super_admin'})).id;
  const password='synthetic-disposable-test-password';await setPassword(db,owner,password);
  const token=(await createSession(db,{userId:owner})).token,taskId=randomUUID();
  server=createApp(db,{cookieSecure:false,appUrl:'http://localhost',masterKeyCheck:{readFile:()=>Buffer.from(raw.toString('base64'))}}).listen(0,'127.0.0.1');
  await new Promise<void>((resolve,reject)=>{server!.once('listening',resolve);server!.once('error',reject);});
  const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const fixture=join(directory,'fixture.json');
  writeFileSync(fixture,JSON.stringify({origin,owner,password,token,root:directory}),{mode:0o600});
  child=spawn(binary,[fixture],{stdio:['ignore','pipe','pipe']});
  let output='';child.stdout!.on('data',data=>{output+=String(data);});child.stderr!.on('data',data=>{output+=String(data);});
  const completion=new Promise<number|null>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',resolve);});
  void completion.catch(()=>{});
  let deviceId='';
  for(let n=0;n<200;n++){
    const device=(await c.snapshot(owner)).devices[0];
    if(device?.capabilities.includes('file.read')){deviceId=device.id;break;}
    if(child.exitCode!==null)break;
    await delay(50);
  }
  expect(deviceId,output).toMatch(/^mac-[a-f0-9]{40}$/);
  const context={userId:owner,threadId:null,durableTurnId:taskId,latestUserText:'Write and read the disposable native acceptance file.'};
  for(const action of ['file.write','file.read']){
    const proposal=await c.propose(owner,deviceId,taskId,context.latestUserText,{resume:true,
      rule:{id:randomUUID(),action:action as 'file.write'|'file.read',scope:{kind:'folder',target:directory},decision:'allow',duration:{kind:'until',expiresAt:Date.now()+60000}}});
    const approved=await fetch(origin+'/api/computer-control/proposals/'+proposal.id+'/decision',{
      method:'POST',headers:{'content-type':'application/json','x-josi-client':'native',authorization:'Bearer '+token},
      body:JSON.stringify({approve:true,digest:proposal.digest,password})});
    expect(approved.status).toBe(200);
  }
  const path=join(directory,'native-result.txt'),text='Actual Swift → HTTP → chat result 🐈\n';
  const write=await executeComputerTool(db,context,master,'computer_operation',{device_id:deviceId,idempotency_key:'write-once',
    operation:{action:'file.write',scope:{kind:'folder',target:directory},args:{path,text,expectedDigest:''}}});
  expect(write).toMatchObject({state:'succeeded'});expect(readFileSync(path,'utf8')).toBe(text);
  const read=await executeComputerTool(db,context,master,'computer_operation',{device_id:deviceId,idempotency_key:'read-once',
    operation:{action:'file.read',scope:{kind:'folder',target:directory},args:{path}}});
  expect(read).toMatchObject({state:'succeeded',contentProjectionRequired:true});
  expect(JSON.stringify(read)).not.toContain(text);
  expect(await c.result(owner,(read as {id:string}).id)).toMatchObject({state:'succeeded',result:{text,untrusted:true}});
  expect(await completion,output).toBe(0);
  expect(output).toContain('PASS Swift HTTP file round trip and local Stop');
  expect((await c.snapshot(owner)).devices[0].stopped).toBe(true);
},60000);
