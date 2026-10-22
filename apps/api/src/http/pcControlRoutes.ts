import { Router, type Request, type Response } from 'express';
import { verifyPassword } from '@josi-ce/auth';
import { disablePcControl, loadMasterKey, PcControl, PcControlError, LOCAL_WINDOWS_PC, type Db, type LoadOptions, type PcPolicy, type PcBrowserPresence } from '@josi-ce/core';
import { requireSuperAdmin } from './authz.js';
import { asyncRoute, param } from './async.js';

interface Ctx { db:Db; windows:boolean; masterKey?:LoadOptions|false }
// This is the hosting PC only. A future paired desktop gets an independently
// authenticated device identity and its own consent; browser input cannot pick
// another PC or owner. No execution/proposal endpoint is exposed to the browser.
const PC=LOCAL_WINDOWS_PC;
const EXECUTOR_WAIT=60_000;
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
  r.get('/',handle(async(req,res)=>{
    const browser=await control().presence(req.user!.id);
    return res.json({...await control().snapshot(req.user!.id),executorAvailable:!!browser,browser,
      availability:browser?'The Josi app on this PC is connected'+(browser.origin?' with a '+browser.family+' tab attached ('+browser.origin+').':'. No browser tab is attached.')
        :'Permissions can be saved here. Browser control starts when the Josi app is open and a tab is attached with the Josi browser extension.',
      uac:'Windows UAC always requires its own approval. Josi cannot approve future prompts.'});
  }));
  r.put('/enabled',handle(async(req,res)=>{await control().setEnabled(req.user!.id,req.body?.enabled);return res.json({ok:true});}));
  r.post('/stop',handle(async(req,res)=>{
    if(service)await service.stop(req.user!.id);else await disablePcControl(ctx.db,req.user!.id,PC);
    return res.json({ok:true,enabled:false,note:'Control disabled and temporary/task access revoked. Already completed changes cannot be undone.'});
  }));
  // Turning full control ON is a standing grant for everyday actions, so it
  // takes the account password once; turning it off never does.
  r.put('/full-control',handle(async(req,res)=>{
    if(typeof req.body?.enabled!=='boolean')throw new PcControlError(400,'Choose on or off.');
    if(req.body.enabled){
      const [u]=await ctx.db.query<{password_hash:string|null}>(`select password_hash from users where id=$1`,[req.user!.id]);
      if(!await verifyPassword(u?.password_hash??null,typeof req.body?.password==='string'?req.body.password:''))throw new PcControlError(401,'Confirm your account password to turn on full control.');
    }
    await control().setFullControl(req.user!.id,req.body.enabled);
    return res.json({ok:true,fullControl:req.body.enabled});
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
  // The Windows app is the executor. It reports its attached browser, claims
  // approved work one request at a time and reports what happened. A claim
  // goes through execute(), so every policy check runs again at that moment.
  const running=new Map<string,(ok:boolean,result:unknown)=>Promise<void>>();
  r.put('/executor/presence',handle(async(req,res)=>{
    await control().setPresence(req.user!.id,req.body?.connected===true?req.body.browser as PcBrowserPresence:null);
    return res.json({ok:true});
  }));
  r.post('/executor/next',handle(async(req,res)=>{
    const owner=req.user!.id,service=control();
    for(const {id,plan} of await service.approved(owner)){
      if(running.has(id))continue;
      let claimed!:()=>void;const started=new Promise<boolean>(resolve=>{claimed=()=>resolve(true);});
      const done=service.execute(owner,id,plan,(_plan,signal)=>new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{running.delete(id);void service.saveResult(owner,id,{ok:false,code:'executor_timeout'}).finally(()=>reject(new Error('timeout')));},EXECUTOR_WAIT);
        signal.addEventListener('abort',()=>{clearTimeout(timer);running.delete(id);reject(new Error('stopped'));},{once:true});
        running.set(id,async(ok,result)=>{
          clearTimeout(timer);running.delete(id);
          await service.saveResult(owner,id,{ok,result});
          if(ok)resolve();else reject(new Error('failed'));
        });
        claimed();
      }));
      done.catch(()=>undefined);
      if(await Promise.race([started,done.then(()=>false,()=>false)]))
        return res.json({request:{id,description:plan.description,requirements:plan.requirements,payload:plan.payload}});
    }
    return res.json({request:null});
  }));
  r.post('/executor/:id/result',handle(async(req,res)=>{
    const finish=running.get(param(req,'id'));
    if(!finish)throw new PcControlError(404,'This request is not running.');
    if(typeof req.body?.ok!=='boolean')throw new PcControlError(400,'Report success or failure.');
    await finish(req.body.ok,req.body.result??null);
    return res.json({ok:true});
  }));
  return r;
}
