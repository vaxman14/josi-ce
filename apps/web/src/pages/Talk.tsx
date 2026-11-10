// Talking to Josi.
//
// Ported from the engine's Assistant component, and the details below are the
// ones that were expensive to learn. The engine's send path was rewritten three
// times chasing a bug that turned out to be an account with no workspace — so
// what survived is deliberately the SIMPLEST thing that works, and it is worth
// stating why each piece is here before someone "cleans it up":
//
//   * A plain <form onSubmit> with a type="submit" button. The tap, the Enter
//     key and a mouse click all arrive through one path. Earlier versions bolted
//     pointerdown and touchend handlers on top, which on iOS produced double
//     sends and, on one path, none at all.
//   * text-base on the textarea. Anything smaller and Safari zooms the page
//     when the field takes focus, which reads to a user as a layout bug.
//   * h-11 w-11 on the button — 44x44, the iOS tap target minimum.
//   * pb-[max(...,env(safe-area-inset-bottom))] plus viewport-fit=cover in
//     index.html, or the composer sits under the home indicator.
//   * Plain 100dvh height, normal flex flow, NO VisualViewport JS. A previous
//     round drove the height from a VisualViewport handler and the composer
//     shot to the top of the screen when the keyboard opened (round-2 item
//     25). iOS pans the focused field into view natively; let it.
//   * A send lock, because a double tap must not send twice.
//
// The e2e suite taps this button in WebKit with touch emulation, which is the
// closest thing to Safari on an iPhone that runs unattended.
//
// THE GHOST STAGE. The page is the Josi ghost, big in the middle, and one line
// under it: an acknowledgement while Josi works, then her latest reply coming
// in word by word. There is no bubble list on the stage; the whole
// conversation, with its work cards and approvals, is the History panel that
// slides up over it. The header's status, the thinking chip and the ghost all
// follow one state (src/lib/ghost.ts). The panel is `inert` while closed but
// stays laid out, so the transcript keeps its scroll position and every
// bubble is in the DOM the moment it is sent.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { api, ApiError, type Approval, type Message, type Thread, type TurnResult } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { JosiMark } from '@/components/brand/JosiMark';
import type { ShellOutlet } from '@/components/layout/Shell';
import { VoiceChat } from '@/components/VoiceChat';
import { ChatWorkProgressList } from '@/components/WorkProgress';
import { GhostFigure, StageReply, useReducedMotion } from '@/components/ghost/Ghost';
import { useWorkGoals } from '@/lib/workGoals';
import { PcPermissionCards } from '@/components/PcPermissionCards';
import { CredentialCards } from '@/components/CredentialCards';
import { ProposalCard, SettingsChangeCards } from '@/components/SettingsChangeCards';
import { belongsHere, useSettingsChanges, waitingOnMe } from '@/lib/settingsChanges';
import {
  firstName, GhostController, isListReply, loopFor, nextAcknowledgement, stageMood, type GhostSnapshot,
} from '@/lib/ghost';

const SUGGESTIONS = ["What's on my calendar today?", 'Remind me to call Dana', 'Draft a note to the team'];

type ThreadWork = Pick<ReturnType<typeof useWorkGoals>, 'goals' | 'error' | 'refresh' | 'connection'>;

/** Follows the work this conversation started. Mounted only once there is a
 * thread, so the hook never asks for everybody's work. */
function ThreadWorkWatcher({ threadId, onChange }: { threadId: string; onChange: (work: ThreadWork) => void }) {
  const { goals, error, refresh, connection } = useWorkGoals(threadId, true);
  useEffect(() => { onChange({ goals, error, refresh, connection }); }, [goals, error, refresh, connection, onChange]);
  return null;
}

/** "Today", "Yesterday", or the date — the label WhatsApp taught everyone. */
function dayLabel(at: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (at.toDateString() === today.toDateString()) return 'Today';
  if (at.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: at.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
import { Button, ErrorNote, Working } from '@/components/ui';

const talkCache = new Map<string, { thread: Thread; messages: Message[] }>();

const sentence = (action: string) => {
  const words = action.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Something Josi wants to do, asked right where the conversation is. "Not now"
 * decides nothing: declining is final and belongs to the Approvals page, so this
 * only puts the card away, and the request stays there. */
function ApprovalCard({ approval, onApprove, onLater }: { approval: Approval; onApprove: () => Promise<void>; onLater: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="approval-card w-full max-w-md rounded-lg p-4">
      <p className="font-display text-sm font-semibold">{sentence(approval.action)}</p>
      {/* The exact action, in words, before anyone agrees to it. */}
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-lilac">{approval.summary}</p>
      {approval.action_class === 'email_send' ? <Link to="/app/approvals" className="link mt-1 inline-flex min-h-11 items-center text-sm">See the email first</Link> : null}
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => { setBusy(true); setError(''); void onApprove().catch(err => { setBusy(false); setError(err instanceof Error ? err.message : 'Could not record that'); }); }}>Approve</Button>
        <Button variant="secondary" disabled={busy} onClick={onLater}>Not now</Button>
      </div>
    </div>
  );
}

export function Talk() {
  const [params] = useSearchParams();
  const requestedThread = params.get('thread');
  // Separate mounted conversation state: a late response from the previous
  // conversation must not append its messages to a newly selected goal.
  return <TalkConversation key={requestedThread ?? 'recent'} requestedThread={requestedThread} />;
}

function TalkConversation({ requestedThread }: { requestedThread: string | null }) {
  const { user } = useAuth();
  const previous = user ? talkCache.get(user.id) : undefined;
  const cached = previous && (!requestedThread || previous.thread.id === requestedThread) ? previous : undefined;
  const [thread, setThread] = useState<Thread | null>(cached?.thread ?? null);
  const [messages, setMessages] = useState<Message[]>(cached?.messages ?? []);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(!cached);
  const [sending, setSending] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const inputElement = useRef<HTMLTextAreaElement>(null);
  const sendLock = useRef(false);
  const sendGeneration = useRef(0);
  const followLatest = useRef(true);
  const [backgroundOffline, setBackgroundOffline] = useState(false);
  const { approvals, setChatStatus, chatBarSlot } = useOutletContext<ShellOutlet>();
  // Answered here, or put away with "Not now". The poll catches up on its own.
  const [settled, setSettled] = useState<string[]>([]);
  const pendingApprovals = approvals.filter(approval => !settled.includes(approval.id));
  const navigate = useNavigate();

  // ---- the stage
  const reduced = useReducedMotion();
  const ghostRef = useRef<GhostController | null>(null);
  if (!ghostRef.current) ghostRef.current = new GhostController();
  const ghost = ghostRef.current;
  const [ghostView, setGhostView] = useState<GhostSnapshot>(() => ghost.snapshot());
  const [focused, setFocused] = useState(false);
  const [ack, setAck] = useState('');
  // The reply still coming in word by word, by its text: the background poll
  // swaps a reply's client id for the server's, and that must not restart it.
  const [revealing, setRevealing] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyPanel = useRef<HTMLElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [work, setWork] = useState<ThreadWork>({ goals: [], error: '', refresh: async () => {}, connection: 'connecting' });
  const goalStates = useRef<Map<string, string> | null>(null);
  const typing = focused && input.trim().length > 0;
  const speaking = ghostView.speaking || revealing !== null;
  const mood = stageMood({ waiting: sending, speaking, voice: voiceActive, typing });
  const activeTasks = work.goals.filter(goal => goal.state !== 'completed' && goal.state !== 'cancelled').length;
  const lastReply = [...messages].reverse().find(message => message.direction === 'out');

  // Settings changes, credential cards and PC permissions Josi opened: one
  // poll, checked again the moment a reply lands (lib/settingsChanges.ts).
  const { proposals, needsPassword } = useSettingsChanges(thread?.id, lastReply?.id);
  const [cardsDone, setCardsDone] = useState<string[]>([]);
  const cardDone = useCallback((id: string) => setCardsDone(ids => ids.includes(id) ? ids : [...ids, id]), []);
  const threadCards = thread ? proposals.filter(p => !cardsDone.includes(p.id) && belongsHere(p, thread.id, needsPassword) && waitingOnMe(p, needsPassword)) : [];

  // Hello when the page opens. The controller lives as long as the page.
  useEffect(() => {
    const unsubscribe = ghost.subscribe(setGhostView);
    ghost.set('Hello');
    return () => { unsubscribe(); ghost.dispose(); };
  }, [ghost]);

  useEffect(() => { ghost.set(loopFor({ waiting: sending, voice: voiceActive, typing })); }, [ghost, sending, voiceActive, typing]);

  useEffect(() => { setChatStatus(mood); }, [mood, setChatStatus]);
  useEffect(() => () => setChatStatus('online'), [setChatStatus]);

  // A task this chat follows finishing is worth a celebration. The first
  // snapshot only records where things stand.
  useEffect(() => {
    const before = goalStates.current;
    if (before && work.goals.some(goal => goal.state === 'completed' && before.has(goal.goalId) && before.get(goal.goalId) !== 'completed')) ghost.set('TaskDone');
    goalStates.current = new Map(work.goals.map(goal => [goal.goalId, goal.state]));
  }, [ghost, work.goals]);

  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => { setHistoryOpen(false); historyButton.current?.focus(); }, []);

  useEffect(() => {
    const panel = historyPanel.current;
    if (panel) panel.inert = !historyOpen;
    if (!historyOpen) return;
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    const frame = window.requestAnimationFrame(() => closeButton.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      // The menu, when it is open on top, takes Escape for itself.
      if (event.key === 'Escape' && !document.getElementById('app-menu')) { event.preventDefault(); closeHistory(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener('keydown', onKeyDown); };
  }, [historyOpen, closeHistory]);

  // The most recent thread, or a new one. A member always has somewhere to talk.
  useEffect(() => {
    if (!user || (cached && !requestedThread)) return;
    let alive = true;
    void (async () => {
      try {
        if (requestedThread) {
          if (!/^[a-f0-9-]{36}$/i.test(requestedThread)) throw new Error('Choose an existing conversation.');
          const detail = await api.get<{ thread: Thread; messages: Message[] }>(`/assistant/threads/${requestedThread}?recent=1`);
          if (!alive) return;
          setThread(detail.thread); setMessages(detail.messages);
          talkCache.set(user.id, { thread: detail.thread, messages: detail.messages });
          return;
        }
        const { threads } = await api.get<{ threads: Thread[] }>('/assistant/threads');
        if (!alive) return;
        const existing = threads[0];
        if (existing) {
          const detail = await api.get<{ messages: Message[] }>(`/assistant/threads/${existing.id}?recent=1`);
          if (!alive) return;
          setThread(existing);
          setMessages(detail.messages);
          talkCache.set(user.id, { thread: existing, messages: detail.messages });
        } else {
          const created = await api.post<{ thread: Thread }>('/assistant/threads', { title: 'Talk' });
          if (!alive) return;
          setThread(created.thread);
          talkCache.set(user.id, { thread: created.thread, messages: [] });
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Could not open the conversation');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [user, requestedThread]);

  useEffect(() => {
    if (user && thread) talkCache.set(user.id, { thread, messages });
  }, [messages, thread, user]);

  // Background work writes real messages in the original conversation. Use
  // canonical IDs after foreground sends settle; never merge an optimistic
  // bubble into a second copy of the same server message.
  useEffect(() => {
    if (!thread || !user || loading) return;
    let alive = true, pending = false;
    async function refreshConversation() {
      if (!alive || pending || sendLock.current || document.hidden) return;
      pending = true;
      const generation = sendGeneration.current;
      try {
        const result = await api.get<{ messages: Message[] }>(`/assistant/threads/${thread!.id}?recent=1`);
        if (!alive || sendLock.current || sendGeneration.current !== generation) return;
        setBackgroundOffline(false);
        setMessages(current => JSON.stringify(current) === JSON.stringify(result.messages) ? current : result.messages);
      } catch {
        if (alive) setBackgroundOffline(true);
      } finally { pending = false; }
    }
    void refreshConversation();
    const timer = window.setInterval(() => void refreshConversation(), 5000);
    const visible = () => { if (!document.hidden) void refreshConversation(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [thread?.id, user?.id, loading]);

  // Never animate through the full transcript when a message is sent. On a
  // long thread, that looked exactly like the conversation was being fetched
  // and replayed from the top (especially while Chrome-on-iOS also resized its
  // toolbar). Put the newest message in place immediately; the bubble itself is
  // the motion/feedback the user needs.
  useEffect(() => {
    if (followLatest.current) transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'instant' as ScrollBehavior });
  }, [messages]);

  // When the keyboard opens/closes the page height changes and the scrolling
  // list reflows from the top — visually indistinguishable from the whole
  // conversation reloading (round-2 item 25, Chrome-on-iOS evidence). Re-pin
  // the newest message instantly on every viewport resize so the list never
  // appears to reset. `instant` because an animated correction reads as a
  // second glitch, not a fix.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const repin = () => {
      if (transcript.current && followLatest.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    };
    vv.addEventListener('resize', repin);
    return () => vv.removeEventListener('resize', repin);
  }, []);

  // The field grows with what is typed, up to its max height, and shrinks back
  // when the message goes.
  useEffect(() => {
    const field = inputElement.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [input]);

  // `spoken` is a voice turn, or with `suggested` a suggestion chip: either way
  // the words did not come from the field and attachments stay put.
  async function send(spoken?: string, suggested = false): Promise<string | undefined> {
    if (spoken === undefined && voiceActive) return;
    // Read the DOM value as well as React state: iOS can display composition
    // text before a controlled component catches up.
    const body = (spoken ?? inputElement.current?.value ?? input).trim();
    const attachments = spoken === undefined ? files : [];
    if (!thread || (!body && !attachments.length) || sendLock.current) return;
    sendLock.current = true;
    sendGeneration.current++; followLatest.current = true;

    const optimistic: Message = {
      id: `pending-${Math.random().toString(36).slice(2)}`,
      thread_id: thread.id, direction: 'in', channel: 'web', body: body || 'Sent an attachment',
      created_at: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    if (spoken === undefined) setInput('');
    setSending(true);
    setError('');
    setAck(nextAcknowledgement());
    setRevealing(null);
    ghost.set('Received');

    try {
      const attachmentIds: string[] = [];
      for (const file of attachments) {
        const form = new FormData(); form.append('file', file);
        const uploaded = await api.upload<{ attachment: { id: string; filename: string; contentType: string } }>(`/assistant/threads/${thread.id}/attachments`, form);
        attachmentIds.push(uploaded.attachment.id);
      }
      const uploadedMeta = attachments.map((file, index) => ({
        id: attachmentIds[index], filename: file.name, contentType: file.type || 'application/octet-stream',
      }));
      setMessages((current) => current.map((message) => message.id === optimistic.id
        ? { ...message, meta: { attachments: uploadedMeta } } : message));
      const result = await api.post<TurnResult>(`/assistant/threads/${thread.id}/talk`, { message: body, attachmentIds });
      if (spoken === undefined) setFiles([]);
      if (result.reply !== undefined) {
        // Only a reply somebody was waiting on gets the moment and the reveal;
        // opening a conversation that already has replies never does.
        if (!reduced) setRevealing(result.reply);
        ghost.replied(isListReply(result.reply));
        setMessages((current) => [...current, {
          id: `reply-${Math.random().toString(36).slice(2)}`,
          thread_id: thread.id, direction: 'out', channel: 'web', body: result.reply!,
          created_at: new Date().toISOString(),
        }]);
      }
      return result.reply;
    } catch (err) {
      // A refusal is not a reply. The server answers 503 with the reason when
      // no model is configured, over its cap, or Local-only blocks it; that
      // sentence is shown as itself rather than dressed up as something Josi
      // said.
      const refusal = err instanceof ApiError ? (err.body as TurnResult | null)?.refusal : null;
      const message = refusal?.message ?? (err instanceof ApiError ? err.message : 'Josi could not answer');
      // A refusal (503 with a reason) RECORDED the inbound message server-side.
      // Removing the bubble here made the client disagree with the database,
      // and the next load showed an unexplained duplicate. Keep what was truly
      // recorded; only a transport failure (nothing stored) takes the bubble back.
      if (!refusal) {
        setMessages((current) => current.filter((m) => m.id !== optimistic.id));
        if (spoken === undefined || suggested) setInput(body);
      }
      setError(message);
      ghost.set('Error');
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }

  const greeting = firstName(user);
  const busy = sending || loading || !thread;
  const stageApproval = !sending ? pendingApprovals[0] : undefined;
  // The history panel is closed by default, so a card waiting there would be
  // invisible: the first one sits on the stage under the reply instead. Only
  // one copy is mounted at a time (stage while History is closed, History
  // while open), so a card never holds two passkey challenges or two drafts.
  const stageCard = !sending && !stageApproval && !historyOpen ? threadCards[0] : undefined;
  const waitingCount = pendingApprovals.length + threadCards.length;
  const approve = (approval: Approval) => async () => {
    await api.post(`/assistant/approvals/${approval.id}/decide`, { approve: true });
    setSettled(ids => [...ids, approval.id]);
  };

  return (
    <div
      // The chat sizes itself with plain 100dvh and lives in normal flow: a
      // flex column of stage / composer. When the iOS keyboard opens, Safari
      // pans the visual viewport to keep the focused composer visible —
      // native behaviour, no JS. The previous release drove this height from
      // a VisualViewport handler and the composer ended up rendered at the TOP
      // of the screen with the history invisible (round-2 item 25).
      // data-viewport-managed opts out of the global focus helper.
      data-viewport-managed
      className="flex w-full min-w-0 flex-col overflow-hidden"
      style={{ height: '100%' }}
    >
      <h1 className="sr-only">Chat with Josi</h1>
      {thread ? <ThreadWorkWatcher key={thread.id} threadId={thread.id} onChange={setWork} /> : null}

      {chatBarSlot ? createPortal(<>
        {activeTasks ? (
          <button type="button" onClick={openHistory} className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-[color:var(--hairline-strong)] bg-card/60 px-3 text-xs font-semibold text-primary hover:bg-card">
            {activeTasks} {activeTasks === 1 ? 'task' : 'tasks'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => navigate('/app/my-world')}
          aria-label="My World"
          title="My World"
          data-testid="josi.chat.my-world"
          className="stage-round shrink-0"
        >
          <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="2.5" /><path d="M7.5 18c1-2.5 2.6-3.5 4.5-3.5s3.5 1 4.5 3.5" /></svg>
        </button>
        <button
          ref={historyButton}
          type="button"
          onClick={() => historyOpen ? closeHistory() : openHistory()}
          aria-expanded={historyOpen}
          aria-controls="chat-history"
          aria-label={historyOpen ? 'Close chat history' : messages.length >= 2 ? `Open chat history, ${messages.length} messages` : 'Open chat history'}
          className="stage-round shrink-0"
        >
          <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3 4v4h4" /><path d="M12 8v4.5l3 2" /></svg>
          {messages.length >= 2 ? <span className="btn-gold absolute -right-1 -top-1 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1 text-[0.65rem] font-bold leading-none">{messages.length > 99 ? '99+' : messages.length}</span> : null}
        </button>
      </>, chatBarSlot) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="ghost-stage absolute inset-0 overflow-hidden">
          <div className="mx-auto flex h-full w-full max-w-2xl flex-col items-center justify-center gap-3 px-4 pb-2 pt-3">
            <GhostFigure clip={ghostView.clip} beat={ghostView.beat} reduced={reduced} />
            <div className="flex min-h-[10rem] w-full flex-col items-center gap-2 text-center" aria-live="polite">
              {backgroundOffline ? <p className="text-xs text-text-muted" role="status">Chat updates are offline. Showing the last saved conversation.</p> : null}
              {loading ? <Working text="Opening…" /> : sending ? <>
                <span className="stage-label">Josi</span>
                <p className="stage-text stage-clamp">{ack}</p>
              </> : lastReply ? <>
                <span className="stage-label">Josi</span>
                <div
                  className="w-full cursor-pointer"
                  title="Open chat history"
                  onClick={event => { if (!(event.target as Element).closest('a')) openHistory(); }}
                >
                  <StageReply
                    key={lastReply.body}
                    text={lastReply.body}
                    animate={!reduced && revealing === lastReply.body}
                    onDone={() => setRevealing(current => current === lastReply.body ? null : current)}
                  />
                </div>
              </> : <>
                <h2 className="text-[1.375rem] font-bold">{greeting ? `Hi ${greeting}, I'm Josi.` : "Hi, I'm Josi."}</h2>
                <p className="text-sm text-lilac">Go on, give me something good to do.</p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map(suggestion => (
                    <button key={suggestion} type="button" className="stage-chip" disabled={busy || voiceActive} onClick={() => void send(suggestion, true)}>{suggestion}</button>
                  ))}
                </div>
              </>}
              <span className="stage-thinking" style={{ opacity: mood === 'thinking' ? 1 : 0 }} aria-hidden={mood !== 'thinking'}>
                <i /><i /><i />Josi is thinking
              </span>
              {stageApproval ? (
                <div className="flex w-full flex-col items-center gap-1 text-left">
                  <ApprovalCard approval={stageApproval} onLater={() => setSettled(ids => [...ids, stageApproval.id])} onApprove={approve(stageApproval)} />
                  {waitingCount > 1 ? <button type="button" onClick={openHistory} className="link min-h-11 text-xs">{waitingCount - 1} more waiting in History</button> : null}
                </div>
              ) : stageCard ? (
                <div className="flex w-full flex-col items-center gap-1 text-left">
                  {/* A credential card can be tall; it scrolls rather than pushing the ghost off the stage. */}
                  <div className="max-h-[50dvh] w-full max-w-md overflow-y-auto">
                    <ProposalCard key={stageCard.id} proposal={stageCard} needsPassword={needsPassword} onDone={() => cardDone(stageCard.id)} />
                  </div>
                  {waitingCount > 1 ? <button type="button" onClick={openHistory} className="link min-h-11 text-xs">{waitingCount - 1} more waiting in History</button> : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <section
          id="chat-history"
          ref={historyPanel}
          aria-label="Chat history"
          className={`history-panel absolute inset-0 z-20 flex flex-col ${historyOpen ? 'history-panel-open' : ''}`}
        >
          <div className="hairline-b flex shrink-0 items-center gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <h2 className="text-lg font-bold">Chat history</h2>
              <p className="text-xs text-lilac">{messages.length ? `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}` : 'Nothing yet'}</p>
            </div>
            <button ref={closeButton} type="button" onClick={closeHistory} aria-label="Close chat history" className="stage-round ml-auto text-xl leading-none">×</button>
          </div>
          <div ref={transcript} onScroll={event => {
            const view = event.currentTarget; followLatest.current = view.scrollHeight - view.clientHeight - view.scrollTop < 100;
          }} className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6">
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-2">
            {messages.length >= 200 ? <p className="text-xs text-text-muted">Showing the most recent 200 messages.</p> : null}
            {!loading && messages.length === 0 ? <p className="m-auto max-w-[24ch] text-center text-sm text-lilac">Your conversation with Josi shows up here.</p> : null}
            {messages.map((message, index) => {
              const mine = message.direction === 'in';
              const at = new Date(message.created_at);
              const before = index > 0 ? messages[index - 1] : null;
              const prev = before ? new Date(before.created_at) : null;
              const newDay = !prev || prev.toDateString() !== at.toDateString();
              // The J sits on the first bubble of a run of Josi's, not on every one.
              const firstOfRun = !mine && (newDay || before?.direction === 'in');
              return (
                <Fragment key={message.id}>
                  {newDay ? (
                    <div className="flex justify-center py-1">
                      <span className="text-[0.7rem] uppercase tracking-[0.12em] text-text-muted">
                        {dayLabel(at)}
                      </span>
                    </div>
                  ) : null}
                  <div className={`flex items-start gap-2 ${mine ? 'justify-end' : 'justify-start'}`}>
                    {!mine ? firstOfRun ? <JosiMark size={28} className="mt-0.5" /> : <span aria-hidden className="w-7 shrink-0" /> : null}
                    <div className={`flex min-w-0 max-w-[82%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
                    <div className={`whitespace-pre-wrap break-words rounded-[1.1rem] px-3.5 py-2.5 text-[0.95rem] leading-6 ${mine ? 'bubble-mine rounded-tr-[0.375rem]' : 'bubble-josi rounded-tl-[0.375rem]'}`}>
                      {message.meta?.attachments?.length ? (
                        <div className="mb-1 space-y-1 text-xs opacity-80">
                          {message.meta.attachments.map((attachment) => attachment.contentType.startsWith('image/') ? (
                            <a key={attachment.id} href={`/api/assistant/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
                              <img src={`/api/assistant/attachments/${attachment.id}`} alt={attachment.filename}
                                   className="max-h-64 max-w-full rounded-lg object-contain" />
                            </a>
                          ) : (
                            <a key={attachment.id} className="block underline" href={`/api/assistant/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
                              📎 {attachment.filename}
                            </a>
                          ))}
                        </div>
                      ) : null}
                      {message.body}
                    </div>
                    <span className="mt-1 px-1.5 text-xs text-text-muted">{at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{mine ? <span className="ml-1.5 text-primary" aria-label="Sent">✓✓</span> : null}</span>
                    </div>
                  </div>
                </Fragment>
              );
            })}
            {pendingApprovals.length ? (
              <ul className="flex flex-col gap-2 sm:pl-9" aria-label="Waiting for your approval">
                {pendingApprovals.map(approval => (
                  <li key={approval.id}>
                    <ApprovalCard
                      approval={approval}
                      onLater={() => setSettled(ids => [...ids, approval.id])}
                      onApprove={async () => {
                        await api.post(`/assistant/approvals/${approval.id}/decide`, { approve: true });
                        setSettled(ids => [...ids, approval.id]);
                      }}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            {thread && historyOpen ? <PcPermissionCards key={'permissions-'+thread.id} proposals={threadCards} onDone={cardDone} /> : null}
            {thread && historyOpen ? <CredentialCards key={'credentials-'+thread.id} proposals={threadCards} onDone={cardDone} /> : null}
            {thread && historyOpen ? <SettingsChangeCards key={'settings-'+thread.id} proposals={threadCards} needsPassword={needsPassword} onDone={cardDone} /> : null}
            <ChatWorkProgressList {...work} />
            {sending ? <Working text="Josi is thinking" elapsed size={28} className="py-2 pl-1" /> : null}
            <div ref={end} />
            </div>
          </div>
        </section>
      </div>

      <footer className="z-10 w-full min-w-0 max-w-full shrink-0 overflow-x-clip px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
        <div className="mx-auto w-full max-w-3xl">
        {error ? <div className="mb-2 px-2"><ErrorNote>{error}</ErrorNote></div> : null}
        <form
          onSubmit={(event) => { event.preventDefault(); void send(); }}
          className="talk-composer ghost-composer flex min-h-[58px] w-full min-w-0 max-w-full items-end gap-0.5 overflow-hidden p-1.5"
        >
          <label className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-lilac/15 text-foreground hover:bg-lilac/25" aria-label="Attach pictures or files">
            <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <input type="file" multiple className="sr-only" accept="image/*,.pdf,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.txt,.md,.csv" onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 10))} />
          </label>
          <span aria-hidden className="mx-1 mb-1.5 h-8 w-px shrink-0 bg-lilac/25" />
          <textarea
            ref={inputElement}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
            rows={1}
            maxLength={8000}
            enterKeyHint="send"
            placeholder="Message Josi…"
            className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-2.5 text-base outline-none placeholder:text-text-muted sm:text-sm"
            style={{ backgroundColor: 'transparent' }}
            aria-label="Message Josi"
          />
          <VoiceChat onTurn={send} disabled={sending || loading || !thread} onActiveChange={setVoiceActive} />
          <button type="submit" className="btn-sheen inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-opacity disabled:cursor-not-allowed disabled:opacity-50" disabled={sending || voiceActive} aria-label="Send message">
            <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 -rotate-12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
          </button>
        </form>
        {files.length ? <p className="mt-1 truncate px-2 text-xs text-text-muted">Attached: {files.map((file) => file.name).join(', ')}</p> : null}
        </div>
      </footer>
    </div>
  );
}
