# PC control recovery: what was built (November 8, 2026, evening)

Companion to [PC_CONTROL_RECOVERY_PLAN.md](PC_CONTROL_RECOVERY_PLAN.md). The
owner lifted the stop ("go build. all of it.") and asked for PC registration as
a setup step. Everything below is in commit `c36fe5a` on
`redesign/windows-lean-beta`, pushed. Workspace:
`C:\Users\vaxma\Desktop\Windows Josi Native Redesign\Josi Windows PC control`.

## Done

| Plan item | What landed | Where |
|---|---|---|
| Setup step (owner's addition) | New wizard step `pc_control`, "Josi on this PC", after Security, skippable. The Josi app shows the explanation, a "Turn PC control on now" toggle (default on), **Approve This PC and Continue** (creates the executor key, asks the new account's password once, posts key + password) and **Skip for Now**. The server verifies the password, registers the PC, stores the key, and enables control if asked. The browser wizard explains and can only skip. `/setup/state` now returns `ownerId` so the app derives the same key name the running app uses. | `apps/api/src/setup/steps.ts`, `setupRoutes.ts` (`case 'pc_control'`, state), `apps/web/src/pages/Setup.tsx`, `apps/windows-native/src/Screens.cs`, `PcAuthority.PublicPointFor` |
| WP1 readiness | `pcControlReadiness()` returns one fact per link: model tool calling (with probe date), tool server path, PC registered, paired, control on, announcing, grants and pending counts, plus `ready` and a summary. Exposed as `GET /admin/pc-control/readiness`, inside `pc_get_permissions` (`readiness`), and as the first card on the PC Control screen ("Is Josi able to work on this PC?") with **Approve This PC** and, when the server knows another key, **Revoke Old Identity**. | `packages/agent/src/pcPermissionSettings.ts`, `apps/api/src/http/pcControlRoutes.ts`, `apps/windows-native/src/PcControl.cs` |
| WP1 honest prompt | When the stored model failed tool calling, the system prompt says so by name and tells the model what to tell the owner (Check Again or another model under Models). | `packages/agent/src/assistantAgent.ts` |
| WP2 system prompt | Josi's `request.system` is written to a private per-turn file (beside the MCP config, or in its own private folder) and passed with `--system-prompt-file`; stdin carries only the conversation. The strict argument validator accepts the flag only with an absolute path and refuses any other prompt flag. | `packages/llm/src/providers/claudeCli.ts` (`writeSystemPromptFile`), `claudeVaultPolicy.ts` |
| WP3 deadlock | `PUT /admin/pc-control/register` (session only, no proof) upserts the PC's settings row; the app calls it once per sign-in, tolerating an older server. Chat's device list gains `paired`; "turn on PC control" explains the one-time approval when the PC is unpaired. | `packages/core/src/pcControl.ts` (`register`), `pcControlRoutes.ts`, `pcPermissionSettings.ts`, `BrowserBridge.cs` |
| WP3 no surprise sheet | `PcAuthority.Ensure` never prompts; it records `NeedsApproval`/`KeyChanged`. `Approve()` is called from PC Control (and from setup via the key helper). When control is on and the PC is unpaired, the app shows one notification pointing at PC Control. | `apps/windows-native/src/PcAuthority.cs`, `BrowserBridge.cs`, `PcControl.cs` |
| WP4 capability | Covered by readiness (probe date, "not checked yet", "did not pass") and the honest prompt; Models already has **Check Again** (re-probe). | as above |

## Verified

- `npx tsc -b` and web typecheck clean.
- Vitest, from the workspace with TEMP under `artifacts/windows-native/test-tmp`:
  `packages/llm/test`, `packages/core/test/pcControl.test.ts`,
  `packages/agent/test/pcDesktopTools.test.ts`, `packages/agent/test/pcReadiness.test.ts` (new),
  `apps/api/test/pcControlRoutes.test.ts`, `pcControlChat.test.ts`, `settingsChanges.test.ts`,
  `setup.test.ts` (two new pairing cases), `setupVerification.test.ts`:
  **398 passed, 1 skipped** (the known Playwright page test).
- `dotnet build apps/windows-native/Josi.Windows.csproj -c Release`: 0 errors (the two known warnings).
- `pcwork-probe`: ALL PASSED.

## Signed installer

`1.2.5-preview.4`, built from `c36fe5a` with
`node scripts/windows/run-background.mjs powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/windows/Build-Release.ps1 -Version 1.2.5-preview.4 -Sign -SkipProvision`
(run from PowerShell; the runner needs `SystemRoot`, which Git Bash does not pass).
Log: `artifacts/windows-native/evidence/build-1.2.5-preview.4.log`.

| File | Bytes | SHA-256 |
|---|---:|---|
| `Josi-CE-1.2.5-preview.4-Windows-x64.exe` | 1019149896 | `328ce817239704ee5bcab3aad3fda77ed5e0e7f841238caf1a6d77bbde8065e1` |
| `Josi-Client-1.2.5-preview.4-Windows-x64.exe` | 80395152 | `583f8cb48ab8769453d7cfc3d6ad180aa9e0c55ffb5037823b6c1793ed1c95c2` |

Both Authenticode signatures valid, CN=SoCal Receptionist. Under
`artifacts/windows-native/releases/1.2.5-preview.4/`. Not installed, not published.

## Not verified (the live acceptance in the plan, WP5)

Nothing here was driven by a real model turn on the installed Josi. The
six-step live acceptance in `PC_CONTROL_RECOVERY_PLAN.md` is what decides done,
and the readiness card is what to read when a step fails. The owner installs
preview.4 (Update), opens PC Control, reads the card, and follows its red line.

Known soft spots to watch during that run:
- The chat card that turns control on does not itself open the pairing sheet;
  it shows a notification and PC Control has the button. One extra click.
- The honest "no tool calling" sentence depends on the stored probe; a stale
  probe needs **Check Again** under Models.
- The web wizard cannot pair (no key in the browser); only the app can.
