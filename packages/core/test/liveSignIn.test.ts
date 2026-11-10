import { describe, expect, it } from 'vitest';
import { cleanEvents, LiveSignInBroker, LIVE_LIMITS } from '../src/liveSignIn.js';

describe('what a person may send', () => {
  it('keeps clean browser events and drops everything else', () => {
    expect(cleanEvents('browser', [
      { t: 'click', x: 10, y: 20, button: 3, count: 2 }, { t: 'click', x: 1.5, y: 2 }, { t: 'click', x: 1, y: 1, button: 9 },
      { t: 'move', x: 5, y: 6 }, { t: 'scroll', x: 1, y: 1, dy: 3 }, { t: 'scroll', x: 1, y: 1, dy: 99 }, { t: 'scroll', x: 1, y: 1, dy: 0 },
      { t: 'text', text: 'abc' }, { t: 'text', text: '' }, { t: 'text', text: 'a\u0007b' }, { t: 'text', text: 'x'.repeat(LIVE_LIMITS.text + 1) },
      { t: 'key', key: 'ctrl+a' }, { t: 'key', key: 'Return' }, { t: 'key', key: 'ctrl+alt+shift+Delete' }, { t: 'key', key: 'a b' }, { t: 'key', key: '$(x)' },
      { t: 'data', data: 'terminal only' }, 'nonsense', null,
    ])).toEqual([
      { t: 'click', x: 10, y: 20, button: 3, count: 2 }, { t: 'move', x: 5, y: 6 }, { t: 'scroll', x: 1, y: 1, dy: 3 },
      { t: 'text', text: 'abc' }, { t: 'key', key: 'ctrl+a' }, { t: 'key', key: 'Return' }, { t: 'key', key: 'ctrl+alt+shift+Delete' },
    ]);
  });
  it('keeps clean terminal events and drops browser ones', () => {
    expect(cleanEvents('terminal', [{ t: 'data', data: 'x\r' }, { t: 'resize', cols: 120, rows: 36 }, { t: 'resize', cols: 2, rows: 36 }, { t: 'click', x: 1, y: 1 }, { t: 'data', data: 'y'.repeat(LIVE_LIMITS.data + 1) }]))
      .toEqual([{ t: 'data', data: 'x\r' }, { t: 'resize', cols: 120, rows: 36 }]);
  });
  it('caps one call at 64 events and not a list at all', () => {
    expect(cleanEvents('browser', Array.from({ length: 200 }, () => ({ t: 'key', key: 'Tab' }))).length).toBe(LIVE_LIMITS.events);
    expect(cleanEvents('browser', 'x')).toEqual([]);
  });
});

describe('the session broker', () => {
  const make = () => { let now = 1_000; const broker = new LiveSignInBroker(() => now); return { broker, tick: (ms: number) => { now += ms; } }; };
  const fresh = (broker: LiveSignInBroker, kind: 'browser' | 'terminal', pcId = 'p') => {
    const s = broker.create({ kind, pcId, userId: 'u', title: 'T' });
    if (s === 'busy') throw new Error('unexpected busy');
    return s;
  };
  it('allows one active session per computer and kind, and a terminal beside a browser', () => {
    const { broker } = make();
    const a = fresh(broker, 'browser');
    expect(broker.create({ kind: 'browser', pcId: 'p', userId: 'v', title: 'B' })).toBe('busy');
    expect(broker.create({ kind: 'terminal', pcId: 'p', userId: 'u', title: 'C' })).not.toBe('busy');
    expect(broker.create({ kind: 'browser', pcId: 'q', userId: 'u', title: 'D' })).not.toBe('busy');
    broker.end(a.id);
    expect(broker.create({ kind: 'browser', pcId: 'p', userId: 'v', title: 'B' })).not.toBe('busy');
  });
  it('holds only the latest frame, rejects empty or oversized ones, and wakes a waiting person', async () => {
    const { broker } = make();
    const s = fresh(broker, 'browser');
    expect(broker.pushFrame(s.id, 100, 100, Buffer.alloc(0))).toBe(false);
    expect(broker.pushFrame(s.id, 100, 100, Buffer.alloc(LIVE_LIMITS.frameBytes + 1))).toBe(false);
    const waiting = broker.nextFrame(s.id, 0, 2000);
    setTimeout(() => broker.pushFrame(s.id, 320, 200, Buffer.from('one')), 20);
    expect((await waiting)!.frame!.seq).toBe(1);
    broker.pushFrame(s.id, 320, 200, Buffer.from('two'));
    expect(broker.get(s.id)!.frame!.jpeg.toString()).toBe('two');
    expect(broker.get(s.id)!.state).toBe('ready');
  });
  it('keeps a bounded terminal buffer with stable cursors', () => {
    const { broker } = make();
    const s = fresh(broker, 'terminal');
    const chunk = 'x'.repeat(60_000);
    for (let i = 0; i < 6; i++) broker.pushOutput(s.id, chunk, true, null);
    const o = broker.get(s.id)!.output;
    expect(o.end).toBe(360_000);
    expect(o.text.length).toBe(LIVE_LIMITS.outputRing);
    expect(o.start).toBe(360_000 - LIVE_LIMITS.outputRing);
  });
  it('ends by itself when idle, and drops what it held', () => {
    const { broker, tick } = make();
    const s = fresh(broker, 'browser');
    broker.pushFrame(s.id, 100, 100, Buffer.from('x'));
    broker.queueInput(s.id, [{ t: 'key', key: 'Tab' }]);
    tick(LIVE_LIMITS.idleMs + 1);
    expect(broker.get(s.id)!.state).toBe('ended');
    expect(broker.get(s.id)!.frame).toBeNull();
    expect(broker.takeInput(s.id)).toEqual([]);
  });
  it('stays alive while the person is active, until the hard limit', () => {
    const { broker, tick } = make();
    const s = fresh(broker, 'browser');
    for (let i = 0; i < 5; i++) { tick(LIVE_LIMITS.idleMs - 1000); broker.touch(s.id); expect(broker.get(s.id)!.state).not.toBe('ended'); }
    tick(LIVE_LIMITS.maxMs);
    expect(broker.get(s.id)!.state).toBe('ended');
  });
});
