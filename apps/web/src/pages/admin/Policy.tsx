// The deny-only approval ceiling.
//
// M33, and the direction is the whole point: an administrator may force a
// stricter level and may NEVER loosen one a person chose. The server enforces
// it; this page states it so nobody expects otherwise.
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, Card, CardTitle, ErrorNote } from '@/components/ui';

const ACTION_CLASSES = [
  { key: 'email_send', label: 'Sending email on someone\'s behalf' },
  { key: 'calendar_write', label: 'Creating and changing calendar events' },
  { key: 'task_management', label: 'Creating and changing tasks' },
];

const LEVELS = [
  { value: 'always_ask', label: 'Everyone must approve every time' },
  { value: 'risky_only', label: 'At most: ask only for risky actions' },
  { value: 'automatic', label: 'No ceiling — each person decides' },
];

export function AdminPolicy() {
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  async function set(actionClass: string, maxLevel: string) {
    setError('');
    try {
      await api.put(`/admin/assistant/approval-policy/${actionClass}`, { maxLevel });
      setSaved((c) => ({ ...c, [actionClass]: maxLevel }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Approval policy</h1>
      <Card>
        <CardTitle>What is the loosest anyone may choose?</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          This can only tighten. Setting “no ceiling” does not switch anyone to automatic — it returns the
          choice to each person, and someone who asked to be consulted every time still will be.
        </p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="space-y-4">
          {ACTION_CLASSES.map((cls) => (
            <div key={cls.key}>
              <label className="mb-1 block text-sm font-medium" htmlFor={`pol-${cls.key}`}>{cls.label}</label>
              <select
                id={`pol-${cls.key}`}
                defaultValue={saved[cls.key] ?? 'automatic'}
                onChange={(e) => void set(cls.key, e.target.value)}
                className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
              >
                {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
