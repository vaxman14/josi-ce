"use strict";
const $ = selector => document.querySelector(selector);
const status = $('#status');
let local = null;
let busy = false;
let polling = false;
let first = true;
function render() {
  if (!local) return;
  const ready = local.phase === 'ready';
  $('#local-badge').textContent = local.operation ? 'Working' : ready ? 'Ready' : local.serviceState === 'stopped' ? 'Stopped' : local.installed ? 'Offline' : 'Not set up';
  $('#local-badge').dataset.ready = String(ready);
  $('#local-detail').textContent = local.operation ? 'Applying your server change. You can keep this window open to follow its status.'
    : !local.supported ? 'Local hosting for this platform is coming later. You can connect to another Josi server.'
    : local.error || (ready ? local.setupCompleted === false ? 'Your server is running. Finish account and Vault setup inside Josi.' : 'Your local server is ready. Your other devices can connect to it too.'
    : local.installed ? 'Your server is starting, stopped or needs attention. Use the controls below to bring it back online.'
    : local.canManage ? 'Set up a server here to keep your data on this Mac and connect your other devices.'
    : 'Install the unified Josi app in Applications to set up a local server. You can still connect to an existing server.');
  const open = $('#open-local');
  open.textContent = ready ? (local.setupCompleted === false ? 'Continue setup →' : 'Open Josi →') : local.installed ? 'Start local server' : 'Run on this Mac →';
  open.disabled = busy || !!local.operation || !(ready || local.canManage) || !local.supported;
  $('#local-version').textContent = local.installed ? `${local.origin} · ${local.version}` : '';
  for (const name of ['start', 'stop', 'restart', 'repair']) $(`#${name}`).disabled = busy || !!local.operation || !local.canManage || !local.installed;
  $('#start').disabled ||= ready;
  $('#backups').disabled = busy || !ready || local.setupCompleted !== true;
  $('#update-local').hidden = !local.installed || !local.canManage;
  $('#update-local').disabled = busy || !!local.operation;
  $('#remove-local').hidden = !local.installed || !local.canManage;
  $('#remove-local').disabled = busy || !!local.operation;
  $('#connect-remote').disabled = busy;
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const state = await window.josiShell.state(); local = state.local;
    if (first) { status.textContent = state.error || ''; first = false; }
    render();
  } catch { if (first) status.textContent = 'Josi could not read its local status. Try reopening the app.'; }
  finally { polling = false; }
}
async function action(callback, message) {
  if (busy) return;
  busy = true; status.textContent = message; render();
  try { const result = await callback(); if (result?.cancelled) status.textContent = 'No change made.'; else status.textContent = ''; }
  catch (error) { status.textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  finally { busy = false; await refresh(); render(); }
}
async function operate(operation, openAfter = false) {
  return action(async () => {
    const result = await window.josiShell.operate(operation);
    if (openAfter && !result.cancelled && result.local?.phase === 'ready') await window.josiShell.openLocal();
    return result;
  }, 'Waiting for your confirmation…');
}
$('#open-local').addEventListener('click', () => {
  if (local?.phase === 'ready') void action(() => window.josiShell.openLocal(), 'Opening Josi…');
  else void operate(local?.installed ? 'start' : 'install', true);
});
for (const name of ['start', 'stop', 'restart']) $(`#${name}`).addEventListener('click', () => void operate(name));
$('#repair').addEventListener('click', () => void operate('recover-latest'));
$('#update-local').addEventListener('click', () => void operate('install'));
$('#remove-local').addEventListener('click', () => void operate('uninstall'));
$('#backups').addEventListener('click', () => void action(() => window.josiShell.openLocal('backups'), 'Opening backups…'));
$('#diagnostics').addEventListener('click', async () => {
  await action(() => window.josiShell.copyDiagnostics(), 'Preparing a status report…');
  if (!status.textContent) status.textContent = 'Status report copied. It contains no credentials or conversation content.';
});
$('#connect').addEventListener('submit', event => {
  event.preventDefault();
  void action(() => window.josiShell.connect($('#server').value), 'Connecting…');
});
void refresh();
const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
