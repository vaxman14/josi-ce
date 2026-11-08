import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { posix } from 'node:path';
import { COMPUTER_ACTIONS, COMPUTER_CONTROL_VERSION, COMPUTER_LEASE_MS,
  type ComputerAction, type ComputerDevice, type ComputerOperation, type ComputerProof,
  type ComputerProposal, type ComputerRequest, type ComputerRule, type ComputerScope } from '@josi-ce/protocol';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { openSealed, seal, Secret } from './sealing.js';
import type { AutomationModelProjection } from './automationRuntime.js';
import { currentAutomationModelCandidate, requireCurrentAutomationModel, type AutomationModelCandidate } from './automationModelTargets.js';
import { sameAutomationIdentity } from './automationTargets.js';
import { refuseMemorySecret } from './memorySafety.js';
import { vaultRecords } from './vault.js';
import { evaluateComputerPolicy, type ComputerPolicySnapshot, type ComputerPolicyUsage } from './computerPolicy.js';
export { COMPUTER_ACTIONS, COMPUTER_CONTROL_VERSION, COMPUTER_LEASE_MS, type ComputerAction, type ComputerDevice, type ComputerOperation, type ComputerProof, type ComputerProposal, type ComputerRequest, type ComputerRule, type ComputerScope } from '@josi-ce/protocol';
export class ComputerControlError extends Error { constructor(readonly status:number,message:string){super(message);} }
const fail=(message:string,status=400):never=>{throw new ComputerControlError(status,message);};
const id=(v:unknown):string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)?v:fail('Invalid identity.');
const text=(v:unknown,n=2048):string=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\x00-\x1f\x7f]/.test(v)?v:fail('An exact bounded scope is required.');
export function computerCanonical(v:unknown,depth=0):string {
  if(depth>20)return fail('Protocol value is too deeply nested.');
  if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);
  if(typeof v==='number'&&Number.isSafeInteger(v))return String(v);
  if(Array.isArray(v))return '['+v.map(x=>computerCanonical(x,depth+1)).join(',')+']';
  if(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype)return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+computerCanonical((v as Record<string,unknown>)[k],depth+1)).join(',')+'}';
  return fail('Only integer-valued bounded JSON is supported.');
}
export const computerDigest=(v:unknown)=>createHash('sha256').update(computerCanonical(v)).digest('hex');
export const computerDeviceId=(publicKey:string)=>'mac-'+createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('hex').slice(0,40);
const same=(a:unknown,b:unknown)=>computerCanonical(a)===computerCanonical(b);
function exact(v:object,keys:string[]){if(Object.keys(v).some(k=>!keys.includes(k)))fail('Unsupported restrictions or fields must not be discarded.');}
export function computerPath(v:unknown):string {
  const p=text(v);
  if(!p.startsWith('/')||p.startsWith('//')||p.includes('\\')||p.split('/').some(s=>s==='.'||s==='..')||p!==posix.normalize(p)||p.endsWith('/')&&p!=='/')fail('Use an exact absolute POSIX path. Links and volume identity are checked again on the Mac.');
  return p;
}
function scopeFor(action:ComputerAction|'*',raw:ComputerScope):ComputerScope {
  if(!raw||typeof raw!=='object')return fail('A scope is required.');exact(raw,['kind','target']);
  const kind=action.startsWith('file.')?'folder':action.startsWith('terminal.')||action==='*'?'host':action==='environment'||action==='app.list'?'device':'application';
  if(raw.kind!==kind)fail('This capability requires a '+kind+' scope.');
  const target=kind==='folder'?computerPath(raw.target):text(raw.target);
  if(['host','device'].includes(kind)&&target!=='this-device')fail('Select this-device; the authenticated device id provides its identity.');
  // Applications use bundle id, signing-team id and canonical .app path together.
  if(kind==='application'&&!/^[a-zA-Z0-9.-]+\|[a-zA-Z0-9.-]+\|\/.+\.app$/.test(target))fail('Choose an application identity from this Mac’s inventory.');
  return {kind,target};
}
export function normalizeComputerOperation(raw:ComputerOperation):ComputerOperation {
  if(!raw||typeof raw!=='object')return fail('An operation is required.');exact(raw,['action','scope','args']);
  if(!COMPUTER_ACTIONS.includes(raw.action))fail('Unsupported computer action.');
  if(!raw.args||typeof raw.args!=='object'||Array.isArray(raw.args)||computerCanonical(raw.args).length>32_768)fail('Invalid operation arguments.');
  const fields:Record<ComputerAction,string[]>={environment:[], 'file.list':['path'],'file.read':['path'],'file.write':['path','text','expectedDigest'],
    'app.list':[],'app.launch':[], 'window.read':[],'window.capture':[],
    'window.click':['observationId','elementId'],'window.type':['observationId','elementId','text'],
    'window.scroll':['observationId','deltaY'],'window.drag':['observationId','fromX','fromY','toX','toY'],
    'window.close':['observationId'], 'terminal.open':['shell','cwd'], 'terminal.input':['sessionId','text'],
    'terminal.read':['sessionId','offset'],'terminal.close':['sessionId']};
  exact(raw.args,fields[raw.action]);
  if(fields[raw.action].some(k=>!Object.hasOwn(raw.args,k)))fail('Every operation argument must be explicit.');
  const scope=scopeFor(raw.action,raw.scope), args=raw.args;
  const argumentText=(name:string,max:number)=>{
    if(typeof args[name]!=='string'||args[name].length>max||args[name].includes('\0'))fail('Invalid '+name+' text.');
  };
  const integer=(name:string,min:number,max:number)=>{
    if(!Number.isSafeInteger(args[name])||Number(args[name])<min||Number(args[name])>max)fail('Invalid '+name+' integer.');
  };
  if(raw.action.startsWith('file.')){const p=computerPath(args.path),root=scope.target;if(!(p===root||p.startsWith(root==='/'?'/':root+'/')))fail('The file is outside the selected folder.');}
  if(raw.action==='file.write'){
    argumentText('text',32768);
    if(typeof args.expectedDigest!=='string'||! /^(?:[a-f0-9]{64})?$/.test(args.expectedDigest))fail('Provide the previous content digest, or an empty digest to create a new file.');
  }
  if(raw.action.startsWith('window.')&&!['window.read','window.capture'].includes(raw.action))id(args.observationId);
  if(['window.click','window.type'].includes(raw.action))id(args.elementId);
  if(raw.action==='window.type')argumentText('text',4096);
  if(raw.action==='window.scroll'){integer('deltaY',-1000,1000);if(args.deltaY===0)fail('Use a nonzero scroll delta.');}
  if(raw.action==='window.drag')for(const name of ['fromX','fromY','toX','toY'])integer(name,0,100_000);
  if(raw.action==='terminal.open'){computerPath(args.shell);computerPath(args.cwd);}
  if(['terminal.input','terminal.read','terminal.close'].includes(raw.action))id(args.sessionId);
  if(raw.action==='terminal.input')argumentText('text',4096);
  if(raw.action==='terminal.read')integer('offset',0,Number.MAX_SAFE_INTEGER);
  return {action:raw.action,scope,args};
}
function normalizeRule(raw:ComputerRule,taskId:string,now:number):ComputerRule {
  if(!raw||typeof raw!=='object')return fail('A permission rule is required.');exact(raw,['id','action','scope','decision','duration']);
  if(raw.action!=='*'&&!COMPUTER_ACTIONS.includes(raw.action))fail('Unknown capability.');
  if(!['allow','ask','deny'].includes(raw.decision))fail('Choose allow, ask or deny.');
  const d=raw.duration;if(!d||typeof d!=='object')return fail('Choose a duration.');
  exact(d,d.kind==='once'?['kind','requestId']:d.kind==='task'?['kind','taskId','expiresAt']:d.kind==='until'?['kind','expiresAt']:['kind']);
  if(!['saved','until','task','once'].includes(d.kind))fail('Unknown duration.');
  if(d.kind==='until'||d.kind==='task')if(!Number.isSafeInteger(d.expiresAt)||d.expiresAt<=now||d.expiresAt>now+30*86400_000)fail('Choose an expiration within 30 days.');
  if(d.kind==='task'&&d.taskId!==taskId)fail('The task grant must name the authenticated current work task.');
  if(d.kind==='once')id(d.requestId);
  return {id:raw.id?id(raw.id):randomUUID(),action:raw.action,scope:scopeFor(raw.action,raw.scope),decision:raw.decision,duration:d};
}
function active(rule:ComputerRule,q:ComputerRequest,now:number,liveTasks:string[]=[]) {
  const d=rule.duration;
  return d.kind==='saved'||d.kind==='until'&&d.expiresAt>now||d.kind==='task'&&d.taskId===q.taskId&&d.expiresAt>now&&liveTasks.includes(d.taskId)||d.kind==='once'&&d.requestId===q.id;
}
function covers(rule:ComputerRule,q:ComputerRequest){
  if(rule.action==='*')return true;
  if(rule.decision!=='allow'&&rule.action===q.operation.action&&rule.scope.kind==='folder'){const path=String(q.operation.args.path??'');return path===rule.scope.target||path.startsWith(rule.scope.target==='/'?'/':rule.scope.target+'/');}
  return rule.action===q.operation.action&&same(rule.scope,q.operation.scope);
}
export function computerDecision(device:ComputerDevice,q:ComputerRequest,now:number,liveTasks:string[]=[]):'allow'|'ask'|'deny' {
  if(device.stopped||device.revoked||!device.capabilities.includes(q.operation.action))return 'deny';
  const rules=device.rules.filter(r=>active(r,q,now,liveTasks));
  // Broad execution cannot enforce any narrower exclusion or ask boundary.
  if((q.operation.action.startsWith('terminal.')||['window.click','window.type','window.scroll','window.drag'].includes(q.operation.action))&&rules.some(r=>r.decision!=='allow'))return 'deny';
  const matching=rules.filter(r=>covers(r,q));
  if(matching.some(r=>r.decision==='deny'))return 'deny';
  if(matching.some(r=>r.decision==='ask'))return 'ask';
  return matching.some(r=>r.decision==='allow')?'allow':'ask';
}
interface State {ownerId:string;devices:ComputerDevice[];requests:ComputerRequest[];proposals:ComputerProposal[];nonces:{id:string;expiresAt:number}[];endedTasks:string[];liveTasks:string[];knownTasks:string[];taskStarts?:Record<string,number>;usage?:ComputerPolicyUsage[];links?:Array<{id:string;message:string;enrollmentId:string;workspaceId:string;deviceId:string;digest:string;expiresAt:number}>}
const initial=(ownerId:string):State=>({ownerId,devices:[],requests:[],proposals:[],nonces:[],endedTasks:[],liveTasks:[],knownTasks:[]});
export class ComputerControl {
  constructor(private db:Db,private key:MasterKey,private now=()=>Date.now()){}
  private linkChoices(policy:ComputerPolicySnapshot){
    if(!policy.available)return [];
    return policy.workspaces.flatMap(workspace=>{
      const device=policy.devices.find(d=>!d.revokedAt&&d.identity.userId===workspace.identity.userId
        &&d.identity.deviceId===workspace.identity.deviceId&&d.identity.serverId===workspace.identity.serverId);
      return device?[{enrollmentId:device.enrollmentId,identity:device.identity,workspaceId:workspace.workspaceId,
        label:workspace.label,wrappingFingerprint:device.wrappingFingerprint}]:[];
    });
  }
  private prepareLink(s:State,policy:ComputerPolicySnapshot,d:ComputerDevice,body:Record<string,unknown>){
    const selected=this.linkChoices(policy).find(c=>c.enrollmentId===body.enrollmentId&&c.workspaceId===body.workspaceId);
    const reference=policy.deviceReference;
    if(!selected||!reference)fail('Choose this Mac’s current saved desktop enrollment.',409);
    const challengeId=randomUUID(),now=this.now(),expiresAt=now+60_000;
    const i=selected!.identity,r=reference!;
    const message='josi-computer-control-link.1\n'+JSON.stringify([1,challengeId,randomBytes(32).toString('base64url'),
      i.serverOrigin,i.serverId,i.userId,i.deviceId,[r.recordId,r.version,r.digest,r.epoch],selected!.wrappingFingerprint,
      now,expiresAt,d.id,d.publicKey,selected!.workspaceId]);
    s.links=s.links!.filter(l=>l.deviceId!==d.id);
    s.links.push({id:challengeId,message,enrollmentId:selected!.enrollmentId,workspaceId:selected!.workspaceId,
      deviceId:d.id,digest:policy.digest,expiresAt});
    return {challengeId,message:Buffer.from(message).toString('base64'),identity:i,expiresAt};
  }
  private completeLink(s:State,policy:ComputerPolicySnapshot,d:ComputerDevice,body:Record<string,unknown>){
    const challenge=s.links!.find(l=>l.id===body.challengeId&&l.deviceId===d.id&&l.expiresAt>this.now()&&l.digest===policy.digest);
    const enrolled=challenge&&policy.devices.find(v=>v.enrollmentId===challenge.enrollmentId&&!v.revokedAt);
    if(!challenge||!enrolled||typeof body.signature!=='string')fail('Saved enrollment proof expired or changed.',409);
    const raw=Buffer.from(enrolled!.wrappingPublicKey,'base64');
    const key=createPublicKey({key:Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200','hex'),raw]),format:'der',type:'spki'});
    if(!verify('sha256',Buffer.from(challenge!.message),key,Buffer.from(body.signature as string,'base64url')))fail('This Mac does not possess the saved hardware key.',403);
    const {userId,serverId,deviceId}=enrolled!.identity;
    d.savedPermissions={enrollmentId:enrolled!.enrollmentId,wrappingFingerprint:enrolled!.wrappingFingerprint,
      identity:{userId,serverId,deviceId,workspaceId:challenge!.workspaceId}};
    d.revision++;d.stopped=true;
    s.links=s.links!.filter(l=>l.id!==challenge!.id);
    for(const q of s.requests.filter(q=>q.deviceId===d.id&&['pending','approved','running'].includes(q.state)))q.state='cancelled';
    return {ok:true,deviceId:d.id,savedPermissions:d.savedPermissions};
  }
  private decision(s:State,policy:ComputerPolicySnapshot,d:ComputerDevice,q:ComputerRequest){
    const started=s.taskStarts?.[q.taskId];
    const saved=evaluateComputerPolicy(policy,d,q,this.now(),started===undefined?undefined:
      {active:s.liveTasks.includes(q.taskId),startedAtMs:started},s.usage??[]);
    const local=computerDecision(d,q,this.now(),s.liveTasks);
    if(local==='deny')return {...saved,verdict:'deny' as const,reason:'Stopped, unsupported, or explicitly denied by this computer’s policy.'};
    if(saved.verdict!=='allow')return saved;
    if(local==='allow')return saved;
    const explicitAsk=d.rules.some(r=>r.decision==='ask'&&active(r,q,this.now(),s.liveTasks)&&covers(r,q));
    return {...saved,verdict:policy.required&&policy.permissions&&!explicitAsk?'allow' as const:'ask' as const};
  }
  private dispatchDevice(s:State,policy:ComputerPolicySnapshot,d:ComputerDevice,q:ComputerRequest){
    const rules=[...d.rules];
    // Project one exact, expiring operation from the current saved policy.
    // It is never written as a new grant or used to erase a local denial.
    if(policy.required&&policy.permissions)rules.push({id:q.id,action:q.operation.action,scope:q.operation.scope,
      decision:'allow',duration:{kind:'once',requestId:q.id}});
    return {...d,rules,activeTasks:s.liveTasks};
  }
  private async transaction<T>(owner:string,fn:(s:State,policy:ComputerPolicySnapshot,db:Db)=>T|Promise<T>):Promise<T>{
    id(owner);if(!this.db.transaction)return fail('Transactional storage is unavailable.',503);
    return this.db.transaction(async db=>{
      const policy=await vaultRecords(db,this.key).computerPolicy(owner,db);
      await db.query('insert into computer_control_v2(owner_user_id,state_enc) values($1,$2) on conflict do nothing',[owner,seal(this.key,initial(owner))]);
      const [row]=await db.query<{state_enc:string}>('select state_enc from computer_control_v2 where owner_user_id=$1 for update',[owner]);
      const s=openSealed<State>(this.key,row.state_enc);if(s.ownerId!==owner)return fail('Owner integrity check failed.',409);
      s.usage??=[];s.links??=[];
      const goals=await db.query<{id:string;state:string;created_at:string}>('select id,state,created_at from work_goals where owner_user_id=$1',[owner]);
      s.taskStarts=Object.fromEntries(goals.map(g=>[g.id,new Date(g.created_at).getTime()]));
      s.knownTasks=goals.map(g=>g.id);
      s.liveTasks=goals.filter(g=>!['completed','cancelled','paused'].includes(g.state)).map(g=>g.id);
      const now=this.now();s.links=s.links.filter(l=>l.expiresAt>now);s.nonces=s.nonces.filter(n=>n.expiresAt>now);
      for(const q of s.requests)if(['pending','approved','running'].includes(q.state)&&(q.expiresAt<=now||q.state==='running'&&(q.leaseUntil??0)<=now||s.endedTasks.includes(q.taskId)||q.taskBound&&!s.liveTasks.includes(q.taskId)))q.state='cancelled';
      for(const q of s.requests)if(['approved','running'].includes(q.state)&&q.savedPolicyDigest!==undefined&&q.savedPolicyDigest!==policy.digest)q.state='cancelled';
      // Retain concise bounded receipts, never raw output indefinitely.
      s.requests=s.requests.filter(q=>q.createdAt>now-86400_000).slice(-200);
      s.proposals=s.proposals.filter(p=>p.createdAt>now-86400_000).slice(-100);
      const out=await fn(s,policy,db);
      if(computerCanonical(s).length>4*1024*1024)return fail('Computer history is full. Clear completed activity before continuing.',409);
      await db.query('update computer_control_v2 set state_enc=$2,updated_at=now() where owner_user_id=$1',[owner,seal(this.key,s)]);
      return out;
    });
  }
  private device(s:State,deviceId:string){return s.devices.find(d=>d.id===deviceId&&!d.revoked)??fail('Enroll this computer first.',404);}
  private checkProof(owner:string,method:string,proof:ComputerProof,publicKey:string,s:State){
    const p=proof?.payload;
    if(!p||p.version!==COMPUTER_CONTROL_VERSION||p.ownerId!==owner||p.method!==method||p.deviceId!==computerDeviceId(publicKey)||
      !Number.isSafeInteger(p.timestamp)||Math.abs(this.now()-p.timestamp)>15_000||!id(p.nonce)||s.nonces.some(n=>n.id===p.nonce))return fail('Invalid, expired or replayed device proof.',403);
    exact(p,['version','ownerId','deviceId','method','body','nonce','timestamp']);
    const bytes=Buffer.from(publicKey,'base64');if(bytes.length!==32||bytes.toString('base64')!==publicKey)return fail('Invalid public key.');
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),bytes]),format:'der',type:'spki'});
    if(!verify(null,Buffer.from(computerCanonical(p)),key,Buffer.from(proof.signature,'base64')))return fail('Device signature was rejected.',403);
    s.nonces.push({id:p.nonce,expiresAt:this.now()+30_000});
  }
  async enroll(owner:string,proof:ComputerProof){return this.transaction(owner,s=>{
    const b=proof.payload.body;const publicKey=text(b.publicKey,128);this.checkProof(owner,'enroll',proof,publicKey,s);
    if(b.platform!=='macos')return fail('This adapter enrolls macOS computers only.');
    if(s.devices.some(d=>d.id===proof.payload.deviceId))return fail('This key was already enrolled. Revocation cannot be undone by replaying enrollment.',409);
    if(s.devices.length>=20)return fail('Too many computers.');
    const device:ComputerDevice={id:proof.payload.deviceId,label:text(b.label,100),platform:'macos',publicKey,revision:1,stopped:true,revoked:false,lastSeen:0,rules:[],capabilities:[]};
    s.devices.push(device);return {version:COMPUTER_CONTROL_VERSION,device};
  });}
  async snapshot(owner:string){return this.transaction(owner,(s,policy)=>({version:COMPUTER_CONTROL_VERSION,policyStatus:{required:policy.required,available:policy.available,reason:policy.reason},savedPermissionChoices:this.linkChoices(policy),devices:s.devices.map(({publicKey,...d})=>d),
    requests:s.requests.map(({result,...q})=>({...q,hasResult:result!==undefined})),proposals:s.proposals.filter(p=>p.state==='pending'&&p.expiresAt>this.now())}));}
  /** A direct chat restriction needs no step-up credential. This path cannot
   * add an allowance, remove a denial/ask rule, enable work or approve work. */
  async restrict(owner:string,deviceId:string,taskId:string,change:ComputerProposal['change']) {
    return this.transaction(owner,s=>{
      id(taskId);const d=this.device(s,deviceId);exact(change,['rule','removeRuleId','resume','approveRequestId']);
      if(!Object.keys(change).length||change.resume===true||change.approveRequestId||change.rule?.decision==='allow')return null;
      if(change.resume!==undefined&&change.resume!==false)return null;
      const removed=change.removeRuleId?d.rules.find(r=>r.id===change.removeRuleId):undefined;
      if(change.removeRuleId&&removed?.decision!=='allow')return null;
      const rule=change.rule?normalizeRule(change.rule,taskId,this.now()):undefined;
      if(rule&&(rule.decision==='allow'||rule.duration.kind==='once'))return null;
      if(rule?.duration.kind==='task'&&!s.liveTasks.includes(taskId))fail('Choose an active owned work task.');
      if(rule&&d.rules.some(r=>r.id===rule.id))fail('Use a new identity for the restriction.');
      if(removed)d.rules=d.rules.filter(r=>r.id!==removed.id);
      if(rule)d.rules.push(rule);
      if(change.resume===false)d.stopped=true;
      d.revision++;
      for(const q of s.requests.filter(q=>q.deviceId===d.id&&['pending','approved','running'].includes(q.state)))q.state='cancelled';
      return {applied:true,restrictionOnly:true,deviceId:d.id,revision:d.revision,stopped:d.stopped,
        message:'The restriction is active. Affected work was cancelled; completed effects are not undone.'};
    });
  }
  async propose(owner:string,deviceId:string,taskId:string,instruction:string,change:ComputerProposal['change']){
    id(taskId);if(!instruction.trim())return fail('An authenticated chat instruction is required.');
    return this.transaction(owner,(s,policy)=>{
      const d=this.device(s,deviceId);
      if(!policy.available&&(change.resume===true||change.rule?.decision==='allow'))fail(policy.reason,409);
      exact(change,['rule','removeRuleId','resume','approveRequestId']);
      if(!Object.keys(change).length)fail('Choose a permission change.');
      const normalized:ComputerProposal['change']={};
      if(change.rule){normalized.rule=normalizeRule(change.rule,taskId,this.now());if(normalized.rule.duration.kind==='task'&&!s.liveTasks.includes(taskId))fail('Choose an active work task belonging to this authenticated conversation.');if(d.rules.some(r=>r.id===normalized.rule!.id))fail('Replace an existing rule by explicitly naming removeRuleId and adding a new rule.');}
      if(change.removeRuleId){if(!d.rules.some(r=>r.id===change.removeRuleId))fail('The named rule does not exist.');normalized.removeRuleId=change.removeRuleId;}
      if(change.resume!==undefined){if(typeof change.resume!=='boolean')fail('Choose resume or stop.');normalized.resume=change.resume;}
      if(change.approveRequestId){const q=s.requests.find(q=>q.id===change.approveRequestId&&q.deviceId===deviceId&&q.state==='pending'&&q.expiresAt>this.now());if(!q)return fail('That exact request is no longer waiting.');normalized.approveRequestId=q.id;}
      if(normalized.rule?.duration.kind==='once'&&normalized.rule.duration.requestId!==normalized.approveRequestId)fail('A once rule must approve its exact pending request atomically.');
      const waiting=s.requests.find(q=>q.id===normalized.approveRequestId);
      const removed=d.rules.find(r=>r.id===normalized.removeRuleId);
      const summary=`Computer: ${d.label} (${d.id})\nRevision: ${d.revision}\n${normalized.rule?`${normalized.rule.decision}: ${normalized.rule.action}, ${normalized.rule.scope.target}\nDuration: ${computerCanonical(normalized.rule.duration)}\n`:''}${normalized.removeRuleId?'Remove this rule: '+computerCanonical(removed)+'\n':''}${normalized.resume===true?'Enable work; local Stop/takeover still requires local Resume.\n':''}${normalized.resume===false?'Stop work.\n':''}${normalized.approveRequestId?'Resume only request '+normalized.approveRequestId+'\nExact operation: '+computerCanonical(waiting!.operation)+'\nOperation digest: '+waiting!.digest+'\n':''}Existing denials remain unless explicitly removed. No OS authentication or administrator prompt is bypassed.`;
      const p:ComputerProposal={id:randomUUID(),ownerId:owner,deviceId,revision:d.revision,taskId,instruction:instruction.slice(0,4000),change:normalized,summary,savedPolicyDigest:policy.digest,createdAt:this.now(),expiresAt:this.now()+120_000,state:'pending',digest:''};
      p.digest=computerDigest({...p,digest:''});s.proposals.push(p);return p;
    });
  }
  async decide(owner:string,proposalId:string,digest:string,approve:boolean){return this.transaction(owner,(s,policy)=>{
    const p=s.proposals.find(p=>p.id===proposalId&&p.digest===digest&&p.state==='pending'&&p.expiresAt>this.now())??fail('Proposal expired, changed or already decided.',409);
    const d=this.device(s,p.deviceId);if(d.revision!==p.revision)fail('Permissions changed. Review a fresh proposal.',409);
    if(!approve){p.state='denied';return {ok:true};}
    if(!policy.available||p.savedPolicyDigest!==policy.digest)fail('Saved permissions changed. Review a fresh proposal.',409);
    const next:ComputerDevice={...d,rules:d.rules.filter(r=>r.id!==p.change.removeRuleId),revision:d.revision+1};
    if(p.change.rule)next.rules.push(p.change.rule);
    if(p.change.resume!==undefined)next.stopped=!p.change.resume;
    const preserved=s.requests.find(q=>q.id===p.change.approveRequestId&&q.deviceId===d.id&&q.state==='pending'&&q.expiresAt>this.now());
    if(p.change.approveRequestId&&!preserved)fail('The waiting operation expired. Nothing changed.',409);
    if(preserved){preserved.savedPolicyReview=policy.digest;const decision=this.decision(s,policy,next,preserved);if(decision.verdict!=='allow')fail(decision.reason||'The rules do not allow the exact waiting operation.',409);preserved.savedPolicyDigest=policy.digest;
      if(p.change.rule?.duration.kind==='until'||p.change.rule?.duration.kind==='task')preserved.expiresAt=Math.min(preserved.expiresAt,p.change.rule.duration.expiresAt);}
    Object.assign(d,next);p.state='approved';
    for(const q of s.requests.filter(q=>q.deviceId===d.id&&['pending','approved','running'].includes(q.state))){q.state=q===preserved?'approved':'cancelled';if(q===preserved)q.revision=d.revision;}
    return {ok:true,revision:d.revision};
  });}
  async stop(owner:string,deviceId:string,revoked=false){return this.transaction(owner,s=>{
    const d=this.device(s,deviceId);d.stopped=true;d.revoked=revoked;d.revision++;
    for(const q of s.requests.filter(q=>q.deviceId===deviceId&&['pending','approved','running'].includes(q.state)))q.state='cancelled';
    return {ok:true};
  });}
  async endTask(owner:string,taskId:string){return this.transaction(owner,s=>{
    if(!s.endedTasks.includes(taskId))s.endedTasks.push(taskId);s.endedTasks=s.endedTasks.slice(-1000);
    for(const d of s.devices){const n=d.rules.length;d.rules=d.rules.filter(r=>r.duration.kind!=='task'||r.duration.taskId!==taskId);if(n!==d.rules.length)d.revision++;}
    for(const q of s.requests.filter(q=>q.taskId===taskId&&['pending','approved','running'].includes(q.state)))q.state='cancelled';
  });}
  async submit(owner:string,deviceId:string,taskId:string,operation:ComputerOperation,idempotencyKey:string){return this.transaction(owner,(s,policy)=>{
    id(taskId);const d=this.device(s,deviceId);const op=normalizeComputerOperation(operation);
    if(s.endedTasks.includes(taskId)||s.knownTasks.includes(taskId)&&!s.liveTasks.includes(taskId))fail('This task has ended or is paused.',409);
    const digest=computerDigest({owner,deviceId,taskId,operation:op,idempotencyKey:text(idempotencyKey,120)});
    const existing=s.requests.find(q=>q.digest===digest);if(existing)return existing;
    const q:ComputerRequest={id:randomUUID(),ownerId:owner,deviceId,taskId,revision:d.revision,taskBound:s.knownTasks.includes(taskId),operation:op,digest,createdAt:this.now(),expiresAt:this.now()+600_000,state:'pending'};
    const decision=this.decision(s,policy,d,q);if(decision.verdict==='deny')return fail(decision.reason||'Stopped, unsupported, or explicitly denied by this computer’s policy.',403);
    q.savedPolicyDigest=policy.digest;q.state=decision.verdict==='allow'?'approved':'pending';if(decision.verdict==='allow')q.expiresAt=Math.min(this.authorityExpiry(d,q,s.liveTasks),decision.expiresAt);s.requests.push(q);return q;
  });}
  private authorityExpiry(d:ComputerDevice,q:ComputerRequest,liveTasks:string[]){
    return Math.min(q.expiresAt,...d.rules.filter(r=>r.decision==='allow'&&covers(r,q)&&active(r,q,this.now(),liveTasks)).map(r=>
      r.duration.kind==='until'||r.duration.kind==='task'?r.duration.expiresAt:q.expiresAt));
  }
  async result(owner:string,requestId:string){return this.transaction(owner,s=>s.requests.find(q=>q.id===requestId)??fail('Request not found.',404));}
  /** Only the trusted provider loop calls this. Tool/MCP receipts contain no
   * captured content. One pinned send rechecks current Vault policy and
   * charges all overlapping limits under the same lock as native dispatch. */
  async prepareModelProjection(owner:string,requestIds:string[]):Promise<AutomationModelProjection>{
    if(!requestIds.length||requestIds.length>16||new Set(requestIds).size!==requestIds.length)fail('Choose exact bounded computer results.');
    const projectionId=randomUUID();
    let destination:AutomationModelCandidate|undefined, policyDigest:string|undefined;
    const read=(charge:boolean)=>this.transaction(owner,async(s,policy,db)=>{
      if(!policy.available)fail(policy.reason,409);
      if(policyDigest!==undefined&&policy.digest!==policyDigest)fail('Saved permissions changed before model transmission.',409);
      let model=destination;
      const values:Record<string,unknown>={};
      for(const requestId of requestIds){
        const q=s.requests.find(q=>q.id===requestId)??fail('Computer result expired.',404);
        const d=this.device(s,q.deviceId);
        if(!['succeeded','failed'].includes(q.state)||q.result===undefined||q.expiresAt<=this.now()||d.stopped
          ||s.endedTasks.includes(q.taskId)||q.taskBound&&!s.liveTasks.includes(q.taskId))fail('Computer result is no longer available for transmission.',409);
        const body=computerCanonical(q.result);
        if(refuseMemorySecret(body))fail('The result contains a known sensitive value and cannot be sent to a model.',403);
        if(policy.required){
          const candidates=policy.targets.models.filter(m=>d.savedPermissions&&sameAutomationIdentity(m.identity,d.savedPermissions.identity)&&m.candidate.role==='primary');
          const current=[];
          for(const candidate of candidates){try{await requireCurrentAutomationModel(db,candidate.candidate);current.push(candidate);}catch{}}
          if(current.length!==1)fail('Register the current primary model for this Mac and grant its exact transmission permission.',409);
          const target=current[0];
          if(model&&!same(model,target.candidate))fail('Computer results require different model destinations.',409);
          model=target.candidate;
          const started=s.taskStarts?.[q.taskId];
          const evaluated=evaluateComputerPolicy(policy,d,{...q,id:projectionId+':'+q.id},this.now(),started===undefined?undefined:
            {active:s.liveTasks.includes(q.taskId),startedAtMs:started},s.usage??[],
            {configurationId:target.configurationId,configurationRevision:target.configurationRevision,bytes:Buffer.byteLength(body)});
          if(evaluated.verdict!=='allow'||evaluated.expiresAt<=this.now())fail('Saved model-transmission permissions or limits prevent sending this result.',403);
          if(charge)s.usage!.push({requestId:projectionId+':'+q.id,taskId:q.taskId,charges:evaluated.charges});
        }
        values[q.id]=q.result;
      }
      model??=await currentAutomationModelCandidate(db,'primary',projectionId)??undefined;
      if(!model)return fail('An explicitly configured primary model is required for computer results.',409);
      if(['vertex_ai','ernie','anthropic_subscription'].includes(model.providerId))fail('This provider cannot receive computer results through the protected model transport.',409);
      await requireCurrentAutomationModel(db,model);
      destination=model;policyDigest=policy.digest;
      return new Secret(computerCanonical(values));
    });
    let body:Secret|null=await read(false),ended=false,attempted=false;
    const expected=destination!;
    return {expectedPrimary:{providerId:expected.providerId,model:expected.model,configurationVersion:expected.configurationVersion},
      content:()=>{if(ended||!body)throw new Error('Computer result projection expired.');return body;},
      beforeDispatch:async()=>{if(ended||attempted)throw new Error('Computer results cannot be sent twice.');attempted=true;await read(true);},
      finish:async()=>{ended=true;body=null;}};
  }
  async deviceCall(owner:string,method:string,proof:ComputerProof){return this.transaction(owner,(s,policy)=>{
    const d=this.device(s,proof.payload.deviceId);this.checkProof(owner,method,proof,d.publicKey,s);d.lastSeen=this.now();const b=proof.payload.body;
    if(method==='presence'){
      if(!Array.isArray(b.capabilities)||b.capabilities.some(a=>!COMPUTER_ACTIONS.includes(a as ComputerAction)))fail('Unsupported capability advertisement.');
      d.capabilities=b.capabilities as ComputerAction[];return {device:{...d,activeTasks:s.liveTasks}};
    }
    if(method==='stop'){d.stopped=true;d.revision++;for(const q of s.requests.filter(q=>q.deviceId===d.id&&['pending','approved','running'].includes(q.state)))q.state='cancelled';return {ok:true};}
    if(method==='resume'){
      if(!policy.available)fail(policy.reason,409);
      if(policy.required&&!d.savedPermissions)fail('Connect the saved Mac permissions before resuming.',409);
      d.stopped=false;d.revision++;
      for(const q of s.requests.filter(q=>q.deviceId===d.id&&['pending','approved','running'].includes(q.state)))q.state='cancelled';
      return {ok:true,revision:d.revision};
    }
    if(method==='link-prepare')return this.prepareLink(s,policy,d,b);
    if(method==='link-complete')return this.completeLink(s,policy,d,b);
    if(['next','lease','result'].includes(method)&&!policy.available)fail(policy.reason,409);
    if(method==='next'){
      if(d.stopped||s.requests.some(q=>q.deviceId===d.id&&q.state==='running'))return {request:null,device:{...d,activeTasks:s.liveTasks}};
      const q=s.requests.find(q=>q.deviceId===d.id&&q.state==='approved'&&q.revision===d.revision&&q.expiresAt>this.now()&&this.decision(s,policy,d,q).verdict==='allow');
      if(!q)return {request:null,device:{...d,activeTasks:s.liveTasks}};const decision=this.decision(s,policy,d,q);q.state='running';if(decision.applicationPin)q.applicationPin=decision.applicationPin;q.expiresAt=Math.min(this.authorityExpiry(d,q,s.liveTasks),decision.expiresAt);q.leaseUntil=Math.min(this.now()+COMPUTER_LEASE_MS,q.expiresAt);s.usage!.push({requestId:q.id,taskId:q.taskId,charges:decision.charges});return {request:q,device:this.dispatchDevice(s,policy,d,q)};
    }
    const q=s.requests.find(q=>q.id===b.requestId&&q.deviceId===d.id&&q.state==='running')??fail('This computer has no such running request.',409);
    if(q.revision!==d.revision||this.decision(s,policy,d,q).verdict!=='allow')fail('Authority expired or changed.',409);
    if(method==='lease'){q.leaseUntil=Math.min(this.now()+COMPUTER_LEASE_MS,q.expiresAt,this.decision(s,policy,d,q).expiresAt);return {leaseUntil:q.leaseUntil,revision:d.revision};}
    if(method==='result'){
      if(typeof b.ok!=='boolean'||computerCanonical(b.result??null).length>256_000)fail('Invalid bounded result.');
      q.state=b.ok?'succeeded':'failed';q.result=b.result??null;
      d.rules=d.rules.filter(r=>r.duration.kind!=='once'||r.duration.requestId!==q.id);return {ok:true};
    }
    return fail('Unknown device method.');
  });}
}
