# PC control: live acceptance on the installed Josi (November 8, 2026, evening)

The first time the real chain ran end to end on this PC: the installed Josi
(services plus app), the owner's Claude Code subscription model (Haiku), the
assistant's PC tools, PC Control, and the native executor. Driven by Claude
through UI Automation on Josi's own composer and buttons (no keystrokes, no
mouse), with the owner watching and answering the password prompts.

Builds: `1.2.5-preview.4` (from `c36fe5a`) first, then `1.2.5-preview.5`
(from `2613a4d`) for the chat cards, tray and faster updates. Fixes found
during this run are in `e5951c8` and ship in `1.2.5-preview.6`.

## What happened, in order

| Step | Result |
|---|---|
| Install preview.4 (Update) | Installed; all six services running; Josi opened from the new version. |
| Readiness | Chat said the model "doesn't have the ability to control your PC": the honest no-tool-calling sentence. The stored probe for Haiku said no tools. Owner ran **Check Again** under Models; it passed. |
| "open notepad" (preview.4) | Josi found Notepad and filed the request; it waited for approval under PC Control (expected on that build). The approved launch did not open Notepad: Store apps under `Program Files\WindowsApps` refuse a direct start. Fixed in preview.5 (execution alias). |
| Install preview.5 (Update) | Installed; `installed-components.json` written for the fast update path. |
| "open notepad" (preview.5) | A card appeared under Josi's reply: "Look for an installed program named like notepad" with Allow once / Allow everyday things / Deny. Claude clicked **Allow once**. |
| Owner approved the "let Josi use this PC" card (password) | Control on, everyday allowances on. Side effect: the request waiting at that moment was cancelled, so the tool said "stopped" once and Haiku repeated that line on the next ask. Fixed in `e5951c8`: a widening change re-approves the requests it covers. |
| "open notepad" again | **Notepad opened.** Josi: "Notepad is now open for you." Process start 18:13:11. No card, no question. |
| "what files are in my Downloads folder?" | Listed, no question (folder read is an everyday allowance). |
| PowerShell `git status` in the project folder | First ask: Haiku repeated the stale "off" line. The owner approved the command card with **Always allow this shell here** (password). Second ask: real output, branch `redesign/windows-lean-beta`, clean tree. `pc_get_permissions` afterwards: enabled, fullControl, one `command.run` grant for PowerShell in that folder, readiness **Ready**. |
| Close the window (X) | Window hid; process stayed alive (tray). |
| Launch Josi again while hidden | Window came back as an unpainted black frame (Win32 show without WPF). Fixed in `e5951c8`; the app was restarted to recover. |

## What this proves

- The chain works on the installed product: model → tools → PC Control →
  native executor → result in chat, for programs, files and commands.
- One ask turns control on with the everyday allowances; approvals are cards
  in the chat; commands ask once per shell and folder.
- The X keeps Josi running in the tray; the services were never touched.

## preview.6 (from `e5951c8`), same evening

| Step | Result |
|---|---|
| Install (Update) | 366 s wall clock including the wait for the owner's clicks; staging ended 18:36:16, commit phase 18:36:16 to 18:37:42 (86 s). Reuse did **not** run: a Windows PowerShell quirk made the component record parse as one object. Fixed in `bd03715`, measured by running the reuse step against the installed files (Node 6 files in 96 ms, ffmpeg in 69 ms). |
| After install | The old preview.5 process (hidden in the tray) answered the installer's "open Josi" and showed an unpainted frame; preview.6 never started. Recovered by hand. Fixed twice: the window repaints on an outside show (`e5951c8`), and a newer copy now asks the older one to quit (`fb7365c`, effective from the next update). |
| "open notepad" | Opened, no question. |
| "list the five newest files in Downloads" | Listed (the second ask returned the names on one line). |
| `git log --oneline -1` through PowerShell | Real output, the latest commit line. |
| Bar at rest | None. `pc=off` in the status line while idle. |
| Dev build from the repo against the installed server | Works like the installed app (opened Notepad). App-side fixes are tested this way from now on; only server changes need an installer run. |

## Still to verify on preview.7 (`bd03715`: reuse fix, phase timing log)

- The fast update itself: `Program Files\Josi CE Server\installer\setup-timing-1.2.5-preview.7.log`
  should show "Keeping Python/Node.js/the database… from version 1.2.5-preview.6" and
  the timestamps say which phase is still slow.
- A pending request that a widening card covers runs instead of being cancelled.
- Haiku's wording after a wait for approval.
- The takeover (`fb7365c`) is in the build after preview.7.

## preview.7 and preview.8, same evening

| Step | Result |
|---|---|
| preview.7 (silent install) | 2 min 44 s from first step to Done (18:54:28 to 18:57:12). Phases: unpack 50 s, file check 23 s, copy 30 s, database and services 80 s. Still "Unpacking" for every component: the record read had a PowerShell array quirk (`bd03715` fixed the read). |
| preview.8 (silent install) | Same shape, 2 min 46 s. Still unpacking: the record's paths had lost their backslashes (`ab216d8`), and the archives are zipped afresh per release so archive hashes never match (`8290eac` compares file inventories instead; measured: 7 of 8 components identical between releases, Python decided in 262 ms). |
| Takeover | preview.8 replaced the hidden dev build on launch (one process). |
| Chat after preview.8 | Plain chat worked; every PC request failed after minutes with a provider error. Cause: the old app saved "paused" as it quit; the new app loaded it; approved work was never claimed; the model timed out. Fixed in `554e654` (no pause saved on exit; a paused app sends no presence so tools fail fast with the reason; readiness card shows Paused with Resume). Verified: card said "Paused on this PC / Not ready: pcPresence", Resume made it Ready, then Notepad, Downloads and `git log` ran from chat. |
| Model capability check | Passed in about 40 s (chat, tools, images, structured answers) while chat PC work was failing, which separated the model path from the executor path. |

## preview.9 to preview.11, late evening

| Build | Result |
|---|---|
| preview.9 (`ab216d8`) | Built, not installed (superseded). |
| preview.10 (`0f8cfd4`) | First update to keep all seven unchanged components ("Keeping Python from version 1.2.5-preview.8"...). Then the file check refused them: hard links have two links and the check requires one (`NativeFileAttributes.cs`, `Links == 1`). The installer stopped before changing anything; preview.8 kept running. |
| preview.11 (`e2a4590`) | Reuse now copies instead of linking. Installed cleanly in 2 min 47 s, but every "Keeping" fell back to "Unpacking": the failed preview.10 run had left hard links to preview.8's files in the installer cache, so those files failed the single-link check as reuse sources. Preview.11's own files have one link each, so the next update is the first that can prove the saving. The cache's old staging folders are now removed at the start of a run (committed after preview.11). After install: the new app took over from the dev build on its own, and "open notepad" opened Notepad on the first ask, no pause, no card. |

Expected on the next update (from preview.11): unpack about 15 s instead of 50, file check a few seconds instead of 23, copy unchanged (30 s), database and services unchanged (80 s): roughly 2 minutes, of which the services are most. The setup-timing log in `Program Files\Josi CE Server\installer` tells.

## After preview.11 (dev build against the installed server)

| Change | Verified |
|---|---|
| A takeover ends only the running action; no bar afterwards, nothing saved (`10c80f2`) | Bar sampled every second through a two-step request: visible during the steps, gone within a second of the reply. |
| Bar holds six seconds between steps (`9b34e03`) | Same sample: no flicker between "open Notepad" and the folder step. |
| Model picker in the chat bar (`9b34e03`) | Picked Sonnet from the picker; the server saved it and ran its check; the owner confirmed "it's on sonnet". |
| Instant switching (`llm_probe_memory`, `9b34e03`) | Server side only; takes effect after the next install. Model-route tests: 51 pass. |

## preview.12 (`5bd9e03`): the fast update, proven

| Phase | preview.7 (all unpacked) | preview.12 (7 of 8 kept) |
|---|---:|---:|
| Unpack / keep | 50 s | 38 s (Josi payload unpacked 14 s; Python copied 15 s) |
| File check | 23 s | 10 s |
| Copy into Program Files | 30 s | 25 s |
| Database, services, health | 80 s | 77 s |
| **Total, first step to Done** | **2 min 44 s** | **2 min 14 s** |

Every component other than the Josi payload logged "Keeping … from version
1.2.5-preview.11" with no fallback. The remaining time is the service restart
and database step; making that faster is a different job (fewer restarts, or
a hot swap of the web and worker processes).

After install: preview.12 took over from the previous app on its own, and the
chat picker, instant model switching (once each model is checked once on this
server), approvals as cards, tray, and the quiet bar are all in the installed
build.

## Owner feedback carried forward

- Fewer steps, always: the setup step now pairs and enables in one go; the
  chat card does the same for existing installs.
- Haiku is weak at following tool results in a long thread; the owner moved
  to Sonnet from the new picker. The readiness card names the model in use.
- The bar must never sit on screen while nothing happens; paused, stopped and
  taken-over states live in PC Control and the tray, not across the window.
- Switching models must not make the owner wait for a check they already paid for.

## Josi is the interface: live run on preview.13 to preview.15 (November 8, 2026, evening)

Driven through UI Automation on the installed build, with the owner at the keyboard for the parts that need a real paste.

| Step | Result |
|---|---|
| A: "What is the redirect URI for Google, and which model are you on?" | Both exact Google callback URIs for `https://cewin.heyjosi.com` and "Claude Sonnet, primary" in one reply, from `josi_setup_status`. |
| B: "Set up GitHub, I have a token" (preview.13) | Josi said the card was open; it took up to 30 s to appear (the app polled every 30 s) and had no input (the card travelled under the wrong key). Fixed in `651538d` (card shows with the reply; visible boxes) and `3abccab` (fields reach the app; Paste and Show/Hide). |
| B again (preview.14) | Card open with the reply; paste and Save worked; the route answered "not permitted for this account": a second member-ceiling check inside the credential store. Fixed in `1a35704`. |
| B again (preview.15) | Pasted, saved; the chat got "Saved: GitHub is connected." Then "list my three most recently updated repositories" answered from GitHub through the saved token. |
| Leftover cards | Every "open it again" had left its earlier card waiting, and each popped up after the save. `e43a907` retires stale cards for the same route when a new one opens or one is saved; not yet installed at the time of this run. |
| G: "I just bought a 2026 Ford Explorer, blue" | "Saved to your World", with the VIN offered as a protected card. "Give you the plate" opened the License plate card (Paste, Show). The My World page shows the vehicle with its three secret fields to set, Remove, and one "Josi knows" line with Forget. |
| D (member request) | Not driven: needs a second account. |
| H (extension) | Not built. |

## Step H, the browser extension: live run on preview.17 and preview.18 (November 9, 2026, night)

Driven through UI Automation on the installed build (Sonnet), with extension
0.9.0 loaded unpacked from `C:\Dev\josi-dev\browser-extension\chrome`. The
owner reloaded the extension and accepted the install prompts.

| Check | Result |
|---|---|
| Link without a tab (preview.17) | "Which tabs do I have open?" got "13 tabs" from `browser_list_tabs`, with no tab attached. |
| "Use this tab" from chat | With Chrome's front tab on `chrome://extensions`, Josi said plainly that it was not a website. "Attach the Mercari tab" then went through PC Control and came back `site_permission_required`; the owner clicked the icon once. The owner found that click too much, so `4ff7e36` asks for site access once at install (PC Control still decides each site). |
| Read | First turn: the model claimed it had no read tool (a one-off slip). Asked again, it read the "In progress" listings. |
| Photo | Described the real thumbnail (SOLD banner, the graphics card). |
| Open a page (preview.17) | The tab navigated, but the tool reported failure: Chrome still shows the old address until the navigation commits. Fixed in `4ff7e36` (`loadedTab` waits through `pendingUrl`). |
| Open with no tab attached (preview.18) | "Open the Mercari in-progress page" opened a new tab, attached it and read it. |
| Select | `the-internet.herokuapp.com/dropdown`: Option 2 selected, confirmed on re-read. (I opened this practice site in the owner's tab without asking first; the owner objected. Tests use a new tab or a page I name first from now on.) |
| Download | `Images.txt` landed in Downloads, but the narrated-search guard flagged the file name as invented and the model retracted a true answer. Fixed in `87d5aa7`: a successful browser, PC or desktop tool counts as evidence. |
| Pause mid-task | The bar showed Josi working; Pause stopped it before the next photo. The model then said "click the extension to relink" (no presence while paused). Fixed in `87d5aa7`: the tool says Josi is paused and to press Resume. Resume from PC Control kept the tab attached. |
| Stop mid-task | Stop on the floating bar ended the task and turned PC control off; the model said so and did not retry. Turning control back on needs the owner (the toggle did not stick from automation). |
| Josi restart with the tab attached | A second launch only focused the running copy. After ending the process and starting Josi fresh, the Mercari tab re-attached by itself with no click. |
| Garage-sale task | Not run yet: waiting for the owner to turn PC control back on. |

Not installed yet: the two fixes in `87d5aa7` (the evidence guard and the
paused message). They go into the next installer.
