'use strict';
const api = globalThis.browser ?? globalThis.chrome;
const status = document.querySelector('#status');
// Found when the popup opens, so the click can ask for site access before
// anything is awaited: Chrome only grants it during the click itself.
let origin = null;
async function findOrigin() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url ?? '');
    origin = ['https:', 'http:'].includes(url.protocol) && !tab.incognito ? url.origin : null;
  } catch { origin = null; }
}
async function update() {
  try { const state = await api.runtime.sendMessage({ kind: 'status' }); status.textContent = state.status;
    document.querySelector('#connect').disabled = state.connected || !origin; document.querySelector('#stop').disabled = !state.connected;
    if (!state.connected && !origin) status.textContent = 'Open a website in this tab to attach it to Josi.'; }
  catch { status.textContent = 'Reconnect from Josi on this computer.'; }
}
document.querySelector('#connect').addEventListener('click', async () => {
  document.querySelector('#connect').disabled = true;
  try {
    // Site access is scoped to this one site; never all-site access.
    const granted = origin ? await api.permissions.request({ origins: [origin + '/*'] }) : false;
    if (granted) await api.runtime.sendMessage({ kind: 'connect' });
    else status.textContent = 'Josi needs access to this site to attach the tab.';
  } catch { /* status explains the unavailable host */ }
  await update();
});
document.querySelector('#stop').addEventListener('click', async () => {
  document.querySelector('#stop').disabled = true;
  try { await api.runtime.sendMessage({ kind: 'stop' }); } catch { /* status explains */ }
  await update();
});
void findOrigin().then(update);
