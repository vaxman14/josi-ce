# Josi fix list

> **Status, 2026-11-09:** all six items are fixed on `linux/josi-server`
> (1.2.8-beta.5): ghost on setup and sign-in, clipboard fallback, five-part test
> progress, the installer asks for the address, a Linux-aware Network page, and
> web flags matching the Windows lean beta. Verified by install on Debian 13 and
> Ubuntu 24.04 VMs; see `docs/LINUX_PC_CONTROL.md` for PC control.

Started 2026-11-08. Branch `linux/josi-server` in `C:\Dev\josi-ce-linux`.

## 1. No ghost on the setup or sign-in pages

The setup wizard and the signed-out pages show the gold "J", not the ghost.

- Setup: `apps/web/src/pages/Setup.tsx:184` draws `<JosiMark variant="bare" size={64}>`.
- Sign-in and other signed-out pages: `apps/web/src/components/auth/AuthStage.tsx:43` draws `<JosiMark … size={160}>`.
- The ghost is only on the main stage. The component is `GhostFigure` in `apps/web/src/components/ghost/Ghost.tsx`, and the clips and still are listed in `apps/web/src/lib/ghost.ts`.
- No other branch has the ghost on these pages either.
- Fix: put `GhostFigure` in place of the J on both pages. For example, `wave-hello` then `idle-wiggle` on setup, and `celebrate` on success.

## 2. Codex CLI sign-in: Copy on the login code does nothing

Clicking Copy next to the device login code copies nothing.

- The copy button is `apps/web/src/components/ui/index.tsx:233` (`navigator.clipboard?.writeText(value)`).
- Likely cause: the browser only provides `navigator.clipboard` on HTTPS or localhost. Gate is opened over plain `http://10.10.1.x:8080`, where `navigator.clipboard` is undefined, so the `?.` skips the copy silently.
- The same problem affects `Setup.tsx:536` (recovery key) and `pages/admin/Backups.tsx:369`.
- Fix: fall back to a hidden textarea with `document.execCommand('copy')`, or select the code so it can be copied by hand. Show an error when copying fails.

## 3. The five-part test shows no progress and looks stuck

After signing in with Codex and clicking "Save and run the five-part test", nothing on the page shows what is happening until the whole test finishes.

- The button is in the setup model step: `LlmStep` in `apps/web/src/pages/Setup.tsx:519`. It uses the shared form in `apps/web/src/components/ProviderForm.tsx`.
- The page sends one request and waits for all five checks. The button is only disabled while it waits.
- Fix: show the five checks as a list, each marked waiting, running, passed or failed, with the time elapsed. Report each result as it finishes, either by streaming from the server or by polling a progress endpoint. The same form is on the admin Model page, so fix it in `ProviderForm`.

## 4. Setup never asks for the public address (domain)

A setup step for the address already exists (`case 'domain'` in `apps/web/src/pages/Setup.tsx:351`, with the domain, HTTPS mode and certificate email). The Linux server skips it without showing it.

- `packaging/linux/Runtime.mjs:56` and `:63` start the server with `JOSI_NATIVE_RUNTIME=1` and `APP_URL=http://localhost:8080`. Those are the desktop app's settings.
- `applyInstallerDeployment` in `apps/api/src/setup/setupRoutes.ts:146` sees that pair and assumes the desktop app is running. It saves `domain='localhost'` and marks the Address step done.
- Result: on a server, Josi believes its address is `localhost`. Links, sign-in callbacks, email links, phone pairing and HTTPS all point at the wrong place.
- Fix: give the Linux server its own runtime flag. On Linux, always show the Address step and ask whether Josi is LAN only (IP over HTTP) or on a public domain (HTTPS, the bundled Caddy or your own proxy). Prefill the server's LAN IP. Then set `APP_URL` from the answer.

## 5. Admin "Network & address" page is wrong on Linux

Seen on gate (10.10.1.5) after setup:

- **Public address shows `http://localhost:8080`, "Only this PC reaches Josi".** This comes from item 4: the Address step was skipped and saved `localhost`. Fixing item 4 fixes it for new installs. Existing installs like gate also need a way to change the address on this page.
- **Red error: "Maintenance controller is unavailable. Rerun the installer once to provision it."** It comes from `apps/api/src/http/maintenanceRoutes.ts:26`, which needs `JOSI_MAINTENANCE_HELPER_SOCKET`, the helper the Windows and Mac installers set up. The Linux service never sets it, and rerunning the installer won't help. Either give Linux its own maintenance helper (josi.service already runs as a system service, and `josi_update.py` exists), or hide this on Linux and send address changes through the Linux updater or helper.
- **The LAN address is shown as `https://10.10.1.5:8080`.** The server answers plain `http` on 8080. `apps/web/src/pages/admin/Network.tsx:78` hardcodes `https://`. Use the real protocol.
- **Wording says "this PC"**, as in "Only this PC reaches Josi", "This PC on the network" and "Tailscale is not installed on this PC" (`Network.tsx:86`). On a server it should say "this server".

## 6. Features removed from the lean beta are still in the Linux (web) build

The Mac and Windows lean betas switched off a set of features: `apps/macos-native/Sources/JosiFlags.swift` on `redesign/mac-lean-beta` and `apps/windows-native/src/Flags.cs` on `redesign/windows-lean-beta`. The web app has no matching switch, so Linux, which is web only, shows all of them. The menu lives in `apps/web/src/components/layout/mobileNavigation.ts:20-64`.

Off in the lean beta but still shown on Linux:

- **Talk, Workflows:** `/app/workflows`, `/admin/workflows`
- **Local Workspace / PC control:** `/app/workspace`, `/admin/workspace`, `/admin/pc-control`, `/admin/automation`. On Windows, Off also stops the executor and browser bridge from starting, so check whether they start on the Linux server.
- **Channels (WhatsApp, Telegram…):** `/app/channels`, `/admin/channels`
- **Apps:** `/app/apps`
- **Voice Box:** `/admin/voice-box`
- **Policy:** `/admin/policy`
- **Integrations / Connectors / custom APIs:** `/admin/integrations`, `/admin/connectors`, `/app/connections`(?)
- **Storage:** `/admin/storage`
- **Family / Parental controls:** `/app/family`, `/admin/parental-controls`
- **Windows "ExtraSections" (off):** files, reminders, memory, Personalization (`/app/personalization`), templates (`/app/email/templates`?), migration, Usage (`/app/usage`), checklist / Getting started (`/admin/launch`), mail settings, improvements, maintenance, audit
- **Relay / heyjosi.com / hosted accounts (off unless RELAY_ENABLED):** `/admin/hey-josi`

Fix: add one web flags file, for example `apps/web/src/lib/flags.ts`, that mirrors `Flags.cs` with the same section names, and filter the menu and routes through it. The server should also skip starting what's off (executor, browser bridge, channels). Hidden sections stay in the source, as on Mac and Windows.

To decide: anything marked (?) above, plus which of Tasks, Approvals, Conversations, Calendar, Contacts, Vault, Devices, People, Backups and System checkup stay.
