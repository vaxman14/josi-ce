import { useEffect } from 'react';
import { api } from './api';

export interface DesktopRoot {id:string;label:string;writable:boolean}
export interface DesktopWorkspaceState {clientId:string;roots:DesktopRoot[]}
interface DesktopRequest {id:string;mapping_id:string;root_id:string;operation:string;payload:Record<string,unknown>}

declare global {
 interface Window {josiDesktop?:{
  platform?:string;
  localWorkspace?:{
   state:()=>Promise<DesktopWorkspaceState>;
   selectFolder:(writable:boolean)=>Promise<DesktopRoot|null>;
   revoke:(rootId:string)=>Promise<boolean>;
   execute:(request:{rootId:string;operation:string;payload:Record<string,unknown>})=>Promise<unknown>;
  };
 }}
}

export function desktopWorkspaceBridge(){return window.josiDesktop?.localWorkspace??null;}

export async function registerDesktopRoots(state:DesktopWorkspaceState){
 for(const root of state.roots)await api.post('/desktop-workspace/mappings',{clientId:state.clientId,rootId:root.id,label:root.label,writable:root.writable});
}

export function useDesktopWorkspaceRelay(signedIn:boolean){
 useEffect(()=>{
  const bridge=desktopWorkspaceBridge();if(!signedIn||!bridge)return;
  let stopped=false,timer:number|undefined,state:DesktopWorkspaceState|undefined;
  const result=async(request:DesktopRequest,ok:boolean,value:unknown)=>{
   if(!state)return;await api.post(`/desktop-workspace/requests/${request.id}/result`,ok?{clientId:state.clientId,ok:true,result:value}:{clientId:state.clientId,ok:false,error:String((value as Error)?.message??value)});
  };
  const poll=async()=>{
   try{
    // Read state on every pass. A folder can be added or revoked while the
    // relay is already running; caching the first snapshot left the server
    // advertising ghost roots until the whole app restarted.
    state=await bridge.state();await registerDesktopRoots(state);
    await api.post('/desktop-workspace/heartbeat',{clientId:state.clientId,rootIds:state.roots.map(root=>root.id)});
    const next=await api.get<{request:DesktopRequest|null}>(`/desktop-workspace/requests?clientId=${encodeURIComponent(state.clientId)}`);
    if(next.request){try{await result(next.request,true,await bridge.execute({rootId:next.request.root_id,operation:next.request.operation,payload:next.request.payload}));}catch(error){await result(next.request,false,error);}}
   }catch{/* Offline, signed out, or an old server: retry without weakening access. */}
   if(!stopped)timer=window.setTimeout(poll,750);
  };
  void poll();return()=>{stopped=true;if(timer!==undefined)window.clearTimeout(timer);};
 },[signedIn]);
}
