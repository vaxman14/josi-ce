// Sign-in sessions: you sign in for Josi, on a live view of her browser or in a
// terminal (docs/LIVE_SIGN_IN.md).
//
// This broker lives in the API process and holds only what is needed to relay
// one session between the person's browser and the PC service: the latest
// picture, a small terminal buffer and the queue of the person's keystrokes.
// Nothing here is written to the database, a log or the model's context, and a
// session ends on its own when it is idle or too old.
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export type LiveKind = 'browser' | 'terminal';
export type LiveState = 'starting' | 'ready' | 'ended';
export type LiveEvent =
  | { t: 'click'; x: number; y: number; button: 1 | 2 | 3; count: 1 | 2 }
  | { t: 'move'; x: number; y: number }
  | { t: 'scroll'; x: number; y: number; dy: number }
  | { t: 'text'; text: string }
  | { t: 'key'; key: string }
  | { t: 'data'; data: string }
  | { t: 'resize'; cols: number; rows: number };

export const LIVE_LIMITS = {
  events: 64, text: 2000, data: 4096, frameBytes: 450_000, outputRing: 256 * 1024, outputPerSync: 64 * 1024,
  idleMs: 10 * 60_000, maxMs: 60 * 60_000, maxWaitMs: 8000, queue: 512,
} as const;

const KEY = /^([a-zA-Z0-9_]+\+){0,3}[a-zA-Z0-9_]+$/;
const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** The events a person may send, cleaned. Anything malformed is dropped, never
 * repaired, and the count is capped. */
export function cleanEvents(kind: LiveKind, raw: unknown): LiveEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveEvent[] = [];
  for (const item of raw.slice(0, LIVE_LIMITS.events)) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (kind === 'browser') {
      if (e.t === 'click' || e.t === 'move' || e.t === 'scroll') {
        const x = int(e.x, 0, 20000), y = int(e.y, 0, 20000);
        if (x === null || y === null) continue;
        if (e.t === 'move') out.push({ t: 'move', x, y });
        else if (e.t === 'click') {
          const button = e.button === undefined ? 1 : int(e.button, 1, 3), count = e.count === undefined ? 1 : int(e.count, 1, 2);
          if (button === null || count === null) continue;
          out.push({ t: 'click', x, y, button: button as 1 | 2 | 3, count: count as 1 | 2 });
        } else { const dy = int(e.dy, -20, 20); if (dy === null || dy === 0) continue; out.push({ t: 'scroll', x, y, dy }); }
      } else if (e.t === 'text') {
        if (typeof e.text === 'string' && e.text.length > 0 && e.text.length <= LIVE_LIMITS.text && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(e.text)) out.push({ t: 'text', text: e.text });
      } else if (e.t === 'key') {
        if (typeof e.key === 'string' && e.key.length <= 40 && KEY.test(e.key)) out.push({ t: 'key', key: e.key });
      }
    } else if (e.t === 'data') {
      if (typeof e.data === 'string' && e.data.length > 0 && e.data.length <= LIVE_LIMITS.data) out.push({ t: 'data', data: e.data });
    } else if (e.t === 'resize') {
      const cols = int(e.cols, 20, 400), rows = int(e.rows, 5, 200);
      if (cols !== null && rows !== null) out.push({ t: 'resize', cols, rows });
    }
  }
  return out;
}

export interface LiveSession {
  id: string; kind: LiveKind; pcId: string; userId: string; cardId: string | null;
  title: string; url: string | null; command: string | null; runAs: string | null;
  state: LiveState; error: string | null;
  createdAt: number; lastPersonAt: number; endedAt: number | null;
  frame: { seq: number; width: number; height: number; jpeg: Buffer } | null;
  output: { text: string; start: number; end: number; running: boolean; exitCode: number | null };
  input: LiveEvent[];
}

export interface LiveCreate { kind: LiveKind; pcId: string; userId: string; cardId?: string | null; title: string; url?: string | null; command?: string | null; runAs?: string | null }

export class LiveSignInBroker {
  private sessions = new Map<string, LiveSession>();
  private waiters = new Set<() => void>();
  constructor(private now: () => number = Date.now) {}

  private wake() { for (const w of [...this.waiters]) w(); }
  /** Resolves when `ready()` is true, `ms` pass (false), or anything changes and it becomes true. */
  private wait(ready: () => boolean, ms: number): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value: boolean) => { clearTimeout(timer); this.waiters.delete(check); resolve(value); };
      const check = () => { if (ready()) done(true); };
      const timer = setTimeout(() => done(false), Math.min(Math.max(ms, 0), LIVE_LIMITS.maxWaitMs));
      this.waiters.add(check);
    });
  }

  reap() {
    const now = this.now();
    for (const s of this.sessions.values()) {
      if (s.state !== 'ended' && (now - s.lastPersonAt > LIVE_LIMITS.idleMs || now - s.createdAt > LIVE_LIMITS.maxMs)) this.end(s.id, 'timed out');
      // A finished session stays visible for a minute so a late poll learns it ended.
      else if (s.state === 'ended' && s.endedAt !== null && now - s.endedAt > 60_000) this.sessions.delete(s.id);
    }
  }

  create(input: LiveCreate): LiveSession | 'busy' {
    this.reap();
    const clash = [...this.sessions.values()].find((s) => s.pcId === input.pcId && s.kind === input.kind && s.state !== 'ended');
    if (clash) return 'busy';
    const now = this.now();
    const session: LiveSession = {
      id: randomUUID(), kind: input.kind, pcId: input.pcId, userId: input.userId, cardId: input.cardId ?? null,
      title: input.title, url: input.url ?? null, command: input.command ?? null, runAs: input.runAs ?? null,
      state: 'starting', error: null, createdAt: now, lastPersonAt: now, endedAt: null, frame: null,
      output: { text: '', start: 0, end: 0, running: input.kind === 'terminal', exitCode: null }, input: [],
    };
    this.sessions.set(session.id, session);
    this.wake();
    return session;
  }

  get(id: string): LiveSession | null { this.reap(); return this.sessions.get(id) ?? null; }
  forCard(cardId: string): LiveSession | null { return [...this.sessions.values()].find((s) => s.cardId === cardId && s.state !== 'ended') ?? null; }
  active(pcId: string): LiveSession[] { this.reap(); return [...this.sessions.values()].filter((s) => s.pcId === pcId && s.state !== 'ended'); }
  touch(id: string) { const s = this.sessions.get(id); if (s) s.lastPersonAt = this.now(); }

  end(id: string, error: string | null = null) {
    const s = this.sessions.get(id); if (!s || s.state === 'ended') return;
    s.state = 'ended'; s.endedAt = this.now(); s.error = s.error ?? error; s.frame = null; s.input = [];
    this.wake();
  }

  // ---- from the PC service
  ready(id: string) { const s = this.sessions.get(id); if (s && s.state === 'starting') { s.state = 'ready'; this.wake(); } }
  fail(id: string, message: string) { const s = this.sessions.get(id); if (s) { s.error = message.slice(0, 300); this.end(id, s.error); } }
  pushFrame(id: string, width: number, height: number, jpeg: Buffer): boolean {
    const s = this.sessions.get(id);
    if (!s || s.state === 'ended' || s.kind !== 'browser') return false;
    if (jpeg.length === 0 || jpeg.length > LIVE_LIMITS.frameBytes || !int(width, 16, 8192) || !int(height, 16, 8192)) return false;
    s.frame = { seq: (s.frame?.seq ?? 0) + 1, width, height, jpeg };
    this.ready(id); this.wake();
    return true;
  }
  pushOutput(id: string, data: string, running: boolean, exitCode: number | null) {
    const s = this.sessions.get(id);
    if (!s || s.state === 'ended' || s.kind !== 'terminal') return;
    const o = s.output;
    if (data) { o.text += data.slice(0, LIVE_LIMITS.outputPerSync); o.end = o.start + o.text.length; }
    if (o.text.length > LIVE_LIMITS.outputRing) { const cut = o.text.length - LIVE_LIMITS.outputRing; o.text = o.text.slice(cut); o.start += cut; }
    o.running = running; o.exitCode = running ? null : exitCode;
    this.ready(id); this.wake();
  }
  /** The person's queued events, for the PC service. */
  takeInput(id: string): LiveEvent[] { const s = this.sessions.get(id); if (!s) return []; const out = s.input; s.input = []; return out; }

  // ---- from the person
  queueInput(id: string, events: LiveEvent[]): number {
    const s = this.sessions.get(id);
    if (!s || s.state === 'ended') return 0;
    s.lastPersonAt = this.now();
    const room = Math.max(0, LIVE_LIMITS.queue - s.input.length);
    s.input.push(...events.slice(0, room));
    return Math.min(events.length, room);
  }
  async nextFrame(id: string, after: number, waitMs: number) {
    const s = this.sessions.get(id); if (!s) return null;
    s.lastPersonAt = this.now();
    await this.wait(() => s.state === 'ended' || (s.frame?.seq ?? 0) > after, waitMs);
    return s;
  }
  async nextOutput(id: string, after: number, waitMs: number) {
    const s = this.sessions.get(id); if (!s) return null;
    s.lastPersonAt = this.now();
    await this.wait(() => s.state === 'ended' || s.output.end > after || (!s.output.running && s.output.exitCode !== null), waitMs);
    return s;
  }
}

/** Whether this person may sign in for Josi: the owner always, anyone else
 * only when the owner granted it (migration 0123). */
export async function mayLiveSignIn(db: Db, user: { id: string; role: string }): Promise<boolean> {
  if (user.role === 'super_admin') return true;
  const rows = await db.query<{ user_id: string }>(
    `select g.user_id from live_signin_grants g join users u on u.id = g.user_id where g.user_id = $1 and u.status = 'active'`, [user.id]);
  return rows.length > 0;
}
