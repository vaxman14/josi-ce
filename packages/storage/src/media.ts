// Video and audio attachments, made readable.
//
// A model cannot take a video file. What it can take is a handful of still
// frames (as images, for models that passed the image check) and what was
// said (as text). This module produces both with the installation's pinned
// ffmpeg (packaging/windows/ffmpeg.lock.json), configured by JOSI_FFMPEG_EXE
// and JOSI_FFPROBE_EXE. Nothing is guessed: without ffmpeg the attachment
// stays "analysis unavailable" exactly as before.
//
// Untrusted input. ffmpeg parses arbitrary containers, so every run is
// bounded: local file and pipe protocols only, no network, a wall-clock
// limit, a capped output, and a private temporary copy that is removed after.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mpeg'] as const;
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'] as const;
/** Analysis codes recorded on a chat attachment while or after its media
 * analysis runs. The status column stays 'unavailable' until a transcript
 * exists, so nothing reads a half-made transcript as finished. */
export const MEDIA_PROCESSING = 'media_processing';
export const MEDIA_TRANSCRIPT = 'media_transcript';
/** Longest stretch of a recording Josi transcribes or samples. */
export const MAX_MEDIA_SECONDS = 30 * 60;
/** PCM16 mono 16 kHz: the format Voice Box's Whisper takes. */
export const PCM_RATE = 16_000;
export const TRANSCRIBE_CHUNK_SECONDS = 30;

export class MediaUnavailable extends Error {}

export function isVideo(extension: string): boolean { return (VIDEO_EXTENSIONS as readonly string[]).includes(extension.toLowerCase()); }
export function isAudio(extension: string): boolean { return (AUDIO_EXTENSIONS as readonly string[]).includes(extension.toLowerCase()); }

function tool(name: 'JOSI_FFMPEG_EXE' | 'JOSI_FFPROBE_EXE'): string {
  const path = process.env[name] ?? '';
  if (!path || !isAbsolute(path) || !existsSync(path)) throw new MediaUnavailable('The pinned ffmpeg is not installed on this server.');
  return path;
}
export function mediaToolsAvailable(): boolean {
  try { tool('JOSI_FFMPEG_EXE'); tool('JOSI_FFPROBE_EXE'); return true; } catch { return false; }
}

function run(command: string, args: string[], maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0; let failed: Error | null = null;
    const timer = setTimeout(() => { failed = new MediaUnavailable('The media file took too long to read.'); child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { failed = new MediaUnavailable('The media output exceeded its limit.'); child.kill(); } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new MediaUnavailable('ffmpeg could not start.')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) reject(failed);
      else if (code !== 0) reject(new MediaUnavailable('ffmpeg could not read this media file.'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** Run work against a private temporary copy of the media bytes. */
export async function withMediaFile<T>(bytes: Buffer, extension: string, work: (path: string) => Promise<T>): Promise<T> {
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new MediaUnavailable('Unsupported media type.');
  const folder = await mkdtemp(join(tmpdir(), 'josi-media-'));
  const path = join(folder, `input.${extension}`);
  try { await writeFile(path, bytes, { mode: 0o600 }); return await work(path); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

const SAFE_INPUT = ['-nostdin', '-hide_banner', '-v', 'error', '-protocol_whitelist', 'file,pipe'];

/** Duration in seconds, or null when the container does not say. */
export async function mediaDuration(path: string): Promise<number | null> {
  const out = await run(tool('JOSI_FFPROBE_EXE'), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path], 4096, 30_000);
  const value = Number(out.toString('ascii').trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The soundtrack as PCM16 mono 16 kHz, at most MAX_MEDIA_SECONDS. Empty
 * when the file has no audio stream. */
export async function extractPcm(path: string): Promise<Buffer> {
  try {
    return await run(tool('JOSI_FFMPEG_EXE'), [...SAFE_INPUT, '-i', path, '-vn', '-ac', '1', '-ar', String(PCM_RATE),
      '-t', String(MAX_MEDIA_SECONDS), '-f', 's16le', 'pipe:1'], MAX_MEDIA_SECONDS * PCM_RATE * 2 + 4096, 5 * 60_000);
  } catch (error) {
    // A silent video has no audio stream; that is "nothing said", not a failure.
    if (error instanceof MediaUnavailable && !/took too long|limit/.test(error.message)) return Buffer.alloc(0);
    throw error;
  }
}

export interface VideoFrame { atSeconds: number; jpeg: Buffer }

/** Evenly spaced still frames (JPEG, at most 768 px wide), in order. */
export async function extractFrames(path: string, count = 8): Promise<VideoFrame[]> {
  const duration = Math.min(await mediaDuration(path) ?? 0, MAX_MEDIA_SECONDS);
  const times = duration > 0 ? Array.from({ length: count }, (_, i) => duration * (i + 0.5) / count) : [0];
  const frames: VideoFrame[] = [];
  for (const at of times) {
    const jpeg = await run(tool('JOSI_FFMPEG_EXE'), [...SAFE_INPUT, '-ss', at.toFixed(2), '-i', path, '-frames:v', '1',
      '-vf', "scale='min(768,iw)':-2", '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1'], 2 * 1024 * 1024, 60_000).catch(() => Buffer.alloc(0));
    if (jpeg.length > 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8) frames.push({ atSeconds: Math.round(at), jpeg });
  }
  if (!frames.length) throw new MediaUnavailable('No frames could be read from this video.');
  return frames;
}

/** mm:ss or h:mm:ss. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(r).padStart(2, '0');
}

export interface TranscriptSegment { start: number; end: number; text: string }
/** Joins timed segments into the stored transcript text. */
export function transcriptText(segments: TranscriptSegment[]): string {
  return segments.filter(s => s.text.trim()).map(s => `[${clock(s.start)}] ${s.text.trim()}`).join('\n').slice(0, 100_000);
}
