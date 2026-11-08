import { Router, type Request, type Response } from 'express';
import { verifyPassword, checkLoginRate, recordLoginAttempt } from '@josi-ce/auth';
import { ComputerControl, ComputerControlError, loadMasterKey, type Db, type LoadOptions } from '@josi-ce/core';
import { requireSuperAdmin } from './authz.js';
import { asyncRoute, param } from './async.js';
import { clientIp } from './cookies.js';

/** Additive routes and storage preserve existing contract interpretations. */
export function computerControlRoutes(ctx:{db:Db;masterKey?:LoadOptions|false}):Router {
  const r=Router();r.use(requireSuperAdmin);r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const service=()=>{
    if(ctx.masterKey===false)throw new ComputerControlError(503,'Encrypted control storage is unavailable.');
    return new ComputerControl(ctx.db,loadMasterKey(ctx.masterKey??{}));
  };
  const route=(fn:(req:Request,res:Response)=>Promise<unknown>)=>asyncRoute(async(req,res)=>{
    try{return await fn(req,res);}catch(e){return res.status(e instanceof ComputerControlError?e.status:503).json({error:e instanceof ComputerControlError?e.message:'Computer control is unavailable. No action was authorized.'});}
  });
  async function password(req:Request){
    const ip=clientIp(req),identifier='computer-control:'+req.user!.id;
    if((await checkLoginRate(ctx.db,identifier,ip)).blocked)throw new ComputerControlError(429,'Too many incorrect passwords. Wait before trying again.');
    const [u]=await ctx.db.query<{password_hash:string|null}>('select password_hash from users where id=$1',[req.user!.id]);
    const matched=await verifyPassword(u?.password_hash??null,typeof req.body?.password==='string'?req.body.password:'');
    await recordLoginAttempt(ctx.db,{identifier,ip,success:matched});
    if(!matched)throw new ComputerControlError(401,'Confirm your account password in the protected form.');
  }
  r.get('/',route(async(req,res)=>res.json(await service().snapshot(req.user!.id))));
  r.post('/enroll',route(async(req,res)=>{await password(req);return res.json(await service().enroll(req.user!.id,req.body.proof));}));
  r.post('/proposals/:id/decision',route(async(req,res)=>{
    if(typeof req.body?.approve!=='boolean')throw new ComputerControlError(400,'Choose approve or deny.');
    if(req.body.approve)await password(req);
    return res.json(await service().decide(req.user!.id,param(req,'id'),String(req.body.digest??''),req.body.approve));
  }));
  r.post('/devices/:id/stop',route(async(req,res)=>res.json(await service().stop(req.user!.id,param(req,'id')))));
  r.delete('/devices/:id',route(async(req,res)=>res.json(await service().stop(req.user!.id,param(req,'id'),true))));
  r.post('/device/:method',route(async(req,res)=>res.json(await service().deviceCall(req.user!.id,param(req,'method'),req.body.proof))));
  return r;
}
