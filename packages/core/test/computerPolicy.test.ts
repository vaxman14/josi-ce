import { beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { AUTOMATION_PERMISSION_SEMANTICS, COMPUTER_CONTROL_VERSION, type AutomationPermissionPolicy, type ComputerProof } from '@josi-ce/protocol';
import { testDb, type TestDb } from './helpers.js';
import { ComputerControl, computerCanonical, computerDeviceId } from '../src/computerControl.js';
import { MasterKey } from '../src/masterKey.js';
import { initializeVault } from '../src/vault.js';
import { openSealed, seal } from '../src/sealing.js';
import { AUTOMATION_POLICY_RECORD_ID, AUTOMATION_ENFORCEMENT_VERSION } from '../src/automationPolicy.js';
import { CARDINAL_POLICY_RECORD_ID, CARDINAL_ENFORCEMENT_VERSION } from '../src/cardinalPolicy.js';
import { PROTECTED_DEVICES_RECORD_ID } from '../src/protectedDevices.js';
import { WORKSPACE_STORAGE_RECORD_ID } from '../src/workspaceStorage.js';
import { AUTOMATION_TARGETS_RECORD_ID } from '../src/automationTargets.js';
import { testCardinalRule, type CardinalRule } from '../src/cardinalRules.js';
import type { VaultRecordKind } from '../src/vaultRecords.js';
import { currentAutomationModelCandidate } from '../src/automationModelTargets.js';

const installKey=new MasterKey(Buffer.alloc(32,49));
const macKey=generateKeyPairSync('ed25519'), hardware=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const publicKey=macKey.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
const deviceId=computerDeviceId(publicKey);
const wrapping=hardware.publicKey.export({format:'der',type:'spki'}).subarray(-65).toString('base64');
const appIdentity='com.apple.TextEdit|apple|/System/Applications/TextEdit.app';
const appId=randomUUID(),workspaceId=randomUUID(),enrollmentId=randomUUID(),serverId=randomUUID(),oldDeviceId=randomUUID();
let db:TestDb,c:ComputerControl,owner:string,clock:number,vaultKey:MasterKey,policy:AutomationPermissionPolicy,task:string;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function proof(method:string,body:Record<string,unknown>={}):ComputerProof {
  const payload={version:COMPUTER_CONTROL_VERSION,ownerId:owner,deviceId,nonce:randomUUID(),timestamp:clock,method,body};
  return {payload,signature:sign(null,Buffer.from(computerCanonical(payload)),macKey.privateKey).toString('base64')};
}
// Seed authenticated encrypted records in a disposable DB. This fixture is
// not exported by production and cannot bypass the normal protected writers.
async function record(id:string,kind:VaultRecordKind,value:unknown){
  const [prior]=await db.query<{version:number;digest:string}>('select version,digest from vault_record_heads where id=$1',[id]);
  const [state]=await db.query<{authority_epoch:string}>('update vault_state set authority_epoch=authority_epoch+1 returning authority_epoch');
  const version=(prior?.version??0)+1,epoch=Number(state.authority_epoch);
  const enc=seal(vaultKey,{purpose:'josi-vault-record',schemaVersion:1,recordId:id,kind,version,epoch,previousDigest:prior?.digest??null,createdBy:owner,value:JSON.stringify(value)});
  await db.query('insert into vault_record_heads(id,kind,version,digest) values($1,$2,$3,$4) on conflict(id) do update set version=excluded.version,digest=excluded.digest',[id,kind,version,hash(enc)]);
  await db.query('insert into vault_record_versions(record_id,version,schema_version,authority_epoch,digest,previous_digest,value_enc,created_by) values($1,$2,1,$3,$4,$5,$6,$7)',[id,version,epoch,hash(enc),prior?.digest??null,enc,owner]);
}
async function savePolicy(){await record(AUTOMATION_POLICY_RECORD_ID,'automation_policy',{schemaVersion:1,enforcementVersion:AUTOMATION_ENFORCEMENT_VERSION,policies:[policy],lastChange:{actorUserId:owner,at:new Date(clock).toISOString()}});}
async function link(){
  const prepared=await c.deviceCall(owner,'link-prepare',proof('link-prepare',{enrollmentId,workspaceId})) as {challengeId:string;message:string};
  await c.deviceCall(owner,'link-complete',proof('link-complete',{challengeId:prepared.challengeId,signature:sign('sha256',Buffer.from(prepared.message,'base64'),hardware.privateKey).toString('base64url')}));
  await c.deviceCall(owner,'resume',proof('resume'));
  return prepared;
}
const read={action:'window.read' as const,scope:{kind:'application' as const,target:appIdentity},args:{}};
async function workTask(){
  const [thread]=await db.query<{id:string}>("insert into threads(owner_user_id,title) values($1,'Mac control check') returning id",[owner]);
  const [message]=await db.query<{id:string}>("insert into messages(thread_id,direction,body) values($1,'in','Check this Mac') returning id",[thread.id]);
  await db.query("insert into work_goals(id,owner_user_id,thread_id,source_message_id,state,outcome,criteria,steps,activity,created_at) values($1,$2,$3,$4,'working','Mac check','[]','[]','checking',$5)",[task,owner,thread.id,message.id,new Date(clock-1000).toISOString()]);
}
async function modelGrant(mode:'standing'|'deny'='standing',limit:number|null=null){
  await db.query("insert into llm_providers(role,provider,model,activated_at,probed_at,cap_chat) values('primary','openai_compatible','fixture',now(),now(),true)");
  const configurationId=randomUUID(),candidate=await currentAutomationModelCandidate(db,'primary',configurationId);
  const [head]=await db.query<{value_enc:string}>(`select v.value_enc from vault_record_versions v join vault_record_heads h on h.id=v.record_id and h.version=v.version where h.id=$1`,[AUTOMATION_TARGETS_RECORD_ID]);
  const targets=JSON.parse(openSealed<{value:string}>(vaultKey,head.value_enc).value);
  targets.schemaVersion=2;
  targets.models=[{configurationId,configurationRevision:1,identity:policy.identity,candidate,registeredAt:new Date(clock).toISOString()}];
  await record(AUTOMATION_TARGETS_RECORD_ID,'automation_targets',targets);
  policy.rules.push({id:randomUUID(),action:'model.transmit',scope:{kind:'model',configurationId,configurationRevision:1},mode:{kind:mode},
    limits:mode==='deny'?null:{maxActionsPerTask:limit,maxBytesPerTask:null,maxTaskDurationMs:null}});
  await savePolicy();await workTask();await link();
  const q=await c.submit(owner,deviceId,task,read,'capture-for-model');
  await c.deviceCall(owner,'next',proof('next'));
  await c.deviceCall(owner,'result',proof('result',{requestId:q.id,ok:true,result:{observationId:'synthetic-observation',untrusted:true}}));
  return {q,candidate};
}
beforeEach(async()=>{
  db=await testDb();clock=Date.now();
  [{id:owner}]=await db.query<{id:string}>("insert into users(email,username,role) values('mac@fixture.test','mac','super_admin') returning id");
  await initializeVault(db,installKey,owner);
  const [state]=await db.query<{master_key_enc:string}>('select master_key_enc from vault_state');
  vaultKey=new MasterKey(Buffer.from(openSealed<{key:string}>(installKey,state.master_key_enc).key,'base64'));
  const identity={userId:owner,serverId,deviceId:oldDeviceId,workspaceId};
  const deviceIdentity={serverOrigin:'http://127.0.0.1:48991',serverId,userId:owner,deviceId:oldDeviceId};
  await record(PROTECTED_DEVICES_RECORD_ID,'protected_devices',{schemaVersion:1,devices:[{id:enrollmentId,label:'Saved Mac',enrolledAt:new Date(clock).toISOString(),revokedAt:null,
    material:{schemaVersion:1,identity:deviceIdentity,wrappingPublicKey:wrapping,signingPublicKeySpki:macKey.publicKey.export({format:'der',type:'spki'}).toString('base64'),wrappedPrivateKey:randomBytes(80).toString('base64')}}]});
  await record(WORKSPACE_STORAGE_RECORD_ID,'workspace_storage',{schemaVersion:1,workspaces:[{workspaceId,identity:deviceIdentity,label:'This Mac',capacityGiB:0,createdAt:new Date(clock).toISOString(),imagePassword:'',mode:'current_desktop'}]});
  await record(AUTOMATION_TARGETS_RECORD_ID,'automation_targets',{schemaVersion:1,applications:[{applicationId:appId,installationRevision:1,identity,registeredAt:new Date(clock).toISOString(),candidate:{schemaVersion:'1',candidateId:appId,guestBootId:randomUUID(),kind:'application',label:'TextEdit',bundlePath:'/System/Applications/TextEdit.app',bundleId:'com.apple.TextEdit',signingId:'com.apple.TextEdit',teamId:'',codeHash:'a'.repeat(40)}}]});
  policy={schemaVersion:1,semanticsVersion:AUTOMATION_PERMISSION_SEMANTICS,identity,enabled:true,unmatched:'deny',rules:[{id:randomUUID(),action:'computer.observe',scope:{kind:'application',applicationId:appId,installationRevision:1},mode:{kind:'standing'},limits:{maxTaskDurationMs:null,maxActionsPerTask:null,maxBytesPerTask:null}}]};
  await savePolicy();
  c=new ComputerControl(db,installKey,()=>clock);task=randomUUID();
  await c.enroll(owner,proof('enroll',{publicKey,platform:'macos',label:'Native Mac'}));
  await c.deviceCall(owner,'presence',proof('presence',{capabilities:['window.read','window.type','file.read']}));
});
describe('saved Mac permission integration',()=>{
  it('keeps saved model-transmission denials even when observation is allowed',async()=>{
    const {q}=await modelGrant('deny');
    await expect(c.prepareModelProjection(owner,[q.id])).rejects.toThrow(/model-transmission/);
  });
  it('pins one model send and charges its saved budget exactly once',async()=>{
    const {q,candidate}=await modelGrant('standing',1);
    const projection=await c.prepareModelProjection(owner,[q.id]);
    expect(projection.expectedPrimary).toEqual({providerId:'openai_compatible',model:'fixture',configurationVersion:candidate!.configurationVersion});
    expect(JSON.parse(projection.content().reveal())[q.id].observationId).toBe('synthetic-observation');
    await projection.beforeDispatch();
    await expect(projection.beforeDispatch()).rejects.toThrow(/twice/);
    await projection.finish(true);
    expect(()=>projection.content()).toThrow(/expired/);
    await expect(c.prepareModelProjection(owner,[q.id])).rejects.toThrow(/model-transmission/);
  });
  it('rechecks saved policy immediately before captured content leaves the server',async()=>{
    const {q}=await modelGrant();const projection=await c.prepareModelProjection(owner,[q.id]);
    policy.rules[1].mode={kind:'deny'};policy.rules[1].limits=null;await savePolicy();
    await expect(projection.beforeDispatch()).rejects.toThrow(/permissions changed/);
  });
  it.each(['model-change','local-stop'])('refuses transmission after %s',async scenario=>{
    const {q}=await modelGrant();const projection=await c.prepareModelProjection(owner,[q.id]);
    if(scenario==='model-change')await db.query("update llm_providers set model='different-model' where role='primary'");
    else await c.stop(owner,deviceId);
    await expect(projection.beforeDispatch()).rejects.toThrow(scenario==='model-change'?/current primary model/:/no longer available/);
  });
  it('requires possession of the enrolled hardware key and refuses replay',async()=>{
    await expect(c.deviceCall(owner,'resume',proof('resume'))).rejects.toThrow(/saved Mac/);
    const p=await c.deviceCall(owner,'link-prepare',proof('link-prepare',{enrollmentId,workspaceId})) as {challengeId:string};
    await expect(c.deviceCall(owner,'link-complete',proof('link-complete',{challengeId:p.challengeId,signature:randomBytes(64).toString('base64url')}))).rejects.toThrow(/possess/);
    const used=await link();
    await expect(c.deviceCall(owner,'link-complete',proof('link-complete',{challengeId:used.challengeId,signature:'x'}))).rejects.toThrow(/expired/);
  });
  it('reuses a saved exact app allowance without copying or rewriting its policy',async()=>{
    await link();const before=await db.query('select * from vault_record_heads order by id');
    const q=await c.submit(owner,deviceId,task,read,'saved-read');expect(q.state).toBe('approved');
    const next=await c.deviceCall(owner,'next',proof('next')) as any;
    expect(next.request.id).toBe(q.id);expect(next.request.applicationPin).toEqual({signingId:'com.apple.TextEdit',codeHash:'a'.repeat(40)});
    expect(next.device.rules).toContainEqual(expect.objectContaining({action:'window.read',duration:{kind:'once',requestId:q.id}}));
    expect((await c.snapshot(owner)).devices[0].rules).toEqual([]);
    expect(await db.query('select * from vault_record_heads order by id')).toEqual(before);
  });
  it('keeps saved denials stronger than a new broad grant and applies revocation during a lease',async()=>{
    await link();const p=await c.propose(owner,deviceId,task,'Allow broad access',{rule:{id:randomUUID(),action:'*',scope:{kind:'host',target:'this-device'},decision:'allow',duration:{kind:'saved'}}});await c.decide(owner,p.id,p.digest,true);
    const q=await c.submit(owner,deviceId,task,read,'before');await c.deviceCall(owner,'next',proof('next'));
    policy.rules.push({...policy.rules[0],id:randomUUID(),mode:{kind:'deny'},limits:null});await savePolicy();
    await expect(c.deviceCall(owner,'lease',proof('lease',{requestId:q.id}))).rejects.toThrow();
    await expect(c.submit(owner,deviceId,task,read,'after')).rejects.toThrow(/saved permissions/);
  });
  it('keeps a new explicit denial stronger than a saved standing allowance',async()=>{
    await link();await c.restrict(owner,deviceId,task,{rule:{id:randomUUID(),action:'window.read',scope:read.scope,decision:'deny',duration:{kind:'saved'}}});
    await expect(c.submit(owner,deviceId,task,read,'denied')).rejects.toThrow(/explicitly denied/);
  });
  it('enforces Ask on each exact operation and cannot clear it with a standing grant',async()=>{
    policy.rules[0].mode={kind:'ask'};policy.rules[0].limits=null;await savePolicy();await link();
    const q=await c.submit(owner,deviceId,task,read,'first');expect(q.state).toBe('pending');
    const p=await c.propose(owner,deviceId,task,'Allow this exact read once',{approveRequestId:q.id});await c.decide(owner,p.id,p.digest,true);
    expect((await c.deviceCall(owner,'next',proof('next')) as any).request.id).toBe(q.id);
    await c.deviceCall(owner,'result',proof('result',{requestId:q.id,ok:true,result:{}}));
    expect((await c.submit(owner,deviceId,task,read,'second')).state).toBe('pending');
  });
  it('keeps local Stop usable while the Vault is locked, and never treats unreadable policy as empty',async()=>{
    await link();await db.query('update vault_state set locked=true');
    expect((await c.snapshot(owner)).policyStatus.available).toBe(false);
    await expect(c.submit(owner,deviceId,task,read,'locked')).rejects.toThrow(/Vault/);
    await expect(c.stop(owner,deviceId)).resolves.toEqual({ok:true});
    await db.query('update vault_state set locked=false');
    await db.query("update vault_record_versions set value_enc='corrupt' where record_id=$1",[AUTOMATION_POLICY_RECORD_ID]);
    expect((await c.snapshot(owner)).policyStatus.available).toBe(false);
  });
  it('charges saved task budgets once at dispatch, including failed or uncertain attempts',async()=>{
    await workTask();policy.rules[0].limits={maxTaskDurationMs:60000,maxActionsPerTask:1,maxBytesPerTask:65536};await savePolicy();await link();
    const q=await c.submit(owner,deviceId,task,read,'budget');await c.deviceCall(owner,'next',proof('next'));
    await expect(c.deviceCall(owner,'lease',proof('lease',{requestId:q.id}))).resolves.toHaveProperty('leaseUntil');
    await c.deviceCall(owner,'result',proof('result',{requestId:q.id,ok:false,result:{error:'fixture failure'}}));
    await expect(c.submit(owner,deviceId,task,read,'retry')).rejects.toThrow(/limits/);
    expect((await c.submit(owner,deviceId,task,read,'budget')).id).toBe(q.id);
  });
  it('cannot use exact Ask approval to skip overlapping allowance budgets',async()=>{
    await workTask();policy.rules[0].limits={maxTaskDurationMs:null,maxActionsPerTask:1,maxBytesPerTask:65536};
    policy.rules.push({...policy.rules[0],id:randomUUID(),mode:{kind:'ask'},limits:null});await savePolicy();await link();
    const q=await c.submit(owner,deviceId,task,read,'ask-budget');
    const p=await c.propose(owner,deviceId,task,'Read once',{approveRequestId:q.id});await c.decide(owner,p.id,p.digest,true);
    await c.deviceCall(owner,'next',proof('next'));await c.deviceCall(owner,'result',proof('result',{requestId:q.id,ok:true,result:{}}));
    await expect(c.submit(owner,deviceId,task,read,'second')).rejects.toThrow(/limits/);
  });
  it('bounds the local lease by the saved time limit and refuses inactive tasks',async()=>{
    await workTask();policy.rules[0].limits={maxTaskDurationMs:2000,maxActionsPerTask:null,maxBytesPerTask:null};await savePolicy();await link();
    const q=await c.submit(owner,deviceId,task,read,'timed');const next=await c.deviceCall(owner,'next',proof('next')) as any;
    expect(next.request.leaseUntil).toBeLessThanOrEqual(clock+1000);
    clock+=1001;await expect(c.deviceCall(owner,'lease',proof('lease',{requestId:q.id}))).rejects.toThrow();
    await db.query("update work_goals set state='paused' where id=$1",[task]);
    await expect(c.submit(owner,deviceId,task,read,'paused')).rejects.toThrow(/paused/);
  });
  it('enforces Cardinal restrictions even with an ordinary allowance',async()=>{
    const definition:CardinalRule={schemaVersion:1,label:'No observation',wording:'Do not observe this Mac.',actions:['computer.observe'],scope:{userId:'*',serverId:'*',deviceId:'*',workspaceId:'*',taskId:'*'},restriction:{kind:'deny'},onUnavailable:'deny'};
    const ruleId=randomUUID();await record(CARDINAL_POLICY_RECORD_ID,'cardinal_policy',{schemaVersion:1,enforcementVersion:CARDINAL_ENFORCEMENT_VERSION,rules:[{ruleId,source:{recordId:ruleId,version:1,digest:'a'.repeat(64)},definition,tested:{report:testCardinalRule(definition)}}],lastChange:{operation:'activate',ruleId,actorUserId:owner,at:new Date(clock).toISOString()}});
    await link();await expect(c.submit(owner,deviceId,task,read,'cardinal')).rejects.toThrow(/Cardinal/);
  });
});
