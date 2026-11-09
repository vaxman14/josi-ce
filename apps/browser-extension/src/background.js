'use strict';
// Josi Browser Control, service worker (0.9.0). Links this browser to the
// Josi app on this computer through its native messaging host, whenever Josi
// is open, with or without an attached tab. Every page action is a command
// the Josi app hands over after PC Control decided it (saved permissions or
// the owner's approval); this worker re-checks each one with the host before
// acting, never acts on its own and never retries an uncertain action.
if (typeof importScripts === 'function') importScripts('config.js', 'native-channel.js');
const browserApi = globalThis.browser ?? globalThis.chrome;
const config = globalThis.JOSI_BROWSER_CONFIG;
// The Windows host learns tabs and sites from these messages; the macOS host
// requires its exact original fields, so only Windows gets the extras and the
// standing link (a link with no tab attached).
const windowsHost = /^Win/.test(globalThis.navigator?.platform ?? '');
const LINK_ALARM = 'josi-link', TABS_REPORTED = 30, PHOTO_BASE64_LIMIT = 98304, UPLOAD_LIMIT = 8 * 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const bounded = (value, limit = 192 * 1024) => new TextEncoder().encode(JSON.stringify(value)).length <= limit;
const clip = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
function webUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null; }
  catch { return null; }
}

// ------------------------------------------------------------------ state
// Phases: off (Josi not open), unknown (Josi has not allowed this browser),
// linked (no tab), attached, paused (Josi paused or you took over in Josi),
// reconnect (Josi went away; linking again), stopped (you took control here).
const STATUS = {
  off: 'Josi is not open on this computer. Open Josi and this browser links by itself.',
  offAttached: 'Josi is not open. The attached tab attaches again by itself when Josi is back.',
  unknown: 'Josi found this browser. Allow it in Josi under PC Control; it links by itself after that.',
  linked: 'Linked to Josi. No tab is attached: say "use this tab" in Josi, or attach this tab here.',
  attached: 'This tab is attached. Josi acts on it only with your permissions in Josi.',
  attachedElsewhere: 'Another tab is attached to Josi.',
  paused: 'Josi is paused; resume in Josi.',
  reconnect: 'Reconnecting to Josi…',
  stopped: 'You have control. Josi will not use this browser until you resume.',
  site: 'Josi asked to use this tab. Click "Attach this tab" once to let Josi use this site.',
  unsupported: 'Josi cannot use this kind of tab. Open a website to attach it.',
};
let channel = null, workspace = null, phase = 'off', hostPaused = false;
let linking = false, polling = false, generation = 0, pollTimer = null, retryTimer = null, lastClock = Date.now();
let attachedTabId = null, stopped = false, askedSite = null;
const seen = new Set();
// Survives the worker's sleeps (storage.session lasts until the browser
// closes). The browser instance id stays in storage.local.
const ready = (async () => {
  try {
    const saved = await browserApi.storage.session.get(['josiAttachedTab', 'josiStopped']);
    attachedTabId = Number.isSafeInteger(saved.josiAttachedTab) ? saved.josiAttachedTab : null;
    stopped = saved.josiStopped === true;
    if (stopped) phase = 'stopped';
  } catch { /* storage.session unavailable: start fresh */ }
})();
function persist() { void browserApi.storage.session.set({ josiAttachedTab: attachedTabId, josiStopped: stopped }).catch(() => {}); }
function setPhase(next) { phase = next; badge(); }
function badge() {
  const text = askedSite ? '1' : phase === 'attached' ? 'J' : phase === 'paused' ? '||' : phase === 'stopped' ? '■' : '';
  void browserApi.action.setBadgeText({ text }).catch(() => {});
  void browserApi.action.setBadgeBackgroundColor?.({ color: askedSite ? '#c2410c' : phase === 'paused' || phase === 'stopped' ? '#64748b' : '#1f7a55' })?.catch?.(() => {});
}
function arm() { void browserApi.alarms.create(LINK_ALARM, { periodInMinutes: 0.5 }); }

// ------------------------------------------------------------- the host
async function native(operation, payload = {}, sessionId = workspace?.sessionId) {
  const requestId = crypto.randomUUID();
  const request = { version: 1, requestId, operation, sessionId: sessionId ?? null, payload };
  if (!bounded(request)) throw new Error('message_too_large');
  const current = channel;
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
function live() {
  const now = Date.now();
  if (now < lastClock || !workspace || now >= workspace.expiresAt) { lost(); return false; }
  lastClock = now;
  return true;
}
/** Ends the current link without forgetting the attached tab. */
function drop() {
  generation++; workspace = null; hostPaused = false;
  if (pollTimer) clearTimeout(pollTimer); pollTimer = null;
  const previous = channel; channel = null; previous?.close();
}
/** The host went away (Josi closed or restarted), not the person: link again. */
function lost() {
  const wasLinked = !!workspace || phase === 'reconnect';
  drop();
  if (stopped) return;
  setPhase(wasLinked ? 'reconnect' : 'off');
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = null; void link(); }, 3000);
}
async function usableTab(tabId) {
  let tab = null;
  try { tab = await browserApi.tabs.get(tabId); } catch { return null; }
  if (!tab || tab.incognito) return null;
  const url = webUrl(tab.url);
  if (!url || !await browserApi.permissions.contains({ origins: [url.origin + '/*'] })) return null;
  return tab;
}
async function profileId() {
  const saved = await browserApi.storage.local.get('josiBrowserInstance');
  if (uuid(saved.josiBrowserInstance)) return saved.josiBrowserInstance;
  const id = crypto.randomUUID();
  await browserApi.storage.local.set({ josiBrowserInstance: id });
  return id;
}
/** Links to Josi: at startup, every 30 s (alarm), when the popup opens, and
 * again after Josi restarts. Carries the attached tab when there is one. */
async function link() {
  await ready;
  if (stopped || linking || workspace) return;
  linking = true; const epoch = ++generation;
  const before = phase;
  try {
    const tab = Number.isSafeInteger(attachedTabId) ? await usableTab(attachedTabId) : null;
    if (!tab && attachedTabId !== null) { attachedTabId = null; persist(); }
    // Elsewhere than Windows a link always names a tab (the original contract).
    if (!tab && !windowsHost) { setPhase('off'); return; }
    if (before === 'reconnect') setPhase('reconnect');
    const connection = globalThis.createJosiNativeChannel(browserApi, config.family, () => { if (channel === connection) lost(); });
    channel?.close(); channel = connection;
    const reply = await native('browser.hello', { family: config.family,
      extensionId: config.family === 'safari' ? config.extensionId : browserApi.runtime.id, nativeProfileId: await profileId(),
      attachedTabId: tab ? tab.id : null, ...(windowsHost && tab ? { url: tab.url, title: clip(tab.title) } : {}) }, null);
    if (epoch !== generation) return;
    if (reply?.profileDiscovered === true) { drop(); setPhase('unknown'); return; }
    const verified = acceptSession(reply);
    if (epoch !== generation) return;
    workspace = verified; seen.clear(); lastClock = Date.now();
    setPhase(tab ? 'attached' : 'linked');
    pollTimer = setTimeout(poll, 100);
  } catch {
    if (epoch === generation) { drop(); setPhase('off'); }
  } finally { linking = false; }
}
/** Attaches a tab on the person's own click in the popup (site access was
 * granted during that click). A new hello carries the tab. */
async function attachHere(tabId) {
  await ready;
  const tab = await usableTab(tabId);
  if (!tab) return false;
  stopped = false; attachedTabId = tab.id; askedSite = null; persist();
  for (let i = 0; i < 40 && (linking || polling); i++) await new Promise(resolve => setTimeout(resolve, 50));
  drop(); setPhase('reconnect');
  await link();
  return phase === 'attached';
}
async function stopHere() {
  await ready;
  const previous = workspace?.sessionId, connection = channel;
  stopped = true; askedSite = null; persist();
  const notified = previous ? native('browser.stop', { reason: 'local_takeover' }, previous) : Promise.resolve();
  generation++; workspace = null; channel = null;
  if (pollTimer) clearTimeout(pollTimer); pollTimer = null;
  if (retryTimer) clearTimeout(retryTimer); retryTimer = null;
  setPhase('stopped');
  await notified.catch(() => {});
  connection?.close();
}
async function resumeHere() {
  await ready;
  stopped = false; persist(); setPhase('off');
  await link();
}

// ------------------------------------------------------------- polling
/** What the Windows host needs to name tabs: the attached tab, the active
 * tab of the last focused window and up to 30 open web tabs. Incognito tabs
 * are never reported. The app keeps only sites and titles. */
async function describeTabs() {
  let attached = null;
  if (attachedTabId !== null) {
    try { attached = await browserApi.tabs.get(attachedTabId); } catch { attached = null; }
    if (!attached || attached.incognito) { attached = null; attachedTabId = null; persist(); }
  }
  let active = null;
  try { [active] = await browserApi.tabs.query({ active: true, lastFocusedWindow: true }); } catch { active = null; }
  if (active && (active.incognito || !webUrl(active.url))) active = null;
  const open = (await browserApi.tabs.query({})).filter(t => !t.incognito && Number.isSafeInteger(t.id) && webUrl(t.url));
  const listed = open.filter(t => t.id === active?.id).concat(open.filter(t => t.id !== active?.id)).slice(0, TABS_REPORTED);
  return {
    url: attached && webUrl(attached.url) ? attached.url : null, title: attached ? clip(attached.title) : null, tabId: attached ? attached.id : null,
    active: active ? { tabId: active.id, url: active.url, title: clip(active.title) } : null,
    tabs: listed.map(t => ({ tabId: t.id, url: t.url, title: clip(t.title), active: t.id === active?.id })),
  };
}
async function poll() {
  if (polling || !live()) return;
  polling = true; const epoch = generation, sessionId = workspace.sessionId;
  try {
    const place = windowsHost ? await describeTabs() : {};
    const reply = await native('browser.poll', place);
    if (!live() || epoch !== generation) return;
    if (reply.session) {
      const renewed = acceptSession(reply.session);
      if (renewed.sessionId !== sessionId || renewed.profileId !== workspace.profileId || renewed.workspaceId !== workspace.workspaceId) throw new Error('workspace_changed');
      workspace = renewed;
    }
    hostPaused = reply.paused === true;
    setPhase(hostPaused ? 'paused' : attachedTabId !== null ? 'attached' : 'linked');
    if (reply.command) {
      let result;
      try { result = { outcome: 'observed_or_issued', result: await execute(reply.command, epoch) }; }
      catch (error) { result = { outcome: 'uncertain_or_denied', code: failureCode(error), verificationRequired: true }; }
      // The host must reconcile a lost response; this extension never retries
      // a command or converts a click into proof of business completion.
      await native('browser.receipt', { commandId: reply.command.id, ...result }, sessionId);
    }
  } catch { if (epoch === generation) lost(); }
  finally {
    polling = false;
    if (epoch === generation && workspace) pollTimer = setTimeout(poll, 750);
  }
}

// ------------------------------------------------------------ commands
const KINDS = ['inspect', 'observe', 'navigate', 'click', 'fill', 'draft', 'photo', 'openPage', 'openTab', 'scroll', 'attach', 'select', 'drag', 'download', 'upload'];
async function currentTab(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || tabId !== attachedTabId || !live()) throw new Error('invalid_tab');
  const tab = await browserApi.tabs.get(tabId);
  if (!live() || tab.id !== attachedTabId || tab.incognito) throw new Error('unsupported_tab');
  if (tab.url !== 'about:blank' && !workspace.origins.includes(webUrl(tab.url)?.origin)) throw new Error('origin_not_granted');
  return tab;
}
async function authorize(command, tab, epoch) {
  // Exact command plus locally obtained tab identity goes back through the
  // host's current policy, lease and pause state. Single use.
  const authority = await native('browser.authorize', { command, actual: tab ? { tabId: tab.id, windowId: tab.windowId, url: tab.url } : null });
  if (!live() || epoch !== generation || Date.now() >= command.expiresAt || authority?.commandId !== command.id
    || authority?.sessionId !== workspace.sessionId || authority?.allowed !== true) throw new Error('authority_changed');
  return authority;
}
function pageMessage(kind, tab, command, extra = {}) {
  return { version: 1, channel: 'josi-page', sessionId: workspace.sessionId, kind, expectedUrl: tab.url, expiresAt: command.expiresAt, ...extra };
}
async function inject(tabId) { await browserApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['page-agent.js'] }); }
async function execute(command, epoch) {
  if (!live() || epoch !== generation || !command || !bounded(command) || !uuid(command.id)
    || command.sessionId !== workspace.sessionId || command.profileId !== workspace.profileId
    || !Number.isSafeInteger(command.expiresAt) || command.expiresAt <= Date.now()
    || command.expiresAt > workspace.expiresAt || seen.has(command.id) || seen.size >= 4096) throw new Error('invalid_command');
  seen.add(command.id);
  if (!KINDS.includes(command.kind)) throw new Error('unsupported_operation');
  if (command.kind === 'attach') return attachCommand(command, epoch);
  if (!workspace.origins.length) throw new Error('invalid_command');
  if (command.kind === 'openPage') return openPage(command, epoch);
  if (command.kind === 'openTab') return openTab(command, epoch);
  if (command.kind === 'inspect') {
    if (webUrl(command.origin)?.origin !== command.origin || !workspace.origins.includes(command.origin)
      || !Number.isSafeInteger(command.maxOutputBytes) || command.maxOutputBytes < 1024 || command.maxOutputBytes > 65536) throw new Error('invalid_inspection');
  }
  const tab = await currentTab(command.kind === 'inspect' ? attachedTabId : command.tabId);
  if (command.kind === 'inspect' && webUrl(tab.url)?.origin !== command.origin) throw new Error('attached_site_changed');
  const url = command.kind === 'navigate' ? webUrl(command.url) : null;
  if (command.kind === 'navigate' && (!url || !workspace.origins.includes(url.origin))) throw new Error('origin_not_granted');
  if (command.kind === 'download') {
    const target = webUrl(command.url);
    if (!target || target.protocol !== 'https:' || target.origin !== webUrl(tab.url)?.origin) throw new Error('invalid_download');
  }
  const authority = await authorize(command, tab, epoch);
  const fresh = await currentTab(tab.id);
  if (fresh.url !== tab.url || fresh.windowId !== tab.windowId || !live() || epoch !== generation) throw new Error('target_changed');
  if (command.kind === 'navigate') {
    await browserApi.tabs.update(tab.id, { url: url.href });
    return { kind: 'navigation_issued', verificationRequired: true };
  }
  if (command.kind === 'download') return download(command, epoch);
  if (tab.url === 'about:blank') throw new Error('page_not_ready');
  if (command.kind === 'observe' || command.kind === 'inspect') await inject(tab.id);
  if (!live() || epoch !== generation || Date.now() >= command.expiresAt) throw new Error('authority_changed');
  const input = pageMessage(command.kind === 'inspect' ? 'observe' : command.kind, tab, command,
    { observationId: command.observationId, elementId: command.elementId });
  if (command.kind === 'scroll') {
    if (command.deltaY !== 1 && command.deltaY !== -1) throw new Error('invalid_scroll');
    input.direction = command.deltaY;
  }
  if (command.kind === 'drag') input.toElementId = command.toElementId;
  if (['inspect', 'photo', 'scroll'].includes(command.kind)) input.maxOutputBytes = command.maxOutputBytes;
  if (command.kind === 'fill' || command.kind === 'select') {
    if (typeof authority.value !== 'string' || authority.value.length > 16384) throw new Error('value_unavailable');
    input.value = authority.value; // Ephemeral projection; never persist/log/echo.
  }
  if (command.kind === 'draft') {
    if (typeof authority.draftText !== 'string' || new TextEncoder().encode(authority.draftText).length > 2048) throw new Error('draft_unavailable');
    input.value = authority.draftText;
  }
  if (command.kind === 'upload') input.file = await fetchFile(command, authority.file, epoch);
  try {
    const result = await browserApi.tabs.sendMessage(tab.id, input, { frameId: 0 });
    if (!result || !bounded(result) || result.kind === 'refused') throw new Error(result?.code && /^[a-z_]{3,40}$/.test(result.code) ? result.code : 'invalid_page_response');
    if (command.kind === 'photo' && result.photo?.screenshot === true) result.photo = await screenshot(tab, result.photo, epoch, command);
    return ['inspect', 'photo', 'scroll'].includes(command.kind) ? { ...result, tabId: tab.id, windowId: tab.windowId } : result;
  } finally {
    delete input.value; delete input.file; delete authority.value; delete authority.draftText; delete authority.proxy;
  }
}
/** Chat attached a tab ("use this tab"). Needs site access the person gave
 * this extension; without it the popup's one click grants it. */
async function attachCommand(command, epoch) {
  if (!Number.isSafeInteger(command.tabId) || webUrl(command.origin)?.origin !== command.origin || !workspace.origins.includes(command.origin)) throw new Error('invalid_command');
  const tab = await browserApi.tabs.get(command.tabId);
  if (tab.incognito || webUrl(tab.url)?.origin !== command.origin) throw new Error('attached_site_changed');
  if (!await browserApi.permissions.contains({ origins: [command.origin + '/*'] })) {
    askedSite = { tabId: tab.id, origin: command.origin }; badge();
    throw new Error('site_permission_required');
  }
  await authorize(command, tab, epoch);
  attachedTabId = tab.id; askedSite = null; persist();
  setPhase(hostPaused ? 'paused' : 'attached');
  return { kind: 'attached', tabId: tab.id, url: tab.url, title: clip(tab.title) };
}
async function openPage(command, epoch) {
  const tab = await browserApi.tabs.get(attachedTabId);
  if (tab.incognito || !webUrl(tab.url)) throw new Error('unsupported_tab');
  await authorize(command, tab, epoch);
  const destination = webUrl(command.url);
  if (!destination || destination.protocol !== 'https:' || destination.origin !== command.origin
    || !workspace.origins.includes(destination.origin) || attachedTabId !== tab.id) throw new Error('invalid_page');
  const fresh = await browserApi.tabs.get(attachedTabId);
  if (!live() || epoch !== generation || fresh.url !== tab.url || fresh.windowId !== tab.windowId) throw new Error('target_changed');
  const opened = await browserApi.tabs.update(attachedTabId, { url: destination.href });
  const loaded = await loadedTab(opened.id, destination, webUrl(tab.url)?.origin, command, epoch);
  await inject(loaded.id);
  const result = await browserApi.tabs.sendMessage(loaded.id, pageMessage('observe', loaded, command, { maxOutputBytes: command.maxOutputBytes }), { frameId: 0 });
  if (result?.kind !== 'observation' || !bounded(result)) throw new Error('observation_unavailable');
  return { ...result, tabId: loaded.id, windowId: loaded.windowId };
}
/** Waits for a tab to finish loading the destination. Until the navigation
 * commits, Chrome still reports the previous address (with the new one as
 * pendingUrl), so the old site is not a change; a third site is. */
async function loadedTab(tabId, destination, previousOrigin, command, epoch) {
  while (live() && epoch === generation && Date.now() < command.expiresAt - 1000) {
    const current = await browserApi.tabs.get(tabId);
    if (current.incognito) throw new Error('navigation_changed');
    const shown = webUrl(current.url)?.origin;
    if (shown === destination.origin && current.status === 'complete') return current;
    const pending = current.pendingUrl ? webUrl(current.pendingUrl)?.origin : null;
    if (shown !== destination.origin && pending !== destination.origin && shown !== previousOrigin && shown !== undefined) throw new Error('navigation_changed');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('page_not_ready');
}
/** Opens a page in a new tab, which becomes the attached one ("open
 * mercari.com" with no tab attached). The person signs in there if needed. */
async function openTab(command, epoch) {
  const destination = webUrl(command.url);
  if (!destination || destination.protocol !== 'https:' || destination.origin !== command.origin || !workspace.origins.includes(destination.origin)) throw new Error('invalid_page');
  if (!await browserApi.permissions.contains({ origins: [destination.origin + '/*'] })) throw new Error('site_permission_required');
  await authorize(command, null, epoch);
  const created = await browserApi.tabs.create({ url: destination.href, active: true });
  if (created.incognito) throw new Error('unsupported_tab');
  attachedTabId = created.id; persist();
  setPhase(hostPaused ? 'paused' : 'attached');
  const loaded = await loadedTab(created.id, destination, null, command, epoch);
  await inject(loaded.id);
  const result = await browserApi.tabs.sendMessage(loaded.id, pageMessage('observe', loaded, command, { maxOutputBytes: command.maxOutputBytes }), { frameId: 0 });
  if (result?.kind !== 'observation' || !bounded(result)) throw new Error('observation_unavailable');
  return { ...result, tabId: loaded.id, windowId: loaded.windowId, openedTab: true };
}
/** Downloads into the browser's own Downloads folder; reports how it ended
 * (file name only, never the folder). */
async function download(command, epoch) {
  if (!browserApi.downloads) throw new Error('downloads_unavailable');
  const id = await browserApi.downloads.download({ url: command.url, conflictAction: 'uniquify', saveAs: false });
  while (live() && epoch === generation && Date.now() < command.expiresAt - 1000) {
    const [item] = await browserApi.downloads.search({ id });
    if (item?.state === 'complete') return { kind: 'download', state: 'complete', file: String(item.filename ?? '').split(/[\\/]/).pop().slice(0, 200), bytes: item.fileSize ?? item.totalBytes ?? null };
    if (item?.state === 'interrupted') return { kind: 'download', state: 'interrupted', reason: String(item.error ?? 'unknown').slice(0, 60), verificationRequired: true };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { kind: 'download', state: 'in_progress', verificationRequired: true };
}
/** An approved upload's file, in the host's 120 KB chunks. The bytes go to
 * the page agent once and are not kept. */
async function fetchFile(command, file, epoch) {
  if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 255 || typeof file.mediaType !== 'string' || file.mediaType.length > 100
    || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > UPLOAD_LIMIT || !Number.isSafeInteger(file.chunks) || file.chunks < 1 || file.chunks > 80) throw new Error('file_unavailable');
  const parts = [];
  for (let index = 0; index < file.chunks; index++) {
    if (!live() || epoch !== generation || Date.now() >= command.expiresAt) throw new Error('authority_changed');
    const piece = await native('browser.chunk', { commandId: command.id, index });
    if (piece?.index !== index || typeof piece.base64 !== 'string' || piece.last !== (index === file.chunks - 1)) throw new Error('file_unavailable');
    parts.push(piece.base64);
  }
  const base64 = parts.join('');
  if (Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0) !== file.size) throw new Error('file_unavailable');
  return { name: file.name, mediaType: file.mediaType, size: file.size, base64 };
}
// A picture from another site cannot be read as pixels, so take a screenshot
// of the attached tab and keep only the picture's area. The tab must be the
// one showing in its window.
async function screenshot(tab, shown, epoch, command) {
  const current = await browserApi.tabs.get(tab.id);
  if (!current.active || current.url !== tab.url) throw new Error('tab_not_showing');
  const a = shown.area;
  if (!a || ![a.x, a.y, a.width, a.height, a.viewportWidth, a.viewportHeight].every(Number.isFinite)
    || a.width < 8 || a.height < 8 || a.viewportWidth < 1 || a.viewportHeight < 1) throw new Error('photo_unavailable');
  const dataUrl = await browserApi.tabs.captureVisibleTab(current.windowId, { format: 'png' });
  if (!live() || epoch !== generation || Date.now() >= command.expiresAt) throw new Error('authority_changed');
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  // The capture is in device pixels; the page measured CSS pixels.
  const ratio = bitmap.width / a.viewportWidth;
  const left = Math.max(0, Math.round(a.x * ratio)), top = Math.max(0, Math.round(a.y * ratio));
  const width = Math.min(bitmap.width - left, Math.round(a.width * ratio)), height = Math.min(bitmap.height - top, Math.round(a.height * ratio));
  if (width < 8 || height < 8) throw new Error('photo_not_visible');
  for (const longest of [768, 512]) {
    const scale = Math.min(1, longest / Math.max(width, height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, left, top, width, height, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.6, 0.4, 0.25]) {
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const base64 = btoa(binary);
      if (base64.length <= PHOTO_BASE64_LIMIT) {
        bitmap.close();
        return { mediaType: 'image/jpeg', base64, width: canvas.width, height: canvas.height,
          alt: shown.alt, untrustedContent: true, fromScreenshot: true };
      }
    }
  }
  bitmap.close();
  throw new Error('photo_budget');
}
// Failure codes are this extension's own constants (photo_budget,
// tab_not_showing, ...), never page content. Browser error text is
// classified, not forwarded.
function failureCode(error) {
  const message = error instanceof Error ? error.message : '';
  if (/^[a-z][a-z0-9_]{2,40}$/.test(message)) return message;
  if (/activeTab|<all_urls>|permission/i.test(message)) return 'screenshot_permission';
  if (/Receiving end does not exist|message port closed|Could not establish connection/i.test(message)) return 'page_agent_missing';
  if (/No tab with id|cannot be scripted|chrome:\/\//i.test(message)) return 'tab_unavailable';
  return 'command_not_verified';
}

// ------------------------------------------------------------- the popup
async function popupState() {
  let active = null;
  try { [active] = await browserApi.tabs.query({ active: true, currentWindow: true }); } catch { active = null; }
  const here = active && !active.incognito && webUrl(active.url) ? active : null;
  const attachedHere = here && here.id === attachedTabId;
  const asked = askedSite && here && askedSite.tabId === here.id;
  const sentence = phase === 'attached' && !attachedHere ? STATUS.attachedElsewhere
    : asked ? STATUS.site
    : phase === 'off' && attachedTabId !== null ? STATUS.offAttached
    : !here && ['linked', 'attached'].includes(phase) ? STATUS.unsupported + ' ' + STATUS[phase]
    : STATUS[phase] ?? STATUS.off;
  return { phase, status: sentence, family: config.family, origin: here ? webUrl(here.url).origin : null, tabId: here?.id ?? null,
    attachedHere: !!attachedHere, attached: attachedTabId !== null, asked: !!asked,
    canAttach: !!here && !attachedHere && ['linked', 'attached', 'paused', 'off', 'reconnect'].includes(phase) && (windowsHost || phase !== 'unknown'),
    canStop: ['linked', 'attached', 'paused', 'reconnect'].includes(phase), canResume: phase === 'stopped' };
}
browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const popup = sender.id === browserApi.runtime.id && !sender.tab && sender.url === browserApi.runtime.getURL('popup.html');
  if (popup) {
    const reply = promise => { void promise.then(() => popupState()).then(sendResponse, () => popupState().then(sendResponse)); return true; };
    if (message?.kind === 'status') { void link(); return reply(ready); }
    if (message?.kind === 'attach' && Number.isSafeInteger(message.tabId)) return reply(attachHere(message.tabId));
    if (message?.kind === 'stop') return reply(stopHere());
    if (message?.kind === 'resume') return reply(resumeHere());
    return false;
  }
  // A person using the attached page while Josi acts takes control (the page
  // agent reports it only while a command is running).
  const pageStop = message?.kind === 'local_input' && sender.id === browserApi.runtime.id && sender.frameId === 0
    && sender.tab && sender.tab.id === attachedTabId && workspace && message.sessionId === workspace.sessionId;
  if (pageStop) { void stopHere(); sendResponse({ stopped: true }); }
  return false;
});
browserApi.tabs.onRemoved.addListener(id => {
  // A closed tab detaches; the browser stays linked.
  if (id === attachedTabId) { attachedTabId = null; persist(); if (workspace) setPhase(hostPaused ? 'paused' : 'linked'); }
  if (askedSite?.tabId === id) { askedSite = null; badge(); }
});
browserApi.alarms.onAlarm.addListener(alarm => { if (alarm.name === LINK_ALARM) void link(); });
browserApi.runtime.onStartup?.addListener(() => { arm(); void link(); });
browserApi.runtime.onInstalled?.addListener(() => { arm(); void link(); });
// Every wake (an alarm, a message, the browser starting) runs this file.
arm(); void ready.then(() => { badge(); return link(); });
