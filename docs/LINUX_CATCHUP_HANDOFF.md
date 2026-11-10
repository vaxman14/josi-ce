# Linux catch-up handoff (November 10, 2026)

For the session that brings the Linux server (`linux/josi-server`, worktree
`Josi Linux`) level with Windows. Everything below is pushed on
`redesign/windows-lean-beta` at `9bc2586`.

## Where Linux stands

`linux/josi-server` last took Windows at `e6628da` (Nov 9, 14:53). It already
has all of November 8: PC control, chat permission cards, credential cards,
My World, member requests, setup status, the model picker, the step H browser
extension rebuild. It is missing the 23 commits after `e6628da`:

    git log --reverse --oneline e6628da..origin/redesign/windows-lean-beta

Read first: `docs/JOSI_IS_THE_INTERFACE.md` (the rule: a feature not reachable
by asking Josi is not finished) and `docs/WINDOWS_BUILD_LIST.md` (the November
9 list, what was reported, what was fixed and how).

## Step 1: merge

    git merge origin/redesign/windows-lean-beta

Three files changed on both sides since `e6628da`; expect to resolve by hand:

- `apps/api/src/http/pcControlRoutes.ts`: Windows only reworded the
  `availability` sentence (no "tab attached"). Keep the Linux logic, take the
  wording.
- `apps/browser-extension/src/background.js`: Windows added one link at a
  time across browsers (standby), follow the active tab while Josi is idle,
  own tab while working and two minutes after, pictures downloaded by the
  extension itself. Josi's own browser on Linux (`josi-browser.mjs`: Xvfb,
  Chrome for Testing, this extension) must still link and attach after the
  merge; rerun `e2e-pc.mjs`.
- `packages/agent/src/pcBrowserTools.ts`: tool descriptions now say "use the
  browser", never "attach a tab"; opening a page while no browser runs starts
  one. Check the Linux edits (own browser, `linux-` PC ids) survive.

Migrations arrive with the merge: `0121_device_transfers.sql` and
`0122_capabilities_start_on.sql`. Linux stops at 0120, so there is no number
clash. Windows has since added `0123_member_pc_control.sql` (members may
control their own PCs, see `docs/WINDOWS_CLIENT_NODE_SPEC.md`); do not add a
Linux migration under 0124.

## What arrives with the merge and needs no Linux work

- **Connected accounts start with everything on** (`1ede4e3`).
  `upsertConnection` in `packages/connectors/src/connections.ts` inserts every
  granted capability enabled; an administrator's installation-wide block still
  holds for members; a switch the person turned off stays off on reconnect.
  Migration 0122 switches on accounts connected before this, once.
- **A bare yes or no is ordinary talk** (`9bc2586`).
  `resolveConversationalAction` in `packages/core/src/actionState.ts` returns
  `{handled:false}` when nothing waits for approval, so the message reaches
  the model. Before, Josi answered "I do not have one immediately preceding
  prepared action" to the answer of a question she had just asked.
- **Connect an account from chat** (`c327e1e`): agent tool
  `start_account_connection` in `packages/agent/src/credentialCardTools.ts`.
- **Send to my devices, server side** (`c327e1e`): `/api/device-transfers`.
- **Extension 1.0.0** and its store build (`efdd92b`, `d224a9a`, `0fde57a`).
  Chrome Web Store ID `hnhfoacbnkiebihopmppfblmmmonhmbm`.

## What Linux has to build (the web app is the Linux client)

In order. Each one is a place where the server now does something the web app
does not show, or says something that is no longer true.

1. **Connections page wording.** `apps/web/src/pages/Connections.tsx:205` says
   a capability "stays off in Josi until you choose to turn it on here", and
   `apps/web/src/components/CloudFolders.tsx:100` says "It is off until you
   turn it on". Both are now false. Windows says: "Everything it grants starts
   on in Josi. You can turn any of it off here afterwards."

2. **The account connection card.** `start_account_connection` opens a
   settings-change proposal with `area = 'credential_card'` and
   `card.kind = 'account_connection'`: no fields, one "Sign in with <name>"
   button, `apply = POST /connections/<provider>/start`, fixed body
   `{native: true}`. `apps/web/src/components/CredentialCards.tsx` must render
   this kind. In a browser the ordinary web handshake is the right one: start
   it the way the Connections page already does (the web redirect, not the
   native one), then mark the card with `POST /settings-changes/:id/applied`.
   Windows reference: `AppModel.AwaitConnection` in
   `apps/windows-native/src/AppModel.cs`.
   The link-free return (`cb95e81`: start with `{native: true, poll: true}`,
   then `POST /connections/:provider/native/complete {state}` answering
   `202 {waiting: true}` until the provider has returned) exists for native
   apps that cannot be linked back; the web app does not need it.

3. **Send to my devices in the web app.** Contract, all under
   `/api/device-transfers` (`apps/api/src/http/deviceTransferRoutes.ts`, tests
   in `apps/api/test/deviceTransfers.test.ts`):
   - `PUT /devices/:deviceId {name, platform}` registers this device.
     Id shape `^[a-z]{2,8}-[0-9a-f]{8,64}$`; platform one of `windows, macos,
     android, ios, web`. **`linux` is not in the list**: add it if the server's
     own PC service (`linux-<32 hex>`) should be a target, and say so to the
     Windows session so the picker shows it.
   - `GET /devices?deviceId=` → `{devices, people, maxBytes}` (my other
     devices, the other people on this Josi; 25 MB).
   - `POST /?toDevice=|toUser=&fromDevice=` multipart `file` → `{id, state}`.
     Own device: `accepted` at once. Another person: `offered` until they
     accept.
   - `GET /inbox?deviceId=` → `{transfers, sent}`; `POST /:id/accept
     {deviceId}`, `POST /:id/decline`, `GET /:id/content?deviceId=`,
     `POST /:id/received {deviceId}` (clears the server copy).
   - Limits: 20 unfinished per sender, 7 days, then expired.

   A browser has no install id: mint one per browser profile and keep it in
   local storage (`web-<hex>`). Windows UI for reference: the plus button
   menu in `apps/windows-native/src/Chat.cs`, the accept prompt in
   `Notifications.cs`.

   Not built anywhere yet: an agent tool so Josi sends a file when asked.
   Windows does it from the plus menu only. If Linux builds the tool first,
   put it in `packages/agent` so every platform gets it.

4. **Message bar.** On Windows the hint, caret and buttons share one line and
   focus returns to the bar after every reply. Check the web composer does the
   same; the Linux branch reworked web chat in `e94cfec`.

5. **Wording sweep.** Josi and every screen say "use the browser". Grep the
   web app and `packaging/linux` user-facing text for "attach a tab" and
   "Detach Tab" (now "Unlink Browser"). Code comments do not matter.

6. **My World text pass.** Windows sized tabs to their label and put values
   beside their labels. Compare with the web My World page.

## Windows-only, skip on Linux

- `c22abf0`, `76ec698`, `13352f8`: `josi://` link handling and Chrome starting
  an old installed copy.
- `b662395`: paste read straight from the clipboard (a WPF fault).
- The double padding in the message box (`Chat.cs`, in `1ede4e3`).
- Chrome store listing helper and screenshots (`8169b76`, `96a9859`,
  `66763ae`).

## Rules that still hold

- Josi never reads, copies, speaks or stores a secret, with or without
  permission. Secrets go from a card straight to the route with the person's
  own session and live only in the Vault.
- The owner is never gated by member limits.
- "Debian" means the whole apt family. Never Ubuntu's snap Chromium.

## Verification

- `npx vitest run test/deviceTransfers.test.ts test/nativeConnectionCallback.test.ts`
  in `apps/api`; `test/handshake.test.ts` in `packages/connectors`;
  `test/actionState.test.ts` in `packages/core`;
  `test/credentialCardTools.test.ts` in `packages/agent`.
- Known failures that predate all of this and are not yours: about 32
  connector tests (workflows, custom API, contact sync, Nextcloud credential),
  3 API storage tests, 4 agent tests (`dataTools`, `immediateRetry`).
- On a VM (`josi-debian13-vm`, `josi-ubuntu2404-vm`): `e2e-fake.mjs`, then
  `e2e-pc.mjs`, then by hand in the web app:
  1. "Connect my Google account" → card with one button → sign in → note in
     chat → Connections shows every switch on → "show my latest emails" works
     with no further approval.
  2. Answer "yes" to a question Josi asked with nothing waiting: she carries
     on, no canned reply.
  3. Send a file from the web app to the Windows PC and back.

## Not verified on Windows either

Mail reading, the message bar and the yes/no reply were built and installed
as 1.2.5-preview.22 but not yet confirmed by the owner. Send to devices, the
no-tabs answer after opening a page, and focus return were not driven live.
If Linux finds a fault in shared code, fix it in the shared package and tell
the Windows session.
