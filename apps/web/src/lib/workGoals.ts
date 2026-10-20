import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkGoalSnapshot } from '@josi-ce/core';
import { api } from './api';
export type { WorkGoalSnapshot } from '@josi-ce/core';

/** Chat and Tasks read the same durable projection. No local checklist or
 * completion guess is synthesized from a model message. */
export function useWorkGoals(threadId?: string, includeEnded = false) {
  const [goals, setGoals] = useState<WorkGoalSnapshot[]>([]);
  const [error, setError] = useState('');
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let alive = true, pending = false;
    setGoals([]); setError(''); setReceivedAt(null);
    const query = new URLSearchParams();
    if (threadId) query.set('threadId', threadId);
    if (includeEnded) query.set('all', '1');
    const refresh = async () => {
      if (!alive || pending) return;
      pending = true;
      try {
        const result = await api.get<{ goals: WorkGoalSnapshot[] }>(`/assistant/work-goals?${query}`);
        if (alive) { setGoals(result.goals); setError(''); setReceivedAt(Date.now()); }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : 'Progress could not refresh.');
      } finally { pending = false; }
    };
    refreshRef.current = refresh;
    const visible = () => { if (!document.hidden) void refresh(); };
    void refresh();
    const timer = window.setInterval(visible, 3000);
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [threadId, includeEnded]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { goals, error, receivedAt, refresh };
}
