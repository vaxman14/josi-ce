import { describe, expect, it } from 'vitest';
import { EventBatcher, keyToEvent, scaleToFrame, wheelTicks, type LiveEvent } from '../src/lib/liveSignIn';

describe('scaleToFrame', () => {
  const rect = { left: 100, top: 50, width: 640, height: 360 };
  it('maps the shown picture to frame pixels', () => {
    expect(scaleToFrame(420, 230, rect, 1280, 720)).toEqual({ x: 640, y: 360 });
    expect(scaleToFrame(100, 50, rect, 1280, 720)).toEqual({ x: 0, y: 0 });
  });
  it('clamps to the frame and refuses an empty picture', () => {
    expect(scaleToFrame(5000, 5000, rect, 1280, 720)).toEqual({ x: 1279, y: 719 });
    expect(scaleToFrame(0, 0, rect, 1280, 720)).toEqual({ x: 0, y: 0 });
    expect(scaleToFrame(1, 1, { left: 0, top: 0, width: 0, height: 0 }, 1280, 720)).toBeNull();
    expect(scaleToFrame(1, 1, rect, 0, 720)).toBeNull();
  });
});

describe('wheelTicks', () => {
  it('turns pixels into ticks, at least one, at most twenty', () => {
    expect(wheelTicks(100)).toBe(1);
    expect(wheelTicks(10)).toBe(1);
    expect(wheelTicks(-300)).toBe(-3);
    expect(wheelTicks(100000)).toBe(20);
    expect(wheelTicks(0)).toBe(0);
  });
});

describe('keyToEvent', () => {
  it('sends printable keys as text', () => {
    expect(keyToEvent({ key: 'a' })).toEqual({ t: 'text', text: 'a' });
    expect(keyToEvent({ key: 'A', shiftKey: true })).toEqual({ t: 'text', text: 'A' });
    expect(keyToEvent({ key: ' ' })).toEqual({ t: 'text', text: ' ' });
  });
  it('names the special keys the way xdotool does', () => {
    expect(keyToEvent({ key: 'Enter' })).toEqual({ t: 'key', key: 'Return' });
    expect(keyToEvent({ key: 'Backspace' })).toEqual({ t: 'key', key: 'BackSpace' });
    expect(keyToEvent({ key: 'ArrowLeft' })).toEqual({ t: 'key', key: 'Left' });
    expect(keyToEvent({ key: 'Tab', shiftKey: true })).toEqual({ t: 'key', key: 'shift+Tab' });
    expect(keyToEvent({ key: 'PageDown' })).toEqual({ t: 'key', key: 'Next' });
  });
  it('maps ctrl chords, leaves paste to the paste event and ignores modifiers', () => {
    expect(keyToEvent({ key: 'a', ctrlKey: true })).toEqual({ t: 'key', key: 'ctrl+a' });
    expect(keyToEvent({ key: 'v', ctrlKey: true })).toBeNull();
    expect(keyToEvent({ key: 'Shift' })).toBeNull();
    expect(keyToEvent({ key: 'Dead' })).toBeNull();
  });
});

describe('EventBatcher', () => {
  it('joins typing, sums scrolling and keeps the last move', () => {
    const b = new EventBatcher();
    b.push({ t: 'text', text: 'ab' }); b.push({ t: 'text', text: 'c' });
    b.push({ t: 'key', key: 'Return' });
    b.push({ t: 'move', x: 1, y: 1 }); b.push({ t: 'move', x: 5, y: 6 });
    b.push({ t: 'scroll', x: 5, y: 6, dy: 3 }); b.push({ t: 'scroll', x: 5, y: 6, dy: 4 });
    b.push({ t: 'scroll', x: 9, y: 9, dy: 1 });
    expect(b.take()).toEqual([
      { t: 'text', text: 'abc' }, { t: 'key', key: 'Return' }, { t: 'move', x: 5, y: 6 },
      { t: 'scroll', x: 5, y: 6, dy: 7 }, { t: 'scroll', x: 9, y: 9, dy: 1 },
    ]);
    expect(b.size).toBe(0);
  });
  it('does not join text across a click and never exceeds the text limit', () => {
    const b = new EventBatcher();
    b.push({ t: 'text', text: 'a' }); b.push({ t: 'click', x: 1, y: 2 }); b.push({ t: 'text', text: 'b' });
    expect(b.take().map(e => e.t)).toEqual(['text', 'click', 'text']);
    b.push({ t: 'text', text: 'x'.repeat(1500) }); b.push({ t: 'text', text: 'y'.repeat(1500) });
    expect(b.take().map(e => (e as { text: string }).text.length)).toEqual([1500, 1500]);
  });
  it('hands out at most 64 events a call and can put them back', () => {
    const b = new EventBatcher<LiveEvent>();
    for (let i = 0; i < 100; i++) b.push({ t: 'click', x: i, y: 0 });
    const first = b.take();
    expect(first).toHaveLength(64);
    b.putBack(first);
    expect(b.size).toBe(100);
    expect(b.take()[0]).toEqual({ t: 'click', x: 0, y: 0 });
  });
  it('joins terminal data and keeps the last resize', () => {
    const b = new EventBatcher<LiveEvent>();
    b.push({ t: 'data', data: 'ls' }); b.push({ t: 'data', data: '\r' });
    b.push({ t: 'resize', cols: 80, rows: 24 }); b.push({ t: 'resize', cols: 100, rows: 30 });
    expect(b.take()).toEqual([{ t: 'data', data: 'ls\r' }, { t: 'resize', cols: 100, rows: 30 }]);
  });
});
