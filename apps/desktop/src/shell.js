'use strict';
const status = document.querySelector('#status');
const button = document.querySelector('button');
window.josiShell.state().then(state => { status.textContent = state.error || ''; }).catch(() => { status.textContent = 'The app could not read its connection state.'; });
document.querySelector('#connect').addEventListener('submit', async event => {
  event.preventDefault(); button.disabled = true; status.textContent = 'Connecting…';
  try { await window.josiShell.connect(document.querySelector('#server').value); }
  catch { status.textContent = 'Check the server address. Use HTTPS, or private-network HTTP for a local test installation.'; button.disabled = false; }
});
