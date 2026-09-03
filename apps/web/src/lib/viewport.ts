// iOS keyboard-aware viewport tracking. One module, initialised once.
//
// The problem class (Roman's round-2 item 23, two iPhone screenshots): the iOS
// keyboard does NOT resize the layout viewport. 100vh, 100dvh and `height:100%`
// all keep their pre-keyboard value; only window.visualViewport shrinks. So a
// login form centred in `min-h-full` has no scroll room and the password field
// disappears under the keyboard, and a chat layout sized in dvh collapses into
// dead space. The fixes all hang off the same primitive: publish the REAL
// visible height as CSS variables and a `keyboard-open` class, and nudge the
// focused field into view ourselves.
//
// Published on <html>:
//   --josi-visible-height   visualViewport.height in px (fallback: innerHeight)
//   --josi-keyboard-inset   px of layout viewport hidden by the keyboard
//   .keyboard-open          present while the inset looks like a keyboard
//
// A `josi:viewport` CustomEvent fires on every change so components (Talk)
// can react without each wiring their own listeners.

export type ViewportState = { visibleHeight: number; keyboardInset: number; keyboardOpen: boolean };

/** Anything smaller reads as browser chrome settling, not a keyboard. */
const KEYBOARD_THRESHOLD_PX = 80;

let initialised = false;

export function viewportState(): ViewportState {
  const viewport = window.visualViewport;
  const visibleHeight = Math.round(viewport?.height ?? window.innerHeight);
  const keyboardInset = Math.max(0, Math.round(window.innerHeight - ((viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0))));
  return { visibleHeight, keyboardInset, keyboardOpen: keyboardInset > KEYBOARD_THRESHOLD_PX };
}

function isTextField(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function initViewportTracking(): void {
  if (initialised || typeof window === 'undefined') return;
  initialised = true;

  const root = document.documentElement;
  const sync = () => {
    const state = viewportState();
    root.style.setProperty('--josi-visible-height', `${state.visibleHeight}px`);
    root.style.setProperty('--josi-keyboard-inset', `${state.keyboardInset}px`);
    root.classList.toggle('keyboard-open', state.keyboardOpen);
    window.dispatchEvent(new CustomEvent<ViewportState>('josi:viewport', { detail: state }));
  };

  sync();
  const viewport = window.visualViewport;
  viewport?.addEventListener('resize', sync);
  viewport?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);

  // iOS Safari scrolls a focused field "into view" against the LAYOUT viewport,
  // which can still leave it under the keyboard (the login screenshot). After
  // the keyboard animation settles, put the field in the middle of what is
  // actually visible. Containers that manage their own keyboard layout (Talk)
  // opt out with data-viewport-managed.
  window.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!isTextField(target)) return;
    if (target.closest('[data-viewport-managed]')) return;
    window.setTimeout(() => {
      if (document.activeElement !== target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 350);
  });
}
