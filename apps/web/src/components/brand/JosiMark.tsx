// The Josi J. THE ONLY PLACE IN THE APP THE J IS DRAWN.
//
// THE J ARTWORK GETS SWAPPED HERE LATER. The final J has not been decided, so
// this is the existing J from public/brand/josi-mark.png, recoloured gold and
// cropped tight, and nobody should redraw it or improve it in the meantime.
// Swapping it is one change: replace public/brand/josi-mark-gold.png and update
// MARK_RATIO, or render an <svg> where the <img> is below. Every screen comes
// through this component, so nothing else needs to know.
import { cn } from '@/lib/cn';

const MARK_SRC = '/brand/josi-mark-gold.png';
/** Width over height of the artwork. `size` sets the height. */
const MARK_RATIO = 411 / 567;

export function JosiMark({ size = 28, variant = 'tile', state = 'idle', className, alt = '' }: {
  /** Height in pixels. For the tile, the side of the square. */
  size?: number;
  /** "tile" is the gold J on a rounded square; "bare" is the J alone. */
  variant?: 'tile' | 'bare';
  /** "thinking" breathes in and out; "success" lights up and becomes a check. */
  state?: 'idle' | 'thinking' | 'success';
  className?: string;
  alt?: string;
}) {
  const height = variant === 'tile' ? size * 0.62 : size;
  const width = height * MARK_RATIO;
  return (
    <span
      className={cn('josi-mark', variant === 'tile' && 'josi-mark-tile', state === 'thinking' && 'josi-mark-thinking', state === 'success' && 'josi-mark-success', className)}
      style={variant === 'tile' ? { width: size, height: size } : { width, height }}
    >
      <img src={MARK_SRC} alt={alt} width={Math.round(width)} height={Math.round(height)} style={{ width, height }} />
      {state === 'success' ? (
        <span aria-hidden className="josi-mark-check" style={{ width: size * 0.86, height: size * 0.86 }}>
          <svg viewBox="0 0 24 24" fill="none" style={{ width: '46%', height: '46%' }}>
            <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      ) : null}
    </span>
  );
}
