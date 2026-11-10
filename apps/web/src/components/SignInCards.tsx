import {useCallback,useEffect,useState} from 'react';
import {api,ApiError} from '@/lib/api';
import {Button,ErrorNote} from '@/components/ui';
import {LiveSignIn} from '@/components/LiveSignIn';
import {isSignInProposal,signInCard,type Proposal} from '@/lib/settingsChanges';

// "Sign in for Josi" (docs/LIVE_SIGN_IN.md): Josi needs a login she cannot do,
// so a card in chat lets the person do it themselves on a live view of her
// browser or in a terminal. Josi's model learns only whether they finished.

const keyFor=(id:string)=>`josi_live_session_${id}`;
const remembered=(id:string)=>{try{return sessionStorage.getItem(keyFor(id));}catch{return null;}};
const remember=(id:string,session:string|null)=>{try{if(session)sessionStorage.setItem(keyFor(id),session);else sessionStorage.removeItem(keyFor(id));}catch{/* the card still works */}};

/** What the person is told when the server refuses to open the session. */
export function openFailure(e:unknown):string{
  if(e instanceof ApiError){
    if(e.status===409)return e.message&&!/^Request failed/.test(e.message)?e.message:'Someone else is signing in on that computer right now. Try again when they are done.';
    if(e.status===403)return e.message&&!/^Request failed/.test(e.message)?e.message:'You are not allowed to sign in for Josi. Ask the owner to allow it.';
    return e.message;
  }
  return e instanceof Error?e.message:'Could not open the sign-in.';
}

export function SignInCard({proposal,onDone}:{proposal:Proposal;onDone:()=>void}){
  const card=signInCard(proposal);
  const [session,setSession]=useState<string|null>(()=>remembered(proposal.id));
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
  const finished=useCallback((outcome:'done'|'cancelled'|'lost')=>{
    remember(proposal.id,null);setSession(null);
    if(outcome==='lost')setNote('That sign-in ended.');
    onDone();
  },[proposal.id,onDone]);
  // A page reload with a session open comes back to it.
  useEffect(()=>{setSession(remembered(proposal.id));},[proposal.id]);
  if(!card)return null;
  async function open(){
    if(busy)return;
    setBusy(true);setError('');
    try{
      const opened=await api.post<{id:string}>('/live-signin/sessions',{cardId:proposal.id});
      remember(proposal.id,opened.id);setSession(opened.id);
    }catch(e){setError(openFailure(e));}
    finally{setBusy(false);}
  }
  return <article className="approval-card rounded-xl p-4" aria-label={card.title} aria-busy={busy} data-testid="josi.chat.sign-in">
    <h3 className="font-display font-semibold">{card.title}</h3>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{card.intro}</p>
    {card.mode==='terminal'
      ?<div className="mt-2 text-sm"><p className="text-xs opacity-80">This runs exactly:</p><code className="mt-1 block break-all rounded bg-secondary px-2 py-1 font-mono text-xs">{card.command}</code>{card.runAs?<p className="mt-1 text-xs opacity-80">runs as {card.runAs}</p>:null}</div>
      :card.url?<p className="mt-2 text-sm break-all">Site: <span className="font-mono text-xs">{card.url}</span></p>:null}
    <p className="mt-2 text-xs opacity-80">You sign in yourself. Josi never sees the screen or what you type.</p>
    {note?<p className="mt-2 text-sm" role="status">{note}</p>:null}
    {error?<div role="alert" className="mt-2"><ErrorNote>{error}</ErrorNote></div>:null}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button type="button" disabled={busy||!!session} onClick={()=>void open()}>{busy?'Opening…':session?'Open':'Open'}</Button>
      <Button type="button" variant="secondary" disabled={busy||!!session} onClick={onDone}>Not now</Button>
    </div>
    {session?<LiveSignIn sessionId={session} card={card} onFinished={finished}/>:null}
  </article>;
}

/** The sign-in cards among a conversation's proposals. */
export function SignInCards({proposals,onDone}:{proposals:Proposal[];onDone:(id:string)=>void}){
  const visible=proposals.filter(p=>isSignInProposal(p)&&p.canApprove&&p.state==='proposed'&&signInCard(p));
  if(!visible.length)return null;
  return <section aria-label="Sign-in cards" className="my-3 flex flex-col gap-3">{visible.map(proposal=><SignInCard key={proposal.id} proposal={proposal} onDone={()=>onDone(proposal.id)}/>)}</section>;
}
