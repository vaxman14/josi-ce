# Linux handoff for the Mac session (November 9 to 10, 2026)

Branch `linux/josi-server` (worktree "Josi Linux"), pushed, head `7413351` or later.
It already contains the Windows lean beta up to `9cb6123` (merged 2026-11-10, one
conflict, in `pcBrowserTools.ts`). Latest build 1.2.8-beta.10.

## What exists now

**The Linux server** (headless, Debian/Ubuntu and every fork; `curl … | sudo bash`,
interactive with the ghost, or `sudo ./install.sh [--yes]` from a folder):
- Everything the Windows edition does, used from the browser. PC control runs as the
  chosen Linux user in `josi-pc.service` (`packaging/linux/pc-executor/`): commands,
  persistent terminals, files, programs, X11 windows/screenshots/clicks, browser
  extension link. Pairing without a window: spool + one chat card (docs/LINUX_PC_CONTROL.md).
- Josi's own browser for headless machines: Xvfb + pinned Chrome for Testing + the
  extension (`josi-browser.service`).
- Web chat sends durable turns and shows live status, like Windows.
- Docker image of the whole server (`packaging/linux/docker`).
- Release folder installs with no download (`install.sh`, `--from`).

**Sign in for Josi** (docs/LIVE_SIGN_IN.md): Josi's tool `request_sign_in` opens a card;
the person signs in on a live view of her hidden browser or in a terminal running the
exact command shown. Her model never sees the screen, keys or output. Owner only by
default, grants by asking Josi (migration 0123). End-to-end tested on Ubuntu 24.04:
real Chrome received a login typed through the view, a terminal login ran, secrets
appear nowhere on the server (`scripts/linux/e2e-signin.mjs`).

**Shared-code changes the Mac inherits** (all in packages, same as Windows):
- `send_file_to_my_devices` (packages/agent/src/sendFileTools.ts): Josi sends a text
  file she writes to one of the person's OWN devices. The Mac app must register as a
  transfer device and accept `state: accepted` files like Windows (device-transfers).
  `linux` is now a valid device platform.
- Light thinking for ordinary chat: `ChatRequest.reasoningEffort`, Codex gets
  `model_reasoning_effort="low"` unless the turn is a work goal; owner setting
  `chat_reasoning` ("light" default or "model_default"), `PUT /settings-changes/reasoning`.
- Tool registry: every offered tool must be in `ALL_TOOLS`; `toolRegistry.test.ts` checks it.
- `dataTools.test.ts` now starts from switched-off accounts (the Windows change made
  connected accounts start on; the tests assumed off).
- Native host accepts the Chrome Web Store extension id on Linux.

## Done in the last 24 hours (condensed)
Merged Windows twice; fixed the old Linux fix list and review bugs; interactive
installer (asks on the person's own terminal under sudo); domain/HTTPS mode; Josi's own
browser (+ AppArmor profile on Ubuntu 23.10+); web parity (flags, My World, stage cards,
device transfers, account-connection card, focus return); durable-turn live status;
Docker image; folder install; gate (10.10.1.5) wiped and reinstalled, `ce.heyjosi.com`
restored through Cloudflare tunnel `josi-ce` to gate; tested on Debian 13 and Ubuntu
24.04 VMs on claw (10.10.1.3).

## In progress
Web sign-in panel: the live picture showed as a broken image in a real browser (frames
and server are fine); switched to inline images in beta.10, being re-tested.

## Next
1. Re-run `e2e-screens.mjs` against beta.10 (panel must show a real picture), then the
   same on the Debian 13 VM (`e2e-fake`, `e2e-pc`, `e2e-signin`).
2. Upgrade gate to the new build (`sudo ~/josi-install-N/install.sh --yes`).
3. Replace the beta.5 GitHub draft with ONE new draft (owner's choice); nothing public
   until the owner presses Publish.
4. Optional later: a Devices menu badge for waiting files; Wayland live view.

## Checked afterwards: nothing is missing, but Linux is behind Windows (2026-11-10)
Both worktrees ("Josi Linux" and "Josi Windows PC control") are clean and identical to
GitHub: nothing uncommitted, nothing unpushed, no stash. Linux head is `c8d1c2d`.
Do not hunt for lost work on the Mac mini or claw; there is none.

What IS true: Windows `redesign/windows-lean-beta` (head `9b7afc7`) has 6 commits the
Linux branch does not have (after `9cb6123`): `1ede1a5` server: a signed-in person
controls their own PCs; `1e86435` Windows client is a node of whoever signs in;
`0e75cc0`, `8082162` Mac handoffs; `c47e9d0` Forget This PC; `9b7afc7` Safari handoff.
Before the Linux branch takes them, know:
- **Migration number clash.** Windows adds `0123_member_pc_control.sql`
  (`users.pc_control_allowed`); Linux already has `0123_live_signin_grants.sql`.
  Renumber one to `0124` before merging, and renumber the same file on gate and any
  database that already ran it (gate ran Linux's 0123).
- **Conflicts to expect** in `pcControlRoutes.ts`, `settingsChangeRoutes.ts`,
  `pcPermissionSettings.ts`, `settingsChangeTools.ts`, `pcDesktopTools.ts`: Windows
  moved PC control from owner-only to "any signed-in person allowed
  `pc_control_allowed`", every row keyed by user and PC. Linux local pairing
  (`pcLocalPairing.ts`, spool tickets) and the sign-in routes assume an owner session
  and must follow that rule; sign-in stays owner or granted.
- Safari extension and Mac handoffs are Windows-side docs: `docs/MAC_CATCHUP_HANDOFF.md`,
  `docs/SAFARI_EXTENSION_HANDOFF_2026-11-10.md`.
- For the Mac: do NOT merge `linux/josi-server` wholesale. Port the "Shared-code changes"
  list above; show Roman any conflict with the Mac look first.

## Owner decisions (2026-11-10)
Linux server is a send-file target (into Downloads); Josi sends files when asked
(text files she writes); one new draft release when this lands; login terminal may run
any command shown on the card; live view owner-only with grants; sign-ins persist until
cleared; light thinking by default; live view opens inside the chat.

## Where things are
Test VMs and builds on claw `roman@10.10.1.3` (`~/josi-linux`); VMs `josi-debian13-vm`
(ssh -p 2223) and `josi-ubuntu2404-vm` (-p 2224) via claw; build with
`DOCKER_CONFIG=~/josi-linux/docker-anon scripts/linux/build-release.sh --version X
--skip-provision`. Claw itself runs the owner's Josi 1.1.6: do not upgrade it unasked.
