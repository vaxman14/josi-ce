'use strict';
const byId = id => document.getElementById(id);
let current = null, pending = false;
function render(state) {
  current = state;
  for (const [id, value] of Object.entries({ title: state.title, server: state.serverOrigin, wording: state.wording,
    meaning: state.meaning, admin: state.userId, device: state.deviceId, 'device-label': state.deviceLabel })) byId(id).textContent = value;
  byId('advisory').replaceChildren(...state.advisory.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  byId('advice-section').hidden = state.advisory.length === 0;
  const reviewing = state.phase === 'review' && state.authenticationAvailable;
  byId('reviewed').disabled = !reviewing;
  byId('confirm').disabled = !reviewing || !byId('reviewed').checked || pending;
  byId('status').textContent = !state.authenticationAvailable ? 'Touch ID is unavailable on this Mac. This change cannot be confirmed here yet.'
    : state.phase === 'authenticating' ? 'Use the macOS Touch ID prompt to confirm. You can still cancel this change.'
    : state.phase === 'authenticated' ? 'Identity verified. Finishing this confirmation…'
    : state.phase === 'awaiting-server' ? 'Waiting for approval on the server Mac. In Josi on that Mac, open Settings → Automation → Pending device enrollments with the same administrator account.'
    : state.phase === 'reviewed' ? 'Checking that this change is still current…'
    : 'Nothing is changed until your identity and this exact request are verified.';
}
async function decide(decision) {
  if (!current || (pending && decision !== 'cancel')) return;
  pending = true; byId('confirm').disabled = true;
  try { await window.josiProtected.decide(current.challengeId, decision); }
  catch { byId('status').textContent = 'This confirmation is no longer available. Close this window and request a new review.'; }
}
byId('reviewed').addEventListener('change', () => { if (current) render(current); });
byId('cancel').addEventListener('click', () => { void decide('cancel'); });
byId('confirm').addEventListener('click', () => { if (byId('reviewed').checked) void decide('continue'); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void decide('cancel'); } });
window.josiProtected.onState(render);
window.josiProtected.state().then(render).catch(() => { byId('status').textContent = 'This confirmation is no longer available. Close this window.'; });
