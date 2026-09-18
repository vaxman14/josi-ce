import { createHash, randomUUID } from 'node:crypto';
import { json, type Db } from './db.js';
import { asSecret, openSealed, seal } from './sealing.js';
import type { MasterKey } from './masterKey.js';

export type TurnStatus='queued'|'running'|'completed'|'failed';
export interface DurableTurn { id:string;owner_user_id:string;thread_id:string;client_message_id:string;attempt_of:string|null;inbound_message_id:string;reply_to_message_id:string|null;attachment_ids:string[];status:TurnStatus;assistant_message_id:string|null;tool_receipts:unknown[];error_code:string|null;error_retryable:boolean|null;created_at:string;updated_at:string; }
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export class MobileError extends Error { constructor(readonly code:string,message:string){super(message);} }

/** A single PostgreSQL statement is the acceptance transaction: attachment and
 * reply receipts are owner/thread-bound, then the inbound message, turn and
 * queue row become visible together. A duplicate key returns the original turn
 * and creates no second message/job. */
export async function submitDurableTurn(db:Db,args:{ownerUserId:string;sessionId?:string;threadId:string;clientMessageId:string;message:string;replyToMessageId?:string|null;attachmentIds?:string[];attemptOf?:string|null}):Promise<{turn:DurableTurn;duplicate:boolean}>{
  const suppliedAttachmentIds=args.attachmentIds??[];
  const attachmentIds=[...new Set(suppliedAttachmentIds)].sort();
  const message=args.message.trim();
  if(!args.clientMessageId||args.clientMessageId.length>128)throw new MobileError('invalid_idempotency_key','A client_message_id of at most 128 characters is required.');
  if(!message&&!attachmentIds.length)throw new MobileError('empty_turn','Say something or attach a file.');
  if(attachmentIds.length!==suppliedAttachmentIds.length||attachmentIds.length>10||attachmentIds.some(id=>!uuid.test(id)))throw new MobileError('invalid_attachments','Choose at most ten distinct, valid attachment receipts.');
  if(args.replyToMessageId&&!uuid.test(args.replyToMessageId))throw new MobileError('invalid_reply_target','Choose a valid reply target.');
  if(args.attemptOf&&!uuid.test(args.attemptOf))throw new MobileError('invalid_attempt','Choose a valid prior attempt.');
  const [liveSession]=await db.query<{id:string}>(`select id from sessions where id=coalesce($2::uuid,id) and user_id=$1 and revoked_at is null and expires_at>now() order by created_at desc limit 1`,[args.ownerUserId,args.sessionId??null]);
  if(!liveSession)throw new MobileError('session_expired','Sign in again before submitting a turn.');
  const requestHash=digest({message,replyToMessageId:args.replyToMessageId??null,attachmentIds,attemptOf:args.attemptOf??null});
  let rows:Array<DurableTurn&{duplicate:boolean;request_hash:string}>;
  try{rows=await db.query<DurableTurn&{duplicate:boolean;request_hash:string}>(`
    with owned as (
      select id from threads where id=$2 and owner_user_id=$1 and status='open'
    ), valid_attachments as (
      select coalesce(array_agg(a.id order by a.id),array[]::uuid[]) ids,count(*)::int n
      from chat_attachments a join owned t on t.id=a.thread_id
      where a.owner_user_id=$1 and a.storage_state='ready' and a.id=any($6::uuid[])
    ), valid_reply as (
      select case when $5::uuid is null then true else exists(
        select 1 from messages m join owned t on t.id=m.thread_id where m.id=$5
      ) end ok
    ), valid_attempt as (
      select case when $7::uuid is null then true else exists(
        select 1 from assistant_turns x where x.id=$7 and x.owner_user_id=$1 and x.thread_id=$2 and x.status='failed'
      ) end ok
    ), existing as (
      select * from assistant_turns where owner_user_id=$1 and thread_id=$2 and client_message_id=$3
    ), inbound as (
      insert into messages(thread_id,direction,channel,body,meta)
      select $2,'in','native',$4,jsonb_build_object('attachments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'contentType',a.content_type) order by a.id) from chat_attachments a where a.id=any($6::uuid[])),jsonb_build_array()))
      where exists(select 1 from owned) and not exists(select 1 from existing)
        and (select n from valid_attachments)=cardinality($6::uuid[]) and (select ok from valid_reply) and (select ok from valid_attempt)
      returning id
    ), pinned as (
      update chat_attachments set referenced_at=coalesce(referenced_at,now()) where id=any($6::uuid[]) and exists(select 1 from inbound) returning id
    ), inserted as (
      insert into assistant_turns(owner_user_id,accepted_session_id,thread_id,client_message_id,attempt_of,inbound_message_id,reply_to_message_id,attachment_ids,request_hash)
      select $1,$9,$2,$3,$7,id,$5,$6,$8 from inbound returning *
    ), queued as (
      insert into job_queue(kind,payload) select 'assistant.turn',jsonb_build_object('turnId',id) from inserted on conflict do nothing
    ), touched as (
      update threads set last_activity_at=now() where id=$2 and exists(select 1 from inserted) returning id
    )
    select e.*,true duplicate,e.request_hash from existing e
    union all select i.*,false duplicate,i.request_hash from inserted i`,
    [args.ownerUserId,args.threadId,args.clientMessageId,message||'Sent an attachment',args.replyToMessageId??null,attachmentIds,args.attemptOf??null,requestHash,liveSession.id]);}
  catch(err){
    // Concurrent first submissions can race at the unique key. The losing
    // statement is rolled back in full (including its message); return the
    // committed winner rather than surfacing an uncertain-response failure.
    if(/assistant_turn_capacity/i.test(String((err as Error).message)))throw new MobileError('turn_queue_full','Too many turns are already queued or running. Reconcile them before retrying.');
    if(!/assistant_turns_owner_user_id_thread_id_client_message_id_key|duplicate key/i.test(String((err as Error).message)))throw err;
    rows=await db.query<DurableTurn&{duplicate:boolean;request_hash:string}>(`select t.*,true duplicate from assistant_turns t where owner_user_id=$1 and thread_id=$2 and client_message_id=$3`,[args.ownerUserId,args.threadId,args.clientMessageId]);
  }
  if(!rows.length)throw new MobileError('invalid_receipt_binding','Thread, attachment, reply, or prior-attempt receipt is unavailable.');
  if(rows[0].request_hash!==requestHash)throw new MobileError('idempotency_conflict','That client_message_id was already used for a different request.');
  return {turn:rows[0],duplicate:rows[0].duplicate};
}

export async function listDurableTurns(db:Db,args:{ownerUserId:string;threadId:string;after?:string|null}):Promise<DurableTurn[]>{
  return db.query<DurableTurn>(`select id,owner_user_id,thread_id,client_message_id,attempt_of,inbound_message_id,reply_to_message_id,attachment_ids,status,assistant_message_id,tool_receipts,error_code,error_retryable,created_at,updated_at from assistant_turns where owner_user_id=$1 and thread_id=$2 and ($3::timestamptz is null or updated_at>$3) order by created_at limit 200`,[args.ownerUserId,args.threadId,args.after??null]);
}
export async function claimDurableTurn(db:Db,turnId:string,leaseSeconds=300):Promise<(DurableTurn&{lease_token:string})|null>{
  const token=randomUUID();
  // An expired running lease is an ambiguous provider boundary: the old
  // process may have reached a model or tool immediately before dying. Never
  // replay it automatically. Terminally reconcile it as retryable and require
  // a new, explicitly linked attempt. This trades transparent replay for the
  // stronger no-duplicate-consequential-action guarantee.
  const [row]=await db.query<DurableTurn&{lease_token:string}>(`with target as (
    select owner_user_id,thread_id from assistant_turns where id=$1
  ), revoked as (
    update assistant_turns t set status='failed',error_code='session_expired',error_retryable=false,completed_at=now()
      where t.status='queued' and (t.owner_user_id,t.thread_id)=(select owner_user_id,thread_id from target)
        and not exists(select 1 from sessions s join users u on u.id=s.user_id where s.id=t.accepted_session_id and s.user_id=t.owner_user_id and s.revoked_at is null and s.expires_at>now() and u.status='active')
      returning id
  ), interrupted as (
    update assistant_turns set status='failed',lease_token=null,lease_expires_at=null,
      error_code='worker_interrupted',error_retryable=true,completed_at=now()
      where id=$1 and status='running' and lease_expires_at<now() returning id
  ) update assistant_turns t set status='running',lease_token=$2,lease_expires_at=now()+($3*interval '1 second'),started_at=coalesce(started_at,now()),error_code=null,error_retryable=null
    where t.id=$1 and t.status='queued' and not exists(select 1 from interrupted) and not exists(select 1 from revoked where id=t.id)
      and not exists(select 1 from assistant_turns x where x.thread_id=t.thread_id and x.id<>t.id and x.status='running' and x.lease_expires_at>=now())
      and not exists(select 1 from assistant_turns x where x.thread_id=t.thread_id and x.id<>t.id and x.status in ('queued','running') and (x.created_at,x.id)<(t.created_at,t.id)) returning t.*`,[turnId,token,leaseSeconds]);
  return row??null;
}
export async function renewDurableTurnLease(db:Db,args:{turnId:string;leaseToken:string;leaseSeconds?:number}):Promise<boolean>{
  const rows=await db.query(`update assistant_turns set lease_expires_at=now()+($3*interval '1 second') where id=$1 and status='running' and lease_token=$2 returning id`,[args.turnId,args.leaseToken,args.leaseSeconds??300]);
  return !!rows.length;
}
export async function completeDurableTurn(db:Db,args:{turnId:string;leaseToken:string;reply:string;toolReceipts:unknown[];replyMeta?:Record<string,unknown>;approvalNeeded?:boolean;presentedTaskIds?:string[]}):Promise<string|null>{
  const category=args.approvalNeeded?'approval':'assistant',body=args.approvalNeeded?'Your approval is needed.':'Your reply is ready.';
  const [row]=await db.query<{assistant_message_id:string}>(`with eligible as (select id,thread_id,owner_user_id from assistant_turns where id=$1 and status='running' and lease_token=$2 for update), message as (insert into messages(thread_id,direction,channel,body,meta) select thread_id,'out','native',$4,jsonb_build_object('turn_id',id)||$8 from eligible returning id,thread_id), linked as (update assistant_turns t set status='completed',completed_at=now(),lease_expires_at=null,tool_receipts=$3,assistant_message_id=m.id from message m where t.id=$1 and t.status='running' and t.lease_token=$2 returning t.assistant_message_id,t.owner_user_id,t.thread_id,t.id), presented as (update assistant_action_states a set presented_turn_id=l.assistant_message_id from linked l where a.owner_user_id=l.owner_user_id and a.thread_id=l.thread_id and a.task_id=any($7::uuid[]) and a.status in ('collecting','prepared')), notified as (insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) select l.owner_user_id,d.id,'turn:'||l.id,$5,'turn',l.id,'Josi',$6 from linked l join mobile_devices d on d.owner_user_id=l.owner_user_id and d.revoked_at is null and d.app_state<>'foreground' and coalesce((d.categories->>$5)::boolean,true) on conflict(device_id,event_key) do nothing) select assistant_message_id from linked`,[args.turnId,args.leaseToken,json(args.toolReceipts),args.reply,category,body,args.presentedTaskIds??[],json(args.replyMeta??{})]);
  return row?.assistant_message_id??null;
}
export async function failDurableTurn(db:Db,args:{turnId:string;leaseToken:string;code:string;retryable:boolean}):Promise<boolean>{
  const rows=await db.query(`update assistant_turns set status='failed',lease_expires_at=null,error_code=$3,error_retryable=$4,completed_at=now() where id=$1 and status='running' and lease_token=$2 returning id`,[args.turnId,args.leaseToken,args.code,args.retryable]);return !!rows.length;
}

export interface DeviceInput {deviceIdentity:string;platform:'ios'|'android';expoToken:string;appState:'foreground'|'background'|'inactive';privacyLocked:boolean;categories?:Record<string,boolean>;quietStart?:string|null;quietEnd?:string|null;timezone:string;}
export async function upsertMobileDevice(db:Db,key:MasterKey,ownerUserId:string,input:DeviceInput){
  if(!uuid.test(input.deviceIdentity))throw new MobileError('invalid_device','A stable, opaque installation UUID is required.');
  if(!['ios','android'].includes(input.platform))throw new MobileError('invalid_platform','Platform must be ios or android.');
  if(!['foreground','background','inactive'].includes(input.appState))throw new MobileError('invalid_app_state','Choose a valid app state.');
  if(!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(input.expoToken))throw new MobileError('invalid_expo_token','A valid Expo push token is required.');
  if((!!input.quietStart!==!!input.quietEnd)||(input.quietStart&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.quietStart))||(input.quietEnd&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.quietEnd)))throw new MobileError('invalid_quiet_hours','Quiet hours require both start and end in HH:MM.');
  try{new Intl.DateTimeFormat('en-US',{timeZone:input.timezone}).format();}catch{throw new MobileError('invalid_timezone','A valid IANA timezone is required.');}
  const supplied=input.categories??{};const categories=Object.fromEntries(['assistant','approval','reminder','calendar'].map(name=>[name,typeof supplied[name]==='boolean'?supplied[name]:true]));
  const fp=digest(input.expoToken);const enc=seal(key,{token:asSecret(input.expoToken)});
  // A token belongs to one current device/account binding. The data-modifying
  // CTE makes account switches and token moves atomic with registration.
  const [row]=await db.query<{id:string}>(`with revoked as (
    update mobile_devices set revoked_at=now() where (token_fingerprint=$5 or device_identity=$2) and revoked_at is null
      and not(owner_user_id=$1 and device_identity=$2) returning id
  ), cancelled as (
    update push_deliveries set status='suppressed',last_error_code='account_switched'
      where device_id in(select id from revoked) and status in('queued','retry','ticketed') returning id
  ), barrier as (select (select count(*) from revoked)+(select count(*) from cancelled) n)
  insert into mobile_devices(owner_user_id,device_identity,platform,expo_token_enc,token_fingerprint,app_state,privacy_locked,categories,quiet_start,quiet_end,timezone,revoked_at,last_seen_at)
  select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,null,now() from barrier
  on conflict(owner_user_id,device_identity) do update set platform=excluded.platform,expo_token_enc=excluded.expo_token_enc,token_fingerprint=excluded.token_fingerprint,app_state=excluded.app_state,privacy_locked=excluded.privacy_locked,categories=excluded.categories,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,timezone=excluded.timezone,revoked_at=null,last_seen_at=now() returning id`,[ownerUserId,input.deviceIdentity,input.platform,enc,fp,input.appState,input.privacyLocked,json(categories),input.quietStart??null,input.quietEnd??null,input.timezone]);return row;
}
export async function revokeMobileDevice(db:Db,ownerUserId:string,id:string){return !!(await db.query(`update mobile_devices set revoked_at=now() where id=$1 and owner_user_id=$2 and revoked_at is null returning id`,[id,ownerUserId])).length;}

export function localMinutes(now:Date,timeZone:string):number{const parts=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);return Number(parts.find(x=>x.type==='hour')!.value)*60+Number(parts.find(x=>x.type==='minute')!.value);}
export function quietNow(now:Date,timeZone:string,start:string|null,end:string|null):boolean{if(!start||!end||start===end)return false;const parse=(x:string)=>Number(x.slice(0,2))*60+Number(x.slice(3,5));const n=localMinutes(now,timeZone),s=parse(start),e=parse(end);return s<e?n>=s&&n<e:n>=s||n<e;}

export interface PushFetchResult{sent:number;ticketed:number;retried:number;suppressed:number;}
const EXPO_ERROR_CODES=new Set(['DeviceNotRegistered','MessageTooBig','MessageRateExceeded','MismatchSenderId','InvalidCredentials']);
function expoErrorCode(value:unknown,fallback:string):string{return typeof value==='string'&&EXPO_ERROR_CODES.has(value)?value:fallback;}
function safePushBody(category:unknown):string{return category==='approval'?'Your approval is needed.':category==='reminder'?'You have a reminder.':category==='calendar'?'You have a calendar reminder.':'Your reply is ready.';}
export async function processPushBatch(db:Db,key:MasterKey,fetchImpl:typeof fetch,now=new Date(),limit=50):Promise<PushFetchResult>{
  const lease=randomUUID();
  const rows=await db.query<any>(`update push_deliveries p set status='sending',lease_token=$3,attempts=attempts+1 from (select id from push_deliveries where ((status in ('queued','retry') and next_attempt_at<=$1) or (status='sending' and updated_at<$1-interval '10 minutes')) order by created_at for update skip locked limit $2) q where p.id=q.id returning p.*`,[now,Math.min(100,Math.max(1,limit)),lease]);
  let sent=0,ticketed=0,retried=0,suppressed=0;
  for(let i=0;i<rows.length;i+=100){const group=rows.slice(i,i+100);const deliverable=[] as any[];
    for(const p of group){const [d]=await db.query<any>(`select * from mobile_devices where id=$1 and owner_user_id=$2 and revoked_at is null`,[p.device_id,p.owner_user_id]);if(!d||d.app_state==='foreground'||(!p.explicit_reminder&&quietNow(now,d.timezone,d.quiet_start,d.quiet_end))){await db.query(`update push_deliveries set status='suppressed',lease_token=null,last_error_code=$3 where id=$1 and lease_token=$2`,[p.id,lease,!d?'device_unavailable':d.app_state==='foreground'?'foreground':'quiet_hours']);suppressed++;continue;}try{const token=openSealed<{token:string}>(key,d.expo_token_enc).token;await db.query(`update push_deliveries set sent_token_fingerprint=$3 where id=$1 and lease_token=$2`,[p.id,lease,d.token_fingerprint]);deliverable.push({p,d,fingerprint:d.token_fingerprint,msg:{to:token,sound:'default',title:'Josi',body:d.privacy_locked?'Open Josi to view this update.':safePushBody(p.category),data:{route:p.route_type,id:p.route_id}}});}catch{await retryPush(db,p.id,p.attempts,'token_unavailable',lease);retried++;}}
    if(!deliverable.length)continue;let response:Response;try{response=await fetchImpl('https://exp.host/--/api/v2/push/send',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','Accept-Encoding':'gzip, deflate'},body:JSON.stringify(deliverable.map(x=>x.msg))});sent+=deliverable.length;}catch{for(const {p} of deliverable){await retryPush(db,p.id,p.attempts,'network',lease);retried++;}continue;}if(response.status===429||response.status>=500){for(const {p} of deliverable){await retryPush(db,p.id,p.attempts,`http_${response.status}`,lease);retried++;}continue;}if(!response.ok){for(const {p} of deliverable)await db.query(`update push_deliveries set status='failed',lease_token=null,last_error_code=$3 where id=$1 and lease_token=$2`,[p.id,lease,`http_${response.status}`]);continue;}let payload:{data?:Array<{status:string;id?:string;details?:{error?:string}}>};try{payload=await response.json() as typeof payload;}catch{for(const {p} of deliverable){await retryPush(db,p.id,p.attempts,'invalid_response',lease);retried++;}continue;}for(let j=0;j<deliverable.length;j++){const {p,d,fingerprint}=deliverable[j],t=payload.data?.[j];if(t?.status==='ok'&&t.id){await db.query(`update push_deliveries set status='ticketed',lease_token=null,ticket_id=$3,next_attempt_at=now()+interval '15 minutes' where id=$1 and lease_token=$2`,[p.id,lease,t.id]);ticketed++;}else if(t?.details?.error==='DeviceNotRegistered'){await db.query(`update mobile_devices set revoked_at=now() where id=$1 and token_fingerprint=$2`,[d.id,fingerprint]);await db.query(`update push_deliveries set status='failed',lease_token=null,last_error_code='DeviceNotRegistered' where id=$1 and lease_token=$2`,[p.id,lease]);}else{await retryPush(db,p.id,p.attempts,expoErrorCode(t?.details?.error,'ticket_error'),lease);retried++;}}}
  return{sent,ticketed,retried,suppressed};
}
async function retryPush(db:Db,id:string,attempts:number,code:string,lease:string){const terminal=attempts>=5;await db.query(`update push_deliveries set status=$3,lease_token=null,next_attempt_at=now()+(least(3600,power(2,$4)*15)*interval '1 second'),last_error_code=$5 where id=$1 and lease_token=$2`,[id,lease,terminal?'failed':'retry',attempts,code]);}
async function retryReceipt(db:Db,row:any,code:string,lease:string){const terminal=row.receipt_attempts>=5;await db.query(`update push_deliveries set status=$3,lease_token=null,next_attempt_at=now()+(least(3600,power(2,$4)*30)*interval '1 second'),last_error_code=$5 where id=$1 and lease_token=$2`,[row.id,lease,terminal?'failed':'ticketed',row.receipt_attempts,code]);}
export async function processPushReceipts(db:Db,fetchImpl:typeof fetch,limit=100){const lease=randomUUID();const rows=await db.query<any>(`update push_deliveries p set status='checking',lease_token=$2,receipt_attempts=receipt_attempts+1 from (select id from push_deliveries where (status='ticketed' and next_attempt_at<=now()) or (status='checking' and updated_at<now()-interval '10 minutes') order by created_at for update skip locked limit $1) q where p.id=q.id returning p.*`,[Math.min(100,Math.max(1,limit)),lease]);if(!rows.length)return{checked:0,delivered:0};let response:Response;try{response=await fetchImpl('https://exp.host/--/api/v2/push/getReceipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:rows.map(r=>r.ticket_id)})});}catch{for(const row of rows)await retryReceipt(db,row,'receipt_network',lease);return{checked:rows.length,delivered:0};}if(!response.ok){for(const row of rows)await retryReceipt(db,row,`receipt_http_${response.status}`,lease);return{checked:rows.length,delivered:0};}let data:any;try{data=((await response.json()) as any).data??{};}catch{for(const row of rows)await retryReceipt(db,row,'invalid_receipt_response',lease);return{checked:rows.length,delivered:0};}let delivered=0;for(const row of rows){const receipt=data[row.ticket_id];if(!receipt){await retryReceipt(db,row,'receipt_pending',lease);continue;}if(receipt.status==='ok'){const changed=await db.query(`update push_deliveries set status='delivered',lease_token=null,receipt_checked_at=now() where id=$1 and lease_token=$2 returning id`,[row.id,lease]);if(changed.length)delivered++;}else if(receipt.details?.error==='DeviceNotRegistered'){await db.query(`update mobile_devices set revoked_at=now() where id=$1 and token_fingerprint=$2`,[row.device_id,row.sent_token_fingerprint]);await db.query(`update push_deliveries set status='failed',lease_token=null,last_error_code='DeviceNotRegistered',receipt_checked_at=now() where id=$1 and lease_token=$2`,[row.id,lease]);}else await db.query(`update push_deliveries set status='failed',lease_token=null,last_error_code=$3,receipt_checked_at=now() where id=$1 and lease_token=$2`,[row.id,lease,expoErrorCode(receipt.details?.error,'receipt_error')]);}return{checked:rows.length,delivered};}
