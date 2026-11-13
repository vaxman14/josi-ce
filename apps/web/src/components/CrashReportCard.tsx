import { useState } from 'react';
import { Badge, Button, Card, CardTitle, ErrorNote } from '@/components/ui';
import { dismissPendingReport, reportToText, sendPendingReport, textToReport, type PendingReport } from '@/lib/crashReports';

/** A crash report, or feedback, shown whole: the person reads it, may change any of it, and chooses to send it or not.
 * The server removes anything private from what is sent, whatever the text says. */
export function CrashReportCard({ pending, onDone }: { pending: PendingReport; onDone: (sent: boolean) => void }) {
  const [text, setText] = useState(() => reportToText(pending.report));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const feedback = pending.kind === 'feedback';

  async function send() {
    const parsed = textToReport(text);
    if (!parsed.ok) { setError(parsed.message); return; }
    setBusy(true); setError('');
    try { await sendPendingReport(pending.id, parsed.report); onDone(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not send it. Try again in a moment.'); setBusy(false); }
  }
  async function leave() {
    setBusy(true);
    try { await dismissPendingReport(pending.id); } catch { /* it stays waiting; nothing was sent */ }
    onDone(false);
  }

  return <Card className="space-y-3 p-4">
    <div className="flex flex-wrap items-center gap-2">
      <CardTitle>{feedback ? 'Send your feedback' : 'Josi had a problem. Send a crash report?'}</CardTitle>
      <Badge tone="muted">Nothing is sent until you press Send</Badge>
    </div>
    <p className="text-sm text-muted-foreground">
      {feedback ? 'This is what will be sent with your note. ' : 'This is exactly what will be sent to help fix it. '}
      It has no chat messages, Vault data, email addresses, sign-in tokens, file paths under your home folder or IP addresses, and anything like that you add is removed again before it goes.
      You can change any of it.
    </p>
    <label className="grid gap-1 text-sm">
      <span className="font-medium">The report</span>
      <textarea className="min-h-48 rounded-md border border-input bg-background p-2 font-mono text-xs" value={text} onChange={e => setText(e.target.value)} spellCheck={false} aria-label="The report" />
    </label>
    {error ? <ErrorNote>{error}</ErrorNote> : null}
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => void send()}>{feedback ? 'Send feedback' : 'Send crash report'}</Button>
      <Button variant="ghost" disabled={busy} onClick={() => void leave()}>Don&apos;t send</Button>
    </div>
  </Card>;
}
