/** Capture before React mounts or any request runs. New launch capabilities
 * stay in memory; only the legacy bootstrap uses its existing tab storage. */
export function captureSetupHandoff(location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>, storage: Pick<Storage, 'setItem' | 'getItem'>) {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  const launch = fragment.get('handoff');
  const legacy = fragment.get('setup');
  if (fragment.has('handoff') || fragment.has('setup')) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  if (legacy && /^[A-Za-z0-9_-]{40,80}$/.test(legacy)) storage.setItem('josi_setup_handoff', legacy);
  return launch && /^[a-f0-9]{64}$/.test(launch) ? launch : null;
}
