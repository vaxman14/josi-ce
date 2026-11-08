// Chat reads the actual device policy, then prepares a human-approved change.
// The target, owner and policy revision are fixed before any client applies it.
import { normalizePcPolicy, normalizePcPreset, PcControl, PcControlError, type Db, type MasterKey, type PcPolicy, type PcPreset } from '@josi-ce/core';

export const PC_CHAT_PERMISSION_SEMANTICS = 'pc-control-chat.2';
export const PC_SETTING_AREAS = new Set(['pc_control_enabled', 'pc_control_full_control', 'pc_control_preset', 'pc_control_scope', 'pc_control_revoke', 'pc_control_decide']);

export async function pcPermissionState(db:Db,owner:string,key:MasterKey,requested?:unknown) {
  const [user]=await db.query<{role:string}>(`select role from users where id=$1`,[owner]);
  if(user?.role!=='super_admin')throw new PcControlError(403,'Only the owner can manage PC permissions.');
  const devices=await db.query<{pcId:string;enabled:boolean;connected:boolean}>(
    `select s.pc_id as "pcId",s.enabled,coalesce(p.expires_at>now(),false) as connected
     from pc_control_settings s left join pc_control_presence p on p.owner_user_id=s.owner_user_id and p.pc_id=s.pc_id
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
    normalized={enabled:body.enabled};
    detail=area==='pc_control_enabled'
      ? body.enabled?'Enable PC control. This alone does not grant access to applications, files, or commands.':'Disable PC control and revoke temporary and task grants. Completed work is not undone.'
      : body.enabled?'Enable everyday control for browsers, folders and applications. Commands, deletion, purchases, credentials, installs, security changes and elevation still ask. Existing Never rules remain blocked.'
        :'Disable everyday full control. Exact saved permissions still apply.';
  } else if(area==='pc_control_preset'){
    const preset=normalizePcPreset(body as PcPreset);
    if(preset.mode==='task'&&!current.tasks.some(t=>t.id===preset.taskId))throw new PcControlError(400,'Choose an active task belonging to you.');
    normalized={...preset};
    const duration=preset.mode==='always'?'until revoked':preset.mode==='task'?`for task ${preset.taskId}, until ${preset.expiresAt}`:`until ${preset.expiresAt}`;
    detail=`Allow ${preset.access==='apps'?'all applications':preset.access==='terminal'?'all supported terminals in any starting folder':'all supported application, file, browser and terminal operations'} ${duration}.\nAdministrator commands: ${preset.administrator?'allowed for this duration, with Windows UAC still required':'blocked until you change this administrator rule'}.\nExisting exact permissions and Never/Ask rules remain. Protected credentials are excluded.`;
    if(preset.access!=='apps')detail+='\nHost commands can access files and launch programs with your Windows account authority. Starting folders do not sandbox commands; incompatible Never rules block host commands.';
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
