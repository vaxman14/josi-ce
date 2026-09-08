import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, ErrorNote } from '@/components/ui';

const DOCS_URL = 'https://josi-ce-docs.netlify.app/';

export function HelpChat() {
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { void api.get<{ available: boolean }>('/help/status').then((v) => setAvailable(v.available)).catch(() => setAvailable(false)); }, []);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);

  async function ask() {
    if (!question.trim() || busy) return;
    setBusy(true); setError(''); setAnswer('');
    try {
      const result = await api.post<{ answer: string; links: string[] }>('/help/ask', { question: question.trim() });
      setAnswer(result.answer); setLinks(result.links);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Help chat is unavailable.');
    } finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" aria-label="Ask Josi CE help" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="fixed bottom-20 right-4 z-40 flex min-h-14 min-w-14 items-center justify-center rounded-full bg-primary px-4 text-lg font-semibold text-primary-foreground shadow-lg lg:bottom-5">
        Help
      </button>
      {open ? (
        <section role="dialog" aria-modal="false" aria-labelledby="help-chat-title"
          className="fixed inset-x-3 bottom-36 z-40 max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-xl sm:left-auto sm:right-4 sm:w-[24rem] lg:bottom-20">
          <div className="flex items-center justify-between gap-3">
            <h2 id="help-chat-title" className="font-semibold">Josi CE help</h2>
            <Button type="button" variant="ghost" aria-label="Close help" onClick={() => setOpen(false)}>Close</Button>
          </div>
          <p className="text-xs text-muted-foreground">Answers use the public Josi CE documentation only. Your question is sent to Groq when chat is available; workspace data and secrets are never included.</p>
          {!available ? <p className="mt-3 text-sm">Help chat is unavailable, but the documentation is still available.</p> : null}
          {available ? <div className="mt-3 space-y-2">
            <label htmlFor="help-question" className="text-sm font-medium">What do you need help with?</label>
            <input ref={input} id="help-question" value={question} maxLength={800}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void ask(); }}
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm" />
            <Button type="button" disabled={busy || !question.trim()} onClick={() => void ask()}>{busy ? 'Checking docs…' : 'Ask'}</Button>
          </div> : null}
          {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
          {answer ? <p className="mt-3 whitespace-pre-wrap text-sm">{answer}</p> : null}
          {links.map((link) => <a key={link} href={link} target="_blank" rel="noreferrer" className="mt-2 block text-sm font-medium text-primary underline">Read the relevant help section</a>)}
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-primary underline">Open documentation</a>
        </section>
      ) : null}
    </>
  );
}
