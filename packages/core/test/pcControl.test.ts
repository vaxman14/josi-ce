import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey, PcControl, PC_ACTIONS, PC_GRANTABLE_HIGH_RISK, normalizePcRequirement, disablePcControl, type Db, type PcPlan, type PcRequirement, type PcAction, type PcScope } from '../src/index.js';

let db:Db,owner:string,other:string,control:PcControl,clock:number,index=0;
const key=new MasterKey(Buffer.alloc(32,31));
const folder:PcScope={kind:'folder',target:'C:\\Work\\Reports'};
const browser:PcScope={kind:'browser',target:'https://example.test',application:'C:\\Browsers\\Chrome.exe',profile:'Default'};
const requirement=(action:PcAction,scope:PcScope):PcRequirement=>({action,scope});
const read=requirement('folder.read',folder);
const plan=(r:PcRequirement=read,extra:Partial<PcPlan>={}):PcPlan=>({requirements:[r],description:'Read the approved report in the exact folder',payload:{path:'report.txt'},...extra});
beforeAll(async()=>{db=await testDb();other=(await createUser(db,{email:'other-pc@example.test',username:'other-pc',role:'member'})).id;});
beforeEach(async()=>{index++;owner=(await createUser(db,{email:`pc-${index}@example.test`,username:`pc-${index}`,role:'member'})).id;clock=Date.now();control=new PcControl(db,key,'pc-one',()=>clock);});
async function allow(r=read,mode:'never'|'ask'|'task'|'temporary'|'always'='always',extra={}){await control.savePolicy(owner,{...r,mode,...extra});}
async function enable(){await control.setEnabled(owner,true);}
async function task(who=owner){return (await db.query<{id:string}>(`insert into tasks(owner_user_id,template_key,state) values($1,'follow_up','ready') returning id`,[who]))[0].id;}

describe('PC permission revisions and atomic approval',()=>{
  it('applies timed broad access, preserves exclusions and expires it without restoring the old everyday toggle',async()=>{
    await enable();await control.setFullControl(owner,true);
    await control.applyPreset(owner,{access:'full',administrator:false,mode:'temporary',expiresAt:new Date(clock+10000).toISOString()});
    const shell=requirement('command.run',{kind:'command',target:'C:\\Project',application:'C:\\Windows\\System32\\cmd.exe'});
    expect((await control.propose(owner,plan(shell))).state).toBe('approved');
    expect((await control.propose(owner,plan(requirement('administrator.elevate',{kind:'system',target:'host'})))).state).toBe('denied');
    expect((await control.snapshot(owner)).fullControl).toBe(false);
    await allow(requirement('app.control',{kind:'application',target:'C:\\Private.exe'}),'never');
    expect((await control.propose(owner,plan(shell))).state).toBe('denied');
    expect((await control.propose(owner,plan())).state).toBe('approved');
    clock+=11000;expect((await control.propose(owner,plan())).state).toBe('pending');
  });
  it('ties a once-approved terminal to its opening request and revokes it when policy changes',async()=>{
    await enable();const command=requirement('command.run',{kind:'command',target:'C:\\Project',application:'C:\\Windows\\System32\\cmd.exe'});
    const opening=plan(command,{payload:{kind:'desktop.terminal.open',timeoutSeconds:60}}),request=await control.propose(owner,opening);
    await control.decide(owner,request.id,true);await control.execute(owner,request.id,opening,async()=>({sessionId:request.id}));
    expect((await control.terminalAuthorization(owner,request.id)).authorized).toBe(true);
    expect((await control.propose(owner,plan(command,{payload:{kind:'desktop.terminal.input',sessionId:request.id,text:'echo fixture'}}))).state).toBe('approved');
    await allow(command,'never');expect((await control.terminalAuthorization(owner,request.id)).authorized).toBe(false);
  });
  it('does not let atomic once approval outlive its saved temporary allowance',async()=>{
    await enable();const input=plan(),q=await control.propose(owner,input);
    await control.savePolicy(owner,{...read,mode:'temporary',expiresAt:new Date(clock+10000).toISOString()},{approveRequestId:q.id});
    await control.execute(owner,q.id,input,async()=>{
      expect(await control.executionAuthorized(owner,q.id)).toBe(true);
      clock+=11000;
      expect(await control.executionAuthorized(owner,q.id)).toBe(false);
    });
  });
  it('ends a running lease when its temporary grant expires',async()=>{
    await enable();await allow(read,'temporary',{expiresAt:new Date(clock+30000).toISOString()});
    const input=plan(),q=await control.propose(owner,input);
    await control.execute(owner,q.id,input,async()=>{
      expect(await control.executionAuthorized(owner,q.id)).toBe(true);
      clock+=31000;
      expect(await control.executionAuthorized(owner,q.id)).toBe(false);
    });
    expect(await control.executionAuthorized(owner,q.id)).toBe(false);
  });
  const command:PcRequirement={action:'command.run',scope:{kind:'command',target:'C:\\Work',application:'C:\\Windows\\System32\\cmd.exe'}};
  it('saves a grant and preserves the exact waiting request for one execution',async()=>{
    await enable();
    const input=plan(command),q=await control.propose(owner,input),otherRequest=await control.propose(owner,plan());
    const before=await control.snapshot(owner);
    await control.savePolicy(owner,{...command,mode:'always'},{approveRequestId:q.id,expectedRevision:before.revision});
    expect((await control.snapshot(owner)).revision).toBe(before.revision+1);
    expect((await control.outcome(owner,q.id))?.state).toBe('approved');
    expect((await control.outcome(owner,otherRequest.id))?.state).toBe('revoked');
    const adapter=vi.fn(async()=>{});
    await control.execute(owner,q.id,input,adapter);
    await expect(control.execute(owner,q.id,input,adapter)).rejects.toThrow();
    await expect(control.savePolicy(owner,{...command,mode:'always'},{approveRequestId:q.id})).rejects.toThrow(/no longer active/);
    expect(adapter).toHaveBeenCalledTimes(1);
  });
  it('refuses a mismatched scope without saving a grant or revoking the request',async()=>{
    await enable();const q=await control.propose(owner,plan(command));
    const before=await control.snapshot(owner);
    await expect(control.savePolicy(owner,{...command,scope:{...command.scope,target:'C:\\Other'},mode:'always'},{approveRequestId:q.id})).rejects.toThrow(/match a scope/);
    const after=await control.snapshot(owner);
    expect(after.revision).toBe(before.revision);expect(after.policies).toEqual([]);
    expect((await control.outcome(owner,q.id))?.state).toBe('pending');
  });
  it('rolls back the grant if another effect is denied',async()=>{
    await enable();const remove=requirement('file.delete',folder);
    await allow(remove,'never');
    // A pending request cannot normally contain a denied scope. Simulate a
    // stale/tampered state and still require the full verdict in the transaction.
    const q=await control.propose(owner,plan(command,{requirements:[command,remove]}));
    await db.query(`update pc_control_requests set state='pending' where id=$1`,[q.id]);
    const before=await control.snapshot(owner);
    await expect(control.savePolicy(owner,{...command,mode:'always'},{approveRequestId:q.id})).rejects.toThrow(/disabled/);
    expect((await control.snapshot(owner)).revision).toBe(before.revision);
    expect((await control.snapshot(owner)).policies.some(p=>p.action==='command.run')).toBe(false);
  });
  it('rejects expired, foreign and nongrantable requests',async()=>{
    await enable();const q=await control.propose(owner,plan(command));clock+=11*60*1000;
    await expect(control.savePolicy(owner,{...command,mode:'always'},{approveRequestId:q.id})).rejects.toThrow(/no longer active/);
    clock-=11*60*1000;
    await expect(new PcControl(db,key,'pc-two',()=>clock).savePolicy(owner,{...command,mode:'always'},{approveRequestId:q.id})).rejects.toThrow(/not found/);
    const remove=requirement('secret.access',{kind:'secret',target:'protected-fixture'}),deletion=await control.propose(owner,plan(remove));
    await expect(control.savePolicy(owner,{...remove,mode:'always'},{approveRequestId:deletion.id})).rejects.toThrow(/cannot be approved/);
    expect((await control.snapshot(owner)).policies).toEqual([]);
  });
  it('checks the revision under the write lock and does not cancel running work for a stale proposal',async()=>{
    await enable();await allow();const before=await control.snapshot(owner);
    const q=await control.propose(owner,plan());let started!:()=>void,finish!:()=>void,signal!:AbortSignal;
    const ready=new Promise<void>(r=>started=r),done=new Promise<void>(r=>finish=r);
    const work=control.execute(owner,q.id,plan(),async(_p,s)=>{signal=s;started();await done;});
    await ready;
    await expect(control.setFullControl(owner,true,before.revision-1)).rejects.toThrow(/permissions changed/);
    await expect(control.savePolicy(owner,{...read,mode:'never'},{expectedRevision:before.revision-1})).rejects.toThrow(/permissions changed/);
    expect(signal.aborted).toBe(false);finish();await work;
  });
  it('permits task grants only for the task of the exact waiting action',async()=>{
    await enable();const taskId=await task(),otherTask=await task();
    const input=plan(command,{taskId}),q=await control.propose(owner,input);
    await expect(control.savePolicy(owner,{...command,mode:'task',taskId:otherTask},{approveRequestId:q.id})).rejects.toThrow(/request's task/);
    await control.savePolicy(owner,{...command,mode:'task',taskId},{approveRequestId:q.id});
    await control.execute(owner,q.id,input,async()=>{});
  });
});

describe('Windows exact PC scope authorization',()=>{
  it('defaults off and never infers permission from the master toggle',async()=>{
    await allow();expect((await control.snapshot(owner)).enabled).toBe(false);
    expect((await control.propose(owner,plan())).state).toBe('denied');
    await enable();expect((await control.propose(owner,plan(requirement('folder.write',folder)))).state).toBe('pending');
  });
  it('full control grants everyday actions on any scope but not money, deleting or secrets, and Never still wins',async()=>{
    await enable();
    await expect(control.setFullControl(owner,true)).resolves.toBeUndefined();
    const click=requirement('browser.submit',{...browser,target:'https://anywhere.test'});
    expect((await control.propose(owner,plan(click))).state).toBe('approved');
    expect((await control.propose(owner,plan(requirement('browser.fill',browser)))).state).toBe('approved');
    expect((await control.propose(owner,plan(requirement('folder.write',{kind:'folder',target:'C:\\Anything'})))).state).toBe('approved');
    expect((await control.propose(owner,plan(requirement('browser.purchase',browser)))).state).toBe('pending');
    expect((await control.propose(owner,plan(requirement('file.delete',folder)))).state).toBe('pending');
    expect((await control.propose(owner,plan(requirement('secret.access',{kind:'secret',target:'vault:item'})))).state).toBe('pending');
    await allow(requirement('browser.view',browser),'never');
    expect((await control.propose(owner,plan(requirement('browser.view',browser)))).state).toBe('denied');
    expect((await control.snapshot(owner)).fullControl).toBe(true);
    await control.setFullControl(owner,false);
    expect((await control.propose(owner,plan(click))).state).toBe('pending');
    await control.setFullControl(owner,true);await control.stop(owner);
    expect((await control.snapshot(owner)).fullControl).toBe(false);
    const disabled=new PcControl(db,key,'pc-three',()=>clock);
    await expect(disabled.setFullControl(owner,true)).rejects.toThrow(/Allow Josi to control this PC/);
  });
  it('commands ask until the owner saves a grant for that shell and folder, which full control never gives',async()=>{
    await enable();
    const shell={kind:'command',target:'C:\\Users\\Roman',application:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'} as PcScope;
    const run=requirement('command.run',shell);
    expect((await control.propose(owner,plan(run))).state).toBe('pending');
    await control.setFullControl(owner,true);
    expect((await control.propose(owner,plan(run))).state).toBe('pending');
    await allow(run,'always');
    expect((await control.propose(owner,plan(run))).state).toBe('approved');
    // Another shell asks; the approved starting folder includes descendants.
    expect((await control.propose(owner,plan(requirement('command.run',{...shell,application:'C:\\Windows\\System32\\cmd.exe'})))).state).toBe('pending');
    expect((await control.propose(owner,plan(requirement('command.run',{...shell,target:'C:\\Users\\Roman\\Desktop'})))).state).toBe('approved');
    expect((await control.propose(owner,plan(requirement('command.run',{...shell,target:'C:\\Users\\Romana'})))).state).toBe('pending');
    // Deletion has a separate grant; it never inherits the command grant.
    const remove=requirement('file.delete',folder);await allow(remove,'always');
    expect((await control.propose(owner,plan(remove))).state).toBe('approved');
    await allow(run,'never');
    expect((await control.propose(owner,plan(run))).state).toBe('denied');
    expect((await control.snapshot(owner)).catalog.find(c=>c.action==='command.run')?.grantable).toBe(true);
    expect((await control.snapshot(owner)).catalog.find(c=>c.action==='file.delete')?.grantable).toBe(true);
  });
  it('a widening change approves the request that was waiting for it instead of cancelling it',async()=>{
    await enable();
    const launch=requirement('app.launch',{kind:'application',target:'C:\\Windows\\System32\\notepad.exe'});
    const q=await control.propose(owner,plan(launch));expect(q.state).toBe('pending');
    await control.setFullControl(owner,true);
    expect((await control.outcome(owner,q.id))?.state).toBe('approved');
    expect((await control.approved(owner)).map(a=>a.id)).toContain(q.id);
    // Still outside the new rules: stays revoked, the model asks again.
    const shell={kind:'command',target:'C:\\Work',application:'C:\\Windows\\System32\\cmd.exe'} as PcScope;
    const run=await control.propose(owner,plan(requirement('command.run',shell)));expect(run.state).toBe('pending');
    await control.setFullControl(owner,false);
    expect((await control.outcome(owner,run.id))?.state).toBe('revoked');
    // A saved grant covers the waiting command.
    const again=await control.propose(owner,plan(requirement('command.run',shell)));expect(again.state).toBe('pending');
    await allow(requirement('command.run',shell),'always');
    expect((await control.outcome(owner,again.id))?.state).toBe('approved');
  });
  it('matches browser executable, profile AND exact origin independently',async()=>{
    const view=requirement('browser.view',browser);await allow(view);await enable();
    expect((await control.propose(owner,plan(view))).state).toBe('approved');
    for(const scope of [{...browser,application:'C:\\Browsers\\Edge.exe'},{...browser,profile:'Work'},{...browser,target:'https://other.test'},{...browser,target:'http://example.test'},{...browser,target:'https://sub.example.test'}])expect((await control.propose(owner,plan(requirement('browser.view',scope)))).state).toBe('pending');
    expect((await control.propose(owner,plan(requirement('browser.fill',browser)))).state).toBe('pending');
  });
  it('inherits folder descendants but never another action, application, PC or owner',async()=>{
    await allow();await enable();
    for(const target of ['C:\\Work','C:\\Work\\Reports-other'])expect((await control.propose(owner,plan(requirement('folder.read',{kind:'folder',target})))).state).toBe('pending');
    expect((await control.propose(owner,plan(requirement('folder.read',{kind:'folder',target:'C:\\Work\\Reports\\Private'})))).state).toBe('approved');
    expect((await control.propose(owner,plan(requirement('file.delete',folder)))).state).toBe('pending');
    const app=requirement('app.launch',{kind:'application',target:'C:\\Apps\\One.exe'});await allow(app);
    expect((await control.propose(owner,plan(requirement('app.launch',{kind:'application',target:'C:\\Apps\\Two.exe'})))).state).toBe('pending');
    const second=new PcControl(db,key,'pc-two');expect((await second.snapshot(owner)).policies).toEqual([]);
    expect((await control.snapshot(other)).policies).toEqual([]);
  });
  it('checks every effect together including source and destination and never denial wins',async()=>{
    await enable();await allow();
    const write=requirement('folder.write',{kind:'folder',target:'C:\\Other'});
    const multi=plan(read,{requirements:[read,write]});expect((await control.propose(owner,multi)).state).toBe('pending');
    await allow(write);expect((await control.propose(owner,multi)).state).toBe('approved');
    await allow(write,'never');expect((await control.propose(owner,multi)).state).toBe('denied');
  });
  it('ask always needs a new pinned decision and cannot be replayed or changed',async()=>{
    await enable();await allow(read,'ask');const input=plan();const requested=await control.propose(owner,input),run=vi.fn(async()=>{});
    await expect(control.execute(owner,requested.id,input,run)).rejects.toThrow();await control.decide(owner,requested.id,true);
    await expect(control.execute(owner,requested.id,plan(read,{payload:{path:'different.txt'}}),run)).rejects.toThrow();
    await control.execute(owner,requested.id,input,run);await expect(control.execute(owner,requested.id,input,run)).rejects.toThrow();expect(run).toHaveBeenCalledTimes(1);
    expect((await control.propose(owner,input)).state).toBe('pending');
  });
  it('never cannot be overridden by approving or broad existing approvals',async()=>{
    await enable();const proposed=await control.propose(owner,plan());await allow(read,'never');
    await expect(control.decide(owner,proposed.id,true)).rejects.toThrow();expect((await control.propose(owner,plan())).state).toBe('denied');
  });
  // Commands are the one high-risk action a saved grant may pre-approve (tested above).
  for(const [action,,kind,high] of PC_ACTIONS.filter(s=>s[3]&&!PC_GRANTABLE_HIGH_RISK.includes(s[0])))it(`${action} always requires a separate single-action approval`,async()=>{
    const scope:PcScope=kind==='browser'?browser:kind==='folder'?folder:kind==='application'?{kind,target:'C:\\Apps\\Editor.exe'}:kind==='command'?{kind,target:'C:\\Work',application:'C:\\Tools\\Runner.exe'}:{kind,target:'exact-item'};
    const r=requirement(action,scope);await allow(r);await enable();const input=plan(r),q=await control.propose(owner,input),run=vi.fn(async()=>{});
    expect(high).toBe(true);expect(q.state).toBe('pending');await expect(control.execute(owner,q.id,input,run)).rejects.toThrow();
    await control.decide(owner,q.id,true);await control.execute(owner,q.id,input,run);expect(run).toHaveBeenCalledTimes(1);
    expect((await control.propose(owner,input)).state).toBe('pending');
  });
  it('temporary grants expire at the exact bound even between preparation and execution',async()=>{
    await enable();await allow(read,'temporary',{expiresAt:new Date(clock+1000).toISOString()});const input=plan(),q=await control.propose(owner,input);
    expect(q.state).toBe('approved');clock+=1000;await expect(control.execute(owner,q.id,input,vi.fn())).rejects.toThrow();
    expect((await control.snapshot(owner)).policies[0].active).toBe(false);expect((await control.propose(owner,input)).state).toBe('pending');
  });
  it('task grants bind to an owned active task and end when the task ends',async()=>{
    await enable();const id=await task(),otherTask=await task(other);await allow(read,'task',{taskId:id});
    expect((await control.propose(owner,plan())).state).toBe('pending');
    expect((await control.propose(owner,plan(read,{taskId:otherTask}))).state).toBe('denied');
    const input=plan(read,{taskId:id}),q=await control.propose(owner,input);expect(q.state).toBe('approved');
    await db.query(`update tasks set state='closed' where id=$1`,[id]);await expect(control.execute(owner,q.id,input,vi.fn())).rejects.toThrow();
    expect((await control.snapshot(owner)).policies[0].active).toBe(false);
    await expect(allow(read,'task',{taskId:otherTask})).rejects.toThrow();
  });
  it('rejects expired pending decisions and approved actions',async()=>{
    await enable();const input=plan(),q=await control.propose(owner,input);clock+=600001;
    await expect(control.decide(owner,q.id,true)).rejects.toThrow();expect((await control.snapshot(owner)).requests).toEqual([]);
  });
  it('claims once under concurrent execution and does not retry failed adapters',async()=>{
    await allow();await enable();const input=plan(),q=await control.propose(owner,input),run=vi.fn(async()=>{});
    const results=await Promise.allSettled([control.execute(owner,q.id,input,run),control.execute(owner,q.id,input,run)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(run).toHaveBeenCalledTimes(1);
    const next=await control.propose(owner,input);await expect(control.execute(owner,next.id,input,async()=>{throw Error('private command output');})).rejects.toThrow('PC action failed');
    await expect(control.execute(owner,next.id,input,run)).rejects.toThrow();expect(JSON.stringify(await control.snapshot(owner))).not.toContain('private command output');
  });
  it('emergency stop aborts active work, revokes task/temporary/pending access and preserves exact enduring choices',async()=>{
    await enable();await allow();await allow(requirement('folder.write',folder),'temporary',{expiresAt:new Date(clock+100000).toISOString()});
    await allow(requirement('explorer.view',folder),'task',{taskId:await task()});
    const input=plan(),q=await control.propose(owner,input);let signal:AbortSignal|undefined;let started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    const running=control.execute(owner,q.id,input,async(_,s)=>{signal=s;started();await new Promise<void>(resolve=>s.addEventListener('abort',()=>resolve(),{once:true}));});
    await ready;await control.stop(owner);await running;expect(signal?.aborted).toBe(true);
    const after=await control.snapshot(owner);expect(after.enabled).toBe(false);expect(after.policies).toHaveLength(1);expect(after.policies[0].mode).toBe('always');expect(after.activity.some(e=>e.kind==='Action interrupted')).toBe(true);
    await enable();await expect(control.execute(owner,q.id,input,vi.fn())).rejects.toThrow();
  });
  it('persists encrypted scopes/action payloads/audit with owner/PC binding and rejects tampering',async()=>{
    await allow();await enable();const input=plan(read,{payload:{secret:'sensitive-fixture-value'}}),q=await control.propose(owner,input);
    const stored=JSON.stringify(await db.query(`select policy_enc,scope_hash from pc_control_policies where owner_user_id=$1`,[owner]))+JSON.stringify(await db.query(`select request_enc from pc_control_requests where id=$1`,[q.id]))+JSON.stringify(await db.query(`select detail_enc from pc_control_activity where owner_user_id=$1`,[owner]));
    expect(stored).not.toContain('sensitive-fixture-value');expect(stored).not.toContain('Reports');
    const snapshot=JSON.stringify(await control.snapshot(owner));expect(snapshot).not.toContain('sensitive-fixture-value');expect(snapshot).not.toContain('request_enc');
    const persisted=new PcControl(db,key,'pc-one',()=>clock);expect((await persisted.snapshot(owner)).policies).toHaveLength(1);
    await expect(control.decide(other,q.id,true)).rejects.toMatchObject({status:404});
    await db.query(`update pc_control_requests set request_hash=$2 where id=$1`,[q.id,'0'.repeat(64)]);await expect(control.execute(owner,q.id,input,vi.fn())).rejects.toThrow('integrity');
  });
  it('emergency disable needs no decryption key or readable policy ciphertext',async()=>{
    await allow(read,'temporary',{expiresAt:new Date(clock+10000).toISOString()});await enable();
    await db.query(`update pc_control_policies set policy_enc='broken' where owner_user_id=$1`,[owner]);await disablePcControl(db,owner,'pc-one');
    expect((await control.snapshot(owner)).enabled).toBe(false);expect((await control.snapshot(owner)).policies).toEqual([]);
  });
  it('revoke and policy changes invalidate already prepared actions; restart never retries executing work',async()=>{
    const saved=await control.savePolicy(owner,{...read,mode:'always'});await enable();const input=plan(),q=await control.propose(owner,input);await control.revoke(owner,saved.id);
    await expect(control.execute(owner,q.id,input,vi.fn())).rejects.toThrow();
    await allow();const executing=await control.propose(owner,input);await db.query(`update pc_control_requests set state='executing' where id=$1`,[executing.id]);
    await expect(new PcControl(db,key,'pc-one').execute(owner,executing.id,input,vi.fn())).rejects.toThrow();
  });
  it('does not change existing connector/workspace approval preferences',async()=>{
    await db.query(`insert into user_approval_prefs(user_id,action_class,level) values($1,'calendar_write','risky_only')`,[owner]);
    const before=await db.query(`select * from user_approval_prefs where user_id=$1`,[owner]);await allow();await enable();await control.stop(owner);
    expect(await db.query(`select * from user_approval_prefs where user_id=$1`,[owner])).toEqual(before);
  });
  it('refuses missing transactional storage and malformed/unbounded inputs',async()=>{
    const unsafe=new PcControl({query:db.query},key,'pc-one');await expect(unsafe.propose(owner,plan())).rejects.toMatchObject({status:503});
    for(const target of ['..\\Private','C:\\Work\\..\\Private','C:\\Work\\*','\\\\server\\share','C:\\Work\\a.txt:secret','C:\\Work\\Bad.'])expect(()=>normalizePcRequirement(requirement('folder.read',{kind:'folder',target}))).toThrow();
    expect(()=>normalizePcRequirement(requirement('browser.view',{...browser,target:'https://example.test/private?token=x'}))).toThrow();
    await expect(control.savePolicy(owner,{...read,mode:'temporary',expiresAt:new Date(clock+86400001).toISOString()})).rejects.toThrow();
    await expect(control.savePolicy(owner,{...read,mode:'temporary',expiresAt:'not-a-time'})).rejects.toThrow();
    await expect(control.propose(owner,plan(read,{payload:{value:undefined}}))).rejects.toThrow();
    await expect(control.propose(owner,plan(read,{payload:'x'.repeat(65537)}))).rejects.toThrow();
  });
});
