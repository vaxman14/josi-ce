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

## For the next build (noted by Roman, 2026-11-10, beta.11 on gate)

**Installer: the ghost is drawn twice and the second one is broken.** Seen on gate
(Ubuntu 26.04, sudo-rs, ssh from the Mac's Terminal, 99x30) with
`curl … | sudo bash`, after answering the questions. The question screen's header
(ghost + "A few questions, then Josi installs itself.") stays on screen instead of being
cleared, and the progress screen is drawn under it: its ghost has rows out of place (the
face is cut by stray lines, the body is shifted), then the step list and the bar. The steps
and the bar themselves are right, and the install works.

Where to look: `packaging/linux/install-josi-ce-server.sh`, the hand-over from the
questions (`q`, `q_clear`, the `QH`/`QL` line counts, drawn on fd 5) to the progress
drawing on stderr, which moves the cursor up by a counted number of rows. Since
`281f7e3` the questions under sudo-rs are asked on the script's own terminal (the one
sudo-rs made) instead of the outer one, so check whether that terminal's size and the
line count still agree, and that the header is cleared before the progress ghost is
drawn. A 30-row window may also be too short for both. Reproduce by typing through a
real pty on Ubuntu 26.04; the VM runs use `--yes` and never draw the questions.

**Installer: the ghost's animation still looks weird (Roman, beta.13 on gate, 2026-11-10).**
The remarks in the thought bubble are fine. The doubled ghost and leftover questions were
fixed in beta.13 (`efcaba8`), so this is about the animation itself, seen in a real
Terminal window over ssh. Roman said not to redo it now and has not yet said what looks
wrong. Ask him first (a screenshot or a short screen recording). Things to look at when
it is taken up: the float is done by shifting the whole picture down a row at a time
(`make_frames`, offsets 0 1 2 1), which reads as a jump in half-block art; the bubble and
its trail stay still while the ghost moves under them; the eyes blink every 40 ticks;
the whole ghost is redrawn on every frame change, which can flicker over ssh. My check
was a terminal model that only shows the final state of each screen, so it could not see
motion at all.

**A goal that sends an email loses the thread (Roman, gate, 2026-11-10). Shared code, not Linux.**
Roman asked Josi to check whether someone was free for a call and create the meeting if he
confirmed. She made a four-step goal: send the email, wait for and check the reply, draft
the event, get it approved. What happened on gate (beta.14):
1. The email approval expired; Roman had it prepared again and approved it; both emails
   were sent (tasks `confirmed`, action states `succeeded`).
2. The goal never learned that. `work_goals.state` stayed `needs_instruction`, with the
   question "Please approve the resurfaced email action card", unchanged for an hour.
   Step 1 was not ticked, so step 2 never started.
3. The other person replied. Nothing was scheduled to look at the inbox
   (`continuation_ready_at` null), and Josi said nothing. Roman had to be told to tell her.
What it should do, from the person's side: once the email it asked for is sent, the goal
moves on by itself; while it is waiting for a reply it checks the mailbox on a schedule
and tells the person when the reply comes (or that none has, after a while); the question
it shows is never about a card that no longer exists.
Where to look: how an approved action reports back to the goal that asked for it (the
fresh request made by `draft_email` or by `prepareAgain` in actionState.ts is a new task
with no link to the goal's step); `work-goals.reconcile` in the worker; how a goal sets
`continuation_ready_at` when its next step is "wait for a reply"; whether anything reads
mail without being asked. Not investigated beyond gate's status columns. Roman: a real
problem, do not fix now.

**Josi reports a reply and moves on before the person can answer (Roman, gate, 2026-11-10).**
Told to check the reply and continue, she said what the reply was and, in the next
message, showed the calendar card. The stage shows only her newest message, so the news
about the reply was on screen for a moment and then replaced by the card; Roman had no
chance to react to the reply itself. Nothing was created without approval (the card
waits), and the goal did say "create the meeting if he confirms", so this is about pace
and what stays visible, not about permission. Options to put to Roman: keep the reply's
gist on the card ("Roman confirmed: ...") so the reason for the card is on screen with it;
or stop after reporting a reply and ask before preparing the next step. Shared code
(goal continuation and the web stage), not Linux. Not fixed.
Roman's own words for the item above, which is the real point: "there is just no
conversational follow up. She doesn't take it as something that needs to be a convo,
just something that needs to know." So the fix is not a layout tweak. When something
comes back that the person would want to talk about (a reply, a result, a surprise), she
should say it and wait for the person, as in a conversation, instead of filing it as a
fact and running the next step. The plan saying "if he confirms, create the meeting" is
permission to prepare it, not a reason to skip the exchange.

## TO FIX, in order (Roman, 2026-11-10: "add those things to the fix")
These are no longer notes. They are the fix list for the next round, from Roman using
beta.11 to beta.14 on gate as a user. Details for each are in the entries above.
1. **Goals hold a conversation.** When something comes back that the person would want to
   talk about (a reply, a result, a surprise), Josi says it and waits for the person. She
   does not file it as a fact and run the next step. Shared code.
2. **A goal notices its own work.** When the email a goal asked for is approved and sent
   (including a request prepared again after expiry), the goal ticks that step and goes
   on by itself. Its question is never about a card that no longer exists. Shared code.
3. **A goal that waits for a reply watches for it.** It checks the mailbox on a schedule
   and tells the person when the reply arrives, or that none has after a while. Shared code.
4. **Approvals that expire say so.** Today the card vanishes after fifteen minutes and
   Josi's last message still points at it. Decide the time limit with Roman (fifteen
   minutes may be short) and have her say when one has expired. Shared code.
5. **One word for the second button.** Josi says "Approve or Deny"; the web card says
   "Approve" and "Not now". Web and agent.
6. **Typed approval on Windows, Mac and iPhone.** They do not send `reply_to_message_id`,
   so a typed yes is refused there. Their sessions' work; the server side is ready.
7. **The installer ghost's animation.** Still looks weird to Roman in a real terminal; ask
   him what (screenshot or recording) before touching it. Linux.
8. **A typed-answers run in the VM tests.** The e2e runs use `--yes` and missed both the
   lost keystrokes and the screen drift. Linux.
9. **An Admin screen for the sending account** (pick or change it after setup). Shared.
10. **Old versions are never removed.** Every upgrade leaves the previous program under
    `/var/lib/josi/versions/<version>` (1.9 GB each). After a day of betas the Ubuntu test
    VM had eleven of them and its disk filled; the beta.15 install then failed half-way
    with "No space left on device" and only said "apt could not install the Josi package".
    Keep the running version and one to roll back to, remove the rest after a good start,
    and have the installer check free space first and say so in plain words. Linux.
The built-in debugger Roman asked for is planned and its first step built: `docs/JOSI_DEBUGGER_PLAN.md`.
