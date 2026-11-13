import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Button, Card, CardTitle, ErrorNote } from '@/components/ui';
import { CrashReportCard } from '@/components/CrashReportCard';
import { loadCrashState, setAutoReports, type CrashState } from '@/lib/crashReports';

/** For the owner of a tester installation: asks once whether crash reports may go out by themselves,
 * and while the answer is "no" shows each crash on a card to read, edit and send or not. Shows nothing
 * on an installation with no tester token, to anyone but the owner, or while reports go out by themselves. */
export function CrashReportPrompt() {
  const { user } = useAuth();
  const owner = user?.role === 'super_admin';
  const [state, setState] = useState<CrashState | null>(null);
  const [choice, setChoice] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(() => { loadCrashState().then(setState).catch(() => undefined); }, []);

  useEffect(() => {
    if (!owner) return;
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [owner, refresh]);

  if (!owner || !state?.settings.tokenPresent) return null;

  if (state.settings.auto === null) {
    const picked = choice ?? state.settings.defaultAuto ?? true;
    async function save() {
      setError('');
      try { await setAutoReports(picked); refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save that'); }
    }
    return <div className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-xl p-3" role="dialog" aria-label="Crash reports">
      <Card className="space-y-3 p-4">
        <CardTitle>Send crash reports automatically?</CardTitle>
        <p className="text-sm text-muted-foreground">
          If Josi crashes, a short report (what failed, your Josi and system versions, no personal data) can be sent to the person making Josi so they can fix it.
          If you say no, you will see each report first and decide.
        </p>
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" name="auto" className="h-5 w-5" checked={picked} onChange={() => setChoice(true)} />Yes, send them automatically</label>
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" name="auto" className="h-5 w-5" checked={!picked} onChange={() => setChoice(false)} />No, show me each one first</label>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button onClick={() => void save()}>Save</Button>
        <p className="text-xs text-muted-foreground">You can change this later in Settings.</p>
      </Card>
    </div>;
  }

  const waiting = state.settings.auto === false ? state.pending.find(report => report.kind === 'crash') : undefined;
  if (!waiting) return null;
  return <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-h-[90dvh] w-full max-w-2xl overflow-y-auto p-3" role="dialog" aria-label="Crash report">
    <CrashReportCard key={waiting.id} pending={waiting} onDone={refresh} />
  </div>;
}
