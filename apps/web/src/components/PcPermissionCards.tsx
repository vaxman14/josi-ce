import 'webauthn-polyfills';
import {useEffect,useRef,useState} from 'react';
import {api} from '@/lib/api';
import {passkeyMessage} from '@/lib/passkeys';
import {Button,ErrorNote} from '@/components/ui';

type Proposal={id:string;threadId:string;area:string;title:string;summary:string;sensitive:boolean;canApprove:boolean};
type Challenge={id:string;options:Parameters<typeof PublicKeyCredential.parseRequestOptionsFromJSON>[0]};

function Card({proposal,onDone}:{proposal:Proposal;onDone:()=>void}){
  const [challenge,setChallenge]=useState<Challenge|null>(null);
  const [password,setPassword]=useState(''),[passwordForm,setPasswordForm]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
  const abort=useRef<AbortController|null>(null),lock=useRef(false);
  const supports=window.isSecureContext&&typeof PublicKeyCredential!=='undefined';
  useEffect(()=>{
    let alive=true;
    setChallenge(null);
    if(supports&&proposal.sensitive)void api.post<Challenge>(`/settings-changes/${proposal.id}/pc-passkey/options`,{}).then(value=>{if(alive)setChallenge(value);}).catch(()=>{});
    return()=>{alive=false;abort.current?.abort();};
  },[proposal.id,proposal.sensitive,supports,reload]);
  async function approve(usePasskey:boolean){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    const secret=password;setPassword('');
    try{
      if(usePasskey){
        if(!challenge)throw new Error('Prepare a new approval before continuing.');
        abort.current?.abort();abort.current=new AbortController();
        // Prepared before the click so Safari keeps the user gesture for the
        // native credential prompt. The exact change remains visible below it.
        const credential=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON(challenge.options),signal:abort.current.signal}) as PublicKeyCredential|null;
        if(!credential)throw new Error('No passkey approval was received.');
        await api.post(`/settings-changes/${proposal.id}/pc-apply`,{challengeId:challenge.id,passkey:credential.toJSON()});
      }else await api.post(`/settings-changes/${proposal.id}/pc-apply`,{password:secret});
      onDone();
    }catch(e){setError(passkeyMessage(e,'The permission was not changed.'));setReload(value=>value+1);}
    finally{lock.current=false;setBusy(false);}
  }
  return <article className="approval-card rounded-xl p-4" aria-label="Computer permission review" aria-busy={busy}>
    <h3 className="font-display font-semibold">{proposal.title}</h3>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{proposal.summary}</p>
    {error?<div role="alert" className="mt-2"><ErrorNote>{error}</ErrorNote></div>:null}
    <div className="mt-3 flex flex-wrap gap-2">
      {proposal.sensitive&&supports?<Button disabled={busy||!challenge} onClick={()=>void approve(true)}>Approve with passkey</Button>:null}
      {!proposal.sensitive?<Button disabled={busy} onClick={()=>void approve(false)}>Apply change</Button>:<Button variant="secondary" disabled={busy} onClick={()=>setPasswordForm(value=>!value)}>Use account password</Button>}
      <Button variant="secondary" disabled={busy} onClick={()=>{if(lock.current)return;lock.current=true;setBusy(true);void api.post(`/settings-changes/${proposal.id}/decide`,{approve:false}).then(onDone).catch(e=>setError(e instanceof Error?e.message:'Could not decline.')).finally(()=>{lock.current=false;setBusy(false);});}}>Decline</Button>
    </div>
    {passwordForm?<form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={event=>{event.preventDefault();void approve(false);}}>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">Account password<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} className="min-h-11 rounded-lg border border-current bg-transparent px-3 text-base" required disabled={busy}/></label>
      <Button type="submit" disabled={busy||!password}>Approve</Button>
    </form>:null}
  </article>;
}
export function PcPermissionCards({threadId}:{threadId:string}){
  const [proposals,setProposals]=useState<Proposal[]>([]),[done,setDone]=useState<string[]>([]);
  useEffect(()=>{
    let alive=true,pending=false;
    async function refresh(){if(pending||document.hidden)return;pending=true;try{const result=await api.get<{proposals:Proposal[]}>('/settings-changes');if(alive)setProposals(result.proposals.filter(p=>p.threadId===threadId&&p.area.startsWith('pc_control_')&&p.canApprove));}catch{}finally{pending=false;}}
    void refresh();const timer=window.setInterval(()=>void refresh(),6000);
    return()=>{alive=false;window.clearInterval(timer);};
  },[threadId]);
  const visible=proposals.filter(p=>!done.includes(p.id));
  if(!visible.length)return null;
  return <section aria-label="Computer permissions" className="my-3 flex flex-col gap-3">{visible.map(proposal=><Card key={proposal.id} proposal={proposal} onDone={()=>setDone(ids=>[...ids,proposal.id])}/>)}</section>;
}
