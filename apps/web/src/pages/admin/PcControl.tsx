import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button, ErrorNote } from '@/components/ui';

type Scope={kind:string;target:string;application?:string;profile?:string};
type Requirement={action:string;scope:Scope};
type Policy=Requirement&{id:string;mode:string;taskId?:string;expiresAt?:string;active:boolean};
type Catalog={action:string;label:string;kind:string;highRisk:boolean;access:string};
type Pending={id:string;description:string;requirements:Requirement[];taskId?:string;expiresAt:string;highRisk:boolean;access:string};
type Activity={id:string;at:string;kind:string;description?:string;requirements?:Requirement[]};
type State={enabled:boolean;pcId:string;catalog:Catalog[];policies:Policy[];requests:Pending[];activity:Activity[];tasks:{id:string;name:string;created_at:string}[];executorAvailable:boolean;availability:string;uac:string};
const MODES=[['never','Never allow'],['ask','Ask every time'],['task','Allow for this task'],['temporary','Allow temporarily'],['always','Always allow for this exact scope']];
const endpoint='/admin/pc-control';
function ScopeText({scope}:{scope:Scope}){return <span className="break-all">{scope.application?`${scope.application} · `:''}{scope.profile?`Profile ${scope.profile} · `:''}{scope.target}</span>;}

export function AdminPcControl(){
  const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [action,setAction]=useState('browser.view'),[target,setTarget]=useState(''),[application,setApplication]=useState(''),[profile,setProfile]=useState('');
  const [mode,setMode]=useState('ask'),[taskId,setTaskId]=useState(''),[expires,setExpires]=useState('');
  const [passwords,setPasswords]=useState<Record<string,string>>({});
  const spec=state?.catalog.find(s=>s.action===action);
  async function refresh(){setState(await api.get<State>(endpoint));}
  useEffect(()=>{void refresh().catch(e=>setError(e instanceof Error?e.message:'Could not load PC permissions.'));},[]);
  // Refresh pending requests and expiry displays, including while this tab is
  // open. No optimistic permission updates: success comes from durable storage.
  useEffect(()=>{const timer=setInterval(()=>{void refresh().catch(()=>undefined);},15000);return()=>clearInterval(timer);},[]);
  async function change(work:()=>Promise<unknown>){setBusy(true);setError('');try{await work();await refresh();}catch(e){setError(e instanceof Error?e.message:'Could not save that.');}finally{setBusy(false);}}
  async function save(){if(!spec)return;await change(()=>api.put(endpoint+'/policies',{action,scope:{kind:spec.kind,target,
    ...(['browser','command'].includes(spec.kind)?{application}:{}),...(spec.kind==='browser'?{profile}:{})},mode,
    ...(mode==='task'?{taskId}:{}),...(mode==='temporary'?{expiresAt:expires?new Date(expires).toISOString():''}:{})}));}
  const inputClass='min-h-11 w-full rounded-md border border-input bg-background px-3';
  return <div className="mx-auto max-w-4xl space-y-6">
    <h1 className="text-xl font-semibold">PC control permissions</h1>
    {error?<ErrorNote>{error}</ErrorNote>:null}
    <section className="space-y-3 rounded-lg border p-4">
      <p role="status">{state?.availability??'Loading PC permissions…'}</p>
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={state?.enabled??false} disabled={!state||busy}
        onChange={e=>void change(()=>api.put(endpoint+'/enabled',{enabled:e.target.checked}))}/>Allow Josi to control this PC</label>
      <p className="text-sm text-muted-foreground">Off by default. Turning this on does not grant any browser, folder or application access. These permissions apply only to this hosting PC and your account.</p>
      <Button variant="danger" onClick={()=>void change(()=>api.post(endpoint+'/stop',{}))}>Stop control and revoke temporary access</Button>
      <p className="text-sm">Emergency stop disables control, cancels active broker actions and revokes pending approvals and task/temporary grants. Completed changes cannot be undone. Permanent scope choices remain saved.</p>
      <p className="text-sm">{state?.uac}</p>
    </section>
    {state?<>
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-semibold">Choose one exact scope</h2>
        <p className="text-sm">Each browser executable, browser profile and origin needs its own permission. Folder choices apply to that exact folder; application choices apply to that exact executable. No wildcard or inherited grants.</p>
        <div><label className="block" htmlFor="pc-action">Action</label><select id="pc-action" className={inputClass} value={action} onChange={e=>{setAction(e.target.value);setTarget('');setApplication('');setProfile('');}}>{state.catalog.map(c=><option key={c.action} value={c.action}>{c.label}</option>)}</select></div>
        {spec?<p>{spec.access}{spec.highRisk?' · Separate approval for each exact action is required in every mode.':''}</p>:null}
        <label className="block">{spec?.kind==='browser'?'Exact website origin (for example, https://example.com)':spec?.kind==='application'?'Exact application .exe path':spec?.kind==='folder'||spec?.kind==='command'?'Exact local folder path':spec?.kind==='secret'?'Exact credential/item identifier':'Exact software or settings scope'}
          <input className={inputClass} value={target} onChange={e=>setTarget(e.target.value)} autoComplete="off"/></label>
        {['browser','command'].includes(spec?.kind??'')?<label className="block">Exact {spec?.kind==='browser'?'browser':'command runner'} .exe path<input className={inputClass} value={application} onChange={e=>setApplication(e.target.value)} autoComplete="off"/></label>:null}
        {spec?.kind==='browser'?<label className="block">Exact browser profile<input className={inputClass} value={profile} onChange={e=>setProfile(e.target.value)} autoComplete="off"/></label>:null}
        <div><label className="block" htmlFor="pc-mode">Approval mode</label><select id="pc-mode" className={inputClass} value={mode} onChange={e=>setMode(e.target.value)}>{MODES.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>
        {mode==='task'?<div><label className="block" htmlFor="pc-task">Exact active Josi task</label><select id="pc-task" className={inputClass} value={taskId} onChange={e=>setTaskId(e.target.value)}><option value="">Choose your task</option>{state.tasks.map(t=><option key={t.id} value={t.id}>{t.name} · {new Date(t.created_at).toLocaleString()} · {t.id.slice(0,8)}</option>)}</select><p className="text-sm">Expires when this task ends, or after 24 hours, whichever comes first.</p></div>:null}
        {mode==='temporary'?<label className="block">Expires at (your local time, within 24 hours)<input className={inputClass} type="datetime-local" value={expires} onChange={e=>setExpires(e.target.value)}/></label>:null}
        <Button disabled={busy||!target||(spec?.kind==='browser'&&(!application||!profile))||(spec?.kind==='command'&&!application)||(mode==='task'&&!taskId)||(mode==='temporary'&&!expires)} onClick={()=>void save()}>Save exact-scope permission</Button>
        <p className="text-sm text-muted-foreground">Deleting, submissions/messages, financial actions, credential access, installs/uninstalls, security changes and elevation always ask separately. Commands and generic application control also ask because they can hide these effects. Existing workspace and connector permissions are unchanged.</p>
      </section>
      <section className="space-y-3"><h2 className="font-semibold">Saved scopes and temporary access</h2>
        {!state.policies.length?<p>No scopes granted. Unlisted scopes ask before each action while the master switch is on.</p>:null}
        {state.policies.map(p=>{const c=state.catalog.find(x=>x.action===p.action);return <article key={p.id} className="space-y-2 rounded-lg border p-4"><h3 className="font-medium">{c?.label}</h3><p><ScopeText scope={p.scope}/></p><p>{c?.access} · {MODES.find(x=>x[0]===p.mode)?.[1]}{!p.active?' · Expired or task ended':''}</p>
          {p.taskId?<p className="break-all">Exact task: {p.taskId}</p>:null}{p.expiresAt?<p>Expires: <time dateTime={p.expiresAt}>{new Date(p.expiresAt).toLocaleString()}</time></p>:null}
          {c?.highRisk?<p>Each exact action still requires approval.</p>:null}<Button variant="secondary" disabled={busy} onClick={()=>void change(()=>api.del(endpoint+'/policies/'+p.id))}>Revoke</Button></article>;})}
      </section>
      <section className="space-y-3"><h2 className="font-semibold">Actions awaiting approval</h2>{!state.requests.length?<p>No actions awaiting approval.</p>:null}
        {state.requests.map(q=><article key={q.id} className="space-y-2 rounded-lg border p-4"><h3 className="font-medium">{q.description}</h3><p>{q.access}{q.highRisk?' · High risk':''}</p>
          {q.requirements.map((r,i)=><p key={i}>{state.catalog.find(c=>c.action===r.action)?.label}: <ScopeText scope={r.scope}/></p>)}{q.taskId?<p>Task: {q.taskId}</p>:null}
          <p>Expires: <time dateTime={q.expiresAt}>{new Date(q.expiresAt).toLocaleString()}</time></p>
          {q.highRisk?<label className="block">Confirm your account password<input className={inputClass} type="password" autoComplete="current-password" value={passwords[q.id]??''} onChange={e=>setPasswords(s=>({...s,[q.id]:e.target.value}))}/></label>:null}
          <div className="flex flex-wrap gap-2"><Button disabled={busy||(q.highRisk&&!passwords[q.id])} onClick={()=>{const password=passwords[q.id]??'';setPasswords(s=>({...s,[q.id]:''}));void change(()=>api.post(endpoint+'/requests/'+q.id+'/decision',{approve:true,password}));}}>Approve this exact action once</Button>
          <Button variant="secondary" disabled={busy} onClick={()=>void change(()=>api.post(endpoint+'/requests/'+q.id+'/decision',{approve:false}))}>Deny</Button></div></article>)}
      </section>
      <section className="space-y-3"><h2 className="font-semibold">Activity log</h2><p className="text-sm">Latest 100 attempts, access/change actions, launches, decisions and outcomes. Sensitive form values, command output and credentials are omitted. Scope details are encrypted locally.</p>
        {!state.activity.length?<p>No PC control activity.</p>:null}{state.activity.map(e=><article key={e.id} className="rounded-lg border p-3"><time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time><p>{e.kind}{e.description?`: ${e.description}`:''}</p>{e.requirements?.map((r,i)=><p key={i}>{state.catalog.find(c=>c.action===r.action)?.label}: <ScopeText scope={r.scope}/></p>)}</article>)}
      </section>
    </>:null}
  </div>;
}
