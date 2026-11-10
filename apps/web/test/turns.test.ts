import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// api.get is the only thing the polling fallback needs from the app.
const get = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: vi.fn() },
  ApiError: class ApiError extends Error { constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); } },
}));

import { activityText, failureMessage, followTurn } from '../src/lib/turns';

class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, Array<(e: { data: string }) => void>>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSource.last = this; }
  addEventListener(name: string, fn: (e: { data: string }) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  emit(name: string, data: unknown) { for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}

beforeEach(() => { get.mockReset(); FakeSource.last = null; vi.stubGlobal('EventSource', FakeSource); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('turn activity words', () => {
  it('shows a tool line with an ellipsis and a said line as it is', () => {
    expect(activityText({ phase: 'tool', detail: 'Reading your email' })).toBe('Reading your email…');
    expect(activityText({ phase: 'said', detail: 'One moment, checking.' })).toBe('One moment, checking.');
    expect(activityText({ phase: 'thinking', detail: '' })).toBe('');
    expect(activityText(null)).toBe('');
  });
  it('words failures like the Windows app', () => {
    expect(failureMessage('provider_error')).toMatch(/model provider could not complete/);
    expect(failureMessage('session_expired')).toMatch(/Sign in again/);
    expect(failureMessage('something_new')).toMatch(/System checkup/);
  });
});

describe('following a turn', () => {
  it('reports live activity from the stream and resolves on done', async () => {
    const seen: string[] = [];
    const done = followTurn('t1', 'u1', (text) => seen.push(text));
    const source = FakeSource.last!;
    expect(source.url).toBe('/api/assistant/threads/t1/turns/u1/stream');
    source.emit('progress', { status: 'running', progress: { phase: 'tool', detail: 'Searching your mail' } });
    source.emit('done', { status: 'completed', messageId: 'm9', error: null });
    await expect(done).resolves.toEqual({ status: 'completed', messageId: 'm9', error: null });
    expect(seen).toEqual(['Searching your mail…']);
    expect(source.closed).toBe(true);
  });
  it('resolves a failed turn with its error code', async () => {
    const done = followTurn('t1', 'u1', () => {});
    FakeSource.last!.emit('done', { status: 'failed', messageId: null, error: 'provider_error' });
    await expect(done).resolves.toEqual({ status: 'failed', messageId: null, error: 'provider_error' });
  });
  it('polls when the stream drops, and still finishes', async () => {
    vi.useFakeTimers();
    get.mockResolvedValueOnce({ turns: [{ id: 'u1', status: 'running', assistant_message_id: null, error_code: null, progress: { phase: 'tool', detail: 'Opening the page' } }] })
      .mockResolvedValueOnce({ turns: [{ id: 'u1', status: 'completed', assistant_message_id: 'm2', error_code: null }] });
    const seen: string[] = [];
    const done = followTurn('t1', 'u1', (text) => seen.push(text));
    FakeSource.last!.onerror!();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1600);
    await expect(done).resolves.toEqual({ status: 'completed', messageId: 'm2', error: null });
    expect(seen).toEqual(['Opening the page…']);
    expect(get.mock.calls[0][0]).toBe('/assistant/threads/t1/turns?turn_id=u1');
  });
  it('stops cleanly when told to', async () => {
    const controller = new AbortController();
    const done = followTurn('t1', 'u1', () => {}, controller.signal);
    controller.abort();
    await expect(done).rejects.toThrow();
    expect(FakeSource.last!.closed).toBe(true);
  });
});
