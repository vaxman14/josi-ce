// The Josi ghost on the stage, and the one line under it.
//
// The ghost is real Masko clips from public/ghost, never a drawing. Two <video>
// layers take turns: the next clip loads behind the one on screen and comes
// forward once it is actually playing, so a change never cuts mid-frame.
// Safari cannot play WebM with alpha and gets the HEVC .mov instead. With
// reduced motion, or if a clip will not play, the still pose stands in.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CLIP_MS, clipUrl, ghostRetryDelayMs, glowFor, GHOST_STILL, inlineTokens, isLoopClip, plainText, prefersHevc, replyParts, revealStepMs, splitWords, warmClips,
  type GhostClip,
} from '@/lib/ghost';

export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return reduced;
}

/** `size` in pixels pins the figure for pages other than the stage (setup,
 * sign-in); without it the stage CSS sizes it to the screen. */
export function GhostFigure({ clip, beat, reduced, size }: { clip: GhostClip; beat: number; reduced: boolean; size?: number }) {
  const figure = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const front = useRef(1);
  const wanted = useRef<GhostClip | null>(null);
  const request = useRef(0);
  const [failed, setFailed] = useState(false);
  const [stillBroken, setStillBroken] = useState(false);
  const attempts = useRef(0);
  const hevc = useMemo(() => typeof navigator !== 'undefined' && prefersHevc(navigator.userAgent), []);
  const still = reduced || failed;

  // Hold the looping clips in memory a moment after the page is up, so the resting clip (asked
  // for after twenty quiet seconds) plays even if the connection has dropped by then.
  useEffect(() => {
    if (reduced) return;
    const timer = window.setTimeout(() => { void warmClips(hevc); }, 1500);
    return () => window.clearTimeout(timer);
  }, [hevc, reduced]);

  // A clip that would not play is not the end of the ghost: the still stands in, then the
  // animation is tried again (sooner when the page comes back to the front or the network returns).
  useEffect(() => {
    if (!failed || reduced) return;
    const retry = () => { wanted.current = null; setStillBroken(false); setFailed(false); };
    const timer = window.setTimeout(retry, ghostRetryDelayMs(attempts.current++));
    const soon = () => { if (document.visibilityState !== 'hidden') { window.clearTimeout(timer); retry(); } };
    window.addEventListener('online', soon);
    document.addEventListener('visibilitychange', soon);
    return () => { window.clearTimeout(timer); window.removeEventListener('online', soon); document.removeEventListener('visibilitychange', soon); };
  }, [failed, reduced]);

  useEffect(() => {
    if (still) { wanted.current = null; return; }
    if (wanted.current === clip) return;
    const layers = [first.current, second.current];
    const backIndex = 1 - front.current;
    const back = layers[backIndex], old = layers[front.current];
    if (!back) return;
    wanted.current = clip;
    const mine = ++request.current;
    back.classList.remove('ghost-layer-on');
    back.loop = isLoopClip(clip);
    back.src = clipUrl(clip, hevc);
    const forward = () => {
      if (mine !== request.current) return;
      attempts.current = 0;
      back.classList.add('ghost-layer-on');
      old?.classList.remove('ghost-layer-on');
      front.current = backIndex;
      window.setTimeout(() => { if (old && !old.classList.contains('ghost-layer-on')) old.pause(); }, 320);
    };
    back.addEventListener('playing', forward, { once: true });
    void back.play()?.catch((error: DOMException) => {
      if (mine === request.current && error?.name !== 'AbortError') setFailed(true);
    });
    return () => back.removeEventListener('playing', forward);
  }, [clip, hevc, still]);

  // A small bounce whenever a one-shot starts.
  useEffect(() => {
    if (!beat || reduced || !figure.current?.animate) return;
    figure.current.animate(
      [{ transform: 'none' }, { transform: 'translateY(-8px) scale(1.04)' }, { transform: 'none' }],
      { duration: 520, easing: 'cubic-bezier(.3,1.5,.5,1)' },
    );
  }, [beat, reduced]);

  const glow = glowFor(clip);
  const onError = () => { if (wanted.current) setFailed(true); };
  return (
    <div ref={figure} className="ghost-figure" aria-hidden style={size ? { width: size, height: size } : undefined}>
      <div className={`ghost-glow ${glow === 'calm' ? '' : `ghost-glow-${glow}`}`} />
      {still ? (stillBroken ? null : <img src={GHOST_STILL} alt="" className="ghost-layer ghost-layer-on" draggable={false} onError={() => setStillBroken(true)} />) : <>
        <video ref={first} className="ghost-layer" muted playsInline preload="auto" disablePictureInPicture onError={onError} />
        <video ref={second} className="ghost-layer" muted playsInline preload="auto" disablePictureInPicture onError={onError} />
      </>}
    </div>
  );
}

/** Inline markdown as words, each its own span so it can fade in. */
/** The ghost off the stage: a wave hello that settles into the idle wiggle,
 * or a celebration once something has worked (setup and sign-in pages). */
export function GreetingGhost({ size, success = false }: { size: number; success?: boolean }) {
  const reduced = useReducedMotion();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const timer = window.setTimeout(() => setSettled(true), CLIP_MS[success ? 'celebrate' : 'wave-hello']);
    return () => window.clearTimeout(timer);
  }, [success]);
  const clip: GhostClip = success ? (settled ? 'gentle-float' : 'celebrate') : settled ? 'idle-wiggle' : 'wave-hello';
  return <GhostFigure clip={clip} beat={0} reduced={reduced} size={size} />;
}

function renderInline(source: string, next: () => number, step: number, animate: boolean): ReactNode[] {
  const words = (text: string) => text.split(/(\s+)/).map((chunk, index) => {
    if (!chunk) return null;
    if (/^\s+$/.test(chunk)) return <Fragment key={index}>{' '}</Fragment>;
    const at = next();
    return <span key={index} className={animate ? 'stage-word stage-word-in' : 'stage-word'} style={animate ? { animationDelay: `${Math.round(at * step)}ms` } : undefined}>{chunk}</span>;
  });
  return inlineTokens(source).map((token, index) => {
    if (token.kind === 'link') return <a key={index} href={token.href} target="_blank" rel="noopener noreferrer">{words(token.text)}</a>;
    if (token.kind === 'bold') return <strong key={index}>{words(token.text)}</strong>;
    if (token.kind === 'code') return <code key={index}>{words(token.text)}</code>;
    return <Fragment key={index}>{words(token.text)}</Fragment>;
  });
}

const SHOWN_ITEMS = 4;

/** Josi's reply as the stage shows it: the sentence, numbered items in gold if
 * it is a list, revealed word by word. Every word is laid out from the start,
 * so nothing moves as it comes in. */
export function StageReply({ text, animate, onDone }: { text: string; animate: boolean; onDone?: () => void }) {
  const parts = useMemo(() => replyParts(text), [text]);
  const items = parts.items.slice(0, SHOWN_ITEMS);
  const total = useMemo(() => [parts.lead, ...items, parts.tail].reduce((sum, part) => sum + splitWords(plainText(part)).length, 0), [parts]);
  const step = revealStepMs(total);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!animate) { done.current?.(); return; }
    const timer = window.setTimeout(() => done.current?.(), total * step + 450);
    return () => window.clearTimeout(timer);
  }, [animate, text, total, step]);
  let counter = 0;
  const next = () => counter++;
  return (
    <div className="flex flex-col items-center">
      {parts.lead ? <p className={`stage-text stage-clamp ${items.length ? 'stage-clamp-2' : ''}`}>{renderInline(parts.lead, next, step, animate)}</p> : null}
      {items.length ? (
        <ol className="stage-items">
          {items.map((item, index) => (
            <li key={index} className="stage-clamp" style={{ WebkitLineClamp: 1 }}><b>{index + 1}</b>{renderInline(item, next, step, animate)}</li>
          ))}
          {parts.items.length > SHOWN_ITEMS ? <li className="text-sm text-lilac">+{parts.items.length - SHOWN_ITEMS} more in History</li> : null}
        </ol>
      ) : null}
      {parts.tail ? <p className="stage-text stage-clamp stage-clamp-2 mt-1 text-base">{renderInline(parts.tail, next, step, animate)}</p> : null}
    </div>
  );
}
