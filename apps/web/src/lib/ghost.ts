// The Ghost Stage's thinking, kept apart from React so it can be tested.
//
// A port of the Android and Windows GhostController: screens set a state, and
// this works out which Masko clip is on. Loops run underneath; a one-shot plays
// once and hands back to the loop. The clips are static files under
// public/ghost, never imported into the bundle.

export const LOOP_CLIPS = ['idle-wiggle', 'listening', 'thinking', 'gentle-float', 'nod-along', 'ear-cup', 'chin-tap', 'explaining'] as const;
export const ONE_SHOT_CLIPS = ['wave-hello', 'got-it', 'lightbulb', 'counting-off', 'celebrate', 'oops'] as const;
export type GhostClip = typeof LOOP_CLIPS[number] | typeof ONE_SHOT_CLIPS[number];

/** How long each clip runs, in milliseconds. */
export const CLIP_MS: Record<GhostClip, number> = {
  'idle-wiggle': 2333, 'gentle-float': 2333,
  listening: 3042, 'nod-along': 3042, 'ear-cup': 3042, thinking: 3042, 'chin-tap': 3042, explaining: 3042,
  'wave-hello': 3750, 'got-it': 3750, 'counting-off': 3750,
  lightbulb: 5167, celebrate: 5167, oops: 5167,
};

export const isLoopClip = (clip: GhostClip) => (LOOP_CLIPS as readonly string[]).includes(clip);

export type GhostLoop = 'Idle' | 'Resting' | 'Typing' | 'Voice' | 'Waiting' | 'Streaming';
export type GhostMoment = 'Hello' | 'Received' | 'AnswerFound' | 'ListReply' | 'TaskDone' | 'Error';
export type GhostState = GhostLoop | GhostMoment;

const LOOPS: Record<GhostLoop, GhostClip[]> = {
  Idle: ['idle-wiggle'],
  Resting: ['gentle-float'],
  Typing: ['listening', 'nod-along'],
  Voice: ['ear-cup', 'listening'],
  Waiting: ['thinking', 'chin-tap'],
  Streaming: ['explaining'],
};
const MOMENTS: Record<GhostMoment, GhostClip> = {
  Hello: 'wave-hello', Received: 'got-it', AnswerFound: 'lightbulb', ListReply: 'counting-off', TaskDone: 'celebrate', Error: 'oops',
};
export const isMoment = (state: GhostState): state is GhostMoment => state in MOMENTS;

export const GHOST_TIMING = {
  maxQueued: 2,
  passesPerClip: 2,
  chinTapAfterMs: 2000,
  explainMs: 3042,
  quietMs: 20_000,
};

export interface GhostSnapshot {
  clip: GhostClip;
  /** True while a one-shot is on. */
  oneShot: boolean;
  /** Bumped each time a one-shot starts, so the view can bounce. */
  beat: number;
  /** True from a reply landing until the ghost settles back to idle. */
  speaking: boolean;
}

/** The one thing the stage talks to. Timers are the global ones, so tests can
 * drive it with fake timers. */
export class GhostController {
  private clip: GhostClip = 'idle-wiggle';
  private mood: GhostLoop = 'Idle';
  private after: GhostLoop | null = null;
  private settlePending = false;
  private queue: GhostClip[] = [];
  private oneShot: ReturnType<typeof setTimeout> | null = null;
  private turns: ReturnType<typeof setTimeout>[] = [];
  private settling: ReturnType<typeof setTimeout> | null = null;
  private beat = 0;
  private listener: ((snapshot: GhostSnapshot) => void) | null = null;

  subscribe(listener: (snapshot: GhostSnapshot) => void) {
    this.listener = listener;
    listener(this.snapshot());
    return () => { if (this.listener === listener) this.listener = null; };
  }

  snapshot(): GhostSnapshot {
    return { clip: this.clip, oneShot: this.oneShot !== null, beat: this.beat, speaking: this.after !== null || this.settlePending };
  }

  get loop(): GhostLoop { return this.mood; }

  set(state: GhostState) {
    if (isMoment(state)) {
      if (this.queue.length < GHOST_TIMING.maxQueued) this.queue.push(MOMENTS[state]);
      if (this.oneShot === null) this.playNext();
      return;
    }
    if (state === this.mood) return;
    this.mood = state;
    if (state !== 'Idle') this.cancelSettling();
    this.showLoop();
  }

  /** A reply the person was waiting on: the moment it lands, explaining for a
   * while, a brief float, then idle. */
  replied(isList: boolean) {
    this.cancelSettling();
    this.after = 'Streaming';
    this.settlePending = true;
    this.set(isList ? 'ListReply' : 'AnswerFound');
    if (this.oneShot === null) this.startSettling();
    else this.emit();
  }

  dispose() {
    this.clearTurns();
    if (this.oneShot) clearTimeout(this.oneShot);
    if (this.settling) clearTimeout(this.settling);
    this.oneShot = null; this.settling = null; this.listener = null;
  }

  private cancelSettling() {
    if (this.settling) clearTimeout(this.settling);
    this.settling = null;
    this.after = null;
    this.settlePending = false;
  }

  private startSettling() {
    this.settlePending = false;
    this.after = 'Streaming';
    this.showLoop();
    this.settling = setTimeout(() => {
      this.after = 'Resting';
      this.showLoop();
      this.settling = setTimeout(() => {
        this.settling = null;
        this.after = null;
        this.showLoop();
      }, CLIP_MS['gentle-float']);
    }, GHOST_TIMING.explainMs);
  }

  private playNext() {
    const next = this.queue.shift();
    if (next === undefined) {
      this.oneShot = null;
      if (this.settlePending) this.startSettling();
      else this.showLoop();
      return;
    }
    this.clearTurns();
    this.clip = next;
    this.beat++;
    this.oneShot = setTimeout(() => this.playNext(), CLIP_MS[next]);
    this.emit();
  }

  private clearTurns() {
    this.turns.forEach(clearTimeout);
    this.turns = [];
  }

  private showLoop() {
    if (this.oneShot !== null) { this.emit(); return; }
    this.clearTurns();
    const state = this.after ?? this.mood;
    const clips = LOOPS[state];
    this.clip = clips[0]!;
    this.emit();
    if (state === 'Waiting') {
      this.turns.push(setTimeout(() => { this.clip = 'chin-tap'; this.emit(); }, GHOST_TIMING.chinTapAfterMs));
    } else if (state === 'Typing' || state === 'Voice') {
      let turn = 0;
      const step = () => {
        this.turns = [setTimeout(() => {
          turn++;
          this.clip = clips[turn % clips.length]!;
          this.emit();
          step();
        }, CLIP_MS[this.clip] * GHOST_TIMING.passesPerClip)];
      };
      step();
    } else if (state === 'Idle') {
      const rest = () => {
        this.turns = [setTimeout(() => {
          this.clip = 'gentle-float'; this.emit();
          this.turns = [setTimeout(() => { this.clip = 'idle-wiggle'; this.emit(); rest(); }, CLIP_MS['gentle-float'])];
        }, GHOST_TIMING.quietMs)];
      };
      rest();
    }
  }

  private emit() { this.listener?.(this.snapshot()); }
}

/** The loop underneath, from what the page knows. */
export function loopFor({ waiting, voice, typing }: { waiting: boolean; voice: boolean; typing: boolean }): GhostLoop {
  if (waiting) return 'Waiting';
  if (voice) return 'Voice';
  if (typing) return 'Typing';
  return 'Idle';
}

export type StageMood = 'listening' | 'thinking' | 'speaking' | 'online';

/** The one state the header, the chip and the ghost's glow all follow. */
export function stageMood({ waiting, speaking, voice, typing }: { waiting: boolean; speaking: boolean; voice: boolean; typing: boolean }): StageMood {
  if (waiting) return 'thinking';
  if (speaking) return 'speaking';
  if (voice || typing) return 'listening';
  return 'online';
}

export const moodLabel = (mood: StageMood) => mood === 'online' ? 'online' : `${mood}…`;

/** What the glow under the ghost does for each clip. */
export function glowFor(clip: GhostClip): 'listen' | 'think' | 'oops' | 'yay' | 'calm' {
  if (clip === 'listening' || clip === 'nod-along' || clip === 'ear-cup') return 'listen';
  if (clip === 'thinking' || clip === 'chin-tap') return 'think';
  if (clip === 'oops') return 'oops';
  if (clip === 'celebrate') return 'yay';
  return 'calm';
}

/** Safari (and every iOS browser, which is Safari underneath) cannot play WebM
 * with alpha, so it gets the HEVC .mov. */
export function prefersHevc(userAgent: string): boolean {
  return /AppleWebKit/.test(userAgent) && !/(Chrome|Chromium|Edg|OPR|Android)\//.test(userAgent) && !/Android/.test(userAgent);
}

export const clipSource = (clip: GhostClip, hevc: boolean) => `/ghost/${clip}.${hevc ? 'mov' : 'webm'}`;
export const GHOST_STILL = '/ghost/arms-open.png';

// ------------------------------------------------------------------ the line

export const ACKNOWLEDGEMENTS = [
  'I got you.',
  'Consider it handled. Well, almost.',
  'On it. Try to contain your excitement.',
  'Oh, I like this one. Give me a sec.',
  'Say less.',
] as const;

let ackTurn = 0;
/** The next acknowledgement, in rotation. */
export function nextAcknowledgement(): string {
  const value = ACKNOWLEDGEMENTS[ackTurn % ACKNOWLEDGEMENTS.length]!;
  ackTurn++;
  return value;
}

const LIST_LINE = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/;

/** A reply as the stage shows it: the sentence, its list if it has one, and
 * what follows the list. Still markdown inline; block syntax is gone. */
export interface ReplyParts { lead: string; items: string[]; tail: string }

function cleanBlockLine(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/, '')
    .replace(/^\s*```.*$/, '');
}

/** Two list lines or more make a list. */
export function replyParts(reply: string): ReplyParts {
  const lines = reply.replace(/\r\n?/g, '\n').trim().split('\n').map(cleanBlockLine);
  const isItem = (line: string) => LIST_LINE.test(line);
  const items = lines.flatMap(line => { const match = LIST_LINE.exec(line); return match ? [match[1]!.trim()] : []; });
  const join = (part: string[]) => part.map(line => line.trim()).filter(Boolean).join(' ').trim();
  if (items.length < 2) return { lead: join(lines.map(line => line.replace(LIST_LINE, '$1'))), items: [], tail: '' };
  const first = lines.findIndex(isItem);
  let last = lines.length - 1;
  while (last >= 0 && !isItem(lines[last]!)) last--;
  return { lead: join(lines.slice(0, first)), items, tail: join(lines.slice(last + 1)) };
}

export const isListReply = (reply: string) => replyParts(reply).items.length > 0;

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

/** Inline markdown as tokens: links show only their words, bold and code keep
 * their look, every other symbol goes. */
export function inlineTokens(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const push = (token: InlineToken) => {
    if (!token.text) return;
    const previous = tokens[tokens.length - 1];
    if (token.kind === 'text' && previous?.kind === 'text') previous.text += token.text;
    else tokens.push(token);
  };
  const pattern = /!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let at = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (match.index > at) push({ kind: 'text', text: stripEmphasis(source.slice(at, match.index)) });
    const [, imageAlt, , linkText, linkHref, code, bold, boldUnderscore, bare] = match;
    if (imageAlt !== undefined) push({ kind: 'text', text: stripEmphasis(imageAlt) });
    else if (linkText !== undefined && linkHref !== undefined) {
      const text = stripEmphasis(linkText);
      push(SAFE_HREF.test(linkHref) ? { kind: 'link', text, href: linkHref } : { kind: 'text', text });
    } else if (code !== undefined) push({ kind: 'code', text: code });
    else if (bold !== undefined || boldUnderscore !== undefined) push({ kind: 'bold', text: stripEmphasis(bold ?? boldUnderscore ?? '') });
    else if (bare !== undefined) push({ kind: 'link', text: bare, href: bare });
    at = match.index + match[0].length;
  }
  if (at < source.length) push({ kind: 'text', text: stripEmphasis(source.slice(at)) });
  return tokens;
}

/** Single-star and underscore emphasis, strikethrough and stray markers. */
function stripEmphasis(text: string): string {
  return text
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '');
}

/** The words a person sees, with no markdown left in them. */
export const plainText = (source: string) => inlineTokens(source).map(token => token.text).join('');

/** Splits on whitespace and keeps the spacing out of the words. */
export const splitWords = (text: string) => text.split(/\s+/).filter(Boolean);

/** The pace of a reply coming in. A long one speeds up, so it never takes
 * over about 3.5 seconds. */
export const revealStepMs = (words: number) => words <= 0 ? 0 : Math.min(70, 3500 / words);

/** "Hi Alex" from whatever the account has. */
export function firstName(user: { displayName?: string | null; display_name?: string | null; username?: string } | null | undefined): string {
  const name = (user?.displayName || user?.display_name || user?.username || '').trim();
  return name.split(/\s+/)[0] ?? '';
}

// ------------------------------------------------------------------ keeping the clips

/** After a clip fails to play, wait this long before trying again: 4 s, 8 s, 16 s, then every 30 s.
 * A failure must never leave the ghost on a still for good. */
export const ghostRetryDelayMs = (attempt: number) => Math.min(30_000, 4_000 * 2 ** Math.max(0, attempt));

const keptClips = new Map<string, string>();
let warming: Promise<void> | null = null;

/** Where a clip plays from: the copy this page already holds, else the server. A clip the page
 * holds still plays when the connection is down, which is exactly when the ghost used to vanish
 * (the resting clip is first asked for after twenty quiet seconds). */
export const clipUrl = (clip: GhostClip, hevc: boolean) => keptClips.get(`${clip}.${hevc}`) ?? clipSource(clip, hevc);

/** Keeps the looping clips in memory, one at a time, once per page. Failures are skipped; the
 * next call tries the missing ones again. */
export function warmClips(hevc: boolean, fetcher: typeof fetch = fetch): Promise<void> {
  if (warming) return warming;
  warming = (async () => {
    for (const clip of LOOP_CLIPS) {
      const key = `${clip}.${hevc}`;
      if (keptClips.has(key)) continue;
      try {
        const response = await fetcher(clipSource(clip, hevc), { cache: 'force-cache' });
        if (!response.ok) continue;
        keptClips.set(key, URL.createObjectURL(await response.blob()));
      } catch { /* try again on the next call */ }
    }
  })().finally(() => { warming = null; });
  return warming;
}
