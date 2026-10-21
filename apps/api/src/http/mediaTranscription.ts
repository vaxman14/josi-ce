// What was said in an audio or video attachment, transcribed once after
// upload by Voice Box's local Whisper and kept as the attachment's extracted
// text with [m:ss] timestamps. Runs in the web service because only it holds
// the private voice credential; the upload answers at once and the transcript
// arrives a little later. The assistant turn waits for it briefly.
import type { Db } from '@josi-ce/core';
import {
  MEDIA_PROCESSING, MEDIA_TRANSCRIPT, MediaUnavailable, PCM_RATE, TRANSCRIBE_CHUNK_SECONDS,
  extractPcm, transcriptText, withMediaFile, type TranscriptSegment,
} from '@josi-ce/storage';
import type { VoiceHelper } from './voiceBoxRoutes.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function finish(db: Db, id: string, status: 'available' | 'unavailable', code: string, text: string | null) {
  // Only the run that started it settles it; a deleted attachment stays deleted.
  await db.query(`update chat_attachments set analysis_status=$2, analysis_code=$3, extracted_text=$4
    where id=$1 and analysis_code=$5`, [id, status, code, text, MEDIA_PROCESSING]);
}

async function transcribeChunk(helper: VoiceHelper, pcm: Buffer): Promise<TranscriptSegment[]> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const reply = await helper('/transcribe', { pcm: pcm.toString('base64') });
    if (reply.status === 429) { await sleep(5000); continue; }
    if (reply.status !== 200) throw new Error(`voice ${reply.status}`);
    const value = JSON.parse(reply.data.toString('utf8')) as { segments?: unknown };
    if (!Array.isArray(value.segments)) throw new Error('voice reply');
    return value.segments.flatMap((s) => {
      const segment = s as Partial<TranscriptSegment>;
      return typeof segment.start === 'number' && typeof segment.end === 'number' && typeof segment.text === 'string'
        ? [{ start: segment.start, end: segment.end, text: segment.text.slice(0, 2000) }] : [];
    });
  }
  throw new Error('voice busy');
}

/** Starts the transcription in the background; never throws. */
export function transcribeAttachmentLater(db: Db, helper: VoiceHelper, id: string, extension: string, bytes: Buffer): void {
  void (async () => {
    let pcm: Buffer;
    try { pcm = await withMediaFile(bytes, extension, extractPcm); }
    catch (error) {
      await finish(db, id, 'unavailable', error instanceof MediaUnavailable ? 'media_unreadable' : 'media_failed', null);
      return;
    }
    if (pcm.length < PCM_RATE) { await finish(db, id, 'available', 'media_no_speech', null); return; }
    const chunkBytes = TRANSCRIBE_CHUNK_SECONDS * PCM_RATE * 2;
    const segments: TranscriptSegment[] = [];
    try {
      for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
        const piece = pcm.subarray(offset, Math.min(pcm.length, offset + chunkBytes));
        if (piece.length < 320) break;
        const base = offset / (PCM_RATE * 2);
        for (const s of await transcribeChunk(helper, piece)) segments.push({ start: s.start + base, end: s.end + base, text: s.text });
      }
    } catch {
      await finish(db, id, 'unavailable', 'voice_box_unavailable', null);
      return;
    }
    const text = transcriptText(segments);
    await finish(db, id, 'available', text ? MEDIA_TRANSCRIPT : 'media_no_speech', text || null);
  })().catch(() => undefined);
}

/** A restart can interrupt a transcription; say so instead of "processing" forever. */
export async function settleInterruptedMedia(db: Db): Promise<void> {
  await db.query(`update chat_attachments set analysis_code='media_interrupted'
    where analysis_code=$1 and created_at < now() - interval '30 minutes'`, [MEDIA_PROCESSING]).catch(() => undefined);
}
