# Mac catch-up handoff (November 10, 2026)

For the session that brings the Mac app (`redesign/mac-lean-beta`, head
`ed2bcdc`) level with Windows. Everything below is pushed on
`redesign/windows-lean-beta` at `1e86435`.

## Where Mac stands

`redesign/mac-lean-beta` last took Windows at `76e7c4d`. It is missing 27
commits:

    git log --reverse --oneline origin/redesign/mac-lean-beta..origin/redesign/windows-lean-beta

Read first: `docs/JOSI_IS_THE_INTERFACE.md`, `docs/WINDOWS_BUILD_LIST.md`
(the November 9 list), `docs/WINDOWS_CLIENT_NODE_SPEC.md` (the client as a
node) and `docs/LINUX_CATCHUP_HANDOFF.md` (the same server changes, described
for the web app; its "arrives with the merge" section applies to Mac as is).

## Step 1: merge

    git merge origin/redesign/windows-lean-beta

Migrations 0121 to 0123 arrive with it. `e6628da` ("PC Control understands a
Mac") is in the range and touches shared PC control code Mac also edited in
`ed2bcdc`; expect to resolve `PcIdentity.swift`-side assumptions by hand.

## What Mac has to build

1. **The Mac is a node of whoever signs in** (the main item; spec in
   `docs/WINDOWS_CLIENT_NODE_SPEC.md`).
   - Server, already done: `users.pc_control_allowed`; `/auth/me` and sign-in
     return `pcControlAllowed`; `/admin/pc-control/*` is open to any allowed
     user for their own PCs; `POST /admin/pc-control/identity` takes
     `{publicKey, password}` or `{publicKey, elevated: true}` on a session at
     most ten minutes old (401 otherwise). The executor's signed proof is
     required in both.
   - Mac undid part of this in `ed2bcdc` ("one key per owner"): the key must
     be per server and per user, and the node loop, PC Control page and nav
     item must follow `pcControlAllowed`, not the owner role.
   - Enrolment after an interactive sign-in: ask macOS for an administrator
     (Authorization Services, the system prompt), record the approval where
     only an administrator can write (Windows uses `HKLM\SOFTWARE\Josi\Nodes`:
     server, user id, key fingerprint), then enrol with `{elevated: true}`.
     Declined: nothing is enrolled, "Approve This Mac" stays. Session older
     than ten minutes: fall back to the password form.
   - Windows reference: `NodeApproval.cs`, `PcAuthority.Approve`,
     `AppModel.ApproveThisPc`, `AppModel.CanControlPc`.
2. **Reach.** The address field takes a bare host or a LAN address
   (`192.168.1.20:8443` means `https://`). Plain HTTP stays loopback only. A
   self-signed LAN server is trusted by pinning after one confirmation.
   Reference: `JosiApi` constructor, `AppModel.Open`.
3. **Stay running.** Two settings on the Mac, both on by default: keep Josi
   in the menu bar when the window closes; open at login (`SMAppService`),
   menu bar only. Reconnect to the last server at launch, retry every 30 s
   while hidden. Reference: `AppPrefs.cs`, `MainWindow.StartHidden`.
4. **Sections follow the person's allow list.** Only Server and Network need
   the server's own machine. Reference: `Flags.cs`.
5. **The November 9 list**, where the Mac app differs: the account
   connection card (`card.kind = 'account_connection'`, link-free return in
   `cb95e81`), connected accounts start with everything on (wording), Send
   to my devices (`/api/device-transfers`, platform `macos`), "use the
   browser" wording, focus back to the message bar after a reply. Contracts
   are in `docs/LINUX_CATCHUP_HANDOFF.md`.

## Windows-only, skip on Mac

`c22abf0`, `76ec698`, `13352f8` (josi:// handler and old copies), `b662395`
(WPF paste), the Chrome store helper commits.

## Rules that still hold

- Josi never reads, copies, speaks or stores a secret. The Vault is always
  on the server.
- The owner is never gated by member limits, but controls only the owner's
  own PCs.

## Not verified on Windows either

The elevation prompt, the tray-only start and a member enrolling a PC were
built and shipped in 1.2.5-preview.23 but not yet driven live. Elevation is
the client's own check; the server cannot verify it. Pairing through
heyjosi.com is off (relay.heyjosi.com does not answer). There is no People
switch for `pcControlAllowed` yet. If Mac finds a fault in shared code, fix
it in the shared package and tell the Windows session.
