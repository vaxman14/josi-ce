'use strict';
const api = globalThis.browser ?? globalThis.chrome;
const status = document.querySelector('#status');
async function update() {
  try { const state = await api.runtime.sendMessage({ kind: 'status' }); status.textContent = state.status;
    document.querySelector('#connect').disabled = state.connected; document.querySelector('#stop').disabled = !state.connected; }
  catch { status.textContent = 'Reconnect this Mac in Josi.'; }
}
for (const kind of ['connect', 'stop']) document.querySelector(`#${kind}`).addEventListener('click', async () => {
  document.querySelector(`#${kind}`).disabled = true;
  try { await api.runtime.sendMessage({ kind }); } catch { /* status explains the unavailable host */ }
  await update();
});
void update();
