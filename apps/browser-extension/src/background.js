'use strict';
if (typeof importScripts === 'function') importScripts('config.js');
const browserApi = globalThis.browser ?? globalThis.chrome;
const config = globalThis.JOSI_BROWSER_CONFIG;
const host = 'com.heyjosi.workspace';
let workspace = null, pollTimer = null, pending = false, generation = 0;
let status = 'Open an automation workspace in Josi to connect.';
let lastClock = Date.now();
const seen = new Set();
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const bounded = value => new TextEncoder().encode(JSON.stringify(value)).length <= 192 * 1024;
function webUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null; }
  catch { return null; }
}
function live() {
  const now = Date.now();
  if (now < lastClock || !workspace || now >= workspace.expiresAt) { stop('Connection expired. Reconnect from Josi.'); return false; }
  lastClock = now;
  return true;
}
function stop(message = 'Paused. Resume control in Josi.') {
  generation++; workspace = null; status = message;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  void browserApi.action.setBadgeText({ text: '' });
}
async function native(operation, payload = {}, sessionId = workspace?.sessionId) {
  const requestId = crypto.randomUUID();
  const request = { version: 1, requestId, operation, sessionId: sessionId ?? null, payload };
  if (!bounded(request)) throw new Error('message_too_large');
  let timer;
  try {
    const response = await Promise.race([
      browserApi.runtime.sendNativeMessage(host, request),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('host_timeout')), 5000); }),
    ]);
    if (!response || !bounded(response) || response.version !== 1 || response.requestId !== requestId) throw new Error('invalid_host_response');
    if (response.ok !== true) throw new Error('host_refused');
    return response.payload;
  } finally { clearTimeout(timer); }
}
function acceptSession(value) {
  const now = Date.now();
  if (!value || value.isolatedWorkspace !== true || value.family !== config.family
    || !['sessionId', 'workspaceId', 'profileId'].every(key => uuid(value[key]))
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 60000
    || !Array.isArray(value.origins) || !value.origins.length || value.origins.length > 128
    || value.origins.some(origin => webUrl(origin)?.origin !== origin)) throw new Error('invalid_workspace');
  // This assertion is accepted ONLY from the registered native workspace
  // host, whose P4/P6 implementation must attest the real browser process and
  // isolated profile. Page messages and popup inputs can never supply it.
  return Object.freeze({ sessionId: value.sessionId, workspaceId: value.workspaceId,
    profileId: value.profileId, family: value.family, expiresAt: value.expiresAt,
    origins: Object.freeze([...value.origins]) });
}
async function connect() {
  if (pending || workspace) return;
  pending = true; const epoch = ++generation;
  status = 'Connecting to your Josi workspace…';
  try {
    const reply = await native('browser.hello', { family: config.family, extensionId: browserApi.runtime.id }, null);
    if (epoch !== generation) return;
    workspace = acceptSession(reply); seen.clear(); lastClock = Date.now();
    status = 'Connected to an isolated Josi workspace.';
    await browserApi.action.setBadgeText({ text: 'J' });
    pollTimer = setTimeout(poll, 100);
  } catch { if (epoch === generation) stop('No authorized Josi workspace is available. Open one in Josi first.'); }
  finally { pending = false; }
}
async function currentTab(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || !live()) throw new Error('invalid_tab');
  const tab = await browserApi.tabs.get(tabId);
  if (!live() || tab.incognito) throw new Error('unsupported_tab');
  if (tab.url !== 'about:blank' && !workspace.origins.includes(webUrl(tab.url)?.origin)) throw new Error('origin_not_granted');
  return tab;
}
async function execute(command, epoch) {
  if (!live() || epoch !== generation || !command || !bounded(command) || !uuid(command.id)
    || command.sessionId !== workspace.sessionId || command.profileId !== workspace.profileId
    || !Number.isSafeInteger(command.expiresAt) || command.expiresAt <= Date.now()
    || command.expiresAt > workspace.expiresAt || seen.has(command.id) || seen.size >= 4096) throw new Error('invalid_command');
  seen.add(command.id);
  if (!['tabs', 'observe', 'navigate', 'click', 'fill'].includes(command.kind)) throw new Error('unsupported_operation');
  const tab = command.kind === 'tabs' ? null : await currentTab(command.tabId);
  const url = command.kind === 'navigate' ? webUrl(command.url) : null;
  if (command.kind === 'navigate' && (!url || !workspace.origins.includes(url.origin))) throw new Error('origin_not_granted');
  // Exact command plus locally obtained tab identity goes back through the
  // host's current policy, lease and durable-reservation boundary. Native
  // authorization is single-use; no browser-side standing authorization.
  const authority = await native('browser.authorize', { command, actual: tab ? { tabId: tab.id, windowId: tab.windowId, url: tab.url } : null });
  if (!live() || epoch !== generation || Date.now() >= command.expiresAt || authority?.commandId !== command.id
    || authority?.sessionId !== workspace.sessionId || authority?.allowed !== true) throw new Error('authority_changed');
  if (command.kind === 'tabs') {
    const tabs = await browserApi.tabs.query({});
    if (!live() || epoch !== generation) throw new Error('authority_changed');
    return { kind: 'tabs', tabs: tabs.filter(item => !item.incognito && (item.url === 'about:blank' || workspace.origins.includes(webUrl(item.url)?.origin)))
      .slice(0, 128).map(item => ({ tabId: item.id, windowId: item.windowId, title: String(item.title ?? '').slice(0, 200),
        url: item.url === 'about:blank' ? item.url : webUrl(item.url).origin + webUrl(item.url).pathname })) };
  }
  const fresh = await currentTab(command.tabId);
  if (fresh.url !== tab.url || fresh.windowId !== tab.windowId || !live() || epoch !== generation) throw new Error('target_changed');
  if (command.kind === 'navigate') {
    await browserApi.tabs.update(command.tabId, { url: url.href });
    return { kind: 'navigation_issued', verificationRequired: true };
  }
  if (tab.url === 'about:blank') throw new Error('page_not_ready');
  if (command.kind === 'observe') await browserApi.scripting.executeScript({ target: { tabId: command.tabId, frameIds: [0] }, files: ['page-agent.js'] });
  if (!live() || epoch !== generation || Date.now() >= command.expiresAt) throw new Error('authority_changed');
  const input = { version: 1, channel: 'josi-page', sessionId: workspace.sessionId, kind: command.kind,
    observationId: command.observationId, elementId: command.elementId, expectedUrl: tab.url,
    expiresAt: command.expiresAt };
  if (command.kind === 'fill') {
    if (!uuid(command.valueReference) || authority.valueReference !== command.valueReference
      || typeof authority.value !== 'string' || authority.value.length > 16384) throw new Error('value_unavailable');
    input.value = authority.value; // Ephemeral projection; never persist/log/echo.
  }
  try {
    const result = await browserApi.tabs.sendMessage(command.tabId, input, { frameId: 0 });
    if (!result || !bounded(result) || result.kind === 'refused') throw new Error('invalid_page_response');
    return result;
  } finally { delete input.value; delete authority.value; }
}
async function poll() {
  if (pending || !live()) return;
  pending = true; const epoch = generation, sessionId = workspace.sessionId;
  try {
    const reply = await native('browser.poll', {});
    if (!live() || epoch !== generation) return;
    if (reply.session) {
      const renewed = acceptSession(reply.session);
      if (renewed.sessionId !== sessionId || renewed.profileId !== workspace.profileId || renewed.workspaceId !== workspace.workspaceId) throw new Error('workspace_changed');
      workspace = renewed;
    }
    if (reply.command) {
      let result;
      try { result = { outcome: 'observed_or_issued', result: await execute(reply.command, epoch) }; }
      catch { result = { outcome: 'uncertain_or_denied', code: 'command_not_verified', verificationRequired: true }; }
      // The host must reconcile a lost response; this extension never retries
      // a command or converts a click into proof of business completion.
      await native('browser.receipt', { commandId: reply.command.id, ...result }, sessionId);
    }
  } catch { if (epoch === generation) stop('Connection interrupted. Josi must reconnect before continuing.'); }
  finally {
    pending = false;
    if (epoch === generation && workspace) pollTimer = setTimeout(poll, 750);
  }
}
browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const popup = sender.id === browserApi.runtime.id && !sender.tab && sender.url === browserApi.runtime.getURL('popup.html');
  if (popup && message?.kind === 'status') { sendResponse({ connected: !!workspace, status, family: config.family }); return false; }
  if (popup && message?.kind === 'connect') { void connect().then(() => sendResponse({ connected: !!workspace, status })); return true; }
  const pageStop = message?.kind === 'local_input' && sender.id === browserApi.runtime.id && sender.frameId === 0
    && sender.tab && workspace && message.sessionId === workspace.sessionId && workspace.origins.includes(webUrl(sender.url)?.origin);
  if ((popup && message?.kind === 'stop') || pageStop) {
    const previous = workspace?.sessionId; stop('You have control. Resume automation in Josi.');
    if (previous) void native('browser.stop', { reason: 'local_takeover' }, previous).catch(() => {});
    sendResponse({ stopped: true });
  }
  return false;
});
browserApi.tabs.onRemoved.addListener(() => { /* A removed tab fails currentTab before any later action. */ });
