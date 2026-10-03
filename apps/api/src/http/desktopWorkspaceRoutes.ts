import { Router } from 'express';
import { appendEvent, type Db } from '@josi-ce/core';
import { requireAuth } from './authz.js';
import { asyncRoute, param } from './async.js';

const ID=/^[A-Za-z0-9_-]{16,200}$/;
function text(value:unknown,max=200){const result=String(value??'').trim();if(!result||result.length>max)throw new Error('Invalid desktop workspace value');return result;}

/** Keep the value that will be written to PostgreSQL as structured JSON.
 *
 * JSON.stringify is used only to enforce the byte limit. Passing that string
 * to a jsonb parameter stores a JSON string, so the browser receives text
 * instead of `{ entries, permissions }` and crashes when it renders a folder.
 */
export function prepareDesktopWorkspaceResult(value:unknown){
 const result=value??null;
 return {result,bytes:Buffer.byteLength(JSON.stringify(result))};
}

export function desktopWorkspaceRoutes({db}:{db:Db}){
 const r=Router();r.use(requireAuth);
 r.get('/mappings',asyncRoute(async(req,res)=>{
  const mappings=await db.query(`select id,client_id,root_id,label,writable,status,last_seen_at,created_at
    from desktop_workspace_mappings where owner_user_id=$1 and session_id=$2 and status='active' order by label,id`,[req.user!.id,req.user!.session_id]);
  res.set('Cache-Control','no-store').json({mappings});
 }));
 r.post('/mappings',asyncRoute(async(req,res)=>{
  const clientId=text(req.body.clientId),rootId=text(req.body.rootId),label=text(req.body.label);
  if(!ID.test(clientId)||!ID.test(rootId))return void res.status(400).json({error:'Invalid desktop workspace identity'});
  const writable=req.body.writable===true;
  const [existing]=await db.query<{label:string;writable:boolean;status:string}>(`select label,writable,status from desktop_workspace_mappings
    where owner_user_id=$1 and client_id=$2 and root_id=$3`,[req.user!.id,clientId,rootId]);
  const [mapping]=await db.query<{id:string;client_id:string;root_id:string;label:string;writable:boolean;status:string;last_seen_at:string}>(`insert into desktop_workspace_mappings(owner_user_id,client_id,root_id,label,writable,session_id)
    values($1,$2,$3,$4,$5,$6) on conflict(owner_user_id,client_id,root_id) do update set label=excluded.label,writable=excluded.writable,session_id=excluded.session_id,status='active',last_seen_at=now(),updated_at=now()
    returning id,client_id,root_id,label,writable,status,last_seen_at`,[req.user!.id,clientId,rootId,label,writable,req.user!.session_id]);
  if(!existing||existing.label!==label||existing.writable!==writable||existing.status!=='active'){
   await appendEvent(db,{actor:'user',actorUserId:req.user!.id,kind:'desktop_workspace.connected',subjectType:'desktop_workspace_mapping',subjectId:mapping.id,payload:{writable}});
  }
  res.status(201).json({mapping});
 }));
 r.post('/heartbeat',asyncRoute(async(req,res)=>{
  const clientId=text(req.body.clientId);if(!ID.test(clientId))return void res.status(400).json({error:'Invalid desktop workspace identity'});
  const rootIds=Array.isArray(req.body.rootIds)?[...new Set<string>(req.body.rootIds.map((value:unknown)=>String(value)))]:null;
  if(rootIds&&!rootIds.every(rootId=>ID.test(rootId)))return void res.status(400).json({error:'Invalid desktop workspace identity'});
  if(rootIds){
   await db.query(`update desktop_workspace_mappings set last_seen_at=now(),updated_at=now()
     where owner_user_id=$1 and session_id=$2 and client_id=$3 and status='active' and root_id=any($4::text[])`,[req.user!.id,req.user!.session_id,clientId,rootIds]);
   const revoked=await db.query<{id:string}>(`update desktop_workspace_mappings set status='revoked',updated_at=now()
     where owner_user_id=$1 and session_id=$2 and client_id=$3 and status='active' and not(root_id=any($4::text[])) returning id`,[req.user!.id,req.user!.session_id,clientId,rootIds]);
   for(const mapping of revoked){
    await db.query(`update desktop_workspace_requests set status='cancelled' where mapping_id=$1 and status in ('queued','claimed')`,[mapping.id]);
    await appendEvent(db,{actor:'user',actorUserId:req.user!.id,kind:'desktop_workspace.revoked',subjectType:'desktop_workspace_mapping',subjectId:mapping.id,payload:{}});
   }
  }else{
   // Compatibility for an older already-installed desktop renderer.
   await db.query(`update desktop_workspace_mappings set last_seen_at=now(),updated_at=now() where owner_user_id=$1 and session_id=$2 and client_id=$3 and status='active'`,[req.user!.id,req.user!.session_id,clientId]);
  }
  res.json({ok:true});
 }));
 r.delete('/mappings/:id',asyncRoute(async(req,res)=>{
  const id=param(req,'id');const rows=await db.query(`update desktop_workspace_mappings set status='revoked',updated_at=now() where id=$1 and owner_user_id=$2 and session_id=$3 and status='active' returning id`,[id,req.user!.id,req.user!.session_id]);
  if(!rows.length)return void res.status(404).json({error:'not found'});
  await db.query(`update desktop_workspace_requests set status='cancelled' where mapping_id=$1 and status in ('queued','claimed')`,[id]);
  await appendEvent(db,{actor:'user',actorUserId:req.user!.id,kind:'desktop_workspace.revoked',subjectType:'desktop_workspace_mapping',subjectId:id,payload:{}});res.status(204).send();
 }));
 r.get('/requests',asyncRoute(async(req,res)=>{
  const clientId=text(req.query.clientId);if(!ID.test(clientId))return void res.status(400).json({error:'Invalid desktop workspace identity'});
  await db.query(`update desktop_workspace_requests set status='expired' where owner_user_id=$1 and expires_at<=now() and status in ('queued','claimed')`,[req.user!.id]);
  const [request]=await db.query(`with candidate as (
      select q.id from desktop_workspace_requests q join desktop_workspace_mappings m on m.id=q.mapping_id
      where q.owner_user_id=$1 and m.owner_user_id=$1 and m.client_id=$2 and m.session_id=$3 and m.status='active'
        and q.expires_at>now() and (q.status='queued' or (q.status='claimed' and q.claimed_at<now()-interval '10 seconds'))
      order by q.created_at for update of q skip locked limit 1)
    update desktop_workspace_requests q set status='claimed',claimed_at=now() from candidate where q.id=candidate.id
    returning q.id,q.mapping_id,(select root_id from desktop_workspace_mappings where id=q.mapping_id) as root_id,q.operation,q.payload,q.expires_at`,[req.user!.id,clientId,req.user!.session_id]);
  res.set('Cache-Control','no-store').json({request:request??null});
 }));
 r.post('/requests/:id/result',asyncRoute(async(req,res)=>{
  const clientId=text(req.body.clientId);if(!ID.test(clientId))return void res.status(400).json({error:'Invalid desktop workspace identity'});
  const prepared=prepareDesktopWorkspaceResult(req.body.result);if(prepared.bytes>900*1024)return void res.status(413).json({error:'Desktop workspace result is too large'});
  const ok=req.body.ok===true,error=ok?null:String(req.body.error??'Desktop workspace operation failed').slice(0,500);
  const rows=await db.query<{id:string;mapping_id:string;operation:string}>(`update desktop_workspace_requests q set status=$5,response=$6,error=$7,completed_at=now()
    from desktop_workspace_mappings m where q.id=$1 and q.mapping_id=m.id and q.owner_user_id=$2 and m.owner_user_id=$2 and m.client_id=$3 and m.session_id=$4 and q.status='claimed' and q.expires_at>now()
    returning q.id,q.mapping_id,q.operation`,[param(req,'id'),req.user!.id,clientId,req.user!.session_id,ok?'completed':'failed',ok?prepared.result:null,error]);
  if(!rows.length)return void res.status(404).json({error:'Request is no longer active'});
  const completed=rows[0];await appendEvent(db,{actor:'user',actorUserId:req.user!.id,kind:ok?'desktop_workspace.completed':'desktop_workspace.failed',subjectType:'desktop_workspace_mapping',subjectId:completed.mapping_id,payload:{requestId:completed.id,operation:completed.operation}});
  res.json({ok:true});
 }));
 return r;
}
