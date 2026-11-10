'use strict';
const api = globalThis.browser ?? globalThis.chrome;
const status = document.querySelector('#status');
const attach = document.querySelector('#attach'), stop = document.querySelector('#stop'), resume = document.querySelector('#resume');
const sites = document.querySelector('#sites');
// The state arrives when the popup opens, so the click can ask for site
// access before anything is awaited: Chrome grants it only during the click.
let state = null;
function render(next) {
  state = next;
  status.textContent = next.status;
  attach.hidden = !next.canAttach; attach.textContent = next.phase === 'standby' ? 'Use this browser' : 'Let Josi use this site';
  stop.hidden = !next.canStop; resume.hidden = !next.canResume;
  sites.hidden = !next.needsSites;
  if (next.asked) attach.classList.add('asked'); else attach.classList.remove('asked');
}
async function ask(message) {
  for (const button of [attach, stop, resume, sites]) button.disabled = true;
  try { render(await api.runtime.sendMessage(message)); }
  catch { status.textContent = 'The Josi extension is restarting. Open this again in a moment.'; }
  finally { for (const button of [attach, stop, resume, sites]) button.disabled = false; }
}
attach.addEventListener('click', () => {
  const origin = state?.origin, tabId = state?.tabId;
  if (!origin || !Number.isSafeInteger(tabId)) return;
  // Site access is scoped to this one site; never all-site access.
  api.permissions.request({ origins: [origin + '/*'] }).then(granted => {
    if (granted) return ask({ kind: 'attach', tabId });
    status.textContent = 'Josi needs access to this site to use this tab. Nothing was attached.';
  }, () => { status.textContent = 'This browser did not allow access to this site.'; });
});
// Safari: the one click that lets Josi use any site. Asked during the click,
// which is when Safari allows it; Josi still asks in Josi before acting.
sites.addEventListener('click', () => {
  api.permissions.request({ origins: ['https://*/*', 'http://*/*'] }).then(granted => {
    if (granted) return ask({ kind: 'status' });
    status.textContent = 'Safari did not allow it. You can also allow Josi in Safari > Settings > Websites.';
  }, () => { status.textContent = 'Allow Josi in Safari > Settings > Websites, then open this again.'; });
});
stop.addEventListener('click', () => void ask({ kind: 'stop' }));
resume.addEventListener('click', () => void ask({ kind: 'resume' }));
void ask({ kind: 'status' });
