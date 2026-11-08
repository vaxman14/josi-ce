import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACKNOWLEDGEMENTS, CLIP_MS, clipSource, firstName, GhostController, glowFor, inlineTokens, isListReply, loopFor, moodLabel,
  nextAcknowledgement, plainText, prefersHevc, replyParts, revealStepMs, stageMood, type GhostSnapshot,
} from '../src/lib/ghost';

describe('reply parts', () => {
  it('keeps a plain reply as one sentence', () => {
    expect(replyParts('Standup at 9:30, lunch at noon.')).toEqual({ lead: 'Standup at 9:30, lunch at noon.', items: [], tail: '' });
  });

  it('needs two list lines to make a list', () => {
    expect(isListReply('Here you go:\n- one thing')).toBe(false);
    expect(replyParts('Here you go:\n- one thing').lead).toBe('Here you go: one thing');
  });

  it('splits the lead, the items and what follows', () => {
    const parts = replyParts('Three things:\n\n1. Snow jacket\n2) **Chains** for the car\n* Chargers\n\nHave fun.');
    expect(parts).toEqual({ lead: 'Three things:', items: ['Snow jacket', '**Chains** for the car', 'Chargers'], tail: 'Have fun.' });
    expect(isListReply('Packing:\n- a\n- b')).toBe(true);
  });

  it('drops block markdown', () => {
    expect(replyParts('## Today\n> Quiet day.').lead).toBe('Today Quiet day.');
  });
});

describe('inline markdown', () => {
  it('shows only the words of a link and keeps the address for the anchor', () => {
    expect(inlineTokens('See [the agenda](https://example.com/a) now.')).toEqual([
      { kind: 'text', text: 'See ' }, { kind: 'link', text: 'the agenda', href: 'https://example.com/a' }, { kind: 'text', text: ' now.' },
    ]);
  });

  it('refuses unsafe link targets', () => {
    expect(inlineTokens('[click](javascript:void)')).toEqual([{ kind: 'text', text: 'click' }]);
    expect(inlineTokens('[click](javascript:alert(1))').some(token => token.kind === 'link')).toBe(false);
  });

  it('keeps bold and code, and strips every other symbol', () => {
    expect(inlineTokens('A **big** `npm ci` and *soft* ~~old~~ word')).toEqual([
      { kind: 'text', text: 'A ' }, { kind: 'bold', text: 'big' }, { kind: 'text', text: ' ' }, { kind: 'code', text: 'npm ci' },
      { kind: 'text', text: ' and soft old word' },
    ]);
    expect(plainText('**Done.** Saved to [Tasks](https://x.test/t) as _Lease_.')).toBe('Done. Saved to Tasks as Lease.');
  });

  it('turns a bare address into a link without trailing punctuation', () => {
    expect(inlineTokens('Go to https://heyjosi.com.')).toEqual([
      { kind: 'text', text: 'Go to ' }, { kind: 'link', text: 'https://heyjosi.com', href: 'https://heyjosi.com' }, { kind: 'text', text: '.' },
    ]);
  });
});

describe('the line', () => {
  it('paces the reveal at 70ms a word, never over 3.5 seconds', () => {
    expect(revealStepMs(0)).toBe(0);
    expect(revealStepMs(10)).toBe(70);
    expect(revealStepMs(100)).toBe(35);
  });

  it('rotates the acknowledgements', () => {
    const seen = ACKNOWLEDGEMENTS.map(() => nextAcknowledgement());
    expect(new Set(seen).size).toBe(ACKNOWLEDGEMENTS.length);
  });

  it('greets by first name', () => {
    expect(firstName({ displayName: 'Alex Rivera', username: 'alex' })).toBe('Alex');
    expect(firstName({ username: 'sam' })).toBe('sam');
    expect(firstName(null)).toBe('');
  });
});

describe('one state for the header, the chip and the ghost', () => {
  it('ranks thinking over speaking over listening', () => {
    expect(stageMood({ waiting: true, speaking: true, voice: true, typing: true })).toBe('thinking');
    expect(stageMood({ waiting: false, speaking: true, voice: true, typing: false })).toBe('speaking');
    expect(stageMood({ waiting: false, speaking: false, voice: false, typing: true })).toBe('listening');
    expect(stageMood({ waiting: false, speaking: false, voice: false, typing: false })).toBe('online');
    expect(moodLabel('thinking')).toBe('thinking…');
    expect(moodLabel('online')).toBe('online');
  });

  it('picks the loop underneath', () => {
    expect(loopFor({ waiting: true, voice: true, typing: true })).toBe('Waiting');
    expect(loopFor({ waiting: false, voice: true, typing: true })).toBe('Voice');
    expect(loopFor({ waiting: false, voice: false, typing: true })).toBe('Typing');
    expect(loopFor({ waiting: false, voice: false, typing: false })).toBe('Idle');
  });

  it('tints the glow by mood', () => {
    expect(glowFor('ear-cup')).toBe('listen');
    expect(glowFor('chin-tap')).toBe('think');
    expect(glowFor('oops')).toBe('oops');
    expect(glowFor('celebrate')).toBe('yay');
    expect(glowFor('idle-wiggle')).toBe('calm');
  });

  it('gives Safari and every iOS browser the HEVC clips', () => {
    const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    const iosChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
    const edge = `${chrome} Edg/126.0`;
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
    expect(prefersHevc(safari)).toBe(true);
    expect(prefersHevc(iosChrome)).toBe(true);
    expect(prefersHevc(chrome)).toBe(false);
    expect(prefersHevc(edge)).toBe(false);
    expect(prefersHevc(firefox)).toBe(false);
    expect(clipSource('wave-hello', false)).toBe('/ghost/wave-hello.webm');
    expect(clipSource('wave-hello', true)).toBe('/ghost/wave-hello.mov');
  });
});

describe('the ghost controller', () => {
  let ghost: GhostController;
  let last: GhostSnapshot;
  beforeEach(() => {
    vi.useFakeTimers();
    ghost = new GhostController();
    ghost.subscribe(snapshot => { last = snapshot; });
  });
  afterEach(() => { ghost.dispose(); vi.useRealTimers(); });

  it('waves hello, then hands back to idle and floats now and then', () => {
    ghost.set('Hello');
    expect(last.clip).toBe('wave-hello');
    expect(last.oneShot).toBe(true);
    vi.advanceTimersByTime(CLIP_MS['wave-hello']);
    expect(last.clip).toBe('idle-wiggle');
    vi.advanceTimersByTime(20_000);
    expect(last.clip).toBe('gentle-float');
    vi.advanceTimersByTime(CLIP_MS['gentle-float']);
    expect(last.clip).toBe('idle-wiggle');
  });

  it('alternates listening and nod-along, two passes each, while typing', () => {
    ghost.set('Typing');
    expect(last.clip).toBe('listening');
    vi.advanceTimersByTime(CLIP_MS.listening * 2);
    expect(last.clip).toBe('nod-along');
    vi.advanceTimersByTime(CLIP_MS['nod-along'] * 2);
    expect(last.clip).toBe('listening');
  });

  it('cups an ear for voice', () => {
    ghost.set('Voice');
    expect(last.clip).toBe('ear-cup');
  });

  it('thinks, then taps its chin after two seconds', () => {
    ghost.set('Waiting');
    expect(last.clip).toBe('thinking');
    vi.advanceTimersByTime(2000);
    expect(last.clip).toBe('chin-tap');
  });

  it('plays got-it over the wait, then a lightbulb, explains, floats and settles', () => {
    ghost.set('Received');
    ghost.set('Waiting');
    expect(last.clip).toBe('got-it');
    vi.advanceTimersByTime(CLIP_MS['got-it']);
    expect(last.clip).toBe('thinking');
    ghost.replied(false);
    ghost.set('Idle');
    expect(last.clip).toBe('lightbulb');
    expect(last.speaking).toBe(true);
    vi.advanceTimersByTime(CLIP_MS.lightbulb);
    expect(last.clip).toBe('explaining');
    vi.advanceTimersByTime(3042);
    expect(last.clip).toBe('gentle-float');
    expect(last.speaking).toBe(true);
    vi.advanceTimersByTime(CLIP_MS['gentle-float']);
    expect(last.clip).toBe('idle-wiggle');
    expect(last.speaking).toBe(false);
  });

  it('counts off when the reply is a list', () => {
    ghost.replied(true);
    expect(last.clip).toBe('counting-off');
  });

  it('waits for a one-shot already playing before the reply moment', () => {
    ghost.set('Received');
    ghost.replied(false);
    expect(last.clip).toBe('got-it');
    vi.advanceTimersByTime(CLIP_MS['got-it']);
    expect(last.clip).toBe('lightbulb');
  });

  it('queues at most two one-shots', () => {
    ghost.set('Received');
    ghost.set('Error');
    ghost.set('TaskDone');
    ghost.set('Hello');
    const seen = [last.clip];
    vi.advanceTimersByTime(CLIP_MS['got-it']); seen.push(last.clip);
    vi.advanceTimersByTime(CLIP_MS.oops); seen.push(last.clip);
    vi.advanceTimersByTime(CLIP_MS.celebrate); seen.push(last.clip);
    expect(seen).toEqual(['got-it', 'oops', 'celebrate', 'idle-wiggle']);
  });

  it('bumps the beat for every one-shot so the view can bounce', () => {
    const before = last.beat;
    ghost.set('Error');
    expect(last.beat).toBe(before + 1);
  });

  it('typing cuts the settle short', () => {
    ghost.replied(false);
    vi.advanceTimersByTime(CLIP_MS.lightbulb);
    expect(last.clip).toBe('explaining');
    ghost.set('Typing');
    expect(last.clip).toBe('listening');
    expect(last.speaking).toBe(false);
  });
});
