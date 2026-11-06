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
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { api, ApiError, type Approval, type Message, type Thread, type TurnResult } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { JosiMark } from '@/components/brand/JosiMark';
import type { ShellOutlet } from '@/components/layout/Shell';
import { VoiceChat } from '@/components/VoiceChat';
import { ChatWorkProgress } from '@/components/WorkProgress';

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
  const transcript = useRef<HTMLElement>(null);
  const inputElement = useRef<HTMLTextAreaElement>(null);
  const sendLock = useRef(false);
  const sendGeneration = useRef(0);
  const followLatest = useRef(true);
  const [backgroundOffline, setBackgroundOffline] = useState(false);
  const { approvals } = useOutletContext<ShellOutlet>();
  // Answered here, or put away with "Not now". The poll catches up on its own.
  const [settled, setSettled] = useState<string[]>([]);
  const pendingApprovals = approvals.filter(approval => !settled.includes(approval.id));

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

  async function send(spoken?: string): Promise<string | undefined> {
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
        if (spoken === undefined) setInput(body);
      }
      setError(message);
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }

  return (
    <div
      // The chat sizes itself with plain 100dvh and lives in normal flow: a
      // flex column of header / scrolling list / composer. When the iOS
      // keyboard opens, Safari pans the visual viewport to keep the focused
      // composer visible — native behaviour, no JS. The previous release drove
      // this height from a VisualViewport handler and the composer ended up
      // rendered at the TOP of the screen with the history invisible (round-2
      // item 25). data-viewport-managed opts out of the global focus helper.
      data-viewport-managed
      className="flex w-full min-w-0 flex-col overflow-hidden"
      style={{ height: '100%' }}
    >
      <h1 className="sr-only">Chat with Josi</h1>
      <section ref={transcript} onScroll={event => {
        const view = event.currentTarget; followLatest.current = view.scrollHeight - view.clientHeight - view.scrollTop < 100;
      }} className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6" aria-live="polite">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-2">
        {backgroundOffline ? <p className="text-xs text-text-muted" role="status">Chat updates are offline. Showing the last saved conversation.</p> : null}
        {messages.length >= 200 ? <p className="text-xs text-text-muted">Showing the most recent 200 messages.</p> : null}
        {loading ? <Working text="Opening…" /> : null}
        {!loading && messages.length === 0 ? (
          <div className="m-auto flex flex-col items-center text-center">
            <div className="relative grid h-24 w-24 place-items-center">
              <span aria-hidden className="josi-glow" />
              <JosiMark variant="bare" size={72} />
            </div>
            <h2 className="mt-5 text-xl">What can I do for you?</h2>
          </div>
        ) : null}
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
          <ul className="flex flex-col gap-2 pl-9" aria-label="Waiting for your approval">
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
        {thread ? <ChatWorkProgress key={thread.id} threadId={thread.id} /> : null}
        {sending ? <Working text="Josi is thinking" elapsed size={28} className="py-2 pl-1" /> : null}
        <div ref={end} />
        </div>
      </section>

      <footer className="frost hairline-t z-10 w-full min-w-0 max-w-full shrink-0 overflow-x-clip px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
        <div className="mx-auto w-full max-w-3xl">
        {error ? <div className="mb-2 px-2"><ErrorNote>{error}</ErrorNote></div> : null}
        <form
          onSubmit={(event) => { event.preventDefault(); void send(); }}
          className="talk-composer flex min-h-14 w-full min-w-0 max-w-full items-end gap-0.5 overflow-hidden rounded-[1.75rem] border border-[color:var(--hairline-strong)] bg-card/70 p-1.5"
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
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
            rows={1}
            maxLength={8000}
            enterKeyHint="send"
            placeholder="Message Josi…"
            className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-2.5 text-base outline-none placeholder:text-text-muted sm:text-sm"
            aria-label="Message Josi"
          />
          <VoiceChat onTurn={send} disabled={sending || loading || !thread} onActiveChange={setVoiceActive} />
          <button type="submit" className="btn-gold inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-opacity disabled:cursor-not-allowed disabled:opacity-50" disabled={sending || voiceActive} aria-label="Send message">
            <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 -rotate-12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
          </button>
        </form>
        {files.length ? <p className="mt-1 truncate px-2 text-xs text-text-muted">Attached: {files.map((file) => file.name).join(', ')}</p> : null}
        </div>
      </footer>
    </div>
  );
}
