# Handoff to the Mac: bring the macOS app up to date (November 9, 2026)

This handoff is for the session that works on the Mac. Everything below sits on
branch `redesign/windows-lean-beta` in `vaxman14/josi-ce`, head after this doc.
The Mac redesign lives on `redesign/mac-lean-beta` (head `f2350a7` when this was
written). Merge or rebase this branch's shared code into it. Do not copy the
Windows UI: build each piece in the Mac app's own look (`docs/MACOS_LEAN_BETA.md`).

## What is shared and already done (server, agent, extension)

Mostly, the Mac just has to render these. Nothing needs re-implementing.

| Piece | Where | Mac work |
|---|---|---|
| A `josi_setup_status` tool | `packages/agent/src/setupStatusTools.ts` | none (server) |
| B credential cards (`request_credential_card`) | `packages/agent/src/credentialCardTools.ts`, proposal rows with `area: credential_card` | **native card**: secure fields that post straight to the route in the card, then report `/settings-changes/:id/applied`. Windows: `Dialogs.CredentialCard` in `apps/windows-native/src/Dialogs.cs`. Web: `apps/web/src/.../CredentialCards.tsx` |
| C owner is never gated by member ceilings | `packages/connectors`, `connections.ts`, developer routes | none |
| D member connector requests | `connectorRequestTools.ts`, area `member_connector_request` | **card in the owner's chat and in Approvals** (Allow / Deny) |
| E prompt pieces | `assistantAgent.ts` | none |
| F visible pages (Connectors, Apps, Storage) | Windows `Flags.cs` | flip the matching flags in `JosiFlags.swift` |
| G My World | migration `0120_my_world.sql`, `packages/core/src/myWorld.ts`, routes `/my-world`, `myWorldTools.ts` | **My World page** behind password or Touch ID (Windows: `MyWorldView`); secret fields reveal only after the five-minute Vault unlock |
| H browser extension 0.9.0 | `apps/browser-extension/src/*`, `scripts/unified/build-browser-extensions.mjs` | see below |

The governing spec is `docs/JOSI_IS_THE_INTERFACE.md`. The Windows live record is
`docs/WINDOWS_PC_CONTROL_LIVE_ACCEPTANCE.md`.

## Step H on the Mac

What was built for Windows in `07449b3`:

- **Extension (shared by all families).** It links to the native host whenever
  Josi is open, with `attachedTabId: null` when no tab is attached. State
  survives worker sleeps (`storage.session`), and the extension reconnects
  after a Josi restart. Stop holds until Resume. Phases are off, linked,
  attached, paused, reconnect and stopped. New command kinds are `attach`,
  `select`, `drag`, `scroll`, `download` and `upload`. Password, payment and
  one-time-code fields are never listed or filled.
- **The standing link and the tab list are Windows-only for now.** The worker
  checks `windowsHost` (`navigator.platform` starts with `Win`). On macOS it
  keeps the original contract: a link always names a tab, and `browser.poll`
  sends `{}`. That is because the macOS host (`com.heyjosi.ce.unified`)
  requires the old exact fields. To give the Mac the same behaviour:
  1. Make the Mac host accept `browser.hello` with `attachedTabId: null` and no
     `url`/`title`, and keep a link with no tab.
  2. Accept the `browser.poll` payload `{url, title, tabId, active:{tabId,url,title}, tabs:[{tabId,url,title,active}]}`.
     Report presence with `activeTabId`, `activeOrigin`, `activeTitle` and
     `tabs` (origins only, at most 30). The server validates it in
     `normalizePresence` (`packages/core/src/pcControl.ts`).
  3. Reply to polls with `paused: true` while Josi is paused or taken over.
  4. Dispatch the new request kinds from PC Control (`payload.kind`):
     - `attach` `{tabId}`: command `attach`. The receipt's `{tabId, url, title}` becomes the attached tab.
     - `select` `{option}`: the value goes in the authorize reply.
     - `drag` `{toElementId}`
     - `scroll` `{direction}`: command `deltaY` is `1` or `-1`.
     - `download` `{url}`: https only, on the attached origin.
     - `upload` `{path}`: read the file only if a `folder.read` requirement covers its folder. 8 MB cap. The authorize reply carries `file:{name, mediaType, size, chunks}`. Answer `browser.chunk {commandId, index}` with `{index, base64, last}` in 120 KB chunks.
  5. Show each browser command in the Mac's control bar and obey Pause and Stop.
     Windows does this through `DesktopExecutor.BeginExternal/EndExternal`.
  6. Then remove the `windowsHost` gate in `background.js` (or make it check for the host's capability).
  The Windows reference is `apps/windows-native/src/BrowserBridge.cs`; the
  full contract is in `docs/BROWSER_EXTENSION_REBUILD_BRIEF.md`.
- **Chat card.** Next to Allow once there is an "Always allow on this site"
  button: PUT `/admin/pc-control/policies` with `mode: always` for that action
  and exact browser scope. The account password is needed only for high-risk
  actions. Windows: `Chat.cs` `RenderCards`.
- **Safari** still needs its containing app (the build emits `safari/`). Its
  ID is `safariId` in `apps/browser-extension/development-identity.json`.

## Tests to run on the Mac

```
npx vitest run packages/agent/test/pcBrowserTools.test.ts packages/core/test/pcControl.test.ts apps/api/test/pcControlChat.test.ts apps/browser-extension/test/pageAgent.test.ts
npx tsc -b packages/core packages/connectors packages/agent apps/api
```

`pageAgent.test.ts` runs the page agent in Playwright's Chromium, or in the
installed Chrome when Playwright's own browser is missing.

## State on Windows at handoff

- The step H code is committed (`07449b3`), type-checks, and the new tests pass
  (12 agent, 3 core presence, 1 API round-trip, 6 page agent). The wider suite
  has 10 failures in 6 files that this PC already had or that come from earlier
  code: Mac/Linux assumptions, antivirus, the PC Control browser page test, the
  `settingsChangeRoutes.ts` jsonb lint, and a subscription probe timing test.
- Not yet verified live: the signed `1.2.5-preview.17` installer was building
  when this was written. The garage-sale acceptance on a real attached tab is
  still open and goes into `docs/WINDOWS_PC_CONTROL_LIVE_ACCEPTANCE.md`.
- One deliberate deviation from the brief: a person's input on the attached
  page stops Josi only while a command runs (and 1.5 s after it). That way,
  scrolling the page yourself between Josi's steps doesn't end the link.
