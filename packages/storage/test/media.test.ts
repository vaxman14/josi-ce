// Runs against the real pinned ffmpeg when JOSI_FFMPEG_EXE/JOSI_FFPROBE_EXE
// point at it (scripts/windows/dev/Get-Ffmpeg.ps1); skipped otherwise.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MediaUnavailable, PCM_RATE, clock, extractFrames, extractPcm, mediaDuration, mediaToolsAvailable, transcriptText, withMediaFile } from '../src/media.js';

const available = mediaToolsAvailable();
const folder = mkdtempSync(join(tmpdir(), 'josi-media-test-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe.skipIf(!available)('video and audio attachments with the pinned ffmpeg', () => {
  const clip = join(folder, 'clip.mp4');
  execFileSync(process.env.JOSI_FFMPEG_EXE!, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const bytes = readFileSync(clip);

  it('takes evenly spaced JPEG frames in time order', async () => {
    const frames = await withMediaFile(bytes, 'mp4', (path) => extractFrames(path, 4));
    expect(frames).toHaveLength(4);
    expect(frames.map((f) => f.atSeconds)).toEqual([1, 2, 4, 5]);
    for (const f of frames) expect(f.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('extracts the soundtrack as 16 kHz mono PCM', async () => {
    const pcm = await withMediaFile(bytes, 'mp4', extractPcm);
    const seconds = pcm.length / (PCM_RATE * 2);
    expect(seconds).toBeGreaterThan(5.5);
    expect(seconds).toBeLessThan(6.5);
    expect(await withMediaFile(bytes, 'mp4', mediaDuration)).toBeGreaterThan(5.5);
  });

  it('refuses a file that is not media', async () => {
    await expect(withMediaFile(Buffer.from('not a video'), 'mp4', (path) => extractFrames(path, 2))).rejects.toBeInstanceOf(MediaUnavailable);
  });
});

describe('transcript text', () => {
  it('keeps timestamps and drops empty segments', () => {
    expect(clock(75)).toBe('1:15');
    expect(clock(3725)).toBe('1:02:05');
    expect(transcriptText([{ start: 0, end: 2, text: ' Hello there ' }, { start: 3, end: 4, text: '  ' }, { start: 65, end: 70, text: 'Later.' }]))
      .toBe('[0:00] Hello there\n[1:05] Later.');
  });
});
