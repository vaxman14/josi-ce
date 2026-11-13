import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Card, CardTitle, ErrorNote } from '@/components/ui';
import { loadCrashState, setAutoReports, type CrashSettings } from '@/lib/crashReports';

/** Settings: whether crash reports go out by themselves. Only on a tester installation, only for the owner. */
export function CrashReportSettings() {
  const { user } = useAuth();
  const owner = user?.role === 'super_admin';
  const [settings, setSettings] = useState<CrashSettings>();
  const [error, setError] = useState('');
  useEffect(() => { if (owner) loadCrashState().then(state => setSettings(state.settings)).catch(() => undefined); }, [owner]);
  if (!owner || !settings?.tokenPresent) return null;
  async function change(auto: boolean) {
    setError('');
    try { setSettings((await setAutoReports(auto)).settings); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save that'); }
  }
  return <Card className="space-y-2 p-4">
    <CardTitle>Crash reports</CardTitle>
    <p className="text-sm text-muted-foreground">If Josi crashes, a short report (what failed, versions, your computer&apos;s make-up, no personal data) helps fix it.</p>
    <label className="flex min-h-11 items-center gap-3 text-sm">
      <input type="checkbox" className="h-5 w-5" checked={settings.auto === true} onChange={e => void change(e.target.checked)} />
      Send crash reports automatically
    </label>
    <p className="text-xs text-muted-foreground">{settings.auto === true ? 'They are sent quietly in the background.' : 'You will see each one first and choose whether to send it.'}</p>
    {error ? <ErrorNote>{error}</ErrorNote> : null}
  </Card>;
}
