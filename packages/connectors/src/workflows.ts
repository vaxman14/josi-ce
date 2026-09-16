import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { appendEvent, json, openSealed, seal, type Db, type MasterKey } from '@josi-ce/core';
import { assertPublicHost } from './customApiRequest.js';

export type WorkflowProvider = 'zapier' | 'n8n' | 'make';
export interface WorkflowIntegration { id:string; provider:WorkflowProvider; name:string; base_url:string; credentials_enc:string; callback_secret_enc:string; enabled:boolean; allow_private_network:boolean; account_identity:string|null; workspace_identity:string|null; status:string; }
export interface WorkflowDefinition { integration_id:string; external_id:string; name:string; description:string|null; input_schema:Record<string,unknown>; execution_ref:string; active:boolean; exposed?:boolean; }
export interface WorkflowRun { id:string; integration_id:string; external_workflow_id:string; owner_user_id:string; status:string; external_run_id:string|null; result_summary:string|null; error_category:string|null; created_at:string; }
type Credentials = { token:string; workspaceId?:string; workspaceType?:'team'|'organization' };

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS:WorkflowProvider[]=['zapier','n8n','make'];
const defaults:Record<WorkflowProvider,string>={zapier:'https://mcp.zapier.com',n8n:'',make:'https://us1.make.com'};
export class WorkflowError extends Error { constructor(message:string, readonly status=400){super(message);} }
export function isWorkflowProvider(v:string):v is WorkflowProvider{return PROVIDERS.includes(v as WorkflowProvider);}

function privateAddress(host:string):boolean {
  const h=host.toLowerCase().replace(/^\[|\]$/g,'');
  if(h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local'))return true;
  if(isIP(h)===4){const p=h.split('.').map(Number);return p[0]===10||p[0]===127||p[0]===0||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168);}
  return isIP(h)===6&&(h==='::1'||h==='::'||h.startsWith('fc')||h.startsWith('fd')||h.startsWith('fe8')||h.startsWith('fe9')||h.startsWith('fea')||h.startsWith('feb'));
}
function safeBase(provider:WorkflowProvider, raw:string, allowPrivateNetwork=false):string {
  const value=(raw||defaults[provider]).replace(/\/$/,''); let u:URL;
  try{u=new URL(value);}catch{throw new WorkflowError('Enter a valid provider URL.');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new WorkflowError('Workflow provider URLs must be HTTPS origins without credentials, query strings, or fragments.');
  if(provider==='zapier'&&u.hostname!=='mcp.zapier.com')throw new WorkflowError('Zapier connections must use the official mcp.zapier.com endpoint.');
  if(provider==='make'&&!/(^|\.)make\.com$/i.test(u.hostname))throw new WorkflowError('Make connections must use a make.com endpoint.');
  if(provider==='n8n'&&privateAddress(u.hostname)&&!allowPrivateNetwork)throw new WorkflowError('Private-network n8n requires the deliberate LAN access option.');
  return value;
}

export async function saveWorkflowIntegration(db:Db,key:MasterKey,args:{provider:WorkflowProvider;name:string;baseUrl?:string;token:string;actorUserId:string;allowPrivateNetwork?:boolean;workspaceId?:string;workspaceType?:'team'|'organization';fetchImpl?:typeof fetch}) {
  if(!isWorkflowProvider(args.provider)||!args.name.trim()||!args.token)throw new WorkflowError('Provider, name, and credential are required.');
  const base=safeBase(args.provider,args.baseUrl??'',args.allowPrivateNetwork===true);
  // Hosted n8n must resolve entirely to public addresses. A self-hosted LAN
  // endpoint is accepted only behind the explicit operator switch above.
  if(args.provider==='n8n'&&!args.allowPrivateNetwork&&!args.fetchImpl)await assertPublicHost(new URL(base).hostname);
  if(args.provider==='make'&&(!args.workspaceId||!/^\d+$/.test(args.workspaceId)))throw new WorkflowError('Make requires a numeric team or organization id.');
  const identity=await testWorkflowCredential({provider:args.provider,baseUrl:base,token:args.token,workspaceId:args.workspaceId,workspaceType:args.workspaceType,fetchImpl:args.fetchImpl});
  const secret=randomBytes(32).toString('base64url');
  const rows=await db.query<WorkflowIntegration>(`insert into workflow_integrations(provider,name,base_url,credentials_enc,callback_secret_enc,created_by,allow_private_network,account_identity,workspace_identity,status,last_check_at,last_check_ok)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',now(),true) on conflict(provider,name) do update set base_url=excluded.base_url,credentials_enc=excluded.credentials_enc,allow_private_network=excluded.allow_private_network,account_identity=excluded.account_identity,workspace_identity=excluded.workspace_identity,status='active',last_check_at=now(),last_check_ok=true,updated_at=now() returning *`,
    [args.provider,args.name.trim(),base,seal(key,{token:args.token,workspaceId:args.workspaceId,workspaceType:args.workspaceType}),seal(key,{secret}),args.actorUserId,args.allowPrivateNetwork===true,identity.account,identity.workspace]);
  // A credential rotation must not silently rotate the callback verifier: the
  // provider still has the old value until the operator explicitly changes it.
  const callbackSecret=openSealed<{secret:string}>(key,rows[0].callback_secret_enc).secret;
  return {...rows[0],callbackSecret};
}
const auth=(p:WorkflowProvider,token:string):Record<string,string>=>p==='n8n'?{'X-N8N-API-KEY':token}:{Authorization:p==='make'?`Token ${token}`:`Bearer ${token}`};
const makeQuery=(c:Credentials)=>`${c.workspaceType==='organization'?'organizationId':'teamId'}=${encodeURIComponent(c.workspaceId??'')}`;
const discoveryPath=(p:WorkflowProvider,c:Credentials)=>p==='zapier'?'/api/v1/connect':p==='n8n'?'/api/v1/workflows?active=true':`/api/v2/scenarios?${makeQuery(c)}&isActive=true`;
async function mcpRequest(baseUrl:string,token:string,method:string,params:unknown,fetchImpl:typeof fetch){const response=await fetchImpl(`${baseUrl}/api/v1/connect`,{method:'POST',headers:{accept:'application/json, text/event-stream','content-type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:randomBytes(8).toString('hex'),method,params}),redirect:'error'});if(!response.ok)throw new WorkflowError(`Zapier rejected the MCP request (${response.status}).`,502);return response.json() as Promise<any>;}
export async function testWorkflowCredential(args:{provider:WorkflowProvider;baseUrl:string;token:string;workspaceId?:string;workspaceType?:'team'|'organization';fetchImpl?:typeof fetch}) {
  if(args.provider==='zapier'){const body=await mcpRequest(args.baseUrl,args.token,'tools/list',{},args.fetchImpl??fetch);if(body.error)throw new WorkflowError('Zapier rejected the connection token.',422);return {ok:true as const,account:'Zapier MCP connection',workspace:null};}
  const credentials={token:args.token,workspaceId:args.workspaceId,workspaceType:args.workspaceType};
  const response=await (args.fetchImpl??fetch)(args.baseUrl+discoveryPath(args.provider,credentials),{headers:{accept:'application/json',...auth(args.provider,args.token)},redirect:'error'});
  if(!response.ok)throw new WorkflowError(`${args.provider} rejected the credential (${response.status}).`,422);
  await response.json().catch(()=>({}));return {ok:true as const,account:args.provider==='n8n'?'n8n API key':null,workspace:args.provider==='make'?`${args.workspaceType??'team'}:${args.workspaceId}`:new URL(args.baseUrl).host};
}
const parseList=(p:WorkflowProvider,b:any):any[]=>p==='zapier'?(b.result?.tools??[]):p==='n8n'?(b.data??[]):(b.scenarios??[]);
export async function discoverWorkflows(db:Db,key:MasterKey,integration:WorkflowIntegration,fetchImpl:typeof fetch=fetch):Promise<WorkflowDefinition[]> {
  const credentials=openSealed<Credentials>(key,integration.credentials_enc);const {token}=credentials;let body:any;
  if(integration.provider==='zapier')body=await mcpRequest(integration.base_url,token,'tools/list',{},fetchImpl);
  else {const response=await fetchImpl(integration.base_url+discoveryPath(integration.provider,credentials),{headers:{accept:'application/json',...auth(integration.provider,token)},redirect:'error'});if(!response.ok)throw new WorkflowError(`${integration.provider} workflow discovery failed (${response.status}).`,502);body=await response.json();}
  const items=parseList(integration.provider,body);
  const found:WorkflowDefinition[]=[];
  for(const item of items){
    const external=String(item.id??item.name??item.scenarioId??''); if(!external)continue;
    const execution=integration.provider==='n8n'?'':String(item.execution_ref??item.webhookUrl??item.webhook_url??external);
    const [row]=await db.query<WorkflowDefinition>(`insert into workflow_definitions(integration_id,external_id,name,description,input_schema,execution_ref,active)
      values($1,$2,$3,$4,$5,$6,true) on conflict(integration_id,external_id) do update set name=excluded.name,description=excluded.description,input_schema=excluded.input_schema,execution_ref=excluded.execution_ref,active=true,discovered_at=now() returning *`,
      [integration.id,external,String(item.name??item.title??'Workflow'),item.description??null,json(item.inputSchema??item.input_schema??item.params??{type:'object',properties:{}}),execution]); found.push(row);
  }
  await db.query(`update workflow_definitions set active=false where integration_id=$1 and not(external_id=any($2::text[]))`,[integration.id,found.map(x=>x.external_id)]);
  await db.query(`update workflow_integrations set last_check_at=now(),last_check_ok=true where id=$1`,[integration.id]); return found;
}

function validateValue(schema:any,value:unknown,path='$'):string[] {
  if(!schema||typeof schema!=='object')return [`${path} has an invalid provider schema`];
  const errors:string[]=[];const type=schema.type;
  if(type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))return [`${path} must be an object`];
    const obj=value as Record<string,unknown>;for(const k of Array.isArray(schema.required)?schema.required:[])if(!(k in obj))errors.push(`${path}.${k} is required`);
    for(const [k,v] of Object.entries(obj)){if(schema.additionalProperties===false&&!schema.properties?.[k])errors.push(`${path}.${k} is not accepted`);else if(schema.properties?.[k])errors.push(...validateValue(schema.properties[k],v,`${path}.${k}`));}
  } else if(type==='array'){if(!Array.isArray(value))errors.push(`${path} must be an array`);else value.forEach((v,i)=>errors.push(...validateValue(schema.items??{},v,`${path}[${i}]`)));}
  else if(type==='string'&&typeof value!=='string')errors.push(`${path} must be text`);
  else if(type==='number'&&typeof value!=='number')errors.push(`${path} must be a number`);
  else if(type==='integer'&&(!Number.isInteger(value)))errors.push(`${path} must be an integer`);
  else if(type==='boolean'&&typeof value!=='boolean')errors.push(`${path} must be true or false`);
  if(Array.isArray(schema.enum)&&!schema.enum.includes(value))errors.push(`${path} is not an allowed value`);
  return errors;
}
export function validateWorkflowInput(schema:Record<string,unknown>,input:unknown){const errors=validateValue(schema,input);if(errors.length)throw new WorkflowError(`Workflow input is invalid: ${errors.slice(0,5).join('; ')}`,422);return true;}
export function previewWorkflowRun(workflow:WorkflowDefinition,input:Record<string,unknown>){validateWorkflowInput(workflow.input_schema,input);return {workflow:{id:workflow.external_id,name:workflow.name},input,requiresApproval:true};}
export async function registerN8nWebhook(db:Db,integrationId:string,workflowId:string,path:string,inputSchema:Record<string,unknown>){if(!/^\/webhook\/[A-Za-z0-9._~/-]+$/.test(path)||path.includes('..'))throw new WorkflowError('Enter an n8n production webhook path beginning with /webhook/.');validateWorkflowInput({type:'object',properties:{}} as any,{});const rows=await db.query<WorkflowDefinition>(`update workflow_definitions set execution_ref=$3,input_schema=$4 where integration_id=$1 and external_id=$2 returning *`,[integrationId,workflowId,path,json(inputSchema)]);if(!rows.length)throw new WorkflowError('Workflow not found.',404);return rows[0];}
export async function disconnectWorkflowIntegration(db:Db,id:string){const rows=await db.query(`update workflow_integrations set enabled=false,status='disconnected',credentials_enc='',last_check_ok=false,updated_at=now() where id=$1 returning id`,[id]);if(!rows.length)throw new WorkflowError('Integration not found.',404);await db.query(`update workflow_definitions set exposed=false where integration_id=$1`,[id]);return {disconnected:true};}

export async function requestWorkflowRun(db:Db,key:MasterKey,args:{integration:WorkflowIntegration;workflow:WorkflowDefinition;ownerUserId:string;threadId?:string|null;input:Record<string,unknown>}) {
  validateWorkflowInput(args.workflow.input_schema,args.input);
  const canonical=JSON.stringify(args.input); const hash=createHash('sha256').update(canonical).digest('hex');
  if(Buffer.byteLength(canonical)>64*1024)throw new WorkflowError('Workflow input is larger than 64 KB.',413);
  const [run]=await db.query<WorkflowRun>(`insert into workflow_runs(integration_id,external_workflow_id,owner_user_id,thread_id,status,input_enc,input_hash,expires_at)
    values($1,$2,$3,$4,'pending',$5,$6,now()+interval '15 minutes') returning *`,[args.integration.id,args.workflow.external_id,args.ownerUserId,args.threadId??null,seal(key,{input:args.input}),hash]);
  await appendEvent(db,{actorUserId:args.ownerUserId,actor:'agent',kind:'workflow.run_requested',subjectType:'workflow_run',subjectId:run.id,payload:{provider:args.integration.provider,workflow:args.workflow.name}}); return run;
}
export async function executeWorkflowRun(db:Db,key:MasterKey,args:{runId:string;ownerUserId:string;approve:boolean;fetchImpl?:typeof fetch}) {
  await db.query(`update workflow_runs set status='expired',finished_at=now(),error_category='approval_expired' where status='pending' and expires_at<now()`);
  if(!UUID.test(args.runId))throw new WorkflowError('There is no workflow request with that id.',404);
  const rows=await db.query<any>(`select r.*,i.provider,i.base_url,i.credentials_enc,i.status as integration_status,w.execution_ref from workflow_runs r join workflow_integrations i on i.id=r.integration_id join workflow_definitions w on w.integration_id=r.integration_id and w.external_id=r.external_workflow_id where r.id=$1 and r.owner_user_id=$2`,[args.runId,args.ownerUserId]); const row=rows[0];
  if(!row)throw new WorkflowError('There is no workflow request with that id.',404);if(row.integration_status==='disconnected'||!row.credentials_enc)throw new WorkflowError('That workflow provider is disconnected.',409);if(row.provider==='n8n'&&!row.execution_ref)throw new WorkflowError('This n8n workflow has no registered production webhook.',409); if(row.status!=='pending'||new Date(row.expires_at)<new Date())throw new WorkflowError('That workflow request is no longer awaiting approval.',409);
  if(!args.approve){await db.query(`update workflow_runs set status='denied',decided_at=now() where id=$1 and status='pending'`,[row.id]);return {status:'denied'};}
  const claimed=await db.query<any>(`update workflow_runs set status='running',decided_at=now(),started_at=now() where id=$1 and status='pending' returning *`,[row.id]); if(!claimed.length)throw new WorkflowError('That workflow request was already decided.',409);
  const {input}=openSealed<{input:Record<string,unknown>}>(key,row.input_enc); const {token}=openSealed<Credentials>(key,row.credentials_enc);
  try{let body:any;if(row.provider==='zapier')body=await mcpRequest(row.base_url,token,'tools/call',{name:row.execution_ref,arguments:input},args.fetchImpl??fetch);else {const path=row.provider==='n8n'?row.execution_ref:`/api/v2/scenarios/${encodeURIComponent(row.execution_ref)}/run`;const payload=row.provider==='make'?{data:input,responsive:true}:input;const response=await (args.fetchImpl??fetch)(row.base_url+path,{method:'POST',headers:{'content-type':'application/json',...auth(row.provider,token)},body:JSON.stringify(payload),redirect:'error'});body=await response.json().catch(()=>({}));if(!response.ok)throw new WorkflowError(`The ${row.provider} workflow refused the request (${response.status}).`,502);}if(body.error||body.result?.isError)throw new WorkflowError(`The ${row.provider} workflow reported a failure.`,502);const external=String(body.id??body.run_id??body.executionId??'')||null;const completed=row.provider==='zapier'||row.provider==='n8n'||body.status==='succeeded'||body.status==='success';await db.query(`update workflow_runs set status=$2,external_run_id=$3,finished_at=case when $2='succeeded' then now() else null end,result_summary=case when $2='succeeded' then 'Provider reported successful completion.' else null end where id=$1`,[row.id,completed?'succeeded':'running',external]);return {status:completed?'succeeded':'running',runId:row.id,externalRunId:external};}catch(e){await db.query(`update workflow_runs set status='failed',error_category='provider_error',finished_at=now() where id=$1`,[row.id]);throw e;}
}
export function verifyWorkflowCallback(key:MasterKey,integration:WorkflowIntegration,rawBody:string,signature:string,timestamp?:string):boolean {
  if(timestamp){const seconds=Number(timestamp);if(!Number.isFinite(seconds)||Math.abs(Date.now()-seconds*1000)>5*60_000)return false;}
  const {secret}=openSealed<{secret:string}>(key,integration.callback_secret_enc); const supplied=signature.replace(/^sha256=/,''); const expected=createHmac('sha256',secret).update(rawBody).digest('hex');
  return supplied.length===expected.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(expected));
}
export async function recordWorkflowCallback(db:Db,args:{integrationId:string;externalRunId:string;status:'succeeded'|'failed';summary?:string}) {
  const rows=await db.query<WorkflowRun>(`update workflow_runs set status=$3,result_summary=$4,error_category=case when $3='failed' then 'provider_error' else null end,finished_at=now() where integration_id=$1 and external_run_id=$2 and status='running' returning *`,[args.integrationId,args.externalRunId,args.status,args.summary?.slice(0,500)??null]);
  if(!rows.length)throw new WorkflowError('No running workflow matches this callback.',404); return rows[0];
}
export const workflowHistory=async(db:Db,ownerUserId:string)=>{await db.query(`delete from workflow_callback_events where received_at<now()-interval '30 days'`);await db.query(`delete from workflow_runs where created_at<now()-interval '30 days'`);return db.query<WorkflowRun>(`select id,integration_id,external_workflow_id,owner_user_id,status,external_run_id,result_summary,error_category,created_at from workflow_runs where owner_user_id=$1 order by created_at desc limit 100`,[ownerUserId]);};
