/** Pick up interactive work every second without overlapping queue passes.
 * Maintenance keeps its original thirty-second cadence. */
export function startWorkerPolling(
  tick: (maintenance: boolean) => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let stopped = false, current: Promise<void> | null = null, lastMaintenance: number | null = null;
  const run = async () => {
    if (stopped || current) return;
    const now = performance.now();
    const maintenance = lastMaintenance === null || now - lastMaintenance >= 30_000;
    if (maintenance) lastMaintenance = now;
    current = (async () => {
      try { await tick(maintenance); }
      catch (error) { onError(error); }
      finally { current = null; }
    })();
    await current;
  };
  const timer = setInterval(() => { void run(); }, 1_000);
  void run();
  // Stopping drains: the pass in flight (a model call holding a subscription
  // login lease, a durable turn) finishes before the caller exits.
  return () => { stopped = true; clearInterval(timer); return current ?? Promise.resolve(); };
}
