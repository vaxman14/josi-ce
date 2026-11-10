# Handoff to the Mac: ship the Safari extension (November 10, 2026)

This is for the session working on the Mac. The goal: Josi uses Safari the
way it already uses Chrome, Edge, Brave and Firefox on Windows. Josi opens a
tab or uses the tab you're looking at. Once PC Control is approved there are
no other steps: no attaching a tab, no clicking the extension.

- **Windows branch:** `redesign/windows-lean-beta` (this doc is on it).
- **Mac branch:** `redesign/mac-lean-beta`, head `ed2bcdc`. It last merged
  Windows at `76e7c4d`.
- **Order of work:** merge Windows into the Mac branch first. The extension
  changed since `76e7c4d` (see "What changed on Windows" below).

## Rules that still hold

- Every page action goes through PC Control: either a saved permission or the
  owner's approval. The extension never acts on its own and never retries an
  uncertain action.
- Password, payment and one-time-code fields are never read or filled. This
  is `sensitive()` in `page-agent.js`; keep it as is.
- Page content is untrusted data, and secrets never pass through the model.
- Commit as Roman Vaxman with per-command `git -c user.name=… -c user.email=…`,
  never a global config. Pushing is fine. Don't publish a GitHub release.

## What the Mac already has (from `dbe8a70` and the earlier guest work)

Read these before writing anything new:

- **Josi's side of the protocol:** `apps/macos-native/Sources/PcBrowserBridge.swift`.
  - hello, poll, authorize, receipt, chunk and stop.
  - A standing link with no tab, and the tab list.
  - Commands: attach, open in a new tab, read, click, fill, photo, select,
    drag, scroll, download and upload.
  - Presence reporting; browser work shows in the control bar and obeys
    Pause and Stop.
  - It accepts Safari when the peer is `kind: safari-profile` with extension
    `com.heyjosi.ce.unified.workspace-safari`.
- **The Safari extension's native handler:**
  `apps/automation-macos/Sources/GuestSafariExtension.swift`
  (`JosiSafariExtensionHandler`).
  - Safari supplies the profile UUID (`SFExtensionProfileKey`).
  - Each message is relayed to the broker (`GuestBrowserBroker.swift`), which
    Josi owns in host-desktop mode with a 9-second lease.
- **Packaging:** `scripts/macos/build-guest-browser-components.py`.
  1. It runs `build-browser-extensions.mjs` and takes its `safari/` folder.
  2. It runs `xcrun safari-web-extension-packager` on that folder and swaps
     in the handler above.
  3. It builds `Josi Workspace.appex` with bundle ID
     `com.heyjosi.ce.unified.workspace-safari`.
- **The app build:** `scripts/macos/build-native-unified.py` copies that
  appex into `Josi.app/Contents/PlugIns/` and signs it with
  `Safari.entitlements`.
- **In the extension itself,** `native-channel.js` already uses
  `runtime.sendNativeMessage('com.heyjosi.ce.unified', …)` on Safari, with
  one request per message (no port).

So the plumbing exists. What's missing:

- catching up with the Windows changes;
- the Safari-only gaps below;
- a real live run in Safari;
- shipping it in the notarized Josi.app.

As far as the commit messages show, Safari hasn't been tried in the browser
end to end yet.

## What changed on Windows since `76e7c4d`

These are shared code. The Mac host has to match them.

**Extension 1.0.0** (`b4bb4dc`, `adaead4`, `fe1ef9c`, `efdd92b`, `0fde57a`):

- **Follows the tab you're looking at.** While Josi works, and for 2 minutes
  after its last step (`WORK_HOLD_MS`), it stays on its own tab. It only
  switches to a tab whose site it has access to
  (`permissions.contains`).
- **One linked browser at a time.**
  - A `browser.hello` from a second browser carries no `explicit` flag. The
    host replies `{standby: true, family}`.
  - The popup then shows "Use this browser". Clicking it sends
    `explicit: true`, which takes the link over.
- **New phase `standby`**, plus the new popup wording, purple and gold look
  and icons.
- **Photos.** A photo from another site is fetched by the worker
  (`downloadPhoto`, which uses `OffscreenCanvas`), so the tab doesn't need to
  be showing. The screenshot is the fallback. The page agent waits for the
  picture to stop moving before measuring it.
- **Opening a tab.** `openTab` falls back to `windows.create` when the
  browser has no window.
- **Manifest:**
  - version `1.0.0`;
  - all-site `host_permissions`;
  - the `downloads` permission;
  - the store description.

**Josi's side** (`apps/windows-native/src/BrowserBridge.cs`; port anything
`PcBrowserBridge.swift` lacks):

1. **Standby on hello.** If another browser is live and this hello isn't
   `explicit`, reply `standby` and keep the current link.
2. **Poll follows the extension's tab.** `payload.tabId` names the tab Josi
   uses; take it as the link's tab unless a command is in flight.
   `tabId: null` means no tab.
3. **Remember the last browser** (`browserLast`). When no browser is running,
   presence names that browser with an empty tab list. That way "open
   mercari.com" can start it.
4. **Opening a page while the browser is closed.** Start the approved browser
   with that https page. On the Mac that is
   `NSWorkspace.open([url], withApplicationAt:…)` for Safari's path. Then:
   - wait up to 40 s for the link to show that origin;
   - read the page;
   - honour Pause during the wait.

   The refusal codes are `browser_not_linked`, `invalid_page`, `paused`,
   `browser_not_responding` and `browser_did_not_start`.
5. **Gate on `CanControlPc`, not `IsAdministrator`.** A signed-in person
   controls their own PCs (`1ede1a5`, `1e86435`).

**Server and agent:** `pcBrowserTools.ts` and `pcControl.ts` come along with
the merge. They need no Mac work.

## Safari-only gaps to close

1. **Downloads.** Safari has no `browser.downloads` API, so the `download`
   command in `background.js` (around line 406) fails there. Recommended fix:
   on Safari, the worker fetches the file itself. It sends the bytes to the
   host in 120 KB chunks (the reverse of upload), and the host writes the file
   into `~/Downloads` with a unique name.
   - Use the same checks as Windows: https only, on the site in use, and
     8 MB.
   - Leave `downloads` out of the Safari manifest
     (`manifestFor('safari')` in `build-browser-extensions.mjs`), so the
     packager doesn't warn about it.
   - If that is too much for this pass, return a clear
     `download_unsupported` refusal, and have the agent say Safari can't save
     files yet.
2. **Site access.** Safari doesn't grant `host_permissions` at install. The
   person allows sites in Safari > Settings > Websites/Extensions, or per site
   from the toolbar. Until they do:
   - `permissions.contains` is false;
   - follow-the-tab skips the tab;
   - Josi can't read the page.

   What to build:
   - The first time Safari links, the popup (and a short line in Josi's chat
     refusal) should say: "In Safari, allow Josi on every website".
   - Call `browser.permissions.request({origins:['https://*/*','http://*/*']})`
     from a popup button, which Safari allows from a user click.
   - This is the one unavoidable click on Safari. Make it a single step.
3. **Turning the extension on.** Safari ships extensions turned off. After
   install, Josi's setup step (or the PC Control page) should open Safari's
   extension settings:
   `SFSafariApplication.showPreferencesForExtension(withIdentifier: "com.heyjosi.ce.unified.workspace-safari")`.
   The text should say to turn on "Josi Browser Control". The existing
   refusal in `PcBrowserBridge.swift:318` already tells the person where to
   find it; a button that opens the right settings pane is better.
4. **Worker APIs to confirm in Safari 17+.** The build should target
   macOS 14.2 or later, as the script does.
   - `storage.session`, `alarms`, `permissions.contains`, `windows.create`,
     `tabs.captureVisibleTab`.
   - `OffscreenCanvas`, `createImageBitmap` and `convertToBlob` in a
     non-persistent background page.

   If one is missing, add a small fallback in `background.js`. For example, a
   photo can fall back to the screenshot path. Don't fork the extension.
5. **The `persistent: false` background page** gets unloaded. The 30-second
   `josi-link` alarm and `storage.session` already bring it back. Check that
   a link survives Safari unloading it.
6. **Stale wording.** `build-guest-browser-components.py` still says "The
   extension attaches only the tab explicitly selected by its user". Update
   it to the follow-the-tab behaviour.

## Distribution

- **No store submission is needed.** The Safari extension ships inside
  Josi.app, which is signed with Developer ID (Socal Receptionist LLC, team
  `LRH75YR6QW`) and notarized (`docs/MACOS_RELEASE.md`). Safari accepts
  extensions from such apps; the person turns it on in Safari's settings.
- **Signing:** the appex must be signed with the same team, and the app and
  appex must be notarized together. `build-native-unified.py` already signs
  it; confirm `spctl -a -vv` and `codesign --verify --deep --strict` pass on
  the final app.
- **For development:** an unsigned build needs Safari > Develop > "Allow
  unsigned extensions". That setting resets every time Safari quits. Test the
  signed build for acceptance.
- **The Mac App Store (and Safari's extension gallery)** would need a
  separate App Store app. Not for now. Mention it to Roman only if he asks.
- **The privacy policy** at https://heyjosi.com/browser-extension/privacy/
  already covers every browser. The contact is support@heyjosi.com, which
  forwards to roman@socalreceptionist.com.

## Store state (for context)

| Store | State |
|---|---|
| Chrome (also covers Brave) | Submitted Unlisted, in review. ID `hnhfoacbnkiebihopmppfblmmmonhmbm` |
| Firefox AMO | Submitted, in review |
| Edge | Filled in; waiting on Microsoft account verification |

## Acceptance on the Mac

Use the signed Josi.app, installed in /Applications, with PC Control on.
Record the results in a Mac acceptance doc, in the same form as
`docs/WINDOWS_PC_CONTROL_LIVE_ACCEPTANCE.md`.

1. Safari open, the extension on, all sites allowed. The popup shows
   "Linked", and chat lists the open tabs.
2. "What's on this page?" reads the tab you're looking at. No attach step.
3. "Open mercari.com" opens a new tab and reads it. Quit Safari and ask again:
   Safari starts with the page.
4. "Describe each photo": the pictures are fetched or captured.
5. Select, fill, scroll and upload (from an approved folder) on a test page.
   Download goes through the gap 1 fix, or gives the clear refusal.
6. A password field and a card field on the page are never listed or filled.
7. Pause mid-task, then Resume. Stop mid-task: nothing is retried. "Take
   control" in the popup stops Josi in Safari.
8. Chrome and Safari both linked: the second one shows standby, and "Use this
   browser" switches.
9. Restart Josi: Safari links again by itself within 30 s.
10. The garage-sale task (from `docs/BROWSER_EXTENSION_REBUILD_BRIEF.md`) end
    to end in Safari.

## Tests

```
npx vitest run packages/agent/test/pcBrowserTools.test.ts packages/core/test/pcControl.test.ts apps/api/test/pcControlChat.test.ts apps/browser-extension/test/pageAgent.test.ts
npx tsc -b packages/core packages/connectors packages/agent apps/api
node scripts/unified/build-browser-extensions.mjs <new empty folder>
```

The page agent test runs in Chromium. It doesn't cover Safari's WebKit, so
Safari is covered by the live run above.
