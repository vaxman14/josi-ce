// Pure helpers for the live sign-in panel (docs/LIVE_SIGN_IN.md): scaling a
// click on the shown picture to frame pixels, turning keys into the executor's
// xdotool-style events, and batching events so the server is called about ten
// times a second rather than on every mouse move.

export type BrowserEvent =
  | { t: 'click'; x: number; y: number; button?: 1 | 2 | 3; count?: 1 | 2 }
  | { t: 'move'; x: number; y: number }
  | { t: 'scroll'; x: number; y: number; dy: number }
  | { t: 'text'; text: string }
  | { t: 'key'; key: string };
export type TerminalEvent = { t: 'data'; data: string } | { t: 'resize'; cols: number; rows: number };
export type LiveEvent = BrowserEvent | TerminalEvent;

export const MAX_EVENTS_PER_CALL = 64;
export const MAX_TEXT = 2000;
export const MAX_DATA = 4096;
export const MAX_SCROLL = 20;

/** A point on the displayed picture, in pixels of the frame itself. Null when
 * the picture has no size yet. Clamped to the frame. */
export function scaleToFrame(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, frameWidth: number, frameHeight: number): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0) || !(frameWidth > 0) || !(frameHeight > 0)) return null;
  const x = Math.round(((clientX - rect.left) / rect.width) * frameWidth);
  const y = Math.round(((clientY - rect.top) / rect.height) * frameHeight);
  return { x: Math.min(frameWidth - 1, Math.max(0, x)), y: Math.min(frameHeight - 1, Math.max(0, y)) };
}

/** Wheel pixels to wheel ticks (one tick is about 100 px, in lines about 3). */
export function wheelTicks(deltaY: number, deltaMode = 0): number {
  const ticks = deltaMode === 1 ? deltaY / 3 : deltaMode === 2 ? deltaY * 10 : deltaY / 100;
  const rounded = ticks === 0 ? 0 : ticks > 0 ? Math.max(1, Math.round(ticks)) : Math.min(-1, Math.round(ticks));
  return Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, rounded));
}

const NAMED: Record<string, string> = {
  Enter: 'Return', Tab: 'Tab', Backspace: 'BackSpace', Escape: 'Escape', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', Insert: 'Insert',
};
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Dead', 'Process', 'Unidentified']);

export interface KeyLike { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; shiftKey?: boolean }

/** What a key press means to the sign-in screen. `null` means send nothing:
 * a bare modifier, ctrl+v (the paste event carries the text) or an unknown key. */
export function keyToEvent(e: KeyLike): BrowserEvent | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const ctrl = !!e.ctrlKey || !!e.metaKey;
  const named = NAMED[e.key] ?? (/^F([1-9]|1[0-2])$/.test(e.key) ? e.key : undefined);
  if (named) return { t: 'key', key: `${ctrl ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${named}` };
  if (e.key.length === 1) {
    if (ctrl) {
      const letter = e.key.toLowerCase();
      if (letter === 'v') return null;
      if (/^[a-z0-9]$/.test(letter)) return { t: 'key', key: `ctrl+${e.altKey ? 'alt+' : ''}${letter}` };
      return null;
    }
    if (e.altKey && /^[a-z0-9]$/i.test(e.key)) return { t: 'key', key: `alt+${e.key.toLowerCase()}` };
    return { t: 'text', text: e.key };
  }
  return null;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Collects events and hands them out in calls of at most 64. Neighbouring
 * typing is joined into one text event, scrolling at one spot is summed and a
 * run of pointer moves keeps only the last. Order is otherwise kept. */
export class EventBatcher<E extends LiveEvent = LiveEvent> {
  private queue: E[] = [];

  get size(): number { return this.queue.length; }

  push(event: E): void {
    const last = this.queue[this.queue.length - 1] as LiveEvent | undefined;
    const next = event as LiveEvent;
    if (last) {
      if (last.t === 'text' && next.t === 'text' && last.text.length + next.text.length <= MAX_TEXT) { last.text += next.text; return; }
      if (last.t === 'data' && next.t === 'data' && last.data.length + next.data.length <= MAX_DATA) { last.data += next.data; return; }
      if (last.t === 'move' && next.t === 'move') { last.x = next.x; last.y = next.y; return; }
      if (last.t === 'scroll' && next.t === 'scroll' && last.x === next.x && last.y === next.y) { last.dy = clamp(last.dy + next.dy, -MAX_SCROLL, MAX_SCROLL); return; }
      if (last.t === 'resize' && next.t === 'resize') { last.cols = next.cols; last.rows = next.rows; return; }
    }
    this.queue.push({ ...event });
  }

  /** The next call's worth, removed from the queue. Empty when nothing waits. */
  take(max = MAX_EVENTS_PER_CALL): E[] {
    return this.queue.splice(0, max);
  }

  /** Put events back at the front after a call failed. */
  putBack(events: E[]): void { this.queue.unshift(...events); }
}
