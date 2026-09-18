import type { Db } from './db.js';
import { appendEvent } from './events.js';
import { ApprovalError, approvalHash, decideApproval, requestApproval, type Approval } from './approvals.js';
import { enqueue } from './queue.js';
import { getTask, setSlots, transition, type Task } from './tasks.js';

export type ActionDomain = 'email' | 'calendar' | 'contacts';
export type ActionOperation = 'send' | 'create' | 'update';
export type ActionStatus = 'collecting'|'prepared'|'approved'|'executing'|'succeeded'|'failed'|'denied'|'expired'|'superseded';

export interface AssistantActionState {
  id:string; owner_user_id:string; thread_id:string; domain:ActionDomain; operation:ActionOperation;
  status:ActionStatus; task_id:string; approval_id:string|null; source_turn_id:string|null;
  presented_turn_id:string|null; payload_hash:string|null; expires_at:string|null; executed_at:string|null;
  created_at:string; updated_at:string;
}

export async function activeCollectingAction(db:Db,args:{ownerUserId:string;threadId:string;domain:ActionDomain;operation:ActionOperation;sourceTurnId?:string|null}) {
  const [row]=await db.query<AssistantActionState>(`select * from assistant_action_states
    where owner_user_id=$1 and thread_id=$2 and domain=$3 and operation=$4 and status='collecting'
    order by created_at desc limit 1`,[args.ownerUserId,args.threadId,args.domain,args.operation]);
  if(!row)return null;
  // Multiple tool calls while handling one persisted inbound turn belong to
  // the same transaction even though no assistant message exists yet.
  if(args.sourceTurnId&&row.source_turn_id===args.sourceTurnId)return row;
  const [lastOutbound]=await db.query<{id:string}>(`select id from messages
    where thread_id=$1 and direction='out' order by created_at desc limit 1`,[args.threadId]);
  // A partial draft may continue only from the immediately preceding assistant
  // turn which presented it. Domain scoping alone is not enough: without this
  // turn boundary, a later email could silently inherit an old recipient/body.
  if(!lastOutbound||row.presented_turn_id!==lastOutbound.id){
    await db.query(`update assistant_action_states set status='superseded'
      where id=$1 and status='collecting'`,[row.id]);
    const task=await getTask(db,row.task_id);
    if(task.state==='drafting')await transition(db,task.id,'cancelled',{actor:'system'});
    return null;
  }
  return row;
}

export async function attachCollectingAction(db:Db,args:{ownerUserId:string;threadId:string;domain:ActionDomain;operation:ActionOperation;taskId:string;sourceTurnId?:string|null}) {
  const [row]=await db.query<AssistantActionState>(`insert into assistant_action_states
    (owner_user_id,thread_id,domain,operation,task_id,source_turn_id)
    values($1,$2,$3,$4,$5,$6) returning *`,[args.ownerUserId,args.threadId,args.domain,args.operation,args.taskId,args.sourceTurnId??null]);
  await appendEvent(db,{actorUserId:args.ownerUserId,actor:'agent',kind:'assistant_action.collecting',subjectType:'task',subjectId:args.taskId,payload:{domain:args.domain,operation:args.operation,actionStateId:row.id}});
  return row;
}

export async function mergeActionTask(db:Db,action:AssistantActionState,patch:Record<string,unknown>,removeKeys:string[]=[]):Promise<Task>{
  return setSlots(db,action.task_id,patch,{actor:'agent',actorUserId:action.owner_user_id,removeKeys});
}

export async function prepareAction(db:Db,args:{actionState:AssistantActionState;task:Task;summary:string;actionClass:string;action:string;ttlSeconds?:number}) {
  const payload=args.task.slots;
  const approval=await requestApproval(db,{taskId:args.task.id,ownerUserId:args.actionState.owner_user_id,
    actionClass:args.actionClass,action:args.action,summary:args.summary,payload,ttlSeconds:args.ttlSeconds??900});
  if(args.task.state==='drafting') await transition(db,args.task.id,'awaiting_approval',{actor:'agent',actorUserId:args.actionState.owner_user_id});
  const [row]=await db.query<AssistantActionState>(`update assistant_action_states set status='prepared',approval_id=$2,
    payload_hash=$3,expires_at=$4 where id=$1 and status='collecting' returning *`,
    [args.actionState.id,approval.id,approvalHash(payload),approval.expires_at]);
  if(!row) throw new Error('That draft changed while it was being prepared. Review it again.');
  return {...row,approval};
}

export async function markActionsPresented(db:Db,args:{ownerUserId:string;threadId:string;taskIds:string[];messageId:string}) {
  if(!args.taskIds.length)return;
  await db.query(`update assistant_action_states set presented_turn_id=$4
    where owner_user_id=$1 and thread_id=$2 and task_id=any($3::uuid[]) and status in ('collecting','prepared')`,
    [args.ownerUserId,args.threadId,args.taskIds,args.messageId]);
}

export interface ConversationalDecision { handled:boolean; reply?:string; action?:AssistantActionState; task?:Task }
const YES=/^(?:yes|yes please|please do|do it|send it|approve|confirmed?)\s*[.!]?$/i;
const NO=/^(?:no|no thanks|don't|do not|cancel|deny)\s*[.!]?$/i;
const EMAIL_STATUS=/\b(?:was|is|did).{0,16}(?:email|it).{0,12}(?:sent|send)/i;
const BARE_WHY=/^why\s*[?!.]?$/i;

async function latestPresented(db:Db,args:{ownerUserId:string;threadId:string;status?:ActionStatus;domain?:ActionDomain}){
  const rows=await db.query<AssistantActionState>(`select a.* from assistant_action_states a join messages m on m.id=a.presented_turn_id
    where a.owner_user_id=$1 and a.thread_id=$2 and ($3::text is null or a.status=$3)
      and ($4::text is null or a.domain=$4)
    order by m.created_at desc,a.created_at desc limit 2`,[args.ownerUserId,args.threadId,args.status??null,args.domain??null]);
  return rows;
}

async function latestDomainAction(db:Db,args:{ownerUserId:string;threadId:string;domain:ActionDomain}){
  const [row]=await db.query<AssistantActionState>(`select * from assistant_action_states
    where owner_user_id=$1 and thread_id=$2 and domain=$3 order by created_at desc limit 1`,
    [args.ownerUserId,args.threadId,args.domain]);
  return row??null;
}

function statusReply(action:AssistantActionState,task:Task):string{
  const noun=action.domain==='email'?'email':'calendar event';
  switch(action.status){
    case 'collecting':return `The ${noun} draft is not complete yet.`;
    case 'prepared':return `The ${noun} is prepared and waiting for your approval. It has not been ${action.domain==='email'?'sent':'created'}.`;
    case 'approved':case 'executing':return `The ${noun} was approved and is queued. It is not confirmed ${action.domain==='email'?'sent':'created'} yet.`;
    case 'succeeded':return `Yes. The ${noun} was ${action.domain==='email'?'sent':'created'}.`;
    case 'failed':return `No. The ${noun} was not ${action.domain==='email'?'sent':'created'}. ${task.fail_reason?'The attempt failed; retry only after reviewing the draft.':''}`.trim();
    case 'denied':return `No. The ${noun} was denied and was not ${action.domain==='email'?'sent':'created'}.`;
    case 'expired':return `No. The approval expired, so the ${noun} was not ${action.domain==='email'?'sent':'created'}.`;
    default:return `The ${noun} is not pending.`;
  }
}

/** Apply an approval-page or conversational decision to its prepared action.
 * Generic approvals keep their existing behaviour; action approvals also move
 * the pinned task and enqueue at most once. */
export async function decideActionApproval(db:Db,args:{approvalId:string;decidedBy:string;approve:boolean}):Promise<{approval:Approval;action:AssistantActionState|null;task:Task|null}>{
  const [before]=await db.query<AssistantActionState>(`select * from assistant_action_states where approval_id=$1`,[args.approvalId]);
  if(before?.status==='prepared'&&before.expires_at&&new Date(before.expires_at)<=new Date()){
    await db.query(`update assistant_action_states set status='expired' where id=$1 and status='prepared'`,[before.id]);
    await db.query(`update approvals set status='expired' where id=$1 and status='pending'`,[args.approvalId]);
    throw new ApprovalError('that request expired');
  }
  const approval=await decideApproval(db,args);
  const action=before;
  if(!action)return {approval,action:null,task:null};
  const task=await getTask(db,action.task_id);
  const [claimed]=await db.query<AssistantActionState>(`update assistant_action_states set status=$2 where id=$1 and status='prepared' returning *`,[action.id,args.approve?'approved':'denied']);
  if(!claimed)return {approval,action,task};
  await transition(db,task.id,args.approve?'ready':'cancelled',{actor:'user',actorUserId:args.decidedBy});
  if(args.approve)await enqueue(db,{kind:'task.wake',payload:{taskId:task.id}});
  return {approval,action:claimed,task};
}

export async function resolveConversationalAction(db:Db,args:{ownerUserId:string;threadId:string;inbound:string;replyToMessageId?:string|null;requireReplyTarget?:boolean}):Promise<ConversationalDecision>{
  const text=args.inbound.trim();
  if(YES.test(text)||NO.test(text)){
    const candidates=await latestPresented(db,{ownerUserId:args.ownerUserId,threadId:args.threadId,status:'prepared'});
    if(!candidates.length)return {handled:true,reply:'I do not have one immediately preceding prepared action to apply that answer to.'};
    const [lastOutbound]=await db.query<{id:string}>(`select id from messages where thread_id=$1 and direction='out' order by created_at desc limit 1`,[args.threadId]);
    if(!lastOutbound||candidates[0].presented_turn_id!==lastOutbound.id)return {handled:true,reply:'I do not have one immediately preceding prepared action to apply that answer to.'};
    // Durable clients can queue multiple turns before any reply exists. For
    // them, arrival order is not consent: yes/no must explicitly reply to the
    // exact assistant message that presented the action. Legacy synchronous
    // channels retain their immediately-preceding-turn rule above.
    if(args.requireReplyTarget&&args.replyToMessageId!==lastOutbound.id)return {handled:true,reply:'Reply directly to the approval request so I can apply that answer to the action you reviewed.'};
    const latestTurn=candidates[0].presented_turn_id;
    const sameTurn=candidates.filter(c=>c.presented_turn_id===latestTurn);
    if(sameTurn.length!==1)return {handled:true,reply:'That answer is ambiguous because more than one action was prepared together. Name the email or calendar action you mean.'};
    const action=sameTurn[0];
    if(action.expires_at&&new Date(action.expires_at)<=new Date()){
      await db.query(`update assistant_action_states set status='expired' where id=$1 and status='prepared'`,[action.id]);
      if(action.approval_id)await db.query(`update approvals set status='expired' where id=$1 and status='pending'`,[action.approval_id]);
      return {handled:true,reply:'That approval expired. Review and prepare the action again before approving it.',action};
    }
    const task=await getTask(db,action.task_id);
    if(NO.test(text)){
      let decidedAction=action;
      if(action.approval_id)try{decidedAction=(await decideActionApproval(db,{approvalId:action.approval_id,decidedBy:args.ownerUserId,approve:false})).action??action;}
      catch(error){if(error instanceof ApprovalError)return {handled:true,reply:'That action was already decided.',action,task};throw error;}
      return {handled:true,reply:`Denied. The ${action.domain==='email'?'email was not sent':'calendar was not changed'}.`,action:decidedAction,task};
    }
    if(!action.approval_id)return {handled:true,reply:'That prepared action has no valid approval request. Review it again.'};
    let decidedAction=action;
    try{decidedAction=(await decideActionApproval(db,{approvalId:action.approval_id,decidedBy:args.ownerUserId,approve:true})).action??action;}
    catch(error){if(error instanceof ApprovalError)return {handled:true,reply:'That action was already decided.',action,task};throw error;}
    return {handled:true,reply:`Approved. I queued the exact ${action.domain==='email'?'email':'calendar event'} you reviewed.`,action:decidedAction,task};
  }
  let emailStatusQuestion=EMAIL_STATUS.test(text);
  if(!emailStatusQuestion&&BARE_WHY.test(text)){
    const [prior]=await db.query<{domain:string|null}>(`select meta->>'action_status_domain' domain from messages
      where thread_id=$1 and direction='out' order by created_at desc limit 1`,[args.threadId]);
    emailStatusQuestion=prior?.domain==='email';
  }
  if(emailStatusQuestion){
    const action=await latestDomainAction(db,{ownerUserId:args.ownerUserId,threadId:args.threadId,domain:'email'});
    if(!action)return {handled:true,reply:'I do not have an email action in this conversation to check.'};
    return {handled:true,reply:statusReply(action,await getTask(db,action.task_id)),action,task:await getTask(db,action.task_id)};
  }
  return {handled:false};
}

export async function claimReadyTask(db:Db,taskId:string):Promise<Task|null>{
  const [task]=await db.query<Task>(`update tasks set state='attempting' where id=$1 and state='ready' returning *`,[taskId]);
  if(task)await appendEvent(db,{actor:'system',kind:'task.transition',subjectType:'task',subjectId:taskId,payload:{from:'ready',to:'attempting',reason:null}});
  return task??null;
}

export async function settleActionForTask(db:Db,taskId:string,status:'succeeded'|'failed'){
  await db.query(`update assistant_action_states set status=$2,executed_at=case when $2='succeeded' then now() else executed_at end
    where task_id=$1 and status in ('approved','executing')`,[taskId,status]);
}
