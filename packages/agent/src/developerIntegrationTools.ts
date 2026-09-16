import { openCredentialPayload, type Db, type MasterKey } from '@josi-ce/core';
import { describeDeveloperService, isDeveloperService, listDeveloperResources } from '@josi-ce/connectors';
import type { ToolSpec } from './tools.js';

export const DEVELOPER_INTEGRATION_TOOL='list_native_integrations';
export const DEVELOPER_INTEGRATION_TOOLS:ToolSpec[]=[{
  def:{
    name:DEVELOPER_INTEGRATION_TOOL,
    description:'List this user’s connected native developer/productivity integrations, their provider identity, health, and supported capability summary. Read-only; never returns credentials.',
    parameters:{type:'object',properties:{}},
  },
  actionClass:null,
},{def:{name:'list_native_resources',description:'List up to 25 resources from one connected native provider using that provider’s fixed read-only API (repositories, projects, sites, accounts, services, organizations, or shared Notion pages).',parameters:{type:'object',properties:{provider:{type:'string'}},required:['provider']}},actionClass:null}];

export async function developerIntegrationToolAvailability(db:Db,userId:string):Promise<ToolSpec[]>{
  const [row]=await db.query<{n:number}>(`select count(*)::int n from developer_connections where owner_user_id=$1`,[userId]);
  return (row?.n??0)>0?DEVELOPER_INTEGRATION_TOOLS:[];
}

export async function executeDeveloperIntegrationTool(db:Db,userId:string){
  const rows=await db.query<{service:string;account_label:string|null;status:string;last_check_at:string|null;last_check_ok:boolean|null;last_error:string|null;last_used_at:string|null}>(`select service,account_label,status,last_check_at,last_check_ok,last_error,last_used_at from developer_connections where owner_user_id=$1 order by service`,[userId]);
  return {ok:true,integrations:rows.map((row)=>{
    const descriptor=describeDeveloperService(row.service);
    return {
      provider:row.service,
      label:descriptor?.label??row.service,
      account:row.account_label,
      status:row.status,
      last_checked_at:row.last_check_at,
      last_used_at:row.last_used_at,
      healthy:row.last_check_ok,
      problem:row.last_error,
      capability:descriptor?.capability??'Provider connection status only.',
    };
  })};
}

export async function executeDeveloperResourceTool(db:Db,userId:string,input:Record<string,unknown>,access:{masterKey:()=>MasterKey;fetchImpl?:typeof fetch}){
  const service=String(input.provider??'');
  if(!isDeveloperService(service))return {ok:false,message:'Choose a supported native provider.'};
  const [row]=await db.query<{credentials_enc:string}>(`select credentials_enc from developer_connections where owner_user_id=$1 and service=$2 and status='active'`,[userId,service]);
  if(!row)return {ok:false,message:'That provider is not connected and active for this user.'};
  const credential=await openCredentialPayload<Record<string,string>>(db,access.masterKey(),{ownerUserId:userId,service:`developer.${service}`,slot:'token',stored:row.credentials_enc});
  try{
    const resources=await listDeveloperResources({service,token:credential.token??'',username:credential.username,email:credential.email,baseUrl:credential.baseUrl,fetchImpl:access.fetchImpl});
    await db.query(`update developer_connections set last_used_at=now(),last_check_at=now(),last_check_ok=true,last_error=null where owner_user_id=$1 and service=$2`,[userId,service]);
    return {ok:true,provider:service,resources};
  }catch(error){
    await db.query(`update developer_connections set last_check_at=now(),last_check_ok=false,last_error='Resource discovery failed.' where owner_user_id=$1 and service=$2`,[userId,service]);
    return {ok:false,provider:service,message:error instanceof Error?error.message:'Resource discovery failed.'};
  }
}
