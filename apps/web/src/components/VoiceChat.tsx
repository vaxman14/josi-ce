import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fetchVoiceAudio, speechChunks, takeVoiceFrame } from '@/lib/voiceAudio';
import { Button } from '@/components/ui';

type Event = { type: 'speech_start' | 'partial' | 'final'; text?: string };
export function VoiceChat({ onTurn, disabled, onActiveChange }: { onTurn: (text: string) => Promise<string | undefined>; disabled: boolean; onActiveChange: (active: boolean) => void }) {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const stopRef = useRef<() => void>(() => {});
  const interruptRef = useRef<() => void>(() => {});
  const turn = useRef(onTurn);
  turn.current = onTurn;
  const starting = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    void api.get<{ available: boolean }>('/voice/status').then((s) => { if (alive) setAvailable(s.available); }).catch(() => {});
    return () => { alive = false; generation.current++; stopRef.current(); };
  }, []);

  async function start() {
    if (starting.current) return;
    starting.current = true;
    onActiveChange(true);
    const mine = ++generation.current;
    setError('');
    let context: AudioContext | undefined;
    let media: MediaStream | undefined;
    let node: AudioWorkletNode | undefined;
    let session: string | undefined;
    let stopped = false;
    let audio: AudioBufferSourceNode | undefined;
    let controller: AbortController | undefined;
    let epoch = 0;
    let turnChain = Promise.resolve();
    const frames: Uint8Array[] = [];
    let pumping = false;
    let bufferedBytes = 0;
    let pendingTurns = 0;
    const interrupt = () => { epoch++; controller?.abort(); try { audio?.stop(); } catch {} audio = undefined; };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      interrupt();
      node?.disconnect();
      media?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
      frames.length = 0;
      bufferedBytes = 0;
      if (!pumping && session) void api.post('/voice/close', { session }).catch(() => {});
      setListening(false);
      onActiveChange(false);
      setPartial('');
    };
    stopRef.current = stop;
    interruptRef.current = interrupt;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires HTTPS or localhost.');
      context = new AudioContext();
      await context.resume();
      media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (stopped || mine !== generation.current) { media.getTracks().forEach((t) => t.stop()); return; }
      await context.audioWorklet.addModule('/voice-capture.js');
      session = (await api.post<{ session: string }>('/voice/session')).session;
      if (stopped || mine !== generation.current) { void api.post('/voice/close', { session }); return; }
      node = new AudioWorkletNode(context, 'josi-voice-capture');
      context.createMediaStreamSource(media).connect(node);
      const silent = context.createGain();
      silent.gain.value = 0;
      node.connect(silent).connect(context.destination);
      let seq = 0;
      const pump = async () => {
        if (pumping || stopped) return;
        pumping = true;
        try {
          while (frames.length && !stopped) {
            const bytes = takeVoiceFrame(frames);
            bufferedBytes -= bytes.byteLength;
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            const pcm = btoa(binary);
            let result: { events: Event[] };
            // A 429 means no frame was consumed. Retry the same sequence once.
            try { result = await api.post('/voice/audio', { session, seq, pcm }); }
            catch (err) {
              if ((err as { status?: number }).status !== 429) throw err;
              await new Promise((resolve) => setTimeout(resolve, 250));
              result = await api.post('/voice/audio', { session, seq, pcm });
            }
            seq++;
            for (const event of result.events) {
              if (stopped) break;
              if (event.type === 'speech_start') interrupt();
              if (event.type === 'partial') setPartial(event.text ?? '');
              if (event.type === 'final' && event.text?.trim()) {
                setPartial('');
                const text = event.text;
                const spokenEpoch = epoch;
                if (++pendingTurns > 3) throw new Error('Josi is still answering. Please wait before adding more.');
                turnChain = turnChain.then(async () => {
                  if (stopped) return;
                  const reply = await turn.current(text);
                  if (!reply || stopped || spokenEpoch !== epoch) return;
                  for (const chunk of speechChunks(reply)) {
                    if (stopped || spokenEpoch !== epoch) break;
                    controller = new AbortController();
                    const data = await fetchVoiceAudio('/voice/speech', { text: chunk }, controller.signal);
                    if (stopped || spokenEpoch !== epoch) break;
                    const buffer = await context!.decodeAudioData(data);
                    if (stopped || spokenEpoch !== epoch) break;
                    audio = context!.createBufferSource();
                    audio.buffer = buffer;
                    audio.connect(context!.destination);
                    const ended = new Promise<void>((resolve) => {
                      audio!.onended = () => resolve();
                      controller!.signal.addEventListener('abort', () => resolve(), { once: true });
                    });
                    audio.start();
                    await ended;
                  }
                }).catch((err: Error) => { if (!stopped && err.name !== 'AbortError') setError(err.message); })
                  .finally(() => { pendingTurns--; });
              }
            }
          }
        } catch (err) {
          if (!stopped) { setError(err instanceof Error ? err.message : 'Voice audio could not be processed'); stop(); }
        } finally {
          pumping = false;
          if (stopped && session) void api.post('/voice/close', { session }).catch(() => {});
          else if (frames.length) void pump();
        }
      };
      node.port.onmessage = (message: MessageEvent<ArrayBuffer>) => {
        if (stopped) return;
        const bytes = new Uint8Array(message.data);
        frames.push(bytes);
        bufferedBytes += bytes.byteLength;
        if (bufferedBytes > 480_000) {
          setError('Voice processing fell more than 15 seconds behind. Stop other workloads and try again.');
          stop();
          return;
        }
        void pump();
      };
      setListening(true);
      onActiveChange(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone could not start');
      stop();
    } finally { starting.current = false; }
  }
  if (!available) return null;
  return <div className="space-y-1 py-2">
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={disabled && !listening} onClick={() => listening ? stopRef.current() : void start()}>
        {listening ? 'Stop voice chat' : 'Start voice chat'}
      </Button>
      {listening && <Button type="button" onClick={() => interruptRef.current()}>Interrupt speech</Button>}
    </div>
    <p className="text-xs text-muted-foreground">{listening ? 'Microphone on. Speak naturally; pause to send. Speak again to interrupt.' : 'Audio is processed on your Voice Box. Transcripts use your configured Josi model.'}</p>
    {partial && <p role="status" className="text-sm">{partial}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
