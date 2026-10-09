import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createUser, createSession, setPassword } from '@josi-ce/auth';
import { MasterKey, PcControl, type Db, type PcPlan } from '@josi-ce/core';
import { testDb } from '../../../packages/core/test/helpers.js';
import { createApp } from '../src/app.js';

let db:Db,server:Server,base:string,owner:string,ownerJar:string,memberJar:string;
const rawKey=Buffer.alloc(32,31),key=new MasterKey(rawKey),password='pc-control-test-password';
const scope={kind:'folder' as const,target:'C:\\Acceptance\\Reports'};
const input:PcPlan={requirements:[{action:'file.delete',scope}],description:'Delete only the disposable report.txt in C:\\Acceptance\\Reports',payload:{path:'report.txt'}};
const endpoint='/api/admin/pc-control';
beforeAll(async()=>{
  db=await testDb();owner=(await createUser(db,{email:'pc-admin@example.test',username:'pc-admin',role:'super_admin'})).id;
  const member=(await createUser(db,{email:'pc-member@example.test',username:'pc-member',role:'member'})).id;
  await setPassword(db,owner,password);await db.query(`update setup_state set completed=true where id=true`);
  ownerJar=`josi_session=${(await createSession(db,{userId:owner})).token}; josi_csrf=pc-fixture`;
  memberJar=`josi_session=${(await createSession(db,{userId:member})).token}; josi_csrf=pc-fixture`;
  server=createApp(db,{cookieSecure:false,appUrl:'http://localhost',nativeWindowsPermissions:true,
    masterKeyCheck:{readFile:()=>Buffer.from(rawKey.toString('base64'))},webDir:process.env.JOSI_PC_WEB_DIR??join(import.meta.dirname,'../../web/dist')}).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));});
async function call(path='',method='GET',body?:unknown,jar=ownerJar,csrf=true){
  const r=await fetch(base+endpoint+path,{method,headers:{'content-type':'application/json',...(jar?{cookie:jar}:{}),...(csrf?{'x-josi-csrf':'pc-fixture'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};
}
describe('PC permissions over the real authenticated HTTP surface',()=>{
  it('requires installation owner, CSRF and native Windows; never exposes a browser executor',async()=>{
    expect((await call('','GET',undefined,'')).status).toBe(401);expect((await call('','GET',undefined,memberJar)).status).toBe(403);
    expect((await call('/enabled','PUT',{enabled:true},ownerJar,false)).status).toBe(403);
    for(const route of ['/execute','/propose','/register-pc'])expect((await call(route,'POST',{})).status).toBe(404);
    const state=await call();expect(state.status).toBe(200);expect(state.cache).toBe('no-store');expect(state.body.enabled).toBe(false);expect(state.body.executorAvailable).toBe(false);
    const linux=createApp(db,{cookieSecure:false,appUrl:'http://localhost',nativeWindowsPermissions:false,masterKeyCheck:false}).listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>linux.once('listening',resolve));try{const r=await fetch(`http://127.0.0.1:${(linux.address() as AddressInfo).port}${endpoint}`,{headers:{cookie:ownerJar}});expect(r.status).toBe(404);}finally{await new Promise<void>(resolve=>linux.close(()=>resolve()));}
  });
  it('persists only the session owner/hosting-PC scopes and validates malformed choices',async()=>{
    const saved=await call('/policies','PUT',{action:'folder.read',scope,mode:'temporary',expiresAt:new Date(Date.now()+60000).toISOString(),ownerUserId:'foreign-user',pcId:'different-pc'});
    expect(saved.status).toBe(200);const state=(await call()).body;expect(state.pcId).toBe('local-windows-host');expect(state.policies[0].access).toBeUndefined();expect(state.policies[0].active).toBe(true);
    expect((await call('/policies','PUT',{action:'file.delete',scope,mode:'invalid'})).status).toBe(400);
    expect((await call('/enabled','PUT',{enabled:'yes'})).status).toBe(400);
    expect((await call('/policies/'+saved.body.id,'DELETE',undefined,memberJar)).status).toBe(403);
    expect((await call('/policies/'+saved.body.id,'DELETE')).status).toBe(200);
  });
  it('high-risk scope choices never approve actions; approving once requires current owner password',async()=>{
    await call('/enabled','PUT',{enabled:true});await call('/policies','PUT',{...input.requirements[0],mode:'always'});
    const broker=new PcControl(db,key,'local-windows-host'),q=await broker.propose(owner,input);expect(q.state).toBe('pending');
    expect((await call('/requests/'+q.id+'/decision','POST',{approve:true})).status).toBe(401);
    expect((await call('/requests/'+q.id+'/decision','POST',{approve:true,password:'incorrect'})).status).toBe(401);
    expect((await call('/requests/'+q.id+'/decision','POST',{approve:true,password})).status).toBe(200);
    expect((await call('/requests/'+q.id+'/decision','POST',{approve:true,password})).status).toBe(404);
    // No filesystem executor is invoked: this just verifies durable approval.
    expect((await db.query<{state:string}>(`select state from pc_control_requests where id=$1`,[q.id]))[0].state).toBe('approved');
    expect(JSON.stringify((await call()).body)).not.toContain(password);await call('/stop','POST',{});
  });
  it('fails closed without an encryption key while emergency stop still revokes',async()=>{
    const broken=createApp(db,{cookieSecure:false,appUrl:'http://localhost',nativeWindowsPermissions:true,masterKeyCheck:false}).listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>broken.once('listening',resolve));const address=`http://127.0.0.1:${(broken.address() as AddressInfo).port}${endpoint}`;
    try{
      expect((await fetch(address,{headers:{cookie:ownerJar}})).status).toBe(503);
      const stopped=await fetch(address+'/stop',{method:'POST',headers:{cookie:ownerJar,'x-josi-csrf':'pc-fixture','content-type':'application/json'},body:'{}'});expect(stopped.status).toBe(200);
      expect((await db.query<{enabled:boolean}>(`select enabled from pc_control_settings where owner_user_id=$1`,[owner]))[0].enabled).toBe(false);
    }finally{await new Promise<void>(resolve=>broken.close(()=>resolve()));}
  });
  it('renders the actual browser page and saves/revokes exact scopes, displays activity and emergency stop',async()=>{
    const browser=await chromium.launch({...(process.platform==='win32'?{channel:'chrome'}:{}),headless:true});
    try{
      const context=await browser.newContext();let external=0;await context.route('**/*',route=>{if(!route.request().url().startsWith(base+'/')){external++;return route.abort();}return route.continue();});
      const token=/josi_session=([^;]+)/.exec(ownerJar)![1];await context.addCookies([{name:'josi_session',value:token,url:base,httpOnly:true},{name:'josi_csrf',value:'pc-fixture',url:base}]);
      const page=await context.newPage();page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(5000);
      await page.goto(base+'/admin/pc-control');await page.getByRole('heading',{name:'PC control permissions',exact:true}).waitFor();
      await page.getByText('PC control is unavailable until the separate Windows desktop client is connected.',{exact:false}).waitFor();
      // Controlled switch updates only after the durable save, so wait for the
      // real response rather than asserting an optimistic checkbox change.
      const enabled=page.waitForResponse(r=>r.url()===base+endpoint+'/enabled'&&r.request().method()==='PUT');
      await page.getByLabel('Allow Josi to control this PC').click();expect((await enabled).status()).toBe(200);
      await page.waitForFunction(()=>document.querySelector('input[type="checkbox"]')?.checked);
      await page.getByLabel('Action',{exact:true}).selectOption('folder.read');await page.getByLabel('Exact local folder path',{exact:true}).fill('C:\\UI-Acceptance');
      await page.getByLabel('Approval mode',{exact:true}).selectOption('temporary');await page.getByLabel('Expires at (your local time, within 24 hours)',{exact:true}).fill(new Date(Date.now()+3600000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16));
      await page.getByRole('button',{name:'Save exact-scope permission'}).click();await page.getByText('C:\\UI-Acceptance',{exact:true}).first().waitFor();await page.getByText('Read-only · Allow temporarily',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Stop control and revoke temporary access',exact:true}).click();await page.waitForFunction(()=>document.querySelector('input[type="checkbox"]')?.checked===false);
      expect((await call()).body.policies.some((p:{mode:string})=>p.mode==='temporary'||p.mode==='task')).toBe(false);
      await page.getByText('Emergency stop: control disabled and temporary/task access revoked',{exact:true}).first().waitFor();expect(external).toBe(0);
      await page.getByRole('button',{name:'Revoke',exact:true}).first().click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Revoke'));
      await context.close();
    }finally{await browser.close();}
  });
});
