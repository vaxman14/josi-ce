import { createHmac } from 'node:crypto';
import { win32 } from 'node:path';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { openSealed, seal } from './sealing.js';

// These are separate capabilities. Broad application and shell grants include
// their indirect effects; mediated folder rules do not sandbox a host shell.
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
  ['app.view','Reading and capturing an approved application','application',false,true],
  ['app.control','Controlling an approved application','application',true,false],
  ['app.close','Closing an application','application',true,false],
  ['app.terminate','Terminating an application','application',true,false],
  ['command.run','Commands, scripts, builds and tests','command',true,false],
  ['software.install','Installing software','system',true,false],
  ['software.uninstall','Uninstalling software','system',true,false],
  ['system.settings','Changing system settings','system',true,false],
  ['desktop.view','Seeing open windows, their controls and screenshots','system',false,true],
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
export type PcPolicyUpdate = { expectedRevision?:number; approveRequestId?:string };
export type PcPreset = {access:'apps'|'terminal'|'full';administrator:boolean;mode:'always'|'temporary'|'task';expiresAt?:string;taskId?:string};
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
  if(s.target==='*')return {action:input.action,scope:{kind:s.kind,target:'*',...(['browser','command'].includes(s.kind)?{application:s.application==='*'?'*':localPath(s.application)}:{}),...(s.kind==='browser'?{profile:s.profile==='*'?'*':text(s.profile,120)}:{})}};
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
/** Full control: the owner's standing grant for everyday actions on this PC,
 * in any allowed browser, folder or application, so they are not asked before
 * each one. Money, deleting, credentials, installs, security settings,
 * commands and elevation are deliberately outside it and still ask. An exact
 * "Never" scope still wins. */
export const PC_FULL_CONTROL_ACTIONS:readonly PcAction[] = ['browser.view','browser.fill','browser.submit','browser.download','browser.upload',
  'desktop.view','explorer.view','folder.read','folder.write','file.rename','file.move','app.view','app.launch','app.control','app.close'];
export const PC_FULL_CONTROL_ASKS:readonly PcAction[] = PC_ACTIONS.map(s=>s[0]).filter(a=>!PC_FULL_CONTROL_ACTIONS.includes(a));
const fullControlCovers = (r:PcRequirement) => PC_FULL_CONTROL_ACTIONS.includes(r.action);
/** Actions that support an enduring or duration-limited grant. A shell grant
 * authorizes host execution; its starting folder is not an isolation boundary.
 * Protected credentials remain outside all presets and saved allowances. */
export const PC_GRANTABLE_HIGH_RISK:readonly PcAction[] = ['command.run','app.control','app.close','app.terminate','file.delete','browser.submit','browser.purchase','browser.upload','software.install','software.uninstall','system.settings','security.settings','administrator.elevate'];
export const pcActionIsHighRisk = (action:PcAction) => !!PC_ACTIONS.find(s=>s[0]===action)?.[3];
const grantable = (r:PcRequirement) => PC_GRANTABLE_HIGH_RISK.includes(r.action);
type Settings = {enabled:boolean;epoch:number|string;full_control:boolean};
type RequestRow = {id:string;state:string;epoch:number|string;request_enc:string;request_hash:string;expires_at:string;human_approved:boolean};
type Bound<T> = {owner:string;pc:string;value:T};
const ASK_TTL=10*60*1000;
export const PC_TEMP_MAX=24*60*60*1000;

/** Canonical policy input, shared by chat previews and the actual writer. */
export function normalizePcPolicy(input:PcPolicy,now=Date.now()):PcPolicy {
  const requirement=normalizePcRequirement(input);
  if(!PC_MODES.includes(input.mode))fail('Choose a valid approval mode.');
  const value:PcPolicy={...requirement,mode:input.mode};
  if(input.mode==='temporary'||input.mode==='task'){
    const expiry=Date.parse(input.expiresAt??(input.mode==='task'?new Date(now+PC_TEMP_MAX).toISOString():''));
    if(!Number.isFinite(expiry)||expiry<=now||expiry>now+PC_TEMP_MAX)fail('Temporary access must expire within 24 hours.');
    value.expiresAt=new Date(expiry).toISOString();
  }
  if(input.mode==='task'){
    if(!input.taskId||!uuid(input.taskId))fail('Choose an active task belonging to you.');
    value.taskId=input.taskId;
  }
  return value;
}

export function normalizePcPreset(input:PcPreset,now=Date.now()):PcPreset {
  if(!input||!['apps','terminal','full'].includes(input.access)||typeof input.administrator!=='boolean'||!['always','temporary','task'].includes(input.mode))fail('Choose apps, terminal or full access, administrator on/off, and saved, timed or task duration.');
  if(input.access==='apps'&&input.administrator)fail('Administrator commands require terminal or full access.');
  if(input.taskId!==undefined&&input.mode!=='task'||input.expiresAt!==undefined&&!['temporary','task'].includes(input.mode))fail('Choose a matching duration for the task or expiry.');
  const duration=normalizePcPolicy({action:'app.launch',scope:{kind:'application',target:'*'},mode:input.mode,expiresAt:input.expiresAt,taskId:input.taskId},now);
  return {access:input.access,administrator:input.administrator,mode:input.mode,...(duration.expiresAt?{expiresAt:duration.expiresAt}:{}),...(duration.taskId?{taskId:duration.taskId}:{})};
}

/** Fail-safe emergency state change works even if the encryption key cannot be
 * loaded. Permanent policies are preserved but the master switch is disabled. */
export async function disablePcControl(db:Db,owner:string,pcId:string){
  if(!uuid(owner)||!/^[a-z0-9-]{1,80}$/.test(pcId))fail('Invalid PC owner.');
  if(!db.transaction)throw new PcControlError(503,'Transactional permission storage is unavailable.');
  await db.transaction(async tx=>{
    await tx.query(`insert into pc_control_settings(owner_user_id,pc_id) values($1,$2) on conflict do nothing`,[owner,pcId]);
    await tx.query(`select epoch from pc_control_settings where owner_user_id=$1 and pc_id=$2 for update`,[owner,pcId]);
    await tx.query(`update pc_control_settings set enabled=false,full_control=false,epoch=epoch+1 where owner_user_id=$1 and pc_id=$2`,[owner,pcId]);
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
  private async locked<T>(owner:string,fn:(db:Db,s:Settings)=>Promise<T>,expectedRevision?:number):Promise<T>{
    if(!uuid(owner))fail('Invalid owner.');
    if(!this.db.transaction)throw new PcControlError(503,'Transactional permission storage is unavailable.');
    return this.db.transaction(async db=>{
      await db.query(`insert into pc_control_settings(owner_user_id,pc_id) values($1,$2) on conflict do nothing`,[owner,this.pcId]);
      const [s]=await db.query<Settings>(`select enabled,epoch,full_control from pc_control_settings where owner_user_id=$1 and pc_id=$2 for update`,[owner,this.pcId]);
      if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision!==Number(s.epoch)))
        throw new PcControlError(409,'PC permissions changed. Review a fresh proposal before applying it.');
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
  async setEnabled(owner:string,enabled:boolean,expectedRevision?:number){
    if(typeof enabled!=='boolean')fail('Choose on or off.');
    if(!enabled)return this.stop(owner);
    return this.locked(owner,async(db)=>{await this.invalidate(db,owner);await db.query(`update pc_control_settings set enabled=true where owner_user_id=$1 and pc_id=$2`,[owner,this.pcId]);await this.log(db,owner,'Control enabled; exact scopes still required');this.cancel(owner);},expectedRevision);
  }
  async stop(owner:string){
    this.cancel(owner);
    await disablePcControl(this.db,owner,this.pcId);
  }
  /** Full control is a standing grant, so turning it on or off re-decides
   * everything already prepared: nothing approved under the old rules runs. */
  async setFullControl(owner:string,on:boolean,expectedRevision?:number){
    if(typeof on!=='boolean')fail('Choose on or off.');
    return this.locked(owner,async(db,s)=>{
      if(on&&!s.enabled)throw new PcControlError(409,'Turn on "Allow Josi to control this PC" first.');
      await this.invalidate(db,owner);
      await db.query(`update pc_control_settings set full_control=$3 where owner_user_id=$1 and pc_id=$2`,[owner,this.pcId,on]);
      await this.log(db,owner,on?'Full control turned on: everyday browser, folder and application actions no longer ask':'Full control turned off: exact scopes apply again');
      this.cancel(owner);
    },expectedRevision);
  }
  private async liveTask(db:Db,owner:string,taskId?:string){
    if(!taskId||!uuid(taskId))return false;
    return (await db.query(`select id from tasks where id=$1 and owner_user_id=$2 and state not in ('confirmed','failed','cancelled','closed')
      union all select id from work_goals where id=$1 and owner_user_id=$2 and state in ('planning','working','waiting')`,[taskId,owner])).length===1;
  }
  async applyPreset(owner:string,input:PcPreset,expectedRevision?:number){
    const preset=normalizePcPreset(input,this.now());
    return this.locked(owner,async(db,s)=>{
      if(!s.enabled)throw new PcControlError(409,'Enable PC control first.');
      if(preset.mode==='task'&&!await this.liveTask(db,owner,preset.taskId))fail('Choose an active task belonging to you.');
      const actions:readonly PcAction[]=preset.access==='apps'?['desktop.view','app.view','app.launch','app.control','app.close','app.terminate']:preset.access==='terminal'?['command.run']:PC_ACTIONS.map(a=>a[0]).filter(a=>!['secret.access','administrator.elevate'].includes(a));
      await this.invalidate(db,owner);
      // The older everyday toggle must not outlive this preset's duration.
      if(preset.access==='full')await db.query('update pc_control_settings set full_control=false where owner_user_id=$1 and pc_id=$2',[owner,this.pcId]);
      for(const action of [...actions,'administrator.elevate' as const]){
        const kind=PC_ACTIONS.find(a=>a[0]===action)![2];
        const requirement:PcRequirement={action,scope:{kind,target:'*',...(['browser','command'].includes(kind)?{application:'*'}:{}),...(kind==='browser'?{profile:'*'}:{})}};
        const value:PcPolicy={...requirement,mode:action==='administrator.elevate'&&!preset.administrator?'never':preset.mode,...(preset.expiresAt?{expiresAt:preset.expiresAt}:{}),...(preset.taskId?{taskId:preset.taskId}:{})};
        // Keep explicit Never/Ask rules. The reviewed administrator switch
        // replaces only the broad administrator rule, not exact exclusions.
        await db.query(`insert into pc_control_policies(owner_user_id,pc_id,scope_hash,mode,policy_enc) values($1,$2,$3,$4,$5)
          on conflict(owner_user_id,pc_id,scope_hash) do update set mode=excluded.mode,policy_enc=excluded.policy_enc
          where pc_control_policies.mode not in ('never','ask') or $6`,[owner,this.pcId,this.hash(owner,requirement),value.mode,this.pack(owner,value),action==='administrator.elevate']);
      }
      await this.log(db,owner,'Access preset applied',{description:preset.access+' access; administrator '+(preset.administrator?'allowed with Windows UAC':'blocked')+'; '+preset.mode,requirements:[],...(preset.taskId?{taskId:preset.taskId}:{})});
      this.cancel(owner);
      return preset;
    },expectedRevision);
  }
  async savePolicy(owner:string,input:PcPolicy,options:PcPolicyUpdate={}){
    const value=normalizePcPolicy(input,this.now());
    const requirement:PcRequirement={action:value.action,scope:value.scope};
    return this.locked(owner,async(db,s)=>{
      if(value.mode==='task' && !await this.liveTask(db,owner,value.taskId))fail('Choose an active task belonging to you.');
      let approved:Awaited<ReturnType<PcControl['request']>>|undefined;
      if(options.approveRequestId!==undefined){
        approved=await this.request(db,owner,options.approveRequestId);
        if(!s.enabled||approved.row.state!=='pending'||Number(approved.row.epoch)!==Number(s.epoch)||Date.parse(approved.row.expires_at)<=this.now())
          throw new PcControlError(409,'This request is no longer active.');
        if(!['always','temporary','task'].includes(value.mode)||(highRisk(requirement)&&!grantable(requirement)))
          fail('This action cannot be approved with a saved grant.');
        if(!approved.plan.requirements.some(r=>this.hash(owner,r)===this.hash(owner,requirement)))
          fail('The grant must match a scope in this exact request.');
        if(value.mode==='task'&&value.taskId!==approved.plan.taskId)fail('The grant must belong to this request\'s task.');
      }
      await this.invalidate(db,owner);
      const [row]=await db.query<{id:string}>(`insert into pc_control_policies(owner_user_id,pc_id,scope_hash,mode,policy_enc) values($1,$2,$3,$4,$5) on conflict(owner_user_id,pc_id,scope_hash) do update set mode=excluded.mode,policy_enc=excluded.policy_enc returning id`,[owner,this.pcId,this.hash(owner,requirement),value.mode,this.pack(owner,value)]);
      if(approved){
        if(await this.verdict(db,owner,s,approved.plan)==='denied')throw new PcControlError(409,'Control or this scope is disabled.');
        await db.query(`update pc_control_requests set state='approved',human_approved=true,epoch=$2,expires_at=least(expires_at,$3::timestamptz) where id=$1`,[approved.row.id,Number(s.epoch)+1,value.expiresAt??approved.row.expires_at]);
        await this.log(db,owner,'Exact action approved with saved permission',approved.plan);
      }
      await this.log(db,owner,'Exact-scope permission changed',{description:PC_ACTIONS.find(s=>s[0]===value.action)![1],requirements:[requirement],...(value.taskId?{taskId:value.taskId}:{})});
      this.cancel(owner);
      return {id:row.id,...value};
    },options.expectedRevision);
  }
  async revoke(owner:string,id:string,expectedRevision?:number){
    if(!uuid(id))fail('Invalid permission.');
    return this.locked(owner,async db=>{
      const rows=await db.query(`delete from pc_control_policies where id=$1 and owner_user_id=$2 and pc_id=$3 returning id`,[id,owner,this.pcId]);
      if(!rows.length)throw new PcControlError(404,'Permission not found.');
      await this.invalidate(db,owner);await this.log(db,owner,'Permission revoked');
      this.cancel(owner);
    },expectedRevision);
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
    const terminal=plan.payload as {kind?:string;sessionId?:string};
    if(['desktop.terminal.input','desktop.terminal.read','desktop.terminal.close'].includes(terminal?.kind??'')){
      const parent=await this.request(db,owner,terminal.sessionId??'');
      if((parent.plan.payload as {kind?:string})?.kind!=='desktop.terminal.open'||!['executing','succeeded'].includes(parent.row.state)||Number(parent.row.epoch)!==Number(s.epoch)||Date.parse(parent.row.expires_at)<=this.now()||canonical(parent.plan.requirements)!==canonical(plan.requirements))return 'denied';
      const decision=await this.verdict(db,owner,s,parent.plan);
      return decision==='denied'?'denied':parent.row.human_approved||decision==='approved'?'approved':'pending';
    }
    // Under full control an everyday action is granted even when high-risk
    // (a click can submit); actions outside full control keep asking.
    const covered=(r:PcRequirement)=>s.full_control&&fullControlCovers(r);
    // A grantable high-risk action (commands) is decided by its saved exact
    // scope below, like an everyday action; without one it asks.
    let ask=plan.requirements.some(r=>highRisk(r)&&!covered(r)&&!grantable(r));
    const saved=(await db.query<{policy_enc:string}>('select policy_enc from pc_control_policies where owner_user_id=$1 and pc_id=$2',[owner,this.pcId])).map(row=>this.unpack<PcPolicy>(owner,row.policy_enc));
    const active=(p:PcPolicy)=>!['temporary','task'].includes(p.mode)||Date.parse(p.expiresAt??'')>this.now()&&(p.mode!=='task'||p.taskId===plan.taskId);
    // An unrestricted host interpreter cannot honor app, file, site or system
    // exclusions. Refuse that combination; mediated tools remain usable.
    if(plan.requirements.some(r=>r.action==='command.run')&&saved.some(p=>p.mode==='never'&&p.action!=='administrator.elevate'&&p.action!=='command.run'))return 'denied';
    for(const requirement of plan.requirements){
      const matches=saved.filter(p=>p.action===requirement.action&&p.scope.kind===requirement.scope.kind
        &&(p.scope.target==='*'||p.scope.target===requirement.scope.target||['folder','command'].includes(p.scope.kind)&&requirement.scope.target.startsWith(p.scope.target.replace(/\\$/,'')+'\\'))
        &&(p.scope.application==='*'||p.scope.application===requirement.scope.application)&&(p.scope.profile==='*'||p.scope.profile===requirement.scope.profile));
      if(matches.some(p=>p.mode==='never'))return 'denied';
      if(matches.some(p=>p.mode==='ask')){ask=true;continue;}
      if(matches.some(p=>active(p)&&['always','temporary','task'].includes(p.mode)))continue;
      if(!covered(requirement))ask=true;
    }
    return ask?'pending':'approved';
  }
  async propose(owner:string,input:PcPlan){
    const plan=this.normalize(input);
    return this.locked(owner,async(db,s)=>{
      const state=await this.verdict(db,owner,s,plan);
      const payload=plan.payload as {kind?:string;timeoutSeconds?:number};
      const lifetime=payload?.kind==='desktop.terminal.open'?Math.max(ASK_TTL,Math.min(28800,Number(payload.timeoutSeconds)||1800)*1000):ASK_TTL;
      const [row]=await db.query<{id:string}>(`insert into pc_control_requests(owner_user_id,pc_id,epoch,request_hash,request_enc,state,expires_at) values($1,$2,$3,$4,$5,$6,$7) returning id`,[owner,this.pcId,s.epoch,this.hash(owner,plan),this.pack(owner,plan),state,new Date(this.now()+lifetime).toISOString()]);
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
  async decide(owner:string,id:string,approve:boolean,expectedRevision?:number){
    if(typeof approve!=='boolean')fail('Choose approve or deny.');
    return this.locked(owner,async(db,s)=>{
      const {row,plan}=await this.request(db,owner,id);
      if(row.state!=='pending'||Number(row.epoch)!==Number(s.epoch)||Date.parse(row.expires_at)<=this.now())throw new PcControlError(409,'This request is no longer active.');
      if(approve && await this.verdict(db,owner,s,plan)==='denied')throw new PcControlError(409,'Control or this scope is disabled.');
      await db.query(`update pc_control_requests set state=$2,human_approved=$3 where id=$1`,[id,approve?'approved':'denied',approve]);
      await this.log(db,owner,approve?'Exact action approved once':'Exact action denied',plan);
    },expectedRevision);
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
  /** A short native execution lease. Rechecks durable state even when the
   * policy change came through a different server/service instance. */
  async executionAuthorized(owner:string,id:string):Promise<boolean>{
    return this.locked(owner,async(db,s)=>{
      const {row,plan}=await this.request(db,owner,id);
      if(!s.enabled||row.state!=='executing'||Number(row.epoch)!==Number(s.epoch)||Date.parse(row.expires_at)<=this.now())return false;
      const verdict=await this.verdict(db,owner,s,plan);
      return verdict!=='denied'&&(row.human_approved||verdict==='approved');
    });
  }
  /** A persistent session remains bound to the immutable opening request,
   * owner, device, revision, task and original deadline after its open receipt. */
  async terminalAuthorization(owner:string,id:string):Promise<{authorized:boolean;scope?:PcScope}>{
    return this.locked(owner,async(db,s)=>{
      const {row,plan}=await this.request(db,owner,id);
      const payload=plan.payload as {kind?:string;timeoutSeconds?:number};
      if(payload?.kind!=='desktop.terminal.open'||!s.enabled||!['executing','succeeded'].includes(row.state)||Number(row.epoch)!==Number(s.epoch)||Date.parse(row.expires_at)<=this.now())return {authorized:false};
      const verdict=await this.verdict(db,owner,s,plan);
      return {authorized:verdict!=='denied'&&(row.human_approved||verdict==='approved'),scope:plan.requirements.find(r=>r.action==='command.run')?.scope};
    });
  }
  async snapshot(owner:string){
    return this.locked(owner,async(db,s)=>{
      const policies=await db.query<{id:string;policy_enc:string}>(`select id,policy_enc from pc_control_policies where owner_user_id=$1 and pc_id=$2`,[owner,this.pcId]);
      const requests=await db.query<RequestRow>(`select * from pc_control_requests where owner_user_id=$1 and pc_id=$2 and state='pending' and expires_at>$3 order by created_at desc limit 100`,[owner,this.pcId,new Date(this.now()).toISOString()]);
      const logs=await db.query<{id:string;created_at:string;kind:string;detail_enc:string|null}>(`select id,created_at,kind,detail_enc from pc_control_activity where owner_user_id=$1 and pc_id=$2 order by created_at desc,id desc limit 100`,[owner,this.pcId]);
      const tasks=await db.query<{id:string;name:string;created_at:string}>(`select t.id,tt.name,t.created_at from tasks t join task_templates tt on tt.key=t.template_key where t.owner_user_id=$1 and t.state not in ('confirmed','failed','cancelled','closed')
        union all select id,outcome as name,created_at from work_goals where owner_user_id=$1 and state in ('planning','working','waiting') order by created_at desc limit 100`,[owner]);
      const label=(a:PcAction)=>PC_ACTIONS.find(x=>x[0]===a)![1];
      return {enabled:s.enabled,fullControl:s.full_control,pcId:this.pcId,revision:Number(s.epoch),
        fullControlCovers:PC_FULL_CONTROL_ACTIONS.map(label),fullControlAsks:PC_FULL_CONTROL_ASKS.map(label),
        catalog:PC_ACTIONS.map(([action,label,kind,risk,read])=>({action,label,kind,highRisk:risk,grantable:!risk||PC_GRANTABLE_HIGH_RISK.includes(action),access:read?'Read-only':'Read/write'})),
        tasks,policies:await Promise.all(policies.map(async p=>{const value=this.unpack<PcPolicy>(owner,p.policy_enc);return{id:p.id,...value,active:value.mode==='temporary'?Date.parse(value.expiresAt??'')>this.now():value.mode==='task'?Date.parse(value.expiresAt??'')>this.now()&&await this.liveTask(db,owner,value.taskId):true};})),
        requests:requests.map(row=>{const {payload,...visible}=this.unpack<PcPlan>(owner,row.request_enc);return{id:row.id,...visible,expiresAt:row.expires_at,highRisk:visible.requirements.some(highRisk),access:visible.requirements.every(readOnly)?'Read-only':'Read/write'};}),
        activity:logs.map(row=>({id:row.id,at:row.created_at,...(row.detail_enc?this.unpack<Record<string,unknown>>(owner,row.detail_enc):{kind:row.kind})}))};
    });
  }
  /** The local executor reports its live browser connection. It expires on
   * its own, so a closed app or browser never looks connected for long. */
  async setPresence(owner:string,presence:PcBrowserPresence|null){
    if(!uuid(owner))fail('Invalid owner.');
    await this.db.query(`insert into pc_control_settings(owner_user_id,pc_id) values($1,$2) on conflict do nothing`,[owner,this.pcId]);
    if(!presence){await this.db.query(`delete from pc_control_presence where owner_user_id=$1 and pc_id=$2`,[owner,this.pcId]);return;}
    const value=normalizePresence(presence);
    await this.db.query(`insert into pc_control_presence(owner_user_id,pc_id,presence_enc,expires_at) values($1,$2,$3,$4)
      on conflict(owner_user_id,pc_id) do update set presence_enc=excluded.presence_enc,expires_at=excluded.expires_at`,
      [owner,this.pcId,this.pack(owner,value),new Date(this.now()+PRESENCE_TTL).toISOString()]);
  }
  async presence(owner:string):Promise<PcBrowserPresence|null>{
    if(!uuid(owner))return null;
    const [row]=await this.db.query<{presence_enc:string}>(`select presence_enc from pc_control_presence where owner_user_id=$1 and pc_id=$2 and expires_at>$3`,[owner,this.pcId,new Date(this.now()).toISOString()]);
    return row?this.unpack<PcBrowserPresence>(owner,row.presence_enc):null;
  }
  /** Approved, unexpired work for the executor, oldest first. Claiming still
   * goes through execute(), which rechecks everything under the lock. */
  async approved(owner:string):Promise<{id:string;plan:PcPlan}[]>{
    return this.locked(owner,async(db,s)=>{
      const rows=await db.query<RequestRow>(`select * from pc_control_requests where owner_user_id=$1 and pc_id=$2 and state='approved' and epoch=$3 and expires_at>$4 order by created_at limit 10`,[owner,this.pcId,s.epoch,new Date(this.now()).toISOString()]);
      return rows.map(row=>({id:row.id,plan:this.unpack<PcPlan>(owner,row.request_enc)}));
    });
  }
  async saveResult(owner:string,id:string,result:unknown){
    if(!uuid(owner)||!uuid(id))fail('Invalid request.');
    if(Buffer.byteLength(canonical(result))>256*1024)fail('Result is too large.');
    await this.db.query(`insert into pc_control_results(request_id,owner_user_id,pc_id,result_enc) values($1,$2,$3,$4) on conflict(request_id) do nothing`,[id,owner,this.pcId,this.pack(owner,result)]);
  }
  /** Current state of one request and, once it ran, what the executor saw. */
  async outcome(owner:string,id:string):Promise<{state:string;result:unknown}|null>{
    if(!uuid(owner)||!uuid(id))return null;
    const [row]=await this.db.query<{state:string;expires_at:string;result_enc:string|null}>(`select q.state,q.expires_at,r.result_enc from pc_control_requests q left join pc_control_results r on r.request_id=q.id
      where q.id=$1 and q.owner_user_id=$2 and q.pc_id=$3`,[id,owner,this.pcId]);
    if(!row)return null;
    const expired=['pending','approved'].includes(row.state)&&Date.parse(row.expires_at)<=this.now();
    return {state:expired?'expired':row.state,result:row.result_enc?this.unpack<unknown>(owner,row.result_enc):null};
  }
}

export const LOCAL_WINDOWS_PC='local-windows-host';
const PRESENCE_TTL=30_000;
/** Build item 36: every Josi app instance names its own PC (`win-<id>`), so
 * two PCs on one account keep separate permissions, requests and presence.
 * An app that sends no identity is the hosting PC of the old single-PC form. */
export function pcIdFrom(value:unknown):string{
  return typeof value==='string'&&/^[a-z0-9-]{1,80}$/.test(value)?value:LOCAL_WINDOWS_PC;
}
/** The owner's PC whose app reported in most recently and is still live:
 * where the assistant's PC tools run. Null when no app is open anywhere. */
export async function livePcId(db:Db,owner:string):Promise<string|null>{
  if(!uuid(owner))return null;
  const [row]=await db.query<{pc_id:string}>(`select pc_id from pc_control_presence where owner_user_id=$1 and expires_at>now() order by expires_at desc limit 1`,[owner]);
  return row?.pc_id??null;
}
/** What the Windows app reports about the browser attached through its
 * native messaging host. Page content never travels here. */
export type PcBrowserPresence={family:string;application:string;profile:string;origin:string|null;title:string|null};
function normalizePresence(p:PcBrowserPresence):PcBrowserPresence {
  if(!p||typeof p!=='object')fail('Invalid browser connection.');
  // 'desktop': the Josi app is open on this PC with no browser tab attached;
  // desktop tools are available, browser tools are not.
  const family=['chrome','brave','edge','desktop'].includes(p.family)?p.family:fail('Unsupported browser.');
  let origin:string|null=null;
  if(p.origin!==null&&p.origin!==undefined){
    try{const url=new URL(text(p.origin,2048));if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('');origin=url.origin;}
    catch{fail('Invalid attached site.');}
  }
  const title=p.title===null||p.title===undefined||p.title===''?null:String(p.title).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,300);
  return {family,application:localPath(p.application),profile:text(p.profile,120),origin,title};
}
