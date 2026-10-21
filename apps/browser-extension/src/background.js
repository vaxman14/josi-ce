'use strict';
if (typeof importScripts === 'function') importScripts('config.js', 'native-channel.js');
const browserApi = globalThis.browser ?? globalThis.chrome;
const config = globalThis.JOSI_BROWSER_CONFIG;
let nativeChannel = null;
let attachedTabId = null;
let workspace = null, pollTimer = null, pending = false, generation = 0;
let status = 'Open Josi on this computer, then attach the tab you want to use.';
let lastClock = Date.now();
const seen = new Set();
// The Windows host has no other way to learn the attached site; the macOS
// host requires these messages' exact fields, so only Windows gets them.
const windowsHost = /^Win/.test(globalThis.navigator?.platform ?? '');
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
function stop(message = 'Paused. Resume control in Josi.', disconnect = true) {
  generation++; workspace = null; attachedTabId = null; status = message;
  if (disconnect) { const previous = nativeChannel; nativeChannel = null; previous?.close(); }
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  void browserApi.action.setBadgeText({ text: '' });
}
async function native(operation, payload = {}, sessionId = workspace?.sessionId) {
  const requestId = crypto.randomUUID();
  const request = { version: 1, requestId, operation, sessionId: sessionId ?? null, payload };
  if (!bounded(request)) throw new Error('message_too_large');
  const current = nativeChannel;
  if (!current) throw new Error('host_unavailable');
  const response = await current.request(request);
  if (!response || !bounded(response) || response.version !== 1 || response.requestId !== requestId) throw new Error('invalid_host_response');
  if (response.ok !== true) throw new Error('host_refused');
  return response.payload;
}
function acceptSession(value) {
  const now = Date.now();
  if (!value || value.currentDesktop !== true || value.family !== config.family
    || !['sessionId', 'workspaceId', 'profileId'].every(key => uuid(value[key]))
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 60000
    || !Array.isArray(value.origins) || value.origins.length > 128
    || value.origins.some(origin => webUrl(origin)?.origin !== origin)) throw new Error('invalid_workspace');
  // Only the signed native host may supply session authority. A page cannot attach a tab or authorize itself.
  return Object.freeze({ sessionId: value.sessionId, workspaceId: value.workspaceId,
    profileId: value.profileId, family: value.family, expiresAt: value.expiresAt,
    origins: Object.freeze([...value.origins]) });
}
async function connect() {
  if (pending || workspace) return;
  pending = true; const epoch = ++generation;
  status = 'Attaching this tab to Josi…';
  nativeChannel?.close();
  const connection = globalThis.createJosiNativeChannel(browserApi, config.family, () => {
    if (nativeChannel === connection) stop('Connection interrupted. Reconnect from Josi; uncertain actions will not be repeated.');
  });
  nativeChannel = connection;
  try {
    const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
    if (tabs.length !== 1 || tabs[0].incognito || !webUrl(tabs[0].url)) throw new Error('unsupported_tab');
    attachedTabId = tabs[0].id;
    const origin = webUrl(tabs[0].url).origin;
    // Site access is scoped to this attachment; never request all-site access.
    // The popup asked for it during the click; a service worker cannot.
    if (!await browserApi.permissions.contains({ origins: [origin + '/*'] })) throw new Error('site_permission_required');
    const saved = await browserApi.storage.local.get('josiBrowserInstance');
    const nativeProfileId = uuid(saved.josiBrowserInstance) ? saved.josiBrowserInstance : crypto.randomUUID();
    if (!saved.josiBrowserInstance) await browserApi.storage.local.set({ josiBrowserInstance: nativeProfileId });
    const reply = await native('browser.hello', { family: config.family,
      extensionId: config.family === 'safari' ? config.extensionId : browserApi.runtime.id, nativeProfileId, attachedTabId,
      ...(windowsHost ? { url: tabs[0].url, title: String(tabs[0].title ?? '').slice(0, 300) } : {}) }, null);
    if (epoch !== generation) return;
    if (reply?.profileDiscovered === true) {
      stop('Browser identified. Register it in Josi and configure its sites, then attach this tab again.');
      return;
    }
    const verified = acceptSession(reply);
    if (epoch !== generation) return;
    workspace = verified; seen.clear(); lastClock = Date.now();
    status = workspace.origins.length ? 'Tab attached. Josi can act only with current site and action permissions.'
      : 'Connected. Waiting for a permitted task; page access is not enabled.';
    await browserApi.action.setBadgeText({ text: 'J' });
    pollTimer = setTimeout(poll, 100);
  } catch { if (epoch === generation) stop('No current Josi connection is available. Open Josi on this computer and allow this browser there first.'); }
  finally { pending = false; }
}
async function currentTab(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || tabId !== attachedTabId || !live()) throw new Error('invalid_tab');
  const tab = await browserApi.tabs.get(tabId);
  if (!live() || tab.id !== attachedTabId || tab.incognito) throw new Error('unsupported_tab');
  if (tab.url !== 'about:blank' && !workspace.origins.includes(webUrl(tab.url)?.origin)) throw new Error('origin_not_granted');
  return tab;
}
async function execute(command, epoch) {
  if (!live() || !workspace.origins.length || epoch !== generation || !command || !bounded(command) || !uuid(command.id)
    || command.sessionId !== workspace.sessionId || command.profileId !== workspace.profileId
    || !Number.isSafeInteger(command.expiresAt) || command.expiresAt <= Date.now()
    || command.expiresAt > workspace.expiresAt || seen.has(command.id) || seen.size >= 4096) throw new Error('invalid_command');
  seen.add(command.id);
  if (!['inspect', 'observe', 'navigate', 'click', 'fill', 'draft', 'photo', 'openPage', 'scroll'].includes(command.kind)) throw new Error('unsupported_operation');
  let tab;
  if (command.kind === 'inspect') {
    if (webUrl(command.origin)?.origin !== command.origin || !workspace.origins.includes(command.origin)
      || !Number.isSafeInteger(command.maxOutputBytes) || command.maxOutputBytes < 1024 || command.maxOutputBytes > 65536) throw new Error('invalid_inspection');
    tab = await currentTab(attachedTabId);
    if (webUrl(tab.url)?.origin !== command.origin) throw new Error('attached_site_changed');
  } else if (command.kind === 'openPage') {
    tab = await browserApi.tabs.get(attachedTabId);
    if (tab.incognito || !webUrl(tab.url)) throw new Error('unsupported_tab');
  } else tab = await currentTab(command.tabId);
  const url = command.kind === 'navigate' ? webUrl(command.url) : null;
  if (command.kind === 'navigate' && (!url || !workspace.origins.includes(url.origin))) throw new Error('origin_not_granted');
  // Exact command plus locally obtained tab identity goes back through the
  // host's current policy, lease and durable-reservation boundary. Native
  // authorization is single-use; no browser-side standing authorization.
  const authority = await native('browser.authorize', { command, actual: tab ? { tabId: tab.id, windowId: tab.windowId, url: tab.url } : null });
  if (!live() || epoch !== generation || Date.now() >= command.expiresAt || authority?.commandId !== command.id
    || authority?.sessionId !== workspace.sessionId || authority?.allowed !== true) throw new Error('authority_changed');
  if (command.kind === 'openPage') {
    const destination = webUrl(command.url);
    if (!destination || destination.protocol !== 'https:' || destination.origin !== command.origin
      || !workspace.origins.includes(destination.origin) || attachedTabId !== tab.id) throw new Error('invalid_page');
    const fresh = await browserApi.tabs.get(attachedTabId);
    if (!live() || epoch !== generation || fresh.url !== tab.url || fresh.windowId !== tab.windowId) throw new Error('target_changed');
    const opened = await browserApi.tabs.update(attachedTabId, { url: destination.href });
      let loaded;
      while (live() && epoch === generation && Date.now() < command.expiresAt - 1000) {
        const current = await browserApi.tabs.get(opened.id);
        if (current.incognito || webUrl(current.url)?.origin !== destination.origin) throw new Error('navigation_changed');
        if (current.status === 'complete') { loaded = current; break; }
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      if (!loaded || !live() || epoch !== generation) throw new Error('page_not_ready');
      await browserApi.scripting.executeScript({ target: { tabId: loaded.id, frameIds: [0] }, files: ['page-agent.js'] });
      const result = await browserApi.tabs.sendMessage(loaded.id, { version: 1, channel: 'josi-page',
        sessionId: workspace.sessionId, kind: 'observe', expectedUrl: loaded.url,
        expiresAt: command.expiresAt, maxOutputBytes: command.maxOutputBytes }, { frameId: 0 });
      if (result?.kind !== 'observation' || !bounded(result)) throw new Error('observation_unavailable');
      return { ...result, tabId: loaded.id, windowId: loaded.windowId };
  }
  const tabId = tab.id;
  const fresh = await currentTab(tabId);
  if (fresh.url !== tab.url || fresh.windowId !== tab.windowId || !live() || epoch !== generation) throw new Error('target_changed');
  if (command.kind === 'navigate') {
    await browserApi.tabs.update(command.tabId, { url: url.href });
    return { kind: 'navigation_issued', verificationRequired: true };
  }
  if (tab.url === 'about:blank') throw new Error('page_not_ready');
  if (command.kind === 'observe' || command.kind === 'inspect') await browserApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['page-agent.js'] });
  if (!live() || epoch !== generation || Date.now() >= command.expiresAt) throw new Error('authority_changed');
  const input = { version: 1, channel: 'josi-page', sessionId: workspace.sessionId, kind: command.kind === 'inspect' ? 'observe' : command.kind,
    observationId: command.observationId, elementId: command.elementId, expectedUrl: tab.url,
    expiresAt: command.expiresAt };
  if (command.kind === 'scroll') input.deltaY = command.deltaY;
  if (command.kind === 'inspect' || command.kind === 'photo') input.maxOutputBytes = command.maxOutputBytes;
  if (command.kind === 'fill') {
    if (typeof authority.value !== 'string' || authority.value.length > 16384) throw new Error('value_unavailable');
    input.value = authority.value; // Ephemeral projection; never persist/log/echo.
  }
  if (command.kind === 'draft') {
    if (typeof authority.draftText !== 'string'
      || new TextEncoder().encode(authority.draftText).length > 2048) throw new Error('draft_unavailable');
    input.value = authority.draftText;
  }
  try {
    const result = await browserApi.tabs.sendMessage(tabId, input, { frameId: 0 });
    if (!result || !bounded(result) || result.kind === 'refused') throw new Error('invalid_page_response');
    return command.kind === 'inspect' || command.kind === 'photo' ? { ...result, tabId, windowId: tab.windowId } : result;
  } finally {
    delete input.value; delete authority.value; delete authority.draftText; delete authority.proxy;
  }
}
async function poll() {
  if (pending || !live()) return;
  pending = true; const epoch = generation, sessionId = workspace.sessionId;
  try {
    let place = {};
    if (windowsHost) {
      const tab = await browserApi.tabs.get(attachedTabId);
      place = { url: webUrl(tab.url) ? tab.url : null, title: String(tab.title ?? '').slice(0, 300) };
    }
    const reply = await native('browser.poll', place);
    if (!live() || epoch !== generation) return;
    if (reply.session) {
      const renewed = acceptSession(reply.session);
      if (renewed.sessionId !== sessionId || renewed.profileId !== workspace.profileId || renewed.workspaceId !== workspace.workspaceId) throw new Error('workspace_changed');
      workspace = renewed;
      status = workspace.origins.length ? 'Tab attached. Josi can act only with current site and action permissions.'
        : 'Connected. Waiting for a permitted task; page access is not enabled.';
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
    && sender.tab && sender.tab.id === attachedTabId && workspace && message.sessionId === workspace.sessionId && workspace.origins.includes(webUrl(sender.url)?.origin);
  if ((popup && message?.kind === 'stop') || pageStop) {
    const previous = workspace?.sessionId, connection = nativeChannel;
    const notified = previous ? native('browser.stop', { reason: 'local_takeover' }, previous) : Promise.resolve();
    stop('You have control. Resume automation in Josi.', false); nativeChannel = null;
    void notified.catch(() => {}).finally(() => connection?.close());
    sendResponse({ stopped: true });
  }
  return false;
});
browserApi.tabs.onRemoved.addListener(id => { if (id === attachedTabId) stop('Attached tab closed. Control stopped.'); });
