import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSession } from '@josi-ce/auth';
import { MasterKey, PcControl, type Db, type PcPlan } from '@josi-ce/core';
import { testDb } from '../../../packages/core/test/helpers.js';
import { executeSettingsChangeTool } from '../../../packages/agent/src/settingsChangeTools.js';
import { executePcDesktopTool, pcDesktopToolAvailability } from '../../../packages/agent/src/pcDesktopTools.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import {pcExecutorHeaders} from './pcExecutorFixture.js';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';

const rawKey=Buffer.alloc(32,47),key=new MasterKey(rawKey),password='synthetic-chat-pc-owner';
const scope={kind:'folder' as const,target:'C:\\Project'};
let db:Db,server:Server,base:string,owner:string,token:string,control:PcControl,index=0;
beforeAll(async()=>{
  db=await testDb();await ensureWorkspace(db);await db.query(`update setup_state set completed=true where id=true`);
  server=createApp(db,{cookieSecure:false,appUrl:'http://localhost',nativeWindowsPermissions:true,
    masterKeyCheck:{readFile:()=>Buffer.from(rawKey.toString('base64'))}}).listen(0,'127.0.0.1');
  await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
beforeEach(async()=>{
  await db.query(`update users set role='member' where role='super_admin'`);
  index++;owner=(await createUser(db,{email:`pc-chat-${index}@fixture.test`,username:`pc-chat-${index}`,role:'super_admin',password})).id;
  token=(await createSession(db,{userId:owner})).token;
  control=new PcControl(db,key,'win-target');await control.snapshot(owner);
});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));});
async function call(path:string,method='GET',body?:unknown,bearer=token,pcId='win-other-client'){
  const signed=path.startsWith('/admin/pc-control/executor')?await pcExecutorHeaders(db,owner,pcId,method,'/api'+path,body):{};
  const res=await fetch(base+path,{method,headers:{authorization:`Bearer ${bearer}`,'x-josi-client':'native','x-josi-pc':pcId,'content-type':'application/json',...signed},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,body:await res.json() as any};
}
async function propose(body:Record<string,unknown>,params:Record<string,unknown>={pcId:'win-target'},area='pc_control_scope'){
  return await executeSettingsChangeTool(db,owner,'propose_josi_setting_change',
    {area,body,params,summary:'An inaccurate model summary must not decide what the approval says.'},null,key) as any;
}

describe('chat-managed PC permission foundation',()=>{
  it('rejects unsigned, replayed and body-tampered executor requests',async()=>{
    const path='/admin/pc-control/executor/presence',body={connected:false},headers={authorization:`Bearer ${token}`,'x-josi-client':'native','content-type':'application/json'};
    expect((await fetch(base+path,{method:'PUT',headers,body:JSON.stringify(body)})).status).toBe(403);
    const signed=await pcExecutorHeaders(db,owner,'win-target','PUT','/api'+path,body);
    const send=(value:unknown)=>fetch(base+path,{method:'PUT',headers:{...headers,...signed},body:JSON.stringify(value)});
    expect((await send({connected:true})).status).toBe(403);
    expect((await send(body)).status).toBe(200);expect((await send(body)).status).toBe(403);
  });
  it('applies the exact full-access chat card once with password approval, retaining the separate administrator denial',async()=>{
    await control.setEnabled(owner,true);
    const proposal=await propose({access:'full',administrator:false,mode:'always'},{pcId:'win-target'},'pc_control_preset');
    expect(proposal.ok).toBe(true);
    const path=`/settings-changes/${proposal.proposalId}/pc-apply`;
    expect((await call(path,'POST',{})).status).toBe(401);
    expect((await call(path,'POST',{password})).status).toBe(200);
    const policies=(await control.snapshot(owner)).policies;
    expect(policies.some(p=>p.action==='command.run'&&p.scope.target==='*'&&p.mode==='always')).toBe(true);
    expect(policies.some(p=>p.action==='administrator.elevate'&&p.mode==='never')).toBe(true);
    expect((await call(path,'POST',{password})).status).toBe(409);
  });
  it('verifies an owner-bound passkey signature for the immutable permission card and refuses replay',async()=>{
    const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),credentialId=randomBytes(24).toString('base64url');
    await db.query('insert into auth_passkeys(user_id,credential_id,public_key,algorithm,name) values($1,$2,$3,-7,$4)',[owner,credentialId,pair.publicKey.export({format:'der',type:'spki'}).toString('base64'),'Synthetic PC approval']);
    const proposal=await propose({action:'folder.read',scope,mode:'always'}),prefix=`/settings-changes/${proposal.proposalId}`;
    const challenge=await call(prefix+'/pc-passkey/options','POST',{});expect(challenge.status).toBe(200);
    expect(challenge.body.options.allowCredentials.map((c:any)=>c.id)).toEqual([credentialId]);
    const clientData=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:challenge.body.options.challenge,origin:'http://localhost',crossOrigin:false}));
    const authData=Buffer.concat([createHash('sha256').update('localhost').digest(),Buffer.from([5,0,0,0,1])]);
    const signature=sign('sha256',Buffer.concat([authData,createHash('sha256').update(clientData).digest()]),pair.privateKey);
    const body={challengeId:challenge.body.id,passkey:{id:credentialId,rawId:credentialId,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:clientData.toString('base64url'),authenticatorData:authData.toString('base64url'),signature:signature.toString('base64url')}}};
    expect((await call(prefix+'/pc-apply','POST',body)).status).toBe(200);
    expect((await control.snapshot(owner)).policies).toHaveLength(1);
    expect((await call(prefix+'/pc-apply','POST',body)).status).toBe(409);
  });
  it('binds execution leases and results to the claiming PC and notices changes from another service',async()=>{
    await control.setEnabled(owner,true);await control.savePolicy(owner,{action:'folder.read',scope,mode:'always'});
    const plan:PcPlan={requirements:[{action:'folder.read',scope}],description:'Read the test folder',payload:{kind:'desktop.folder',folder:scope.target}};
    const pending=await control.propose(owner,plan);
    const next=await call('/admin/pc-control/executor/next','POST',{},token,'win-target');
    expect(next.status).toBe(200);expect(next.body.request.id).toBe(pending.id);
    const lease=`/admin/pc-control/executor/${pending.id}/lease`,result=`/admin/pc-control/executor/${pending.id}/result`;
    expect((await call(lease,'GET',undefined,token,'win-target')).body.authorized).toBe(true);
    expect((await call(lease)).status).toBe(404);
    expect((await call(result,'POST',{ok:true,result:{}})).status).toBe(404);
    // This PcControl instance is deliberately separate from the HTTP router.
    await control.savePolicy(owner,{action:'folder.read',scope,mode:'never'});
    expect((await call(lease,'GET',undefined,token,'win-target')).body.authorized).toBe(false);
    expect((await call(result,'POST',{ok:false,result:{code:'execution_lease_lost'}},token,'win-target')).status).toBe(200);
    expect((await call(result,'POST',{ok:true,result:{}},token,'win-target')).status).toBe(404);
  });
  it('offers inspection while control is disabled and exposes no executor tools',async()=>{
    expect((await pcDesktopToolAvailability(db,owner,key)).map(t=>t.def.name)).toEqual(['pc_get_permissions']);
    const result=await executePcDesktopTool(db,owner,key,'pc_get_permissions',{}) as any;
    expect(result.ok).toBe(true);expect(result.selected.pcId).toBe('win-target');expect(result.selected.enabled).toBe(false);
    expect(result.selected.activity).toBeUndefined();expect(result.semanticsVersion).toBe('pc-control-chat.2');
  });
  it('requires explicit selection with multiple devices and refuses unknown devices',async()=>{
    await new PcControl(db,key,'win-second').snapshot(owner);
    const listed=await executePcDesktopTool(db,owner,key,'pc_get_permissions',{}) as any;
    expect(listed.selected).toBeNull();expect(listed.devices).toHaveLength(2);
    expect((await propose({action:'folder.read',scope,mode:'always'},{})).message).toMatch(/More than one PC/);
    expect((await propose({action:'folder.read',scope,mode:'always'},{pcId:'win-unknown'})).ok).toBe(false);
  });
  it('binds the truthful approval to its owner, device and revision and applies from another client to the correct PC',async()=>{
    const result=await propose({action:'folder.read',scope,mode:'always'});
    expect(result.ok).toBe(true);expect((await control.snapshot(owner)).policies).toEqual([]);
    const proposal=(await call('/settings-changes')).body.proposals.find((p:any)=>p.id===result.proposalId);
    expect(proposal.summary).toContain('Computer: win-target');expect(proposal.summary).toContain('C:\\Project');
    expect(proposal.summary).not.toContain('inaccurate model');
    expect((await call(`/settings-changes/${result.proposalId}/decide`,'POST',{approve:true})).status).toBe(401);
    const decision=await call(`/settings-changes/${result.proposalId}/decide`,'POST',{approve:true,password});
    expect(decision.status).toBe(200);expect(decision.body.apply.path).toContain('pcId=win-target');
    expect(decision.body.apply.path).toContain(`ownerId=${owner}`);
    const applied=await call(decision.body.apply.path,decision.body.apply.method,decision.body.apply.body);
    expect(applied.status).toBe(200);expect((await control.snapshot(owner)).policies).toHaveLength(1);
    expect((await new PcControl(db,key,'win-other-client').snapshot(owner)).policies).toEqual([]);
    expect((await call(decision.body.apply.path,decision.body.apply.method,decision.body.apply.body)).status).toBe(409);
    expect((await call(`/settings-changes/${result.proposalId}/applied`,'POST',{ok:true})).status).toBe(200);
  });
  it('refuses a stale proposal after another policy edit',async()=>{
    const proposed=await propose({action:'folder.read',scope,mode:'always'});
    const approved=await call(`/settings-changes/${proposed.proposalId}/decide`,'POST',{approve:true,password});
    await control.savePolicy(owner,{action:'folder.read',scope,mode:'never'});
    const applied=await call(approved.body.apply.path,'PUT',approved.body.apply.body);
    expect(applied.status).toBe(409);expect(applied.body.error).toContain('permissions changed');
    expect((await control.snapshot(owner)).policies[0].mode).toBe('never');
  });
  it('does not let a new administrator apply a former owner\'s PC proposal',async()=>{
    const other=(await createUser(db,{email:`other-${index}@fixture.test`,username:`other-${index}`,role:'member',password})).id;
    const otherToken=(await createSession(db,{userId:other})).token;
    const proposed=await propose({action:'folder.read',scope,mode:'always'});
    const [stored]=await db.query<{path:string;body:unknown}>(`select path,body from settings_change_proposals where id=$1`,[proposed.proposalId]);
    await db.query(`update users set role='member' where id=$1`,[owner]);
    await db.query(`update users set role='super_admin' where id=$1`,[other]);
    expect((await call(`/settings-changes/${proposed.proposalId}/decide`,'POST',{approve:true,password},otherToken)).status).toBe(403);
    expect((await call(stored.path,'PUT',stored.body,otherToken)).status).toBe(403);
    expect((await control.snapshot(owner)).policies).toEqual([]);
  });
  it('approves a waiting command and saves its grant atomically after protected confirmation',async()=>{
    await control.setEnabled(owner,true);
    const commandScope={kind:'command' as const,target:'C:\\Project',application:'C:\\Windows\\System32\\cmd.exe'};
    const input:PcPlan={requirements:[{action:'command.run',scope:commandScope}],description:'Run the exact test command in the project',payload:{kind:'desktop.command',command:'echo test'}};
    const pending=await control.propose(owner,input);
    const proposed=await propose({action:'command.run',scope:commandScope,mode:'always',approveRequestId:pending.id});
    expect(proposed.ok).toBe(true);
    const approved=await call(`/settings-changes/${proposed.proposalId}/decide`,'POST',{approve:true,password});
    expect(approved.status).toBe(200);
    expect((await call(approved.body.apply.path,'PUT',approved.body.apply.body)).status).toBe(401);
    expect((await control.outcome(owner,pending.id))?.state).toBe('pending');
    expect((await call(approved.body.apply.path,'PUT',{...approved.body.apply.body,password})).status).toBe(200);
    expect((await control.outcome(owner,pending.id))?.state).toBe('approved');
    let runs=0;await control.execute(owner,pending.id,input,async()=>{runs++;});
    await expect(control.execute(owner,pending.id,input,async()=>{runs++;})).rejects.toThrow();expect(runs).toBe(1);
  });
  it('rejects unsupported restrictions and prepares separate administrator grants without applying them',async()=>{
    expect((await propose({action:'folder.read',scope:{...scope,elevate:false},mode:'always'})).ok).toBe(false);
    expect((await propose({action:'folder.read',scope:{...scope,application:'C:\\OnlyThis.exe'},mode:'always'})).ok).toBe(false);
    expect((await propose({action:'folder.read',scope,mode:'always',expiresAt:new Date(Date.now()+30000).toISOString()})).ok).toBe(false);
    const elevation=await propose({action:'administrator.elevate',scope:{kind:'system',target:'host'},mode:'always'});
    expect(elevation.ok).toBe(true);
    expect((await control.snapshot(owner)).policies).toEqual([]);
  });
  it('prepares an exact one-time decision in chat without saving a standing grant',async()=>{
    await control.setEnabled(owner,true);
    const plan:PcPlan={requirements:[{action:'folder.read',scope}],description:'Read this project once',payload:{kind:'desktop.folder',folder:scope.target}};
    const waiting=await control.propose(owner,plan);
    const proposal=await propose({approve:true},{pcId:'win-target',id:waiting.id},'pc_control_decide');
    expect(proposal.ok).toBe(true);
    const approved=await call(`/settings-changes/${proposal.proposalId}/decide`,'POST',{approve:true,password});
    expect((await call(approved.body.apply.path,'POST',approved.body.apply.body)).status).toBe(200);
    expect((await control.outcome(owner,waiting.id))?.state).toBe('approved');
    expect((await control.snapshot(owner)).policies).toEqual([]);
    expect((await control.propose(owner,plan)).state).toBe('pending');
    expect((await call(approved.body.apply.path,'POST',approved.body.apply.body)).status).toBe(404);
  });
});
