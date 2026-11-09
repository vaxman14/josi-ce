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

## Still to verify on preview.6

- The fast update itself (preview.5 → preview.6 should say "Keeping … from
  version 1.2.5-preview.5" for the unchanged components and finish in a
  fraction of the time).
- No "Josi is ready" bar at rest; relaunch from the tray paints the window.
- A pending request that a widening card covers runs instead of being cancelled.
- Haiku's wording after a wait for approval.

## Owner feedback carried forward

- Fewer steps, always: the setup step now pairs and enables in one go; the
  chat card does the same for existing installs.
- Haiku is weak at following tool results in a long thread; Sonnet is the
  better model for PC work. The readiness card names the model in use.
