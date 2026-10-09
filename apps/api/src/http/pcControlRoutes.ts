import { Router, type Request, type Response } from 'express';
import { verifyPassword } from '@josi-ce/auth';
import { disablePcControl, loadMasterKey, PcControl, PcControlError, type Db, type LoadOptions, type PcPolicy } from '@josi-ce/core';
import { requireSuperAdmin } from './authz.js';
import { asyncRoute, param } from './async.js';

interface Ctx { db:Db; windows:boolean; masterKey?:LoadOptions|false }
// This is the hosting PC only. A future paired desktop gets an independently
// authenticated device identity and its own consent; browser input cannot pick
// another PC or owner. No execution/proposal endpoint is exposed to the browser.
const PC='local-windows-host';
export function pcControlRoutes(ctx:Ctx):Router {
  const r=Router();let service:PcControl|undefined;
  r.use(requireSuperAdmin);
  r.use((_req,res,next)=>{res.set('Cache-Control','no-store');if(!ctx.windows){res.status(404).json({error:'PC control permissions are available on the native Windows host.'});return;}next();});
  function control(){
    if(service)return service;
    if(ctx.masterKey===false)throw new PcControlError(503,'Encrypted permission storage is unavailable.');
    try{service=new PcControl(ctx.db,loadMasterKey(ctx.masterKey??{}),PC);return service;}
    catch{throw new PcControlError(503,'Encrypted permission storage is unavailable.');}
  }
  const handle=(fn:(req:Request,res:Response)=>Promise<unknown>)=>asyncRoute(async(req,res)=>{
    try{return await fn(req,res);}catch(error){
      if(error instanceof PcControlError)return res.status(error.status).json({error:error.message});
      // No plaintext scope/payload/credential or raw database exception in logs.
      return res.status(503).json({error:'PC permission storage is unavailable. No PC action was started.'});
    }
  });
  r.get('/',handle(async(req,res)=>res.json({...await control().snapshot(req.user!.id),executorAvailable:false,
    availability:'Permissions can be saved here. PC control is unavailable until the separate Windows desktop client is connected.',uac:'Windows UAC always requires its own approval. Josi cannot approve future prompts.'})));
  r.put('/enabled',handle(async(req,res)=>{await control().setEnabled(req.user!.id,req.body?.enabled);return res.json({ok:true});}));
  r.post('/stop',handle(async(req,res)=>{
    if(service)await service.stop(req.user!.id);else await disablePcControl(ctx.db,req.user!.id,PC);
    return res.json({ok:true,enabled:false,note:'Control disabled and temporary/task access revoked. Already completed changes cannot be undone.'});
  }));
  r.put('/policies',handle(async(req,res)=>res.json(await control().savePolicy(req.user!.id,req.body as PcPolicy))));
  r.delete('/policies/:id',handle(async(req,res)=>{await control().revoke(req.user!.id,param(req,'id'));return res.json({ok:true});}));
  r.post('/requests/:id/decision',handle(async(req,res)=>{
    if(typeof req.body?.approve!=='boolean')throw new PcControlError(400,'Choose approve or deny.');
    if(req.body.approve){
      const snapshot=await control().snapshot(req.user!.id),request=snapshot.requests.find(q=>q.id===param(req,'id'));
      if(!request)throw new PcControlError(404,'Active request not found.');
      if(request.highRisk){
        const [u]=await ctx.db.query<{password_hash:string|null}>(`select password_hash from users where id=$1`,[req.user!.id]);
        if(!await verifyPassword(u?.password_hash??null,typeof req.body?.password==='string'?req.body.password:''))throw new PcControlError(401,'Confirm your account password to approve this high-risk action.');
      }
    }
    await control().decide(req.user!.id,param(req,'id'),req.body.approve);return res.json({ok:true});
  }));
  return r;
}
