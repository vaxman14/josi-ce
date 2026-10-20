import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkGoalSnapshot } from '@josi-ce/core';
import { api } from './api';
export type { WorkGoalSnapshot } from '@josi-ce/core';

/** Chat and Tasks read the same durable projection. No local checklist or
 * completion guess is synthesized from a model message. */
export function useWorkGoals(threadId?: string, includeEnded = false, endedOnly = false) {
  const [goals, setGoals] = useState<WorkGoalSnapshot[]>([]);
  const [error, setError] = useState('');
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'refreshing' | 'offline'>('connecting');
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let alive = true, pending = false, requested = false;
    let source: EventSource | null = null, opening = false, lastSignal = 0, accessEnded = false;
    setGoals([]); setError(''); setReceivedAt(null); setConnection('connecting');
    const query = new URLSearchParams();
    if (threadId) query.set('threadId', threadId);
    if (includeEnded) query.set('all', '1');
    if (endedOnly) query.set('ended', '1');
    const refresh = async () => {
      if (!alive || accessEnded) return;
      if (pending) { requested = true; return; }
      pending = true;
      try {
        const result = await api.get<{ goals: WorkGoalSnapshot[] }>(`/assistant/work-goals?${query}`);
        if (alive && !accessEnded) {
          setGoals(current => result.goals.map(goal => {
            const previous = current.find(item => item.goalId === goal.goalId);
            return previous && previous.revision > goal.revision ? previous : goal;
          }));
          setError(''); setReceivedAt(Date.now());
          setConnection(lastSignal > Date.now() - 20_000 ? 'live' : 'refreshing');
        }
      } catch (cause) {
        if (alive) { setError(cause instanceof Error ? cause.message : 'Progress could not refresh.'); setConnection('offline'); }
      } finally {
        pending = false;
        if (requested && alive && !accessEnded) { requested = false; void refresh(); }
      }
    };
    refreshRef.current = refresh;
    const stopStream = () => { source?.close(); source = null; lastSignal = 0; };
    const openStream = async () => {
      if (!alive || source || opening || document.hidden || accessEnded || typeof EventSource === 'undefined') return;
      opening = true;
      try {
        const next = await api.openEventSource(`/assistant/work-goals/stream?${query}`);
        if (!alive || document.hidden || accessEnded) { next.close(); return; }
        source = next;
        const signal = () => { if (alive) { lastSignal = Date.now(); setConnection('live'); } };
        next.addEventListener('progress', () => { signal(); void refresh(); });
        next.addEventListener('heartbeat', () => { signal(); if (alive) setReceivedAt(Date.now()); });
        next.addEventListener('unavailable', () => { lastSignal = 0; if (alive) setConnection('refreshing'); });
        next.addEventListener('access-ended', () => {
          accessEnded = true; stopStream();
          if (alive) { setGoals([]); setConnection('offline'); setError('Sign in again to follow your work.'); }
        });
        next.onerror = () => { lastSignal = 0; if (alive) setConnection('refreshing'); };
      } catch { if (alive) setConnection('refreshing'); }
      finally { opening = false; }
    };
    const visible = () => {
      if (document.hidden) { stopStream(); return; }
      void openStream(); void refresh();
    };
    void refresh();
    void openStream();
    // Older servers, proxies and clients retain ordinary polling. While the
    // stream is healthy, fetch only when its durable revision changes.
    const timer = window.setInterval(() => {
      if (!document.hidden && Date.now() - lastSignal > 20_000) { void openStream(); void refresh(); }
    }, 3000);
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; stopStream(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [threadId, includeEnded, endedOnly]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { goals, error, receivedAt, connection, refresh };
}
