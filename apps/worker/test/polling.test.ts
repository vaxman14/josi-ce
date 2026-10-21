import { afterEach, expect, it, vi } from 'vitest';
import { startWorkerPolling } from '../src/polling.js';

afterEach(() => { vi.useRealTimers(); });
it('picks up a newly queued message on the next second while maintenance stays at thirty seconds', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  let queued = false, processed = 0;
  const maintenance: boolean[] = [];
  const stop = startWorkerPolling(async maintain => {
    maintenance.push(maintain);
    if (queued) { queued = false; processed++; }
  }, error => { throw error; });
  await vi.advanceTimersByTimeAsync(1);
  queued = true;
  await vi.advanceTimersByTimeAsync(998);
  expect(processed).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(processed).toBe(1);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(maintenance).toHaveLength(31);
  expect(maintenance.filter(Boolean)).toHaveLength(2);
  stop(); await vi.advanceTimersByTimeAsync(5_000);
  expect(maintenance).toHaveLength(31);
});

it('does not overlap a slow pass and continues after a failure', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const tick = vi.fn().mockImplementationOnce(() => pending).mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue(undefined);
  const errors = vi.fn();
  const stop = startWorkerPolling(tick, errors);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(tick).toHaveBeenCalledTimes(1);
  release(); await vi.advanceTimersByTimeAsync(1_000);
  expect(errors).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(tick).toHaveBeenCalledTimes(3);
  stop();
});
