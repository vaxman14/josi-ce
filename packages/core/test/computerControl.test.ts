import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { testDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import { ComputerControl, ComputerControlError, computerCanonical, computerDeviceId, computerPath, MasterKey,
  createThread, addMessage, type Db, type ComputerProof, type ComputerRule } from '../src/index.js';
import { normalizeComputerOperation } from '../src/computerControl.js';
import { COMPUTER_CONTROL_VERSION } from '@josi-ce/protocol';
let db:Db,c:ComputerControl,owner:string,clock:number,deviceId:string;
const key=new MasterKey(Buffer.alloc(32,71));
const keys=generateKeyPairSync('ed25519');
const publicKey=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
const task=randomUUID();
const read={action:'file.read' as const,scope:{kind:'folder' as const,target:'/tmp/approved'},args:{path:'/tmp/approved/hello.txt'}};
function proof(method:string,body:Record<string,unknown>={},identity=owner):ComputerProof {
  const payload={version:COMPUTER_CONTROL_VERSION,ownerId:identity,deviceId,nonce:randomUUID(),timestamp:clock,method,body};
  return {payload,signature:sign(null,Buffer.from(computerCanonical(payload)),keys.privateKey).toString('base64')};
}
function rule(overrides:Partial<ComputerRule>={}):ComputerRule{return {id:randomUUID(),action:'file.read',scope:read.scope,decision:'allow',duration:{kind:'saved'},...overrides};}
async function change(value:Parameters<ComputerControl['propose']>[4]){const p=await c.propose(owner,deviceId,task,'Please read my test folder.',value);return c.decide(owner,p.id,p.digest,true);}
beforeAll(async()=>{db=await testDb();});
beforeEach(async()=>{
  owner=(await createUser(db,{email:randomUUID()+'@example.test',username:randomUUID(),role:'member'})).id;
  clock=Date.now();c=new ComputerControl(db,key,()=>clock);deviceId=computerDeviceId(publicKey);
  await c.enroll(owner,proof('enroll',{publicKey,platform:'macos',label:'Test Mac'}));
  await c.deviceCall(owner,'presence',proof('presence',{capabilities:['environment','file.read','file.write','window.type','terminal.open']}));
});
describe('computer-control.2 platform and authority boundary',()=>{
  it('accepts exact native POSIX paths only',()=>{
    for(const path of ['C:\\Work','../tmp','/tmp/../etc','//tmp/a','/tmp/a\\b','/tmp//a'])expect(()=>computerPath(path)).toThrow();
    expect(computerPath('/Users/Roman/Case')).toBe('/Users/Roman/Case');
  });
  it('starts stopped and resume alone grants no capability',async()=>{
    await expect(c.submit(owner,deviceId,task,read,'one')).rejects.toThrow(/Stopped/);
    await change({resume:true});expect((await c.submit(owner,deviceId,task,read,'one')).state).toBe('pending');
  });
  it('binds signed calls to the owner, device, method, exact body, time and nonce',async()=>{
    const p=proof('presence',{capabilities:[]});await c.deviceCall(owner,'presence',p);
    await expect(c.deviceCall(owner,'presence',p)).rejects.toThrow(/replayed/);
    await expect(c.deviceCall(owner,'next',proof('presence'))).rejects.toThrow();
    const tampered=proof('presence',{capabilities:[]});tampered.payload.body={capabilities:['file.read']};
    await expect(c.deviceCall(owner,'presence',tampered)).rejects.toThrow(/signature/);
    await expect(c.deviceCall(owner,'presence',proof('presence',{},randomUUID()))).rejects.toThrow();
    const expired=proof('next');clock+=16000;await expect(c.deviceCall(owner,'next',expired)).rejects.toThrow(/expired/);
  });
  it('preserves explicit nested denials under a broad allowance and requires named removal',async()=>{
    await change({resume:true,rule:rule({action:'*',scope:{kind:'host',target:'this-device'}})});
    const denial=rule({decision:'deny',scope:{kind:'folder',target:'/tmp/approved/private'}});await change({rule:denial});
    await expect(c.submit(owner,deviceId,task,{...read,args:{path:'/tmp/approved/private/secret'}},'secret')).rejects.toThrow();
    await expect(c.submit(owner,deviceId,task,{action:'terminal.open',scope:{kind:'host',target:'this-device'},args:{shell:'/bin/zsh',cwd:'/tmp'}},'shell')).rejects.toThrow();
    expect((await c.submit(owner,deviceId,task,read,'public')).state).toBe('approved');
    await change({removeRuleId:denial.id});expect((await c.submit(owner,deviceId,task,{...read,args:{path:'/tmp/approved/private/secret'}},'now')).state).toBe('approved');
  });
  it('rejects unsupported and contradictory fields rather than silently weakening them',async()=>{
    await expect(c.propose(owner,deviceId,task,'Read', {rule:{...rule(),sandbox:true} as ComputerRule})).rejects.toThrow(/Unsupported/);
    await expect(c.propose(owner,deviceId,task,'Read',{rule:rule({duration:{kind:'task',taskId:task,expiresAt:clock+1000}})})).rejects.toThrow(/active work task/);
  });
  it('applies direct chat restrictions immediately but cannot use that path to restore or expand authority',async()=>{
    const allowed=rule();await change({resume:true,rule:allowed});
    const q=await c.submit(owner,deviceId,task,read,'before-restriction');await c.deviceCall(owner,'next',proof('next'));
    const denied=rule({decision:'deny'});
    expect(await c.restrict(owner,deviceId,task,{rule:denied})).toMatchObject({applied:true,restrictionOnly:true});
    expect((await c.result(owner,q.id)).state).toBe('cancelled');
    await expect(c.submit(owner,deviceId,task,read,'after-restriction')).rejects.toThrow();
    expect(await c.restrict(owner,deviceId,task,{removeRuleId:denied.id})).toBeNull();
    expect(await c.restrict(owner,deviceId,task,{rule:rule()})).toBeNull();
    expect(await c.restrict(owner,deviceId,task,{resume:true})).toBeNull();
    expect(await c.restrict(owner,deviceId,task,{removeRuleId:allowed.id})).toMatchObject({applied:true});
    expect((await c.snapshot(owner)).devices[0].rules).toContainEqual(denied);
  });
  it('rejects missing or malformed operation values before native defaults can change their meaning',()=>{
    const write={...read,action:'file.write' as const};
    for(const args of [{path:read.args.path},{path:read.args.path,text:7,expectedDigest:''},
      {path:read.args.path,text:'hello',expectedDigest:'unchecked'}, {path:read.args.path,text:'\0',expectedDigest:''}]){
      expect(()=>normalizeComputerOperation({...write,args})).toThrow();
    }
    expect(normalizeComputerOperation({...write,args:{path:read.args.path,text:'',expectedDigest:''}}).args.text).toBe('');
    const scope={kind:'application' as const,target:'com.apple.TextEdit|apple|/System/Applications/TextEdit.app'};
    expect(()=>normalizeComputerOperation({action:'window.capture',scope,args:{windowId:'silently ignored'}})).toThrow();
    for(const deltaY of ['100',null,0,1001,1.5])expect(()=>normalizeComputerOperation({action:'window.scroll',scope,args:{observationId:randomUUID(),deltaY}})).toThrow();
    expect(()=>normalizeComputerOperation({action:'window.drag',scope,args:{observationId:randomUUID(),fromX:0,fromY:0,toX:1}})).toThrow();
  });
  it('grants and resumes the exact request atomically, rejecting replay and stale proposals',async()=>{
    await change({resume:true});const q=await c.submit(owner,deviceId,task,read,'first');
    const p=await c.propose(owner,deviceId,task,'Approve once',{rule:rule({duration:{kind:'once',requestId:q.id}}),approveRequestId:q.id});
    const outcomes=await Promise.allSettled([c.decide(owner,p.id,p.digest,true),c.decide(owner,p.id,p.digest,true)]);
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await c.submit(owner,deviceId,task,read,'first')).id).toBe(q.id);
    const next=await c.deviceCall(owner,'next',proof('next')) as {request:{id:string}};expect(next.request.id).toBe(q.id);
    expect((await c.deviceCall(owner,'next',proof('next')) as {request:unknown}).request).toBeNull();
    await c.deviceCall(owner,'result',proof('result',{requestId:q.id,ok:true,result:{text:'hello'}}));
    expect((await c.result(owner,q.id)).state).toBe('succeeded');
    expect((await c.submit(owner,deviceId,task,read,'second')).state).toBe('pending');
  });
  it('expires locally renewable leases and never reclaims interrupted work',async()=>{
    await change({resume:true,rule:rule()});const q=await c.submit(owner,deviceId,task,read,'lease');
    await c.deviceCall(owner,'next',proof('next'));clock+=10001;
    await expect(c.deviceCall(owner,'lease',proof('lease',{requestId:q.id}))).rejects.toThrow();
    expect((await c.deviceCall(owner,'next',proof('next')) as {request:unknown}).request).toBeNull();
    expect((await c.result(owner,q.id)).state).toBe('cancelled');
  });
  it('cancels running and queued work on stop, revocation and grant expiry',async()=>{
    await change({resume:true,rule:rule({duration:{kind:'until',expiresAt:clock+1000}})});
    const q=await c.submit(owner,deviceId,task,read,'expires');await c.deviceCall(owner,'next',proof('next'));clock+=1000;
    await expect(c.deviceCall(owner,'lease',proof('lease',{requestId:q.id}))).rejects.toThrow();
    await c.stop(owner,deviceId,true);await expect(c.deviceCall(owner,'next',proof('next'))).rejects.toThrow();
    await expect(c.enroll(owner,proof('enroll',{publicKey,platform:'macos',label:'Replayed'}))).rejects.toThrow(/already/);
  });
  it('binds task grants to an owned active work goal and cancels them on pause or completion',async()=>{
    const thread=await createThread(db,{ownerUserId:owner});
    const message=await addMessage(db,{threadId:thread.id,direction:'in',body:'Read my folder for this task'});
    const goal=randomUUID();
    await db.query("insert into work_goals(id,owner_user_id,thread_id,source_message_id,state,outcome,criteria,steps,activity) values($1,$2,$3,$4,'working','test','[]','[]','testing')",[goal,owner,thread.id,message.id]);
    const p=await c.propose(owner,deviceId,goal,'Read my folder for this task',{resume:true,rule:rule({duration:{kind:'task',taskId:goal,expiresAt:clock+60_000}})});
    await c.decide(owner,p.id,p.digest,true);
    expect((await c.submit(owner,deviceId,task,read,'wrong-task')).state).toBe('pending');
    const q=await c.submit(owner,deviceId,goal,read,'goal');expect(q.state).toBe('approved');
    await c.deviceCall(owner,'next',proof('next'));
    await db.query("update work_goals set state='paused' where id=$1",[goal]);
    await expect(c.deviceCall(owner,'lease',proof('lease',{requestId:q.id}))).rejects.toThrow();
    expect((await c.result(owner,q.id)).state).toBe('cancelled');
    await db.query("update work_goals set state='completed' where id=$1",[goal]);
    await expect(c.submit(owner,deviceId,goal,read,'after-task')).rejects.toThrow(/ended/);
  });
  it('cannot bypass pre-existing protected Mac policies through a fresh enrollment',async()=>{
    const pending=await c.propose(owner,deviceId,task,'Read my folder',{resume:true,rule:rule()});
    const record=randomUUID();
    await db.query("insert into vault_record_heads(id,kind,version,digest) values($1,'automation_policy',1,$2)",[record,'a'.repeat(64)]);
    try {
      expect((await c.snapshot(owner)).policyStatus).toMatchObject({required:true,available:false});
      await expect(change({resume:true,rule:rule()})).rejects.toThrow(/Vault/);
      await expect(c.submit(owner,deviceId,task,read,'legacy')).rejects.toThrow();
      await expect(c.decide(owner,pending.id,pending.digest,true)).rejects.toThrow(/permissions changed/);
      await expect(c.stop(owner,deviceId)).resolves.toEqual({ok:true});
    } finally { await db.query('delete from vault_record_heads where id=$1',[record]); }
  });
  it('does not reveal another owner’s receipts',async()=>{await expect(c.result(randomUUID(),randomUUID())).rejects.toThrow();});
});
