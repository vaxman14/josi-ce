// The terminal half of the live sign-in panel (docs/LIVE_SIGN_IN.md): xterm.js
// showing the program's output and sending what is typed straight back. Loaded
// on demand (React.lazy in LiveSignIn.tsx) so xterm stays out of the main bundle.
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui';
import { EventBatcher, type TerminalEvent } from '@/lib/liveSignIn';

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export default function TerminalPane({ sessionId, onEnded }: { sessionId: string; onEnded: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const batcher = useRef(new EventBatcher<TerminalEvent>());
  const [exit, setExit] = useState<{ code: number | null } | null>(null);
  const [paste, setPaste] = useState('');
  const [problem, setProblem] = useState('');
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let alive = true;
    const term = new Terminal({
      convertEol: false, cursorBlink: true, fontSize: 14, scrollback: 2000, allowProposedApi: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#1a1022', foreground: '#f3eaf7', cursor: '#e8c26a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    const refit = () => { try { fit.fit(); } catch { /* not laid out yet */ } };
    refit();
    batcher.current.push({ t: 'resize', cols: term.cols, rows: term.rows });
    const typed = term.onData((data) => batcher.current.push({ t: 'data', data }));
    const resized = term.onResize(({ cols, rows }) => batcher.current.push({ t: 'resize', cols, rows }));
    const observer = new ResizeObserver(() => refit());
    observer.observe(element);
    term.focus();

    // At most about ten calls a second, never more than 64 events each.
    const sender = window.setInterval(() => {
      const events = batcher.current.take();
      if (!events.length) return;
      void api.post(`/live-signin/sessions/${sessionId}/input`, { events })
        .then(() => setProblem(''))
        .catch((e) => { if (e instanceof ApiError && e.status === 410) endedRef.current(); else setProblem(e instanceof Error ? e.message : 'Input was not delivered.'); });
    }, 100);

    void (async () => {
      let cursor = 0;
      while (alive) {
        try {
          const out = await api.get<{ cursor: number; data: string; running: boolean; exitCode: number | null }>(
            `/live-signin/sessions/${sessionId}/output?after=${cursor}&wait=8000`);
          if (!alive) return;
          if (out.data) term.write(out.data);
          cursor = out.cursor;
          if (!out.running) { setExit({ code: out.exitCode }); return; }
        } catch (e) {
          if (!alive) return;
          if (e instanceof ApiError && e.status === 410) { endedRef.current(); return; }
          await sleep(1500);
        }
      }
    })();

    return () => {
      alive = false;
      window.clearInterval(sender);
      observer.disconnect();
      typed.dispose(); resized.dispose();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div ref={host} className="min-h-0 flex-1 overflow-hidden rounded-lg border border-[color:var(--hairline-strong)] bg-[#1a1022] p-2" role="application" aria-label="Terminal. What you type goes straight to the program." />
      {exit ? <p role="status" className="text-sm font-medium">Finished (exit code {exit.code ?? 'unknown'}). Press Done when you are finished here.</p> : null}
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      {!exit ? <form className="flex items-center gap-2" autoComplete="off" onSubmit={(event) => {
        event.preventDefault();
        if (!paste) return;
        batcher.current.push({ t: 'data', data: paste });
        setPaste('');
      }}>
        <input type="password" autoComplete="new-password" value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Paste a code or token into the terminal"
          placeholder="Paste a code or token" className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-input px-3.5 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm" />
        <Button type="submit" variant="secondary" disabled={!paste}>Paste</Button>
      </form> : null}
    </div>
  );
}
