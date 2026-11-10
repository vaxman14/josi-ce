import {useRef,useState} from 'react';
import {api} from '@/lib/api';
import {Button,ErrorNote} from '@/components/ui';
import {PcPermissionCard} from '@/components/PcPermissionCards';
import {CredentialCard} from '@/components/CredentialCards';
import {SignInCard} from '@/components/SignInCards';
import {applyChange,claimApply,isCredentialProposal,isPcProposal,isSettingsProposal,isSignInProposal,releaseApply,type ApplyRequest,type Proposal} from '@/lib/settingsChanges';

// Every other settings change Josi prepares in conversation (docs/JOSI_IS_THE_INTERFACE.md
// rule 1), member connector requests included: answered right here, like the
// Windows popup (Dialogs / AppModel.DecideSettingsChange). Approve asks for the
// account password when the server will (a sensitive change); an approved
// change this person's app applies is performed with their session and
// reported to /applied. "Not now" decides nothing and only puts the card away.

const message=(e:unknown,fallback:string)=>e instanceof Error&&e.message?e.message:fallback;

export function SettingsChangeCard({proposal,needsPassword,onDone}:{proposal:Proposal;needsPassword:boolean;onDone:()=>void}){
  // Approved already (elsewhere, or here before a password was needed): only the apply is left.
  const [pending,setPending]=useState<ApplyRequest|null>(proposal.state==='approved'?proposal.apply:null);
  const [askPassword,setAskPassword]=useState(needsPassword);
  const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[note,setNote]=useState('');
  const lock=useRef(false);
  const passwordBox=proposal.sensitive&&!pending||askPassword;
  const request=proposal.area==='member_connector_request';
  async function run(work:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await work();}catch(e){setError(message(e,'That did not go through.'));}finally{lock.current=false;setBusy(false);}}
  async function apply(change:ApplyRequest,secret:string|undefined){
    const outcome=await applyChange(proposal.id,change,secret);
    if('password' in outcome){setPending(change);setAskPassword(true);setError('This setting asks for your account password to go live. Type it and choose Apply.');return;}
    if(!outcome.ok)throw new Error(`Not applied: ${outcome.error}`);
    onDone();
  }
  const approve=()=>run(async()=>{
    const secret=password;setPassword('');
    if(pending){await apply(pending,secret||undefined);return;}
    // The poll must not perform what this card is about to.
    claimApply(proposal.id);
    let decided:{state:string;apply:ApplyRequest|null};
    try{decided=await api.post<{state:string;apply:ApplyRequest|null}>(`/settings-changes/${proposal.id}/decide`,proposal.sensitive?{approve:true,password:secret}:{approve:true});}
    catch(e){releaseApply(proposal.id);throw e;}
    if(!decided.apply){
      setNote(`Approved. It is applied by ${proposal.scope==='administrator'?"the administrator's":`${proposal.proposer}'s`} Josi.`);
      window.setTimeout(onDone,2500);return;
    }
    await apply(decided.apply,proposal.sensitive?secret:undefined);
  });
  const decline=()=>run(async()=>{await api.post(`/settings-changes/${proposal.id}/decide`,{approve:false});onDone();});
  return <article className="approval-card rounded-xl p-4" aria-label={request?'Connector request':'Settings change'} aria-busy={busy} data-testid="josi.chat.settings-change">
    <p className="text-xs text-text-muted">{request?`${proposal.proposer} asks`:proposal.mine?'Josi proposes':`${proposal.proposer} asked Josi`}{proposal.scope==='administrator'?' · administrator setting':''}</p>
    <h3 className="font-display font-semibold">{proposal.title}</h3>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{proposal.summary}</p>
    {pending?<p className="mt-2 text-sm">Approved. Applying it needs your account password.</p>:null}
    {note?<p className="mt-2 text-sm" role="status">{note}</p>:null}
    {error?<div role="alert" className="mt-2"><ErrorNote>{error}</ErrorNote></div>:null}
    {note?null:<form className="mt-3 flex flex-col gap-2" onSubmit={event=>{event.preventDefault();void approve();}}>
      {passwordBox?<label className="flex min-w-0 flex-col gap-1 text-sm">Account password{proposal.sensitive&&!pending?' (this change is sensitive)':''}
        <input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} className="min-h-11 rounded-lg border border-current bg-transparent px-3 text-base" required disabled={busy}/></label>:null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy||(passwordBox&&!password)}>{pending?'Apply':'Approve'}</Button>
        {proposal.canDeny||proposal.canApprove?<Button type="button" variant="secondary" disabled={busy} onClick={()=>void decline()}>Decline</Button>:null}
        <Button type="button" variant="secondary" disabled={busy} onClick={onDone}>Not now</Button>
      </div>
    </form>}
  </article>;
}

/** Any proposal's card: PC permission, credential card or settings change. */
export function ProposalCard({proposal,needsPassword,onDone}:{proposal:Proposal;needsPassword:readonly string[];onDone:()=>void}){
  if(isPcProposal(proposal))return <PcPermissionCard proposal={proposal} onDone={onDone}/>;
  if(isSignInProposal(proposal))return <SignInCard proposal={proposal} onDone={onDone}/>;
  if(isCredentialProposal(proposal))return proposal.card?<CredentialCard proposal={proposal} onDone={onDone}/>:null;
  return <SettingsChangeCard proposal={proposal} needsPassword={needsPassword.includes(proposal.id)} onDone={onDone}/>;
}

/** The settings-change cards among a conversation's proposals. */
export function SettingsChangeCards({proposals,needsPassword,onDone}:{proposals:Proposal[];needsPassword:readonly string[];onDone:(id:string)=>void}){
  const visible=proposals.filter(isSettingsProposal);
  if(!visible.length)return null;
  return <section aria-label="Settings changes" className="my-3 flex flex-col gap-3">{visible.map(proposal=><SettingsChangeCard key={proposal.id} proposal={proposal} needsPassword={needsPassword.includes(proposal.id)} onDone={()=>onDone(proposal.id)}/>)}</section>;
}
