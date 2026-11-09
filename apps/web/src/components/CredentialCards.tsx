import {useEffect,useState} from 'react';
import {api} from '@/lib/api';
import {Button,ErrorNote,Input} from '@/components/ui';

// A credential card Josi opened in conversation (docs/JOSI_IS_THE_INTERFACE.md
// rules 3 and 5): the person pastes into secure fields; the browser performs
// the route with their own session; the conversation learns only "saved".
type Field={key:string;label:string;type:'text'|'secret'|'confirm';help?:string;required?:boolean;placeholder?:string};
type Card={kind:string;provider:string;title:string;intro:string;fields:Field[];help:{text:string;url:string|null};done:string};
export type CardProposal={id:string;threadId:string;area:string;title:string;summary:string;canApprove:boolean;card:Card|null};
type Apply={method:string;path:string;body:Record<string,unknown>|null};

function smtpBody(fixed:Record<string,unknown>,values:Record<string,unknown>):Record<string,unknown>{
  const s=(key:string)=>typeof values[key]==='string'?values[key] as string:'';
  const port=Number.parseInt(s('port'),10);
  const from=s('fromAddress'),fromName=s('fromName');
  return {expected:fixed.expected??null,
    system:{copyFromSystem:false,host:s('host'),port:Number.isFinite(port)?port:0,security:s('security').toLowerCase(),username:s('username'),password:s('password'),clearPassword:false,fromName,fromAddress:from},
    communications:{copyFromSystem:true,host:'',port:0,security:'',username:'',password:'',clearPassword:false,fromName,fromAddress:from}};
}

function CredentialCard({proposal,onDone}:{proposal:CardProposal;onDone:()=>void}){
  const card=proposal.card!;
  const [values,setValues]=useState<Record<string,unknown>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save(event:React.FormEvent){
    event.preventDefault();
    if(busy)return;
    for(const field of card.fields){
      const value=values[field.key];
      if(field.required!==false&&(field.type==='confirm'?value!==true:!(typeof value==='string'&&value.trim()))){setError(field.type==='confirm'?`Please confirm: ${field.label}`:`${field.label} is required.`);return;}
    }
    setBusy(true);setError('');
    let failure:string|null=null;
    try{
      const decided=await api.post<{apply:Apply|null}>(`/settings-changes/${proposal.id}/decide`,{approve:true});
      if(!decided.apply)throw new Error('This card can only be filled in by the person it was opened for.');
      const fixed=decided.apply.body??{};
      const body=fixed.__shape==='smtp'?smtpBody(fixed,values):{...fixed,...values};
      try{
        const method=decided.apply.method.toUpperCase();
        if(method==='PUT')await api.put(decided.apply.path,body);
        else if(method==='PATCH')await api.patch(decided.apply.path,body);
        else await api.post(decided.apply.path,body);
      }catch(e){failure=e instanceof Error?e.message:'The credential was not accepted.';}
      await api.post(`/settings-changes/${proposal.id}/applied`,failure===null?{ok:true}:{ok:false,error:failure}).catch(()=>{});
      if(failure!==null)throw new Error(failure);
      setValues({});
      onDone();
    }catch(e){setError(e instanceof Error?e.message:'Could not save.');setValues(current=>Object.fromEntries(Object.entries(current).filter(([key])=>card.fields.find(f=>f.key===key)?.type!=='secret')));}
    finally{setBusy(false);}
  }
  return <article className="approval-card rounded-xl p-4" aria-label={card.title} aria-busy={busy}>
    <h3 className="font-display font-semibold">{card.title}</h3>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{card.intro}</p>
    <form className="mt-3 flex flex-col gap-3" onSubmit={save} autoComplete="off">
      {card.fields.map(field=>field.type==='confirm'
        ?<label key={field.key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={values[field.key]===true} onChange={event=>setValues(v=>({...v,[field.key]:event.target.checked}))} disabled={busy}/>{field.label}</label>
        :<label key={field.key} className="flex flex-col gap-1 text-sm">{field.label}{field.required===false?' (optional)':''}
          <Input type={field.type==='secret'?'password':'text'} autoComplete={field.type==='secret'?'new-password':'off'} placeholder={field.placeholder} value={typeof values[field.key]==='string'?values[field.key] as string:''} onChange={event=>setValues(v=>({...v,[field.key]:event.target.value}))} disabled={busy}/>
        </label>)}
      <p className="text-xs opacity-80">{card.help.text}{card.help.url?<> <a className="underline" href={card.help.url} target="_blank" rel="noreferrer noopener">Open {new URL(card.help.url).host}</a></>:null}</p>
      <p className="text-xs opacity-80">What you paste goes to this Josi's Vault only. Josi never sees it, and it never appears in the conversation.</p>
      {error?<div role="alert"><ErrorNote>{error}</ErrorNote></div>:null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>Save</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={()=>{setBusy(true);void api.post(`/settings-changes/${proposal.id}/decide`,{approve:false}).then(onDone).catch(e=>setError(e instanceof Error?e.message:'Could not decline.')).finally(()=>setBusy(false));}}>Decline</Button>
      </div>
    </form>
  </article>;
}

export function CredentialCards({threadId}:{threadId:string}){
  const [proposals,setProposals]=useState<CardProposal[]>([]),[done,setDone]=useState<string[]>([]);
  useEffect(()=>{
    let alive=true,pending=false;
    async function refresh(){if(pending||document.hidden)return;pending=true;try{const result=await api.get<{proposals:CardProposal[]}>('/settings-changes');if(alive)setProposals(result.proposals.filter(p=>p.threadId===threadId&&p.area==='credential_card'&&p.canApprove&&p.card));}catch{}finally{pending=false;}}
    void refresh();const timer=window.setInterval(()=>void refresh(),5000);
    return()=>{alive=false;window.clearInterval(timer);};
  },[threadId]);
  const visible=proposals.filter(p=>!done.includes(p.id));
  if(!visible.length)return null;
  return <section aria-label="Credential cards" className="my-3 flex flex-col gap-3">{visible.map(proposal=><CredentialCard key={proposal.id} proposal={proposal} onDone={()=>setDone(ids=>[...ids,proposal.id])}/>)}</section>;
}
