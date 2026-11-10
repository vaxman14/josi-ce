import {useState} from 'react';
import {api} from '@/lib/api';
import {Button,ErrorNote,Input} from '@/components/ui';
import {accountConnectionProvider,claimApply,isCredentialProposal,rememberAccountCard,releaseApply,type ApplyRequest,type Proposal} from '@/lib/settingsChanges';

// A credential card Josi opened in conversation (docs/JOSI_IS_THE_INTERFACE.md
// rules 3 and 5): the person pastes into secure fields; the browser performs
// the route with their own session; the conversation learns only "saved".
type Apply=ApplyRequest;

function smtpBody(fixed:Record<string,unknown>,values:Record<string,unknown>):Record<string,unknown>{
  const s=(key:string)=>typeof values[key]==='string'?values[key] as string:'';
  const port=Number.parseInt(s('port'),10);
  const from=s('fromAddress'),fromName=s('fromName');
  return {expected:fixed.expected??null,
    system:{copyFromSystem:false,host:s('host'),port:Number.isFinite(port)?port:0,security:s('security').toLowerCase(),username:s('username'),password:s('password'),clearPassword:false,fromName,fromAddress:from},
    communications:{copyFromSystem:true,host:'',port:0,security:'',username:'',password:'',clearPassword:false,fromName,fromAddress:from}};
}

/** "Sign in with <provider>": nothing to type. Claims the card, starts the
 * ordinary web handshake (no native flag) and leaves for the provider; the
 * return to /app reports the outcome (lib/settingsChanges.ts finishAccountCard). */
function AccountConnectionCard({proposal,provider,onDone}:{proposal:Proposal;provider:string;onDone:()=>void}){
  const card=proposal.card!;
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const name=card.title.replace(/^Connect\s+/,'')||provider;
  async function signIn(){
    if(busy)return;
    setBusy(true);setError('');
    claimApply(proposal.id);
    try{
      const decided=await api.post<{apply:Apply|null}>(`/settings-changes/${proposal.id}/decide`,{approve:true});
      if(!decided.apply)throw new Error('This card can only be used by the person it was opened for.');
      const started=await api.post<{url:string}>(decided.apply.path,{returnPath:'/app'});
      rememberAccountCard(proposal.id,provider);
      window.location.assign(started.url);
    }catch(e){
      releaseApply(proposal.id);
      setError(e instanceof Error?e.message:'Could not start the sign-in.');setBusy(false);
    }
  }
  return <article className="approval-card rounded-xl p-4" aria-label={card.title} aria-busy={busy}>
    <h3 className="font-display font-semibold">{card.title}</h3>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{card.intro}</p>
    {error?<div role="alert" className="mt-2"><ErrorNote>{error}</ErrorNote></div>:null}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button type="button" disabled={busy} onClick={()=>void signIn()}>{busy?'Opening…':`Sign in with ${name}`}</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={()=>{setBusy(true);void api.post(`/settings-changes/${proposal.id}/decide`,{approve:false}).then(onDone).catch(e=>setError(e instanceof Error?e.message:'Could not decline.')).finally(()=>setBusy(false));}}>Decline</Button>
    </div>
  </article>;
}

export function CredentialCard({proposal,onDone}:{proposal:Proposal;onDone:()=>void}){
  const account=accountConnectionProvider(proposal);
  if(account)return <AccountConnectionCard proposal={proposal} provider={account} onDone={onDone}/>;
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
    // The background poll must not try to perform this card's route itself.
    claimApply(proposal.id);
    try{
      const decided=await api.post<{apply:Apply|null}>(`/settings-changes/${proposal.id}/decide`,{approve:true});
      if(!decided.apply)throw new Error('This card can only be filled in by the person it was opened for.');
      const fixed:Record<string,unknown>=decided.apply.body&&typeof decided.apply.body==='object'&&!Array.isArray(decided.apply.body)?decided.apply.body as Record<string,unknown>:{};
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
    }catch(e){releaseApply(proposal.id);setError(e instanceof Error?e.message:'Could not save.');setValues(current=>Object.fromEntries(Object.entries(current).filter(([key])=>card.fields.find(f=>f.key===key)?.type!=='secret')));}
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

/** The credential cards among a conversation's proposals. */
export function CredentialCards({proposals,onDone}:{proposals:Proposal[];onDone:(id:string)=>void}){
  const visible=proposals.filter(p=>isCredentialProposal(p)&&p.canApprove&&p.state==='proposed'&&p.card);
  if(!visible.length)return null;
  return <section aria-label="Credential cards" className="my-3 flex flex-col gap-3">{visible.map(proposal=><CredentialCard key={proposal.id} proposal={proposal} onDone={()=>onDone(proposal.id)}/>)}</section>;
}
