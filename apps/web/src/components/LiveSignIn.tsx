// The sign-in panel (docs/LIVE_SIGN_IN.md): a full-screen view over the chat
// where the person signs in for Josi, either on a live picture of her browser or
// in a terminal. What they type goes straight to the program; Josi's model never
// sees the screen, the keys or the output. It closes only by Done or Cancel.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '@/lib/api';
import { Button, ErrorNote, Working } from '@/components/ui';
import { EventBatcher, keyToEvent, MAX_TEXT, scaleToFrame, wheelTicks, type BrowserEvent } from '@/lib/liveSignIn';
import type { SignInCardSpec } from '@/lib/settingsChanges';

const TerminalPane = lazy(() => import('@/components/TerminalPane'));
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

interface SessionView { id: string; kind: string; state: 'starting' | 'ready' | 'ended'; title: string; width?: number; height?: number; error?: string; command?: string; runAs?: string }

function BrowserView({ sessionId, initial, onEnded }: { sessionId: string; initial: { width: number; height: number } | null; onEnded: () => void }) {
  const [frame, setFrame] = useState<{ url: string; width: number; height: number } | null>(null);
  const [problem, setProblem] = useState('');
  const [text, setText] = useState('');
  const batcher = useRef(new EventBatcher<BrowserEvent>());
  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const size = useRef(initial);
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  useEffect(() => {
    let alive = true;
    const control = new AbortController();
    let seq = 0, current: string | null = null;
    void (async () => {
      while (alive) {
        try {
          const res = await fetch(`/api/live-signin/sessions/${sessionId}/frame?after=${seq}&wait=8000`, { credentials: 'same-origin', cache: 'no-store', signal: control.signal });
          if (res.status === 204) continue;
          if (res.status === 410) { endedRef.current(); return; }
          if (!res.ok) { await sleep(1500); continue; }
          const blob = await res.blob();
          if (!alive) return;
          const n = Number(res.headers.get('X-Frame-Seq'));
          if (Number.isFinite(n)) seq = n;
          const width = Number(res.headers.get('X-Frame-Width')) || size.current?.width || 0;
          const height = Number(res.headers.get('X-Frame-Height')) || size.current?.height || 0;
          size.current = { width, height };
          const url = URL.createObjectURL(blob);
          setFrame({ url, width, height });
          if (current) URL.revokeObjectURL(current);
          current = url;
          setProblem('');
        } catch {
          if (!alive) return;
          await sleep(1500);
        }
      }
    })();
    const sender = window.setInterval(() => {
      const events = batcher.current.take();
      if (!events.length) return;
      void api.post(`/live-signin/sessions/${sessionId}/input`, { events })
        .then(() => setProblem(''))
        .catch((e) => { if (e instanceof ApiError && e.status === 410) endedRef.current(); else setProblem(e instanceof Error ? e.message : 'Input was not delivered.'); });
    }, 100);
    return () => { alive = false; control.abort(); window.clearInterval(sender); if (current) URL.revokeObjectURL(current); };
  }, [sessionId]);

  const point = useCallback((clientX: number, clientY: number) => {
    const img = image.current, dims = size.current;
    if (!img || !dims) return null;
    return scaleToFrame(clientX, clientY, img.getBoundingClientRect(), dims.width, dims.height);
  }, []);

  // A page scroll must not run underneath the picture, so the wheel is not passive.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const at = point(event.clientX, event.clientY);
      if (!at) return;
      event.preventDefault();
      const dy = wheelTicks(event.deltaY, event.deltaMode);
      if (dy) batcher.current.push({ t: 'scroll', x: at.x, y: at.y, dy });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [point]);

  const send = (event: BrowserEvent) => batcher.current.push(event);
  const sendText = (value: string) => { for (let i = 0; i < value.length; i += MAX_TEXT) send({ t: 'text', text: value.slice(i, i + MAX_TEXT) }); };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        ref={surface}
        tabIndex={0}
        role="application"
        aria-label="Josi's browser. Click and type here; it goes straight to the page."
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-[color:var(--hairline-strong)] bg-black/60 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={(event) => {
          // Escape asks to cancel (the panel handles it); the Esc button sends one to the page.
          if (event.key === 'Escape') return;
          const e = keyToEvent(event);
          if (!e) return;
          event.preventDefault(); event.stopPropagation();
          send(e);
        }}
        onPaste={(event) => { const pasted = event.clipboardData.getData('text'); if (pasted) { event.preventDefault(); sendText(pasted); } }}
      >
        {frame ? (
          <img
            ref={image}
            src={frame.url}
            alt="Live view of Josi's browser"
            draggable={false}
            className="max-h-full max-w-full cursor-pointer select-none object-contain"
            onClick={(event) => {
              surface.current?.focus();
              const at = point(event.clientX, event.clientY);
              if (at) send({ t: 'click', x: at.x, y: at.y, button: 1, count: event.detail >= 2 ? 2 : 1 });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              const at = point(event.clientX, event.clientY);
              if (at) send({ t: 'click', x: at.x, y: at.y, button: 3, count: 1 });
            }}
          />
        ) : <Working text="Waiting for the first picture" />}
      </div>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      {/* A phone cannot open its keyboard on a picture, so typing has its own field. */}
      <form className="flex flex-wrap items-center gap-2" autoComplete="off" onSubmit={(event) => {
        event.preventDefault();
        if (text) { sendText(text); setText(''); }
      }}>
        <input
          value={text} onChange={(e) => setText(e.target.value)} aria-label="Type here, then press Send"
          placeholder="Type here" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-input px-3.5 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
        />
        <Button type="submit" variant="secondary" disabled={!text}>Send</Button>
        {([['Enter', 'Return'], ['Tab', 'Tab'], ['Backspace', 'BackSpace'], ['Esc', 'Escape']] as const).map(([label, key]) => (
          <Button key={key} type="button" variant="ghost" className="px-3" aria-label={`Send ${label}`} onClick={() => send({ t: 'key', key })}>{label}</Button>
        ))}
      </form>
    </div>
  );
}

export function LiveSignIn({ sessionId, card, onFinished }: { sessionId: string; card: SignInCardSpec; onFinished: (outcome: 'done' | 'cancelled' | 'lost') => void }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const gone = useRef(false);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const finish = useCallback((outcome: 'done' | 'cancelled' | 'lost') => finishedRef.current(outcome), []);

  // Starting… until the PC says it is ready.
  useEffect(() => {
    let alive = true;
    void (async () => {
      while (alive) {
        try {
          const view = await api.get<SessionView>(`/live-signin/sessions/${sessionId}`);
          if (!alive) return;
          setSession(view);
          if (view.state === 'ended') { if (!gone.current) { gone.current = true; finish('lost'); } return; }
          if (view.state === 'ready' || view.error) return;
        } catch (e) {
          if (!alive) return;
          if (e instanceof ApiError && (e.status === 404 || e.status === 410)) { if (!gone.current) { gone.current = true; finish('lost'); } return; }
          setError(e instanceof Error ? e.message : 'Could not reach the session.');
        }
        await sleep(1000);
      }
    })();
    return () => { alive = false; };
  }, [sessionId, finish]);

  const end = useCallback(async (outcome: 'done' | 'cancelled') => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api.post(`/live-signin/sessions/${sessionId}/end`, { outcome });
      gone.current = true;
      finish(outcome);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) { gone.current = true; finish(outcome); return; }
      setError(e instanceof Error ? e.message : 'Could not finish.');
      setBusy(false);
    }
  }, [busy, sessionId, finish]);
  const ended = useCallback(() => { if (!gone.current) { gone.current = true; finish('lost'); } }, [finish]);

  // Focus goes into the panel and stays there; Escape asks before cancelling.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setAsking(true); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')).filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]!, last = items[items.length - 1]!;
      if (!panel.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const root = document.documentElement, overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); root.style.overflow = overflow; previous?.focus?.(); };
  }, []);

  const terminal = card.mode === 'terminal';
  const ready = session?.state === 'ready';
  const startFailure = session?.error;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={card.title} ref={panel} tabIndex={-1}
      className="fixed inset-0 z-[70] flex flex-col gap-2 bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] text-foreground outline-none sm:p-5"
      data-testid="josi.live-signin">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-lg font-bold">{card.title}</h2>
          <p className="text-xs text-text-muted">
            {terminal ? <>Running <code className="break-all">{session?.command ?? card.command}</code>{(session?.runAs ?? card.runAs) ? <> as {session?.runAs ?? card.runAs}</> : null}</> : 'Josi’s browser, live'}
          </p>
        </div>
        <Button type="button" disabled={busy || !ready && !startFailure} onClick={() => void end('done')}>Done</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => setAsking(true)}>Cancel</Button>
      </div>
      <p className="rounded-lg bg-secondary px-3 py-2 text-xs" data-testid="josi.live-signin.privacy">
        Josi never sees this screen or what you type. It goes straight to the program, and nothing is kept.
      </p>
      {asking ? (
        <div role="alertdialog" aria-label="Cancel this sign-in?" className="approval-card flex flex-wrap items-center gap-2 rounded-lg p-3">
          <p className="min-w-0 flex-1 text-sm">Cancel this sign-in? Josi will be told it was not finished.</p>
          <Button type="button" variant="danger" disabled={busy} onClick={() => { setAsking(false); void end('cancelled'); }}>Yes, cancel</Button>
          <Button type="button" variant="secondary" onClick={() => setAsking(false)}>Keep going</Button>
        </div>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {startFailure ? <ErrorNote>{startFailure}</ErrorNote> : null}
      {!session || (!ready && !startFailure) ? <div className="m-auto"><Working text="Starting…" elapsed /></div> : null}
      {ready ? terminal
        ? <Suspense fallback={<Working text="Opening the terminal…" />}><TerminalPane sessionId={sessionId} onEnded={ended} /></Suspense>
        : <BrowserView sessionId={sessionId} initial={session?.width && session?.height ? { width: session.width, height: session.height } : null} onEnded={ended} />
        : null}
    </div>,
    document.body,
  );
}
