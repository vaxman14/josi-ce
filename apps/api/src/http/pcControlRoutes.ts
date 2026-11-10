import { Router, type Request, type Response } from 'express';
import { verifyPassword, checkLoginRate, recordLoginAttempt } from '@josi-ce/auth';
import { verifyPcExecutor } from './pcExecutorIdentity.js';
import { clientIp } from './cookies.js';
import { type LiveSignInBroker } from '@josi-ce/core';
import { pairLocalExecutor, localExecutorPaired, revokeExecutorSessions } from './pcLocalPairing.js';
import { disablePcControl, localExecutorSpool, readLocalExecutors, syncLocalExecutors, loadMasterKey, PcControl, PcControlError, pcActionIsHighRisk, pcIdFrom, type Db, type LoadOptions, type PcPolicy, type PcPreset, type PcBrowserPresence } from '@josi-ce/core';
import { pcControlReadiness } from '@josi-ce/agent';
import { requireSuperAdmin } from './authz.js';
import { asyncRoute, param } from './async.js';

interface Ctx { db:Db; windows?:boolean; masterKey?:LoadOptions|false; live?:LiveSignInBroker }
// Item 36: each Josi app names its PC in the x-josi-pc header (win-<id>); an
// app without one is the hosting PC of the single-PC form. Permissions,
// requests and presence are kept per PC. No execution/proposal endpoint is
// exposed to the browser.
const EXECUTOR_WAIT=60_000, EXECUTOR_WAIT_MAX=660_000;
export function pcControlRoutes(ctx:Ctx):Router {
  const r=Router();const services=new Map<string,PcControl>();
  r.use(requireSuperAdmin);
  r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  function targetPc(req:Request){
    if(req.query.ownerId!==undefined&&req.query.ownerId!==req.user!.id)throw new PcControlError(403,'This PC permission change belongs to another account.');
    if(req.query.pcId===undefined){
      // A browser names no PC. On a Linux server the PC it means is the
      // server's own PC service, not the Windows hosting-PC placeholder.
      const header=req.get('x-josi-pc');
      if(!header){const local=readLocalExecutors();if(local.length===1)return local[0].pcId;}
      return pcIdFrom(header);
    }
    if(req.path.startsWith('/executor')||typeof req.query.pcId!=='string'||!/^[a-z0-9-]{1,80}$/.test(req.query.pcId))
      throw new PcControlError(400,'Choose a valid target PC.');
    return req.query.pcId;
  }
  function revision(req:Request){
    const value=req.query.revision;
    if(value===undefined)return undefined;
    if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new PcControlError(400,'Invalid PC permission revision.');
    return Number(value);
  }
  function control(req:Request){
    const pcId=targetPc(req);
    const known=services.get(pcId);if(known)return known;
    if(ctx.masterKey===false)throw new PcControlError(503,'Encrypted permission storage is unavailable.');
    try{const service=new PcControl(ctx.db,loadMasterKey(ctx.masterKey??{}),pcId);services.set(pcId,service);return service;}
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
    const browser=await control(req).presence(req.user!.id),linux=control(req).pcId.startsWith('linux-');
    if(linux)return res.json({...await control(req).snapshot(req.user!.id),pcId:control(req).pcId,executorAvailable:!!browser,browser,
      availability:browser?'The PC service on this Linux server is connected and working as its chosen Linux user.':'Permissions can be saved here. Josi works on this server once its PC service is paired (ask Josi to control this server) and running.',
      uac:'Administrator commands are not available on a Linux server.'});
    return res.json({...await control(req).snapshot(req.user!.id),pcId:control(req).pcId,executorAvailable:!!browser,browser,
      availability:browser?'The Josi app on this PC is connected'+(browser.origin?' with a '+browser.family+' browser in use ('+browser.origin+').':browser.family==='desktop'?'. No browser is linked.':', and its '+browser.family+' browser is linked.')
        :'Permissions can be saved here. Browser control starts when the Josi app is open and the Josi browser extension is installed.',
      uac:'Windows UAC always requires its own approval. Josi cannot approve future prompts.'});
  }));
  // The app makes its PC known as soon as the owner signs in, before pairing
  // and before control is on, so chat can list it and offer to turn it on.
  r.put('/register',handle(async(req,res)=>{await control(req).register(req.user!.id);return res.json({ok:true,pcId:control(req).pcId});}));
  r.get('/readiness',handle(async(req,res)=>res.json(await pcControlReadiness(ctx.db,req.user!.id,req.query.pcId===undefined?control(req).pcId:targetPc(req)))));
  r.get('/identity',handle(async(req,res)=>{
    const [identity]=await ctx.db.query<{public_key:string}>('select public_key from pc_executor_identity where owner_user_id=$1 and pc_id=$2',[req.user!.id,targetPc(req)]);
    return res.json({publicKey:identity?.public_key??null,enabled:(await control(req).snapshot(req.user!.id)).enabled});
  }));
  r.post('/identity',handle(async(req,res)=>{
    const identifier='pc-identity:'+req.user!.id,ip=clientIp(req);
    if((await checkLoginRate(ctx.db,identifier,ip)).blocked)throw new PcControlError(429,'Wait before another password attempt.');
    const [user]=await ctx.db.query<{password_hash:string|null}>('select password_hash from users where id=$1',[req.user!.id]);
    const matched=await verifyPassword(user?.password_hash??null,typeof req.body?.password==='string'?req.body.password:'');
    await recordLoginAttempt(ctx.db,{identifier,ip,success:matched});
    if(!matched)throw new PcControlError(401,'Confirm your account password in the protected native form.');
    const key=req.body?.publicKey;
    if(typeof key!=='string'||key.length>100)throw new PcControlError(400,'Invalid PC identity.');
    const pc=targetPc(req);await verifyPcExecutor(ctx.db,req,pc,key);
    await ctx.db.query('insert into pc_executor_identity(owner_user_id,pc_id,public_key) values($1,$2,$3) on conflict do nothing',[req.user!.id,pc,key]);
    return res.json({ok:true});
  }));
  r.delete('/identity',handle(async(req,res)=>{
    const pc=targetPc(req);await control(req).stop(req.user!.id);
    await ctx.db.query('delete from pc_executor_identity where owner_user_id=$1 and pc_id=$2',[req.user!.id,pc]);
    return res.json({ok:true});
  }));
  // The Linux server's own PC service (josi-pc.service). It cannot sign in by
  // itself, so the owner pairs it here, or by approving the chat card that
  // turns control on for it; packages/core/src/pcLocalExecutors.ts.
  r.get('/local',handle(async(req,res)=>{
    const owner=req.user!.id,hellos=await syncLocalExecutors(ctx.db,owner);
    const executors=[];
    for(const hello of hellos){
      const [live]=await ctx.db.query('select 1 from pc_control_presence where owner_user_id=$1 and pc_id=$2 and expires_at>now()',[owner,hello.pcId]);
      executors.push({pcId:hello.pcId,user:hello.user,host:hello.host,paired:await localExecutorPaired(ctx.db,owner,hello.pcId),connected:!!live});
    }
    return res.json({available:localExecutorSpool()!==null,executors});
  }));
  r.post('/local/:pcId/pair',handle(async(req,res)=>{
    const owner=req.user!.id,pcId=param(req,'pcId'),identifier='pc-identity:'+owner,ip=clientIp(req);
    if(!/^linux-[a-f0-9]{32}$/.test(pcId))throw new PcControlError(400,'Choose a PC service on this server.');
    if((await checkLoginRate(ctx.db,identifier,ip)).blocked)throw new PcControlError(429,'Wait before another password attempt.');
    const [user]=await ctx.db.query<{password_hash:string|null}>('select password_hash from users where id=$1',[owner]);
    const matched=await verifyPassword(user?.password_hash??null,typeof req.body?.password==='string'?req.body.password:'');
    await recordLoginAttempt(ctx.db,{identifier,ip,success:matched});
    if(!matched)throw new PcControlError(401,'Confirm your account password to pair this server.');
    if(!await pairLocalExecutor(ctx.db,owner,pcId))throw new PcControlError(404,'That PC service has not started on this server. Run the installer again and choose PC control.');
    return res.json({ok:true});
  }));
  r.delete('/local/:pcId',handle(async(req,res)=>{
    const owner=req.user!.id,pcId=param(req,'pcId');
    if(!/^linux-[a-f0-9]{32}$/.test(pcId))throw new PcControlError(400,'Choose a PC service on this server.');
    await disablePcControl(ctx.db,owner,pcId).catch(()=>undefined);
    await ctx.db.query('delete from pc_executor_identity where owner_user_id=$1 and pc_id=$2',[owner,pcId]);
    await revokeExecutorSessions(ctx.db,owner,pcId);
    return res.json({ok:true});
  }));
  r.put('/enabled',handle(async(req,res)=>{
    // `everyday` (from a chat card the owner approved with their password)
    // also turns on the everyday allowances; it takes the password here too,
    // like PUT /full-control, so a plain toggle cannot widen access silently.
    const everyday=req.body?.enabled===true&&req.body?.everyday===true;
    if(everyday){
      const [u]=await ctx.db.query<{password_hash:string|null}>(`select password_hash from users where id=$1`,[req.user!.id]);
      if(!await verifyPassword(u?.password_hash??null,typeof req.body?.password==='string'?req.body.password:''))throw new PcControlError(401,'Confirm your account password to let Josi work on this PC without asking each time.');
    }
    await control(req).setEnabled(req.user!.id,req.body?.enabled,revision(req));
    if(everyday)await control(req).setFullControl(req.user!.id,true);
    return res.json({ok:true,fullControl:everyday||undefined});
  }));
  r.post('/stop',handle(async(req,res)=>{
    // Stop works even when the sealed store cannot be opened: the plain rows are enough to revoke.
    const pcId=targetPc(req);
    try{await control(req).stop(req.user!.id);}catch{await disablePcControl(ctx.db,req.user!.id,pcId);}
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
    await control(req).setFullControl(req.user!.id,req.body.enabled,revision(req));
    return res.json({ok:true,fullControl:req.body.enabled});
  }));
  r.put('/preset',handle(async(req,res)=>{
    const identifier='pc-preset:'+req.user!.id,ip=clientIp(req);
    if((await checkLoginRate(ctx.db,identifier,ip)).blocked)throw new PcControlError(429,'Wait before another password attempt.');
    const [user]=await ctx.db.query<{password_hash:string|null}>('select password_hash from users where id=$1',[req.user!.id]);
    const matched=await verifyPassword(user?.password_hash??null,typeof req.body?.password==='string'?req.body.password:'');
    await recordLoginAttempt(ctx.db,{identifier,ip,success:matched});
    if(!matched)throw new PcControlError(401,'Confirm your account password in the protected form.');
    const {password,...preset}=req.body??{};
    return res.json(await control(req).applyPreset(req.user!.id,preset as PcPreset,revision(req)));
  }));
  // A standing grant for a high-risk action (commands in a shell and folder)
  // takes the account password once, like full control. Never and Ask do not.
  r.put('/policies',handle(async(req,res)=>{
    const {password,approveRequestId,...policy}=(req.body??{}) as PcPolicy&{password?:unknown;approveRequestId?:string};
    if(approveRequestId!==undefined||(pcActionIsHighRisk(policy.action)&&['always','temporary','task'].includes(policy.mode))){
      const [u]=await ctx.db.query<{password_hash:string|null}>(`select password_hash from users where id=$1`,[req.user!.id]);
      if(!await verifyPassword(u?.password_hash??null,typeof password==='string'?password:''))throw new PcControlError(401,'Confirm your account password to let Josi do this without asking each time.');
    }
    return res.json(await control(req).savePolicy(req.user!.id,policy as PcPolicy,{expectedRevision:revision(req),approveRequestId}));
  }));
  r.delete('/policies/:id',handle(async(req,res)=>{await control(req).revoke(req.user!.id,param(req,'id'),revision(req));return res.json({ok:true});}));
  r.post('/requests/:id/decision',handle(async(req,res)=>{
    if(typeof req.body?.approve!=='boolean')throw new PcControlError(400,'Choose approve or deny.');
    if(req.body.approve){
      const snapshot=await control(req).snapshot(req.user!.id),request=snapshot.requests.find(q=>q.id===param(req,'id'));
      if(!request)throw new PcControlError(404,'Active request not found.');
      if(request.highRisk){
        const [u]=await ctx.db.query<{password_hash:string|null}>(`select password_hash from users where id=$1`,[req.user!.id]);
        if(!await verifyPassword(u?.password_hash??null,typeof req.body?.password==='string'?req.body.password:''))throw new PcControlError(401,'Confirm your account password to approve this high-risk action.');
      }
    }
    await control(req).decide(req.user!.id,param(req,'id'),req.body.approve,revision(req));return res.json({ok:true});
  }));
  // The Windows app is the executor. It reports its attached browser, claims
  // approved work one request at a time and reports what happened. A claim
  // goes through execute(), so every policy check runs again at that moment.
  const running=new Map<string,{owner:string;pcId:string;finish:(ok:boolean,result:unknown)=>Promise<void>}>();
  r.use('/executor',(req,res,next)=>{void (async()=>{
    try {await verifyPcExecutor(ctx.db,req,targetPc(req));next();}
    catch(error){res.status(error instanceof PcControlError?error.status:503).json({error:error instanceof PcControlError?error.message:'PC identity verification is unavailable.'});}
  })();});
  r.put('/executor/presence',handle(async(req,res)=>{
    await control(req).setPresence(req.user!.id,req.body?.connected===true?req.body.browser as PcBrowserPresence:null);
    return res.json({ok:true});
  }));
  r.post('/executor/next',handle(async(req,res)=>{
    const owner=req.user!.id,service=control(req);
    for(const {id,plan} of await service.approved(owner)){
      if(running.has(id))continue;
      let claimed!:()=>void;const started=new Promise<boolean>(resolve=>{claimed=()=>resolve(true);});
      // A command may run for as long as its own timeout; everything else gets the minute.
      const declared=Number((plan.payload as {timeoutSeconds?:unknown}|null)?.timeoutSeconds);
      const wait=Number.isFinite(declared)&&declared>0?Math.min(EXECUTOR_WAIT_MAX,Math.max(EXECUTOR_WAIT,declared*1000+30_000)):EXECUTOR_WAIT;
      const done=service.execute(owner,id,plan,(_plan,signal)=>new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{running.delete(id);void service.saveResult(owner,id,{ok:false,code:'executor_timeout'}).finally(()=>reject(new Error('timeout')));},wait);
        signal.addEventListener('abort',()=>{clearTimeout(timer);running.delete(id);reject(new Error('stopped'));},{once:true});
        running.set(id,{owner,pcId:service.pcId,finish:async(ok,result)=>{
          clearTimeout(timer);running.delete(id);
          await service.saveResult(owner,id,{ok,result});
          if(ok)resolve();else reject(new Error('failed'));
        }});
        claimed();
      }));
      done.catch(()=>undefined);
      if(await Promise.race([started,done.then(()=>false,()=>false)]))
        return res.json({request:{id,description:plan.description,requirements:plan.requirements,payload:plan.payload}});
    }
    return res.json({request:null});
  }));
  r.get('/executor/:id/lease',handle(async(req,res)=>{
    const active=running.get(param(req,'id')),service=control(req);
    if(!active||active.owner!==req.user!.id||active.pcId!==service.pcId)throw new PcControlError(404,'This request is not running on this PC.');
    const authorized=await service.executionAuthorized(req.user!.id,param(req,'id'));
    return res.json({authorized,leaseMilliseconds:5000});
  }));
  r.get('/executor/terminals/:id/lease',handle(async(req,res)=>{
    return res.json(await control(req).terminalAuthorization(req.user!.id,param(req,'id')));
  }));
  // Signing in for Josi (docs/LIVE_SIGN_IN.md): the PC service relays the
  // person's live session. Frames and keystrokes pass through memory only.
  r.get('/executor/live',handle(async(req,res)=>{
    const pcId=targetPc(req);
    return res.json({sessions:(ctx.live?.active(pcId)??[]).map(s=>({id:s.id,kind:s.kind,state:s.state,title:s.title,url:s.url,command:s.command,runAs:s.runAs}))});
  }));
  r.post('/executor/live/:id/sync',handle(async(req,res)=>{
    const live=ctx.live,pcId=targetPc(req),s=live?.get(param(req,'id'));
    if(!live||!s||s.pcId!==pcId)throw new PcControlError(404,'No such sign-in on this PC.');
    const b=(req.body??{}) as {ready?:unknown;error?:unknown;frame?:{width?:unknown;height?:unknown;jpegBase64?:unknown};output?:{data?:unknown;running?:unknown;exitCode?:unknown}};
    if(typeof b.error==='string'&&b.error)live.fail(s.id,b.error);
    else{
      if(b.ready===true)live.ready(s.id);
      if(b.frame&&typeof b.frame.jpegBase64==='string')live.pushFrame(s.id,Number(b.frame.width),Number(b.frame.height),Buffer.from(b.frame.jpegBase64,'base64'));
      if(b.output)live.pushOutput(s.id,typeof b.output.data==='string'?b.output.data:'',b.output.running!==false,Number.isInteger(b.output.exitCode)?Number(b.output.exitCode):null);
    }
    const ended=s.state==='ended';
    return res.json({input:ended?[]:live.takeInput(s.id),ended});
  }));
  r.post('/executor/:id/result',handle(async(req,res)=>{
    const active=running.get(param(req,'id'));
    if(!active||active.owner!==req.user!.id||active.pcId!==control(req).pcId)throw new PcControlError(404,'This request is not running on this PC.');
    if(typeof req.body?.ok!=='boolean')throw new PcControlError(400,'Report success or failure.');
    await active.finish(req.body.ok,req.body.result??null);
    return res.json({ok:true});
  }));
  return r;
}
