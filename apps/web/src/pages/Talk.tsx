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
import { api, ApiError, type ApprovalCard, type Message, type Thread, type TurnResult } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** "Today", "Yesterday", or the date — the label WhatsApp taught everyone. */
function dayLabel(at: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (at.toDateString() === today.toDateString()) return 'Today';
  if (at.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: at.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
import { Button, ErrorNote } from '@/components/ui';

const talkCache = new Map<string, { thread: Thread; messages: Message[] }>();

export function Talk() {
  const { user } = useAuth();
  const cached = user ? talkCache.get(user.id) : undefined;
  const [thread, setThread] = useState<Thread | null>(cached?.thread ?? null);
  const [messages, setMessages] = useState<Message[]>(cached?.messages ?? []);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(!cached);
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  // ROUND-3 ITEM 26(2): the one approval card, in the conversation that asked
  // for it. Not held in `talkCache` — an agreement is about this moment, and
  // an offer restored from a cache after a reload is an offer whose task may
  // already have been decided somewhere else.
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const inputElement = useRef<HTMLTextAreaElement>(null);
  const sendLock = useRef(false);

  // The most recent thread, or a new one. A member always has somewhere to talk.
  useEffect(() => {
    if (!user || talkCache.has(user.id)) return;
    void (async () => {
      try {
        const { threads } = await api.get<{ threads: Thread[] }>('/assistant/threads');
        const existing = threads[0];
        if (existing) {
          setThread(existing);
          const detail = await api.get<{ messages: Message[] }>(`/assistant/threads/${existing.id}`);
          setMessages(detail.messages);
          talkCache.set(user.id, { thread: existing, messages: detail.messages });
        } else {
          const created = await api.post<{ thread: Thread }>('/assistant/threads', { title: 'Talk' });
          setThread(created.thread);
          talkCache.set(user.id, { thread: created.thread, messages: [] });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open the conversation');
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  useEffect(() => {
    if (user && thread) talkCache.set(user.id, { thread, messages });
  }, [messages, thread, user]);

  // Never animate through the full transcript when a message is sent. On a
  // long thread, that looked exactly like the conversation was being fetched
  // and replayed from the top (especially while Chrome-on-iOS also resized its
  // toolbar). Put the newest message in place immediately; the bubble itself is
  // the motion/feedback the user needs.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
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
    const repin = () => { end.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior }); };
    vv.addEventListener('resize', repin);
    return () => vv.removeEventListener('resize', repin);
  }, []);

  async function send(): Promise<void> {
    // Read the DOM value as well as React state: iOS can display composition
    // text before a controlled component catches up.
    const body = (inputElement.current?.value ?? input).trim();
    if (!thread || (!body && !files.length) || sendLock.current) return;
    sendLock.current = true;

    const optimistic: Message = {
      id: `pending-${Math.random().toString(36).slice(2)}`,
      thread_id: thread.id, direction: 'in', channel: 'web', body: body || 'Sent an attachment',
      created_at: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setInput('');
    setSending(true);
    setError('');

    try {
      const attachmentIds: string[] = [];
      for (const file of files) {
        const form = new FormData(); form.append('file', file);
        const uploaded = await api.upload<{ attachment: { id: string; filename: string; contentType: string } }>(`/assistant/threads/${thread.id}/attachments`, form);
        attachmentIds.push(uploaded.attachment.id);
      }
      const uploadedMeta = files.map((file, index) => ({
        id: attachmentIds[index], filename: file.name, contentType: file.type || 'application/octet-stream',
      }));
      setMessages((current) => current.map((message) => message.id === optimistic.id
        ? { ...message, meta: { attachments: uploadedMeta } } : message));
      const result = await api.post<TurnResult>(`/assistant/threads/${thread.id}/talk`, { message: body, attachmentIds });
      setFiles([]);
      setApprovals(result.approvals ?? []);
      if (result.reply !== undefined) {
        setMessages((current) => [...current, {
          id: `reply-${Math.random().toString(36).slice(2)}`,
          thread_id: thread.id, direction: 'out', channel: 'web', body: result.reply!,
          created_at: new Date().toISOString(),
        }]);
      }
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
        setInput(body);
      }
      setError(message);
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }

  /** Agree to one prepared action, and say what actually happened.
   *
   * The server carries the write out in this same request, so the sentence
   * below is the provider's answer rather than a state name. "Created" is only
   * ever printed when `carriedOut` is true. */
  async function decide(card: ApprovalCard, approve: boolean): Promise<void> {
    setDeciding(card.id);
    setError('');
    try {
      const res = await api.post<{ carriedOut?: boolean; message?: string }>(
        `/assistant/approvals/${card.id}/decide`, { approve },
      );
      setApprovals((current) => current.filter((a) => a.id !== card.id));
      const said = approve
        ? (res.carriedOut ? 'Done.' : (res.message ?? 'It did not happen.'))
        : 'Declined. Nothing was done.';
      setMessages((current) => [...current, {
        id: `decision-${Math.random().toString(36).slice(2)}`,
        thread_id: thread!.id, direction: 'out', channel: 'web', body: said,
        created_at: new Date().toISOString(),
      }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that');
    } finally {
      setDeciding(null);
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
      className="mx-auto flex w-full min-w-0 max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card"
      style={{ height: 'calc(100dvh - 10rem)' }}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-4 py-3">
        <img src="/brand/josi-mark.png" alt="" width={28} height={28} className="h-7 w-7 rounded-md" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">Josi</h1>
          <p className="truncate text-xs text-muted-foreground">This conversation is yours</p>
        </div>
      </header>

      <section className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-5" aria-live="polite">
        {loading ? <p className="text-sm text-muted-foreground">Opening…</p> : null}
        {!loading && messages.length === 0 ? (
          <div className="mx-auto mt-10 max-w-sm text-center">
            <h2 className="text-lg font-semibold">What are we doing?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Ask Josi to remember something, plan it, or start a task.
            </p>
          </div>
        ) : null}
        {messages.map((message, index) => {
          const mine = message.direction === 'in';
          const at = new Date(message.created_at);
          const prev = index > 0 ? new Date(messages[index - 1].created_at) : null;
          const newDay = !prev || prev.toDateString() !== at.toDateString();
          return (
            <Fragment key={message.id}>
              {newDay ? (
                <div className="flex justify-center">
                  <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                    {dayLabel(at)}
                  </span>
                </div>
              ) : null}
              <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[86%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-6 sm:max-w-[75%] ${
                    mine
                      ? 'rounded-br-md bg-primary text-primary-foreground'
                      : 'rounded-bl-md border border-border bg-secondary text-secondary-foreground'
                  }`}
                >
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
                  <span className={`ml-2 inline-block translate-y-0.5 select-none whitespace-nowrap text-[10px] leading-none ${
                    mine ? 'text-primary-foreground/70' : 'text-muted-foreground'
                  }`}>
                    {at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            </Fragment>
          );
        })}
        {approvals.map((card) => (
          <div key={card.id} className="flex justify-start">
            <div className="max-w-[86%] rounded-2xl rounded-bl-md border border-border bg-secondary px-4 py-3 text-sm sm:max-w-[75%]">
              <p className="font-medium">Approve this?</p>
              <p className="mt-1 whitespace-pre-wrap break-words">{card.summary}</p>
              <p className="mt-1 text-xs text-muted-foreground">This has not happened yet.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => void decide(card, true)} disabled={deciding === card.id}>
                  {deciding === card.id ? 'Doing it…' : 'Approve'}
                </Button>
                <Button variant="secondary" onClick={() => void decide(card, false)} disabled={deciding === card.id}>
                  Decline
                </Button>
              </div>
            </div>
          </div>
        ))}
        {sending ? <p className="text-sm text-muted-foreground">Josi is working…</p> : null}
        <div ref={end} />
      </section>

      <footer className="shrink-0 border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-3">
        {error ? <div className="mb-2"><ErrorNote>{error}</ErrorNote></div> : null}
        <form
          onSubmit={(event) => { event.preventDefault(); void send(); }}
          className="flex min-w-0 items-end gap-2 rounded-lg border border-input bg-background p-1.5 focus-within:ring-2 focus-within:ring-ring"
        >
          <label className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-xl hover:bg-secondary" aria-label="Attach pictures or files">
            <span aria-hidden>＋</span>
            <input type="file" multiple className="sr-only" accept="image/*,.pdf,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.txt,.md,.csv" onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 10))} />
          </label>
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
            className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            aria-label="Message Josi"
          />
          <Button type="submit" className="h-11 w-11 shrink-0 px-0" disabled={sending} aria-label="Send message">
            <span aria-hidden>↑</span>
          </Button>
        </form>
        {files.length ? <p className="mt-1 truncate text-xs text-muted-foreground">Attached: {files.map((file) => file.name).join(', ')}</p> : null}
      </footer>
    </div>
  );
}
