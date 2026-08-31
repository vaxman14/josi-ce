// How much Josi may do without asking, and confirming who you are.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

const ACTION_CLASSES = [
  { key: 'email_send', label: 'Sending email on your behalf' },
  { key: 'calendar_write', label: 'Creating and changing calendar events' },
  { key: 'task_management', label: 'Creating and changing tasks' },
];

const LEVELS = [
  { value: 'always_ask', label: 'Always ask me first' },
  { value: 'risky_only', label: 'Ask only for risky or destructive actions' },
  { value: 'automatic', label: 'Allow routine actions automatically' },
];

interface LevelState {
  level: string;
  userChoice: string;
  adminCeiling: string;
}

export function Settings() {
  const [levels, setLevels] = useState<Record<string, LevelState>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    for (const cls of ACTION_CLASSES) {
      void api.get<LevelState>(`/assistant/approval-levels/${cls.key}`)
        .then((r) => setLevels((c) => ({ ...c, [cls.key]: r })))
        .catch(() => undefined);
    }
  }, []);

  async function change(actionClass: string, level: string) {
    setError('');
    try {
      const result = await api.put<LevelState>(`/assistant/approval-levels/${actionClass}`, { level });
      setLevels((c) => ({ ...c, [actionClass]: result }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Card>
        <CardTitle>What Josi may do without asking</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          Some actions always need approval whatever you choose here — adding someone to an existing
          conversation, sending an attachment, and anything that deletes.
        </p>
        <div className="space-y-4">
          {ACTION_CLASSES.map((cls) => {
            const state = levels[cls.key];
            const tightened = state && state.level !== state.userChoice;
            return (
              <div key={cls.key}>
                <label className="mb-1 block text-sm font-medium" htmlFor={`lvl-${cls.key}`}>{cls.label}</label>
                <select
                  id={`lvl-${cls.key}`}
                  value={state?.userChoice ?? 'always_ask'}
                  onChange={(e) => void change(cls.key, e.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
                >
                  {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
                {/* M33: an administrator may tighten this and may never loosen
                    it. When they have, the person is told what will actually
                    happen rather than what they asked for. */}
                {tightened ? (
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone="primary">In effect: {state.level.replace(/_/g, ' ')}</Badge>
                    An administrator has set a stricter limit for this workspace.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>

      <StepUpCard />
    </div>
  );
}

/** Re-authentication before something that cannot be undone.
 *
 * Named for what it is. Confirming a password proves the person at the keyboard
 * is not just someone holding an open session; it does not prove more than
 * that, and the wording does not claim it does. */
function StepUpCard() {
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.post('/assistant/step-up', { password });
      setState('ok');
      setMessage('Confirmed for the next 15 minutes on this device.');
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'That did not match');
    } finally {
      setPassword('');
    }
  }

  return (
    <Card>
      <CardTitle>Confirm it is you</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">
        Cancelling work, changing settings and sharing something with a colleague need your password again,
        so an open session someone else is using cannot do them.
      </p>
      <form onSubmit={confirm} className="space-y-3">
        <div>
          <label className="mb-1 block text-sm" htmlFor="stepup-password">Password</label>
          <Input
            id="stepup-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <Button type="submit">Confirm</Button>
        {state !== 'idle' ? (
          state === 'ok'
            ? <p className="text-sm text-emerald-400">{message}</p>
            : <ErrorNote>{message}</ErrorNote>
        ) : null}
      </form>
    </Card>
  );
}
