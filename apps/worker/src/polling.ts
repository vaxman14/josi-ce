/** Pick up interactive work every second without overlapping queue passes.
 * Maintenance keeps its original thirty-second cadence. */
export function startWorkerPolling(
  tick: (maintenance: boolean) => Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  let stopped = false, running = false, lastMaintenance: number | null = null;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    const now = performance.now();
    const maintenance = lastMaintenance === null || now - lastMaintenance >= 30_000;
    if (maintenance) lastMaintenance = now;
    try { await tick(maintenance); }
    catch (error) { onError(error); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void run(); }, 1_000);
  void run();
  return () => { stopped = true; clearInterval(timer); };
}
