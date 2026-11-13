import { describe, expect, it } from 'vitest';
import { LOOP_CLIPS, clipSource, clipUrl, ghostRetryDelayMs, warmClips } from '../src/lib/ghost.js';

describe('a ghost clip that fails is tried again', () => {
  it('waits 4, 8 and 16 seconds, then every 30', () => {
    expect([0, 1, 2, 3, 4, 9].map(ghostRetryDelayMs)).toEqual([4000, 8000, 16000, 30000, 30000, 30000]);
    expect(ghostRetryDelayMs(-1)).toBe(4000);
  });
});

describe('the looping clips are kept in memory', () => {
  it('plays from the server until a clip is kept, then from the copy the page holds', async () => {
    expect(clipUrl('gentle-float', false)).toBe(clipSource('gentle-float', false));
    const asked: string[] = [];
    const fetcher = (async (url: string) => { asked.push(url); return new Response(new Blob(['clip'])); }) as unknown as typeof fetch;
    await warmClips(false, fetcher);
    expect(asked).toEqual(LOOP_CLIPS.map(clip => clipSource(clip, false)));
    expect(clipUrl('gentle-float', false)).toMatch(/^blob:/);
    expect(clipUrl('gentle-float', true)).toBe(clipSource('gentle-float', true)); // the other format is not kept
    expect(clipUrl('celebrate', false)).toBe(clipSource('celebrate', false)); // a one-shot is not kept
  });

  it('skips a clip it could not get and asks for it again next time, and asks only once at a time', async () => {
    let calls = 0;
    const failing = (async () => { calls++; throw new Error('offline'); }) as unknown as typeof fetch;
    await warmClips(true, failing);
    expect(calls).toBe(LOOP_CLIPS.length);
    expect(clipUrl('idle-wiggle', true)).toBe(clipSource('idle-wiggle', true));
    const answered: string[] = [];
    const working = (async (url: string) => { answered.push(url); return new Response(new Blob(['x'])); }) as unknown as typeof fetch;
    await Promise.all([warmClips(true, working), warmClips(true, working)]);
    expect(answered).toHaveLength(LOOP_CLIPS.length);
    expect(clipUrl('idle-wiggle', true)).toMatch(/^blob:/);
  });
});
