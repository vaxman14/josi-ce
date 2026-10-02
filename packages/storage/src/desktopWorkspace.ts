import { randomUUID } from 'node:crypto';
import { appendEvent, type Db } from '@josi-ce/core';
import { looksLikeCredentialFile } from './extract.js';
import { workspacePath, type WorkspaceChange } from './localWorkspace.js';
import { PathEscape } from './paths.js';

export interface DesktopWorkspaceMapping {
  id:string; owner_user_id:string; client_id:string; root_id:string; label:string;
  writable:boolean; status:string; last_seen_at:string;
}

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const ACTIVE_SECONDS=15;
const REQUEST_SECONDS=35;

export async function desktopWorkspaceMapping(db:Db,userId:string,id:string):Promise<DesktopWorkspaceMapping|null>{
  const [mapping]=await db.query<DesktopWorkspaceMapping>(`select id,owner_user_id,client_id,root_id,label,writable,status,last_seen_at
    from desktop_workspace_mappings where id=$1 and owner_user_id=$2 and status='active'`,[id,userId]);
  return mapping??null;
}

export async function activeDesktopWorkspaceMappings(db:Db,userId:string){
  return db.query<DesktopWorkspaceMapping>(`select id,owner_user_id,client_id,root_id,label,writable,status,last_seen_at
    from desktop_workspace_mappings where owner_user_id=$1 and status='active'
      and last_seen_at > now()-($2::text||' seconds')::interval order by label,id`,[userId,ACTIVE_SECONDS]);
}

function validatePayload(operation:string,payload:Record<string,unknown>){
  const path=workspacePath(String(payload.path??''));
  if(operation==='read'&&!path)throw new PathEscape('Choose a file');
  if(operation==='list')return {path};
  if(operation==='read')return {path};
  if(!['create','edit','mkdir','move','delete'].includes(operation))throw new PathEscape('Unsupported desktop workspace operation');
  if(!path)throw new PathEscape('Choose a file or folder');
  const destination=payload.destination===undefined?undefined:workspacePath(String(payload.destination));
  if(operation==='move'&&!destination)throw new PathEscape('Choose a destination');
  const content=operation==='create'||operation==='edit'?String(payload.content??''):undefined;
  if(content!==undefined&&(Buffer.byteLength(content)>256*1024||content.includes('\0')||looksLikeCredentialFile(path,content)))throw new PathEscape('Only non-secret text up to 256 KiB can be written');
  return {path,...(destination?{destination}:{}),...(content!==undefined?{content}:{})};
}

export async function requestDesktopWorkspace(db:Db,userId:string,mappingId:string,operation:string,payload:Record<string,unknown>){
  const mapping=await desktopWorkspaceMapping(db,userId,mappingId);
  if(!mapping||Date.now()-new Date(mapping.last_seen_at).getTime()>ACTIVE_SECONDS*1000)throw new PathEscape('Desktop workspace is offline. Keep Josi CE open on that device.');
  if(!mapping.writable&&['create','edit','mkdir','move','delete'].includes(operation))throw new PathEscape('This desktop workspace is read-only');
  const safe=validatePayload(operation,payload);const id=randomUUID();
  await db.query(`insert into desktop_workspace_requests(id,owner_user_id,mapping_id,operation,payload,expires_at)
    values($1,$2,$3,$4,$5,now()+($6::text||' seconds')::interval)`,[id,userId,mappingId,operation,JSON.stringify(safe),REQUEST_SECONDS]);
  await appendEvent(db,{actor:'user',actorUserId:userId,kind:'desktop_workspace.requested',subjectType:'desktop_workspace_mapping',subjectId:mappingId,payload:{requestId:id,operation}});
  const deadline=Date.now()+REQUEST_SECONDS*1000;
  while(Date.now()<deadline){
    const [request]=await db.query<{status:string;response:unknown;error:string|null}>(`select status,response,error from desktop_workspace_requests where id=$1 and owner_user_id=$2`,[id,userId]);
    if(!request)throw new PathEscape('Desktop workspace request disappeared');
    if(request.status==='completed')return request.response;
    if(request.status==='failed')throw new PathEscape(request.error||'Desktop workspace refused the request');
    if(['expired','cancelled'].includes(request.status))throw new PathEscape('Desktop workspace request expired');
    await delay(250);
  }
  await db.query(`update desktop_workspace_requests set status='expired' where id=$1 and status in ('queued','claimed')`,[id]);
  throw new PathEscape('Desktop workspace did not respond. Keep Josi CE open on that device.');
}

export async function desktopWorkspaceList(db:Db,userId:string,mappingId:string,path=''){
  return requestDesktopWorkspace(db,userId,mappingId,'list',{path});
}
export async function desktopWorkspaceRead(db:Db,userId:string,mappingId:string,path:string){
  return requestDesktopWorkspace(db,userId,mappingId,'read',{path});
}
export async function desktopWorkspaceChange(db:Db,userId:string,mappingId:string,input:WorkspaceChange){
  return requestDesktopWorkspace(db,userId,mappingId,input.operation,input as unknown as Record<string,unknown>);
}
