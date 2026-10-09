import { createHmac } from 'node:crypto';
import { win32 } from 'node:path';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { openSealed, seal } from './sealing.js';

// These are separate capabilities, never a hierarchy. Generic application
// control and shell execution can perform hidden writes, so they also need an
// exact-action decision even with an enduring application/folder policy.
export const PC_ACTIONS = [
  ['browser.view','Browser viewing and navigation','browser',false,true],
  ['browser.fill','Browser form filling','browser',false,false],
  ['browser.submit','Browser submissions and sending messages','browser',true,false],
  ['browser.purchase','Purchases and financial actions','browser',true,false],
  ['browser.download','Browser downloads','browser',false,false],
  ['browser.upload','Browser uploads','browser',true,false],
  ['explorer.view','File Explorer viewing','folder',false,true],
  ['folder.read','Folder read access','folder',false,true],
  ['folder.write','Folder create/edit access','folder',false,false],
  ['file.rename','Renaming files','folder',false,false],
  ['file.move','Moving files','folder',false,false],
  ['file.delete','Deleting files','folder',true,false],
  ['app.launch','Launching an approved application','application',false,false],
  ['app.control','Controlling an approved application','application',true,false],
  ['app.close','Closing an application','application',true,false],
  ['app.terminate','Terminating an application','application',true,false],
  ['command.run','Commands, scripts, builds and tests','command',true,false],
  ['software.install','Installing software','system',true,false],
  ['software.uninstall','Uninstalling software','system',true,false],
  ['system.settings','Changing system settings','system',true,false],
  ['secret.access','Credential or secret access','secret',true,true],
  ['security.settings','Security-setting changes','system',true,false],
  ['administrator.elevate','Administrator elevation (Windows UAC still required)','system',true,false],
] as const;
export type PcAction = (typeof PC_ACTIONS)[number][0];
export const PC_MODES = ['never','ask','task','temporary','always'] as const;
export type PcMode = (typeof PC_MODES)[number];
export type PcScope = { kind:'browser'|'folder'|'application'|'command'|'system'|'secret'; target:string; application?:string; profile?:string };
export type PcRequirement = { action:PcAction; scope:PcScope };
export type PcPlan = { requirements:PcRequirement[]; description:string; taskId?:string; payload:unknown };
export type PcPolicy = PcRequirement & { mode:PcMode; taskId?:string; expiresAt?:string };
export class PcControlError extends Error { constructor(readonly status:number, message:string){super(message);} }
const fail = (message:string):never => {throw new PcControlError(400,message);};
const uuid = (value:string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const text = (value:unknown,max=1024):string => typeof value==='string' && value.length>0 && value.length<=max && !/[\u0000-\u001f\u007f]/.test(value) ? value : fail('Provide a bounded, readable exact scope.');
function localPath(value:unknown):string {
  const path=text(value);
  // No wildcard, UNC/device path, ADS, relative path, traversal or ambiguous
  // trailing-dot/space aliases. The future local adapter must additionally
  // resolve handles/reparse points before preparing AND before executing.
  if(!/^[a-z]:\\/i.test(path) || /[<>"|?*/]/.test(path) || path.slice(2).includes(':') ||
    path.slice(3).split('\\').some(part=>part==='.'||part==='..'||/[. ]$/.test(part))) fail('Choose an exact absolute local Windows path.');
  // Keep case: NTFS directories can be case-sensitive. A differently spelled
  // path gets a new scope instead of silently inheriting another folder grant.
  return path.length===3?path:win32.normalize(path).replace(/\\$/,'');
}
export function normalizePcRequirement(input:PcRequirement):PcRequirement {
  const spec=PC_ACTIONS.find(s=>s[0]===input?.action) ?? fail('Unknown PC action.');
  const s=input.scope; if(!s || s.kind!==spec[2]) fail('This action requires its own exact scope.');
  let scope:PcScope;
  if(s.kind==='browser') {
    let url:URL;try{url=new URL(text(s.target));}catch{ return fail('Choose one exact HTTP or HTTPS origin.'); }
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash) fail('Choose one exact origin without credentials, paths or wildcards.');
    scope={kind:s.kind,target:url.origin,application:localPath(s.application),profile:text(s.profile,120)};
  } else if(['folder','application','command'].includes(s.kind)) {
    scope={kind:s.kind,target:localPath(s.target),...(s.kind==='command'?{application:localPath(s.application)}:{})};
  } else scope={kind:s.kind,target:text(s.target,200)};
  return {action:input.action,scope};
}
// Canonical JSON both pins the actual prepared work and refuses non-JSON,
// lossy serialization (NaN/undefined), cycles and unbounded payloads.
function canonical(value:unknown,depth=0):string {
  if(depth>16) fail('Action is too deeply nested.');
  if(value===null || typeof value==='boolean' || typeof value==='string') return JSON.stringify(value);
  if(typeof value==='number' && Number.isFinite(value)) return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
  if(value && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype)
    return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k],depth+1)).join(',')+'}';
  return fail('Actions must contain only bounded JSON values.');
}
const highRisk = (r:PcRequirement) => PC_ACTIONS.find(s=>s[0]===r.action)![3];
const readOnly = (r:PcRequirement) => PC_ACTIONS.find(s=>s[0]===r.action)![4];
type Settings = {enabled:boolean;epoch:number|string};
type RequestRow = {id:string;state:string;epoch:number|string;request_enc:string;request_hash:string;expires_at:string;human_approved:boolean};
type Bound<T> = {owner:string;pc:string;value:T};
const ASK_TTL=10*60*1000;
export const PC_TEMP_MAX=24*60*60*1000;

/** Fail-safe emergency state change works even if the encryption key cannot be
 * loaded. Permanent policies are preserved but the master switch is disabled. */
export async function disablePcControl(db:Db,owner:string,pcId:string){
  if(!uuid(owner)||!/^[a-z0-9-]{1,80}$/.test(pcId))fail('Invalid PC owner.');
  if(!db.transaction)throw new PcControlError(503,'Transactional permission storage is unavailable.');
  await db.transaction(async tx=>{
    await tx.query(`insert into pc_control_settings(owner_user_id,pc_id) values($1,$2) on conflict do nothing`,[owner,pcId]);
    await tx.query(`select epoch from pc_control_settings where owner_user_id=$1 and pc_id=$2 for update`,[owner,pcId]);
    await tx.query(`update pc_control_settings set enabled=false,epoch=epoch+1 where owner_user_id=$1 and pc_id=$2`,[owner,pcId]);
    await tx.query(`update pc_control_requests set state='revoked' where owner_user_id=$1 and pc_id=$2 and state in ('pending','approved')`,[owner,pcId]);
    await tx.query(`delete from pc_control_policies where owner_user_id=$1 and pc_id=$2 and mode in ('task','temporary')`,[owner,pcId]);
    // This nonsensitive event must be recordable even with a missing key.
    await tx.query(`insert into pc_control_activity(owner_user_id,pc_id,kind) values($1,$2,$3)`,[owner,pcId,'Emergency stop: control disabled and temporary/task access revoked']);
  });
}

/** Trusted application seam, not an agent tool or a browser command endpoint.
 * A local desktop adapter must prepare a complete effect manifest. Multiple
 * effects (upload+read, download+write, move source+destination, etc.) are checked
 * together. No production executor is shipped by this permission-only phase. */
export class PcControl {
  private active=new Map<string,Set<AbortController>>();
  constructor(private db:Db,private key:MasterKey,readonly pcId:string,private now=()=>Date.now()) {
    if(!/^[a-z0-9-]{1,80}$/.test(pcId)) fail('Invalid PC identity.');
  }
  private hash(owner:string,value:unknown){return createHmac('sha256',this.key.reveal()).update(canonical({owner,pc:this.pcId,value})).digest('hex');}
  private pack(owner:string,value:unknown){return seal(this.key,{owner,pc:this.pcId,value});}
  private unpack<T>(owner:string,cipher:string):T {
    const bound=openSealed<Bound<T>>(this.key,cipher);
    if(bound.owner!==owner||bound.pc!==this.pcId)throw new PcControlError(409,'Permission integrity check failed.');
    return bound.value;
  }
  private async locked<T>(owner:string,fn:(db:Db,s:Settings)=>Promise<T>):Promise<T>{
    if(!uuid(owner))fail('Invalid owner.');
    if(!this.db.transaction)throw new PcControlError(503,'Transactional permission storage is unavailable.');
    return this.db.transaction(async db=>{
      await db.query(`insert into pc_control_settings(owner_user_id,pc_id) values($1,$2) on conflict do nothing`,[owner,this.pcId]);
      const [s]=await db.query<Settings>(`select enabled,epoch from pc_control_settings where owner_user_id=$1 and pc_id=$2 for update`,[owner,this.pcId]);
      return fn(db,s);
    });
  }
  private async log(db:Db,owner:string,kind:string,plan?:Pick<PcPlan,'description'|'requirements'|'taskId'>){
    // Never include action payloads, commands/arguments, form values or secrets.
    await db.query(`insert into pc_control_activity(owner_user_id,pc_id,kind,detail_enc) values($1,$2,$3,$4)`,[owner,this.pcId,kind,this.pack(owner,{kind,...(plan?{description:plan.description,requirements:plan.requirements,taskId:plan.taskId??null}:{})})]);
  }
  private cancel(owner:string){for(const controller of this.active.get(owner)??[])controller.abort();}
  private async invalidate(db:Db,owner:string){
    await db.query(`update pc_control_settings set epoch=epoch+1 where owner_user_id=$1 and pc_id=$2`,[owner,this.pcId]);
    await db.query(`update pc_control_requests set state='revoked' where owner_user_id=$1 and pc_id=$2 and state in ('pending','approved')`,[owner,this.pcId]);
  }
  async setEnabled(owner:string,enabled:boolean){
    if(typeof enabled!=='boolean')fail('Choose on or off.');
    if(!enabled)return this.stop(owner);
    this.cancel(owner);
    return this.locked(owner,async(db)=>{await this.invalidate(db,owner);await db.query(`update pc_control_settings set enabled=true where owner_user_id=$1 and pc_id=$2`,[owner,this.pcId]);await this.log(db,owner,'Control enabled; exact scopes still required');});
  }
  async stop(owner:string){
    this.cancel(owner);
    await disablePcControl(this.db,owner,this.pcId);
  }
  private async liveTask(db:Db,owner:string,taskId?:string){
    if(!taskId||!uuid(taskId))return false;
    return (await db.query(`select id from tasks where id=$1 and owner_user_id=$2 and state not in ('confirmed','failed','cancelled','closed')`,[taskId,owner])).length===1;
  }
  async savePolicy(owner:string,input:PcPolicy){
    const requirement=normalizePcRequirement(input);
    if(!PC_MODES.includes(input.mode))fail('Choose a valid approval mode.');
    const value:PcPolicy={...requirement,mode:input.mode};
    if(input.mode==='temporary'||input.mode==='task'){
      const expiry=Date.parse(input.expiresAt??(input.mode==='task'?new Date(this.now()+PC_TEMP_MAX).toISOString():'')); if(!Number.isFinite(expiry)||expiry<=this.now()||expiry>this.now()+PC_TEMP_MAX)fail('Temporary access must expire within 24 hours.');
      value.expiresAt=new Date(expiry).toISOString();
    }
    if(input.mode==='task')value.taskId=input.taskId;
    this.cancel(owner);
    return this.locked(owner,async db=>{
      if(value.mode==='task' && !await this.liveTask(db,owner,value.taskId))fail('Choose an active task belonging to you.');
      await this.invalidate(db,owner);
      const [row]=await db.query<{id:string}>(`insert into pc_control_policies(owner_user_id,pc_id,scope_hash,mode,policy_enc) values($1,$2,$3,$4,$5) on conflict(owner_user_id,pc_id,scope_hash) do update set mode=excluded.mode,policy_enc=excluded.policy_enc returning id`,[owner,this.pcId,this.hash(owner,requirement),value.mode,this.pack(owner,value)]);
      await this.log(db,owner,'Exact-scope permission changed',{description:PC_ACTIONS.find(s=>s[0]===value.action)![1],requirements:[requirement],...(value.taskId?{taskId:value.taskId}:{})});
      return {id:row.id,...value};
    });
  }
  async revoke(owner:string,id:string){
    if(!uuid(id))fail('Invalid permission.');this.cancel(owner);
    return this.locked(owner,async db=>{
      const rows=await db.query(`delete from pc_control_policies where id=$1 and owner_user_id=$2 and pc_id=$3 returning id`,[id,owner,this.pcId]);
      if(!rows.length)throw new PcControlError(404,'Permission not found.');
      await this.invalidate(db,owner);await this.log(db,owner,'Permission revoked');
    });
  }
  private normalize(plan:PcPlan):PcPlan {
    if(!Array.isArray(plan?.requirements)||!plan.requirements.length||plan.requirements.length>12)fail('Declare every exact scope required by this action.');
    const requirements=plan.requirements.map(normalizePcRequirement).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
    if(plan.taskId && !uuid(plan.taskId))fail('Invalid task.');
    const normalized={requirements,description:text(plan.description,600),payload:plan.payload,...(plan.taskId?{taskId:plan.taskId}:{})};
    if(Buffer.byteLength(canonical(normalized))>64*1024)fail('Prepared action is too large.');
    // Snapshot now: caller mutation cannot change approved work later.
    return JSON.parse(canonical(normalized)) as PcPlan;
  }
  private async verdict(db:Db,owner:string,s:Settings,plan:PcPlan):Promise<'denied'|'pending'|'approved'> {
    if(!s.enabled)return 'denied';
    if(plan.taskId && !await this.liveTask(db,owner,plan.taskId))return 'denied';
    let ask=plan.requirements.some(highRisk);
    for(const requirement of plan.requirements){
      const [row]=await db.query<{policy_enc:string}>(`select policy_enc from pc_control_policies where owner_user_id=$1 and pc_id=$2 and scope_hash=$3`,[owner,this.pcId,this.hash(owner,requirement)]);
      const p=row?this.unpack<PcPolicy>(owner,row.policy_enc):undefined;
      if(p && this.hash(owner,{action:p.action,scope:p.scope})!==this.hash(owner,requirement))throw new PcControlError(409,'Permission integrity check failed.');
      if(p?.mode==='never')return 'denied';
      if(!p||p.mode==='ask'||(p.mode==='task'&&p.taskId!==plan.taskId)||
        (['temporary','task'].includes(p.mode)&&Date.parse(p.expiresAt??'')<=this.now()))ask=true;
    }
    return ask?'pending':'approved';
  }
  async propose(owner:string,input:PcPlan){
    const plan=this.normalize(input);
    return this.locked(owner,async(db,s)=>{
      const state=await this.verdict(db,owner,s,plan);
      const [row]=await db.query<{id:string}>(`insert into pc_control_requests(owner_user_id,pc_id,epoch,request_hash,request_enc,state,expires_at) values($1,$2,$3,$4,$5,$6,$7) returning id`,[owner,this.pcId,s.epoch,this.hash(owner,plan),this.pack(owner,plan),state,new Date(this.now()+ASK_TTL).toISOString()]);
      await this.log(db,owner,state==='denied'?'Attempt blocked':state==='pending'?'Exact action awaiting approval':'Exact action authorized',plan);
      return {id:row.id,state};
    });
  }
  private async request(db:Db,owner:string,id:string){
    if(!uuid(id))fail('Invalid request.');
    const [row]=await db.query<RequestRow>(`select * from pc_control_requests where id=$1 and owner_user_id=$2 and pc_id=$3 for update`,[id,owner,this.pcId]);
    if(!row)throw new PcControlError(404,'Request not found.');
    const plan=this.unpack<PcPlan>(owner,row.request_enc);
    if(this.hash(owner,plan)!==row.request_hash)throw new PcControlError(409,'Action integrity check failed.');
    return {row,plan};
  }
  async decide(owner:string,id:string,approve:boolean){
    if(typeof approve!=='boolean')fail('Choose approve or deny.');
    return this.locked(owner,async(db,s)=>{
      const {row,plan}=await this.request(db,owner,id);
      if(row.state!=='pending'||Number(row.epoch)!==Number(s.epoch)||Date.parse(row.expires_at)<=this.now())throw new PcControlError(409,'This request is no longer active.');
      if(approve && await this.verdict(db,owner,s,plan)==='denied')throw new PcControlError(409,'Control or this scope is disabled.');
      await db.query(`update pc_control_requests set state=$2,human_approved=$3 where id=$1`,[id,approve?'approved':'denied',approve]);
      await this.log(db,owner,approve?'Exact action approved once':'Exact action denied',plan);
    });
  }
  /** The caller is trusted code with a narrow adapter, never request.body.
   * Single-use claim is committed before executing. No retries on failure.
   * Abort is cooperative and cannot undo changes already completed. */
  async execute(owner:string,id:string,input:PcPlan,adapter:(plan:PcPlan,signal:AbortSignal)=>Promise<void>){
    const prepared=this.normalize(input),controller=new AbortController();
    const active=this.active.get(owner)??new Set<AbortController>();active.add(controller);this.active.set(owner,active);
    let claimed=false;
    try{
      const plan=await this.locked(owner,async(db,s)=>{
        const {row,plan}=await this.request(db,owner,id);
        const verdict=await this.verdict(db,owner,s,plan);
        if(controller.signal.aborted||row.state!=='approved'||Number(row.epoch)!==Number(s.epoch)||Date.parse(row.expires_at)<=this.now()||this.hash(owner,prepared)!==row.request_hash||verdict==='denied'||(!row.human_approved&&verdict!=='approved'))throw new PcControlError(409,'This exact action is not authorized.');
        await db.query(`update pc_control_requests set state='executing' where id=$1`,[id]);
        await this.log(db,owner,'Action started',plan);return plan;
      });claimed=true;
      if(controller.signal.aborted)throw new PcControlError(409,'Control stopped.');
      await adapter(plan,controller.signal);
      await this.locked(owner,db=>this.finish(db,owner,id,controller.signal.aborted?'interrupted':'succeeded',plan));
    }catch(error){
      if(claimed)await this.locked(owner,db=>this.finish(db,owner,id,controller.signal.aborted?'interrupted':'failed',prepared));
      else await this.locked(owner,db=>this.log(db,owner,'Execution attempt blocked',prepared)).catch(()=>undefined);
      // No arbitrary executor exception/command output reaches HTTP or audit.
      if(error instanceof PcControlError)throw error;
      throw new PcControlError(503,'PC action failed. Inspect the activity log; it was not retried.');
    }finally{active.delete(controller);if(!active.size)this.active.delete(owner);}
  }
  private async finish(db:Db,owner:string,id:string,state:string,plan:PcPlan){
    await db.query(`update pc_control_requests set state=$2 where id=$1 and state='executing'`,[id,state]);await this.log(db,owner,'Action '+state,plan);
  }
  async snapshot(owner:string){
    return this.locked(owner,async(db,s)=>{
      const policies=await db.query<{id:string;policy_enc:string}>(`select id,policy_enc from pc_control_policies where owner_user_id=$1 and pc_id=$2`,[owner,this.pcId]);
      const requests=await db.query<RequestRow>(`select * from pc_control_requests where owner_user_id=$1 and pc_id=$2 and state='pending' and expires_at>$3 order by created_at desc limit 100`,[owner,this.pcId,new Date(this.now()).toISOString()]);
      const logs=await db.query<{id:string;created_at:string;kind:string;detail_enc:string|null}>(`select id,created_at,kind,detail_enc from pc_control_activity where owner_user_id=$1 and pc_id=$2 order by created_at desc,id desc limit 100`,[owner,this.pcId]);
      const tasks=await db.query<{id:string;name:string;created_at:string}>(`select t.id,tt.name,t.created_at from tasks t join task_templates tt on tt.key=t.template_key where t.owner_user_id=$1 and t.state not in ('confirmed','failed','cancelled','closed') order by t.created_at desc limit 100`,[owner]);
      return {enabled:s.enabled,pcId:this.pcId,catalog:PC_ACTIONS.map(([action,label,kind,risk,read])=>({action,label,kind,highRisk:risk,access:read?'Read-only':'Read/write'})),
        tasks,policies:await Promise.all(policies.map(async p=>{const value=this.unpack<PcPolicy>(owner,p.policy_enc);return{id:p.id,...value,active:value.mode==='temporary'?Date.parse(value.expiresAt??'')>this.now():value.mode==='task'?Date.parse(value.expiresAt??'')>this.now()&&await this.liveTask(db,owner,value.taskId):true};})),
        requests:requests.map(row=>{const {payload,...visible}=this.unpack<PcPlan>(owner,row.request_enc);return{id:row.id,...visible,expiresAt:row.expires_at,highRisk:visible.requirements.some(highRisk),access:visible.requirements.every(readOnly)?'Read-only':'Read/write'};}),
        activity:logs.map(row=>({id:row.id,at:row.created_at,...(row.detail_enc?this.unpack<Record<string,unknown>>(owner,row.detail_enc):{kind:row.kind})}))};
    });
  }
}
