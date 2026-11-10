// Chat reads the actual device policy, then prepares a human-approved change.
// The target, owner and policy revision are fixed before any client applies it.
import { existsSync } from 'node:fs';
import { normalizePcPolicy, normalizePcPreset, pcControlAllowed, PcControl, PcControlError, syncLocalExecutors, type Db, type MasterKey, type PcPolicy, type PcPreset } from '@josi-ce/core';

export const PC_CHAT_PERMISSION_SEMANTICS = 'pc-control-chat.2';
export const PC_SETTING_AREAS = new Set(['pc_control_enabled', 'pc_control_full_control', 'pc_control_preset', 'pc_control_scope', 'pc_control_revoke', 'pc_control_decide']);

export async function pcPermissionState(db:Db,owner:string,key:MasterKey,requested?:unknown) {
  if(!await pcControlAllowed(db,owner))throw new PcControlError(403,'PC control is switched off for this account. The owner of this Josi can switch it on.');
  // A Linux server's own executor cannot sign in by itself: it is listed from its hello.
  await syncLocalExecutors(db,owner).catch(()=>[]);
  const devices=await db.query<{pcId:string;enabled:boolean;connected:boolean;paired:boolean}>(
    `select s.pc_id as "pcId",s.enabled,coalesce(p.expires_at>now(),false) as connected,(i.public_key is not null) as paired
     from pc_control_settings s left join pc_control_presence p on p.owner_user_id=s.owner_user_id and p.pc_id=s.pc_id
     left join pc_executor_identity i on i.owner_user_id=s.owner_user_id and i.pc_id=s.pc_id
     where s.owner_user_id=$1 order by s.pc_id`,[owner]);
  if(requested!==undefined&&(typeof requested!=='string'||!/^[a-z0-9-]{1,80}$/.test(requested)))
    throw new PcControlError(400,'Choose a PC id from pc_get_permissions.');
  const pcId=typeof requested==='string'?requested:devices.length===1?devices[0].pcId:undefined;
  if(!pcId)return {semanticsVersion:PC_CHAT_PERMISSION_SEMANTICS,devices,selected:null};
  if(!devices.some(d=>d.pcId===pcId))throw new PcControlError(404,'This account has no such PC. Open Josi on that computer first.');
  const {activity,...selected}=await new PcControl(db,key,pcId).snapshot(owner);
  return {semanticsVersion:PC_CHAT_PERMISSION_SEMANTICS,devices,selected};
}

export async function preparePcPermissionChange(db:Db,owner:string,key:MasterKey,area:string,body:Record<string,unknown>,params:Record<string,unknown>,path:string) {
  const state=await pcPermissionState(db,owner,key,params.pcId);
  const current=state.selected;
  if(!current)throw new PcControlError(400,state.devices.length
    ? 'More than one PC is registered. Ask which PC, then pass params.pcId from pc_get_permissions.'
    : 'Open Josi on the target PC first so its permissions can be identified.');
  let normalized:Record<string,unknown>,detail:string;
  if(area==='pc_control_enabled'||area==='pc_control_full_control'){
    if(typeof body.enabled!=='boolean')throw new PcControlError(400,'Choose on or off.');
    // Turning control on from chat is one ask: it also grants the everyday
    // allowances (apps, files, windows), so the next request does not ask
    // again. Commands, deleting, purchases, installs and elevation still ask.
    const everyday=area==='pc_control_enabled'&&body.enabled&&body.everyday!==false;
    normalized=everyday?{enabled:true,everyday:true}:{enabled:body.enabled};
    const device=state.devices.find(d=>d.pcId===current.pcId);
    detail=area==='pc_control_enabled'
      ? body.enabled?(everyday?'Let Josi work on this PC: open and use programs, read and write files and use windows without asking each time. Commands in a shell ask once per folder; deleting, purchases, credentials, installs, security changes and administrator prompts always ask.'
          :'Enable PC control. This alone does not grant access to applications, files, or commands.')+(device&&!device.paired?(current.pcId.startsWith('linux-')?' Approving this also pairs the PC service of this Linux server with your account.':' Josi on this PC will then ask you once to approve the PC with your password.'):'')
        :'Disable PC control and revoke temporary and task grants. Completed work is not undone.'
      : body.enabled?'Enable everyday control for browsers, folders and applications. Commands, deletion, purchases, credentials, installs, security changes and elevation still ask. Existing Never rules remain blocked.'
        :'Disable everyday full control. Exact saved permissions still apply.';
  } else if(area==='pc_control_preset'){
    const preset=normalizePcPreset(body as PcPreset);
    if(preset.mode==='task'&&!current.tasks.some(t=>t.id===preset.taskId))throw new PcControlError(400,'Choose an active task belonging to you.');
    normalized={...preset};
    const duration=preset.mode==='always'?'until revoked':preset.mode==='task'?`for task ${preset.taskId}, until ${preset.expiresAt}`:`until ${preset.expiresAt}`;
    const linux=current.pcId.startsWith('linux-');
    detail=`Allow ${preset.access==='apps'?'all applications':preset.access==='terminal'?'all supported terminals in any starting folder':'all supported application, file, browser and terminal operations'} ${duration}.\nAdministrator commands: ${linux?'not available on a Linux server':preset.administrator?'allowed for this duration, with Windows UAC still required':'blocked until you change this administrator rule'}.\nExisting exact permissions and Never/Ask rules remain. Protected credentials are excluded.`;
    if(preset.access!=='apps')detail+=`\nHost commands can access files and launch programs with your ${linux?'Linux user':'Windows account'} authority. Starting folders do not sandbox commands; incompatible Never rules block host commands.`;
    if(preset.access==='full')detail+='\nThe older everyday-control toggle is disabled so it cannot outlive this duration. Other existing exact grants keep their own durations.';
  } else if(area==='pc_control_decide'){
    if(typeof body.approve!=='boolean')throw new PcControlError(400,'Choose approve or deny.');
    const waiting=current.requests.find(r=>r.id===params.id);
    if(!waiting)throw new PcControlError(404,'That request is no longer waiting on this PC.');
    normalized={approve:body.approve};
    detail=`${body.approve?'Allow once':'Deny'}: ${waiting.description}\n`+waiting.requirements.map(r=>`${r.action}: ${r.scope.target}${r.scope.application?' using '+r.scope.application:''}${r.scope.profile?' profile '+r.scope.profile:''}`).join('\n');
    if(waiting.requirements.some(r=>r.action==='command.run'))detail+='\nThis command runs with the signed-in user\'s authority. Its starting folder is not a sandbox.';
  } else if(area==='pc_control_revoke'){
    const existing=current.policies.find(p=>p.id===params.id);
    if(!existing)throw new PcControlError(404,'That permission does not belong to this PC.');
    normalized={};
    detail=`Revoke ${existing.action} for ${existing.scope.target}${existing.scope.application?' using '+existing.scope.application:''}.`;
  } else {
    const rawScope=body.scope;
    const kind=(rawScope as Record<string,unknown>|null)?.kind;
    const scopeKeys=kind==='browser'?['kind','target','application','profile']:kind==='command'?['kind','target','application']:['kind','target'];
    if(!rawScope||typeof rawScope!=='object'||Array.isArray(rawScope)||Object.keys(rawScope).some(k=>!scopeKeys.includes(k)))
      throw new PcControlError(400,'Choose an exact supported scope; additional restrictions cannot be silently discarded.');
    if((body.taskId!==undefined&&body.mode!=='task')||(body.expiresAt!==undefined&&!['task','temporary'].includes(String(body.mode))))
      throw new PcControlError(400,'Task and expiry limits need a matching Task or Temporary permission.');
    const policy=normalizePcPolicy(body as PcPolicy);
    const spec=current.catalog.find(c=>c.action===policy.action)!;
    if(['always','temporary','task'].includes(policy.mode)&&!spec.grantable)
      throw new PcControlError(400,'Saved grants for this action are not implemented yet. Choose Ask or Never.');
    if(policy.mode==='task'&&!current.tasks.some(t=>t.id===policy.taskId))throw new PcControlError(400,'Choose an active task belonging to you.');
    const labels={never:'Never allow',ask:'Ask each time',always:'Allow until revoked',temporary:'Allow until '+policy.expiresAt,task:'Allow for task '+policy.taskId+' until '+policy.expiresAt};
    detail=`${labels[policy.mode]}: ${spec.label}. Scope: ${policy.scope.target}${policy.scope.application?'\nApplication: '+policy.scope.application:''}${policy.scope.profile?'\nProfile: '+policy.scope.profile:''}.`;
    normalized={...policy};
    if(body.approveRequestId!==undefined){
      const waiting=current.requests.find(r=>r.id===body.approveRequestId);
      if(!waiting||!waiting.requirements.some(r=>r.action===policy.action&&r.scope.kind===policy.scope.kind&&r.scope.target===policy.scope.target&&r.scope.application===policy.scope.application&&r.scope.profile===policy.scope.profile))
        throw new PcControlError(400,'Choose an active request matching this exact permission.');
      if(!['always','temporary','task'].includes(policy.mode))throw new PcControlError(400,'Choose an allowance to save and approve together.');
      normalized.approveRequestId=waiting.id;
      detail+=`\nAlso approve the waiting action: ${waiting.description}`;
    }
    if(policy.action==='command.run')detail+='\nA starting folder is not a sandbox. Commands can access other files and launch programs with the signed-in user\'s authority.';
  }
  const summary=`Computer: ${current.pcId}\n${detail}\nBased on permission revision ${current.revision}.`;
  if(summary.length>2000)throw new PcControlError(400,'The exact permission description is too long to display. Use a shorter scope.');
  const query=new URLSearchParams({pcId:current.pcId,ownerId:owner,revision:String(current.revision)});
  return {body:normalized,summary,path:path+'?'+query.toString()};
}

/** One fact per link of the chain from a chat request to work on the PC, so a
 * failure names itself instead of ending in "Josi says it can't". Read by the
 * PC Control screen, the readiness route and pc_get_permissions. */
export type ReadinessFact={ok:boolean|null;detail:string};
export async function pcControlReadiness(db:Db,owner:string,requested?:unknown):Promise<{facts:Record<string,ReadinessFact>;ready:boolean;summary:string}> {
  const facts:Record<string,ReadinessFact>={};
  await syncLocalExecutors(db,owner).catch(()=>[]);
  const [model]=await db.query<{provider:string;model:string;cap_tool_calling:boolean|null;cap_vision:boolean|null;probed_at:string|null;activated_at:string|null}>(
    `select provider,model,cap_tool_calling,cap_vision,probed_at,activated_at from llm_providers where role='primary'`);
  facts.model=!model?{ok:false,detail:'No language model is configured. Choose one under Models.'}
    :model.cap_tool_calling===true?{ok:true,detail:`${model.model} (${model.provider}) can call tools${model.cap_vision?' and see images':''}; checked ${model.probed_at??'never'}.`}
    :model.probed_at?{ok:false,detail:`${model.model} (${model.provider}) did not pass the tool-calling check on ${model.probed_at}, so Josi cannot act on this PC or change settings with it. Run Check Again under Models, or pick a model that can call tools.`}
    :{ok:false,detail:`${model.model} (${model.provider}) has not been checked yet. Run Check Again under Models.`};
  const configured=process.env.JOSI_MCP_SERVER?.trim();
  facts.toolServer=configured?(existsSync(configured)?{ok:true,detail:'The Josi tool server is installed at '+configured+'.'}:{ok:false,detail:'JOSI_MCP_SERVER points at a missing file: '+configured+'. Repair the installation.'})
    :{ok:null,detail:'JOSI_MCP_SERVER is not set; the tool server is looked up at its default location.'};
  const devices=await db.query<{pcId:string;enabled:boolean;connected:boolean;paired:boolean;fullControl:boolean}>(
    `select s.pc_id as "pcId",s.enabled,s.full_control as "fullControl",coalesce(p.expires_at>now(),false) as connected,(i.public_key is not null) as paired
     from pc_control_settings s left join pc_control_presence p on p.owner_user_id=s.owner_user_id and p.pc_id=s.pc_id
     left join pc_executor_identity i on i.owner_user_id=s.owner_user_id and i.pc_id=s.pc_id where s.owner_user_id=$1 order by s.pc_id`,[owner]);
  const pcId=typeof requested==='string'?requested:devices.length===1?devices[0].pcId:devices.find(d=>d.connected)?.pcId;
  const pc=devices.find(d=>d.pcId===pcId),linux=!!pc?.pcId.startsWith('linux-');
  facts.pcRegistered=pc?{ok:true,detail:'This PC is registered as '+pc.pcId+'.'}
    :devices.length?{ok:false,detail:'Several PCs are registered and none is selected: '+devices.map(d=>d.pcId).join(', ')+'.'}
    :{ok:false,detail:'No PC is registered to this account. Open Josi on the PC and sign in as the owner; it registers itself.'};
  facts.pcPaired=!pc?{ok:false,detail:'Not paired.'}:pc.paired?{ok:true,detail:'The PC approved its executor key.'}
    :{ok:false,detail:linux?'The PC service of this Linux server is not paired yet. Propose pc_control_enabled for it in chat: approving that card with the password pairs it.':'This PC has not approved its executor key. In Josi on that PC, open PC Control and choose Approve This PC (your password, once).'};
  facts.controlEnabled=!pc?{ok:false,detail:'PC control is off.'}:pc.enabled?{ok:true,detail:'PC control is on'+(pc.fullControl?' with everyday full control.':'.')}
    :{ok:false,detail:'PC control is off. Turn it on under PC Control, or ask Josi in chat to turn it on.'};
  facts.pcPresence=!pc?{ok:false,detail:'Josi is not announcing itself from any PC.'}:pc.connected?{ok:true,detail:'Josi is open on the PC and ready to work.'}
    :pc.enabled&&pc.paired?{ok:false,detail:linux?'The PC service on this Linux server (josi-pc.service) is not announcing itself. It may be stopped or paused; `sudo systemctl restart josi-pc` on the server starts it again.':'Josi on the PC is not announcing itself. Is the app open and signed in as the owner on its Workspace screen?'}
    :{ok:false,detail:'Josi announces itself once the PC is paired and control is on.'};
  if(pc){
    const [counts]=await db.query<{grants:string;pending:string}>(
      `select (select count(*) from pc_control_policies where owner_user_id=$1 and pc_id=$2 and mode in ('always','temporary','task')) as grants,
              (select count(*) from pc_control_requests where owner_user_id=$1 and pc_id=$2 and state='pending' and expires_at>now()) as pending`,[owner,pc.pcId]);
    facts.grants={ok:null,detail:`${counts.grants} saved allowance(s), ${counts.pending} request(s) waiting for approval.`};
  }
  const blocking=Object.entries(facts).filter(([,f])=>f.ok===false).map(([k])=>k);
  const summary=blocking.length?'Not ready: '+blocking.join(', ')+'.':'Ready: Josi can work on this PC.';
  return {facts,ready:blocking.length===0,summary};
}
