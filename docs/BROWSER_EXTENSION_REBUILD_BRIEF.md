# Browser extension rebuild: the brief (step H of JOSI_IS_THE_INTERFACE)

For whoever builds it (Codex or a fresh session). Everything here was read
from the current code on November 8, 2026; nothing below is implemented yet.
The acceptance stays the garage-sale task: a real attached tab, photos
described one by one, through the installed Josi.

## What exists today (0.8.0)

| Piece | File | What it does now |
|---|---|---|
| Service worker | `apps/browser-extension/src/background.js` | Connects to the native host only when the popup's "Attach this tab" is clicked; one attached tab; polls the host every 750 ms for one command at a time; re-attaches for 10 minutes after the host drops; commands: inspect, observe, navigate, click, fill, draft, photo, openPage, scroll. |
| Native channel | `native-channel.js` | One `runtime.connectNative('com.heyjosi.browser')` port; at most two requests in flight; 5 s timeout closes the port. |
| Page agent | `page-agent.js` | Injected into frame 0 only; observes `img, a, button, input, textarea, select, [role=button], [role=link], [contenteditable]`; no shadow DOM, no iframes, no `<select>` choice, no drag; fills only text-like inputs and textareas; stops on any trusted pointer/key/wheel event. |
| Popup | `popup.html/js/css` | Two buttons (Attach this tab, Take control) and a status sentence. |
| Build | `scripts/unified/build-browser-extensions.mjs` | Unpacked folders per family with the fixed dev key, store zips for chrome/edge/firefox, `VERSION` constant. |
| Native host | `apps/windows-native/src/BrowserHost.cs` | Chrome starts `Josi.exe <extension origin>`; relays frames over a per-user pipe; `ChromiumExtensionIds = { dev id }`. |
| Bridge | `apps/windows-native/src/BrowserBridge.cs` | Pipe server; hello/poll/authorize/receipt/stop; one `Link` (one tab); dispatches PC Control requests of kind open/read/click/fill/photo to the extension. |
| Tools | `packages/agent/src/pcBrowserTools.ts` | browser_read_page, browser_open_page, browser_click, browser_fill, browser_view_photo, browser_check_request; offered only while presence has an `origin`. |
| Presence | `packages/core/src/pcControl.ts` `normalizePresence` | families chrome, brave, edge, desktop (no firefox); `origin` and `title` of the attached tab only. |

Chrome on the owner's PC loads the unpacked extension from
`C:\Dev\josi-dev\browser-extension\chrome` (dev id `peopadjeldgefmbfllgjgdndhabbagpl`).
The build script refuses an existing output folder: build to a new folder and
copy `chrome/` over that path, then reload the extension in `chrome://extensions`.

## Target behaviour (the spec's step H, made concrete)

1. **A standing link.** The worker links to the host whenever Josi is open
   (startup, `alarms` every 30 s, and when the popup opens), with no tab
   attached. `browser.hello` therefore accepts `attachedTabId: null`. The
   bridge keeps a `Link` with `TabId = -1`, `Url = null`, and reports presence
   with the browser family but no origin. While linked without a tab, the poll
   carries `active: {tabId, url, title}` (the active tab of the last focused
   window) and `tabs: [{tabId, title, url, active}]` (web URLs only, at most
   30), so Josi can name tabs.
2. **Attach from chat.** New tool `browser_attach_tab {tab_id?}`: proposes a
   PC Control request `browser.view` on the origin of that tab (from
   presence `tabs`/`active`) with payload `{kind:'attach', tabId}`. The
   extension receives command `attach`: if `permissions.contains` for that
   origin is true it re-hellos with the tab; otherwise it answers
   `site_permission_required`, sets a badge, and the popup's one button grants
   the site on click (Chrome only grants during the click). The tool tells the
   person, in one sentence, to click the Josi icon once.
3. **Reconnect that survives sleeps and restarts.** State (`attachedTabId`,
   phase) in `storage.session`; `nativeProfileId` stays in `storage.local`.
   The alarm keeps re-linking while the browser is open (no 10-minute cap).
   Stop (popup, or a human touching the page) sets `stopped` and cancels
   re-linking until Resume.
4. **Several tabs.** `browser_list_tabs` reads presence; `attach` switches
   the attached tab. One attached tab at a time is enough.
5. **Page operations.** In the page agent: shadow DOM traversal when
   collecting candidates; same-origin iframes traversed through
   `contentDocument` (cross-origin frames reported as unsupported);
   `select` (set `value`, dispatch input/change); `fill` on
   `contenteditable` (insert text through `execCommand('insertText')`);
   `drag` (pointer events from one observed element to another);
   `download` (`chrome.downloads.download` of an https URL on the attached
   origin, PC action `browser.download`); `upload` (PC actions
   `browser.upload` + `folder.read` for the file's folder; the bridge reads the
   file, streams base64 chunks of 120 KB through a new `browser.chunk`
   operation, the agent builds a `File` in a `DataTransfer` and sets
   `input.files`; cap 8 MB). Tools: `browser_select_option`, `browser_drag`,
   `browser_download`, `browser_upload_file`.
6. **Never read or fill passwords or payment fields.** The agent excludes
   `input[type=password]`, `autocomplete^=cc-`, and names or ids matching
   `/card|cvv|cvc|ccnum|passw|ssn/i` from observations and refuses `fill`
   and `select` on them.
7. **Clear states.** Worker phases: `off` (Josi not open), `linked` (no tab),
   `attached`, `paused` (human took control), `reconnect`. The popup shows
   the sentence for the phase and the right buttons (Attach this tab, Switch
   to this tab, Take control, Resume). Poll replies carry `paused: true` when
   the app's executor is paused or taken over, so the popup says "Josi is
   paused; resume in Josi".
8. **Ghost bar and Pause/Stop.** `DesktopExecutor` gains
   `BeginExternal(activity)` / `EndExternal()` (a second activity source
   behind `Busy`/`Activity`); the bridge calls them around every dispatched
   browser command ("Reading example.com", "Clicking on example.com"). Pause
   and Stop already fail queued browser work; keep that.
9. **Store IDs.** `BrowserHost.ChromiumExtensionIds` = dev id + store ids
   (a constant list, plus an operator override file
   `%LOCALAPPDATA%\Josi\BrowserHost\extension-ids.json`); `Register` writes
   every id's origin into `allowed_origins`. `development-identity.json`
   gains `chromiumStoreIds: []` for the build script's catalog.
10. **Presence.** `normalizePresence` accepts `firefox` and the optional
    `activeOrigin`, `activeTitle`, `tabs` (bounded, origins only); the tool
    availability offers `browser_attach_tab` and `browser_list_tabs` whenever
    the family is a browser, and the full set when `origin` is set.
11. **One ask in chat.** The chat card for a browser requirement gets an
    "Always allow on this site" button next to Allow once (PUT
    `/admin/pc-control/policies` with mode `always` for that action and scope),
    mirroring the command card's "Always allow this shell here".
12. **Packaging.** `VERSION = '0.9.0'`; manifest adds `downloads`; the store
    doc's permission justifications gain `downloads`; privacy copy unchanged
    (page content goes only to the Josi app on the same computer).

## Message contract (version 1, extended)

- `browser.hello` payload: `{family, extensionId, nativeProfileId, attachedTabId: number|null, url?, title?}`.
  Reply: session `{sessionId, workspaceId, profileId, family, expiresAt, origins, currentDesktop}` or `{profileDiscovered: true}`.
- `browser.poll` payload (Windows host): `{url, title, tabId}` for the attached tab or nulls, `active`, `tabs`, `paused`.
  Reply: `{session, command, paused}`.
- Commands keep `{id, sessionId, profileId, expiresAt, kind, ...}`; new kinds `attach`, `select`, `drag`, `download`, `upload`.
- `browser.authorize` reply may carry `value` (fill, select) or `file: {name, mediaType, size, chunks}` (upload).
- `browser.chunk` payload `{commandId, index}` → `{index, base64, last}`.
- `browser.receipt` unchanged. An `attach` receipt's result carries `{tabId, url, title}`; the bridge updates the link from it.

## Tests to add

- `packages/agent/test/pcBrowserTools.test.ts`: availability with and without origin; `browser_attach_tab` proposes `browser.view` on the named tab's origin; upload requires both actions.
- `packages/core/test/pcControl.test.ts`: presence accepts firefox and bounded tabs; rejects more than 30 or non-web URLs.
- `apps/api/test/windowsBrowserClient.test.ts`: the new presence fields round-trip.
- A page-agent unit test (jsdom) for the password/payment exclusion and `select`.

## Order of work

1. Presence and tools (server), with tests. 2. Bridge and host (app), build
the app. 3. Worker, agent, popup, manifest, build script; copy `chrome/` to
`C:\Dev\josi-dev\browser-extension\chrome` and reload. 4. Live: link without a
tab, "use this tab" from chat, read, photo, select, download; Pause and Stop
mid-task; Josi restart with the tab attached; then the garage-sale task.
