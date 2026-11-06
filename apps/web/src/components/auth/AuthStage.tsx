// The frame around every signed-out page: gold stars, the J on the left and the
// panel on the right, both level in the middle of the screen. Below 860px it is
// one column, the J above the panel.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { JosiMark } from '@/components/brand/JosiMark';

/** A seeded scatter, so the stars hold still between renders. */
function starField() {
  let seed = 7;
  const next = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  return Array.from({ length: 44 }, () => ({ left: `${next() * 100}%`, top: `${next() * 100}%`, animationDelay: `${next() * 3}s` }));
}

function useNarrow() {
  const query = '(max-width: 859px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query), change = () => setNarrow(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return narrow;
}

export function AuthStage({ success = false, children, footer }: { success?: boolean; children: ReactNode; footer?: ReactNode }) {
  const stars = useMemo(starField, []);
  const narrow = useNarrow();
  const size = narrow ? 96 : 160;
  const stage = useRef<HTMLDivElement>(null);
  // On a phone the button is below the J, and the check is the whole point.
  useEffect(() => { if (success) stage.current?.scrollIntoView({ block: 'start' }); }, [success]);
  return (
    <div ref={stage} className="relative min-h-dvh overflow-x-clip">
      <div aria-hidden className="auth-stars">{stars.map((style, index) => <i key={index} className="auth-star" style={style} />)}</div>
      <p className="relative z-[2] flex items-center gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))] font-display text-[1.05rem] font-bold min-[860px]:absolute min-[860px]:left-8 min-[860px]:top-6 min-[860px]:p-0">
        <span aria-hidden className="btn-gold h-2.5 w-2.5 rounded-full" />Hey Josi
      </p>
      <div className="relative z-[1] grid min-h-[calc(100dvh-3rem)] grid-cols-1 content-center gap-4 px-4 pb-6 pt-4 min-[860px]:min-h-dvh min-[860px]:grid-cols-2 min-[860px]:items-center min-[860px]:gap-0 min-[860px]:p-8">
        <div className="flex justify-center py-6 min-[860px]:py-0">
          <div className="relative grid place-items-center" style={{ width: size * 1.1, height: size * 1.1 }}>
            <span aria-hidden className="josi-glow" />
            {success ? null : <span aria-hidden className="josi-halo" />}
            <JosiMark variant="bare" size={size} state={success ? 'success' : 'idle'} />
          </div>
        </div>
        {/* Equal rows above and below hold the panel level with the J, whatever
            sits under it. */}
        <div className="flex min-w-0 flex-col items-center min-[860px]:grid min-[860px]:min-h-[calc(100dvh-4rem)] min-[860px]:grid-rows-[1fr_auto_1fr] min-[860px]:justify-items-center">
          <span aria-hidden className="hidden min-[860px]:block" />
          {children}
          <div className="min-w-0">{footer}</div>
        </div>
      </div>
    </div>
  );
}

export function AuthPanel({ children }: { children: ReactNode }) {
  return <section className="w-full max-w-[380px] rounded-[18px] border border-[color:var(--hairline-strong)] bg-card p-8 shadow-2xl max-[359px]:p-5">{children}</section>;
}
