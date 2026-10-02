import { Router } from 'express';
import { appendEvent, decideApproval, type Db } from '@josi-ce/core';
import { proposeCodingRun, getCodingRun, startCodingRun, codingRunStatus, workspaceList, workspaceRead, workspaceChange, desktopWorkspaceMapping, desktopWorkspaceList, desktopWorkspaceRead, desktopWorkspaceChange, PathEscape, type WorkspaceChange } from '@josi-ce/storage';
import { requireAuth, requireSuperAdmin } from './authz.js';
import { asyncRoute, param } from './async.js';
export function localWorkspaceRoutes({db}:{db:Db}) {
 const r=Router(); r.use(requireAuth);
 const wrap=(fn:Parameters<typeof asyncRoute>[0])=>asyncRoute(async(req,res)=>{try {await fn(req,res);} catch(e){
  const code=(e as NodeJS.ErrnoException).code;
  res.status(e instanceof PathEscape?403:code==='ENOENT'?404:code==='EEXIST'?409:code==='ENOSPC'?507:400).json({error:e instanceof PathEscape?e.message:code==='EEXIST'?'A file already exists at that destination':code==='ENOENT'?'File or folder no longer exists':code==='ENOSPC'?'Storage is full':code==='EROFS'?'Workspace storage is read-only':'Workspace operation failed. Check access and storage permissions.'});
 }});
 r.get('/:id/list',wrap(async(req,res)=>{const id=param(req,'id'),desktop=await desktopWorkspaceMapping(db,req.user!.id,id);res.set('Cache-Control','no-store').json(desktop?await desktopWorkspaceList(db,req.user!.id,id,String(req.query.path??'')):await workspaceList(db,req.user!.id,id,String(req.query.path??'')));}));
 r.get('/:id/file',wrap(async(req,res)=>{const id=param(req,'id'),desktop=await desktopWorkspaceMapping(db,req.user!.id,id);if(desktop){const file=await desktopWorkspaceRead(db,req.user!.id,id,String(req.query.path??'')) as {text?:string};const data=Buffer.from(String(file.text??''),'utf8');return void res.set({'Cache-Control':'no-store','Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Content-Disposition':"attachment; filename*=UTF-8''workspace.txt"}).send(data);}
  const file=await workspaceRead(db,req.user!.id,id,String(req.query.path??''));
  res.set({'Cache-Control':'no-store','Content-Type':'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`}).send(file.data);
 }));
 r.get('/:id/preview',wrap(async(req,res)=>{const id=param(req,'id'),desktop=await desktopWorkspaceMapping(db,req.user!.id,id);if(desktop){const file=await desktopWorkspaceRead(db,req.user!.id,id,String(req.query.path??'')) as {text?:string;size?:number;modified?:string};return void res.set('Cache-Control','no-store').json({name:String(req.query.path??'').split('/').pop(),size:file.size,modified:file.modified,text:String(file.text??'').slice(0,50000),truncated:Number(file.size??0)>50000});}const file=await workspaceRead(db,req.user!.id,id,String(req.query.path??''));
  if(!/\.(txt|md|csv|json|log)$/i.test(file.name)||file.data.includes(0))throw new PathEscape('Preview supports plain text, Markdown, CSV, JSON and logs');
  res.set('Cache-Control','no-store').json({name:file.name,size:file.size,modified:file.modified,text:file.data.toString('utf8').slice(0,50000),truncated:file.size>50000});
 }));
 r.post('/:id/change',wrap(async(req,res)=>{const id=param(req,'id'),desktop=await desktopWorkspaceMapping(db,req.user!.id,id);res.json(desktop?await desktopWorkspaceChange(db,req.user!.id,id,req.body as WorkspaceChange):await workspaceChange(db,req.user!.id,id,req.body as WorkspaceChange));}));
 r.post('/:id/change/:approvalId',wrap(async(req,res)=>{
  if(req.body?.confirm!==true)throw new PathEscape('Confirm this exact operation to continue');
  await decideApproval(db,{approvalId:param(req,'approvalId'),decidedBy:req.user!.id,approve:true});
  res.json(await workspaceChange(db,req.user!.id,param(req,'id'),req.body as WorkspaceChange,param(req,'approvalId')));
 }));
 r.put('/admin/coding/:userId',requireSuperAdmin,wrap(async(req,res)=>{
  if(typeof req.body.enabled!=='boolean')throw new PathEscape('Choose enabled or disabled');
  await db.query('insert into storage_capabilities(user_id,coding_enabled) values($1,$2) on conflict(user_id) do update set coding_enabled=excluded.coding_enabled',[param(req,'userId'),req.body.enabled]);
  await appendEvent(db,{actor:'super_admin',actorUserId:req.user!.id,kind:'workspace.coding_permission_changed',payload:{userId:param(req,'userId'),enabled:req.body.enabled}});res.json({enabled:req.body.enabled});
 }));
 r.post('/:id/code',wrap(async(req,res)=>{res.json(await proposeCodingRun(db,req.user!.id,param(req,'id'),req.body.mode,req.body.source));}));
 r.get('/code/:runId',wrap(async(req,res)=>{res.set('Cache-Control','no-store').json(await codingRunStatus(db,req.user!.id,param(req,'runId')));}));
 r.get('/code/:runId/review',wrap(async(req,res)=>{const run=await getCodingRun(db,req.user!.id,param(req,'runId'));res.set('Cache-Control','no-store').json({id:run.id,mode:run.mode,source:run.source,status:run.status});}));
 r.post('/code/:runId/start',wrap(async(req,res)=>{
  if(req.body.confirm!==true)throw new PathEscape('Confirm the exact code after reviewing it');
  const run=await getCodingRun(db,req.user!.id,param(req,'runId'));
  await decideApproval(db,{approvalId:run.approval_id,decidedBy:req.user!.id,approve:true});res.json(await startCodingRun(db,req.user!.id,run.id));
 }));
 r.post('/code/:runId/cancel',wrap(async(req,res)=>{res.json(await codingRunStatus(db,req.user!.id,param(req,'runId'),true));}));
 return r;
}
