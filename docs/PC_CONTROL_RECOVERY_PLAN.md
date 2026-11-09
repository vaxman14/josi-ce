# PC control on Windows: why it works in demos and not in real life, and the plan to fix it

Written November 8, 2026 (evening) by Claude after reading the whole checkout.
For the model that implements it next. Read this first, then
`PC_CONTROL_CURRENT_HANDOFF.md` (what the last agent saw), and skim
`PC_CONTROL_PLAN.md` (the long-term target; do not try to deliver all of it now).

Workspace: `C:\Users\vaxma\Desktop\Windows Josi Native Redesign\Josi Windows PC control`,
branch `redesign/windows-lean-beta`, head `2f8922c`. Installed on this PC:
`1.2.5-preview.3` (from `85000c3`). Do not use the old `C:\Dev` checkouts.

## What the owner said

> this is not just the chat blocker, the pc control worked in demo only, in real
> life it didn't work. focus on the pc control.

"Demo" = the probes and the mock-API fixture on port 8801. "Real life" = the
installed Josi with the Claude Code subscription model (Haiku) in the real chat.
The goal of this plan is one thing: **a real chat, on the installed Josi, that
turns PC control on, runs a command, opens a program and lists a folder.**
Nothing else ships until that works.

## The chain, and where it breaks

A real chat request travels this path. Each link was checked against the code.

| # | Link | Code | Status |
|---|---|---|---|
| 1 | Model gets Josi's system prompt | `packages/llm/src/providers/claudeCli.ts` `renderClaudePrompt` | **Broken.** The system prompt is pasted into the user text on stdin. The CLI keeps its own "coding assistant" identity. Haiku answered as Claude Code: "I'm a text-based assistant working within specific, fixed boundaries". |
| 2 | Model is offered tools at all | `packages/agent/src/assistantAgent.ts` lines 430-537: everything hangs on `capabilities.toolCalling` | **Unknown for the real model.** It comes from the stored probe result (`cap_tool_calling`). If the stored Haiku row says false, no PC tool and no settings tool is offered and the model can only talk. Nothing tells the owner this. |
| 3 | Tools reach the CLI | `claudeVaultPolicy.ts` (`--strict-mcp-config --mcp-config … --allowed-tools mcp__josi`), `harness.ts`, `Runtime.mjs` sets `JOSI_MCP_SERVER` | Plausibly fine (the 1.2.x "tool check" fix was for this path), unverified on preview.3. |
| 4 | `pc_get_permissions` finds a PC | `pcPermissionSettings.ts` `pcPermissionState`: devices come from `pc_control_settings` | **Deadlock.** A `pc_control_settings` row is only created by presence or by opening the PC Control screen. Presence is only sent after `PcAuthority.Ensure` succeeds, and `Ensure` returns false while control is **disabled** (`PcAuthority.cs` line 33). So on a fresh install, chat sees zero devices and says "Open Josi on the target PC first", while Josi is open. Control cannot be turned on from chat. |
| 5 | PC pairs its executor key | `PcAuthority.Ensure` pops `Dialogs.AskPassword("Approve computer control on …")` as soon as control is enabled, from the background loop | **Confusing.** The password sheet appears with no visible cause. The owner's UI showed `popup-result=password:cancelled`: they dismissed it. Without it, presence is never sent and execution tools never appear, with no explanation anywhere. |
| 6 | Prepared change gets approved | `settingsChangeRoutes.ts`, native `Assistant.cs` "Settings changes Josi prepared", web `PcPermissionCards.tsx` | Exists. Not verified in the native chat on the installed build. |
| 7 | Executor runs approved work | `BrowserBridge.cs` `Execute`, `DesktopExecutor.cs`, `PcWork.cs`, `PcTerminals.cs` | Proven by probes and the 8801 fixture; never driven by a real model turn. |
| 8 | Owner can tell what is wrong | nowhere | **Missing.** Every failure above looks the same to the owner: Josi says it can't. |

Links 1, 4, 5 and 8 are certain defects. Link 2 is the most likely second blocker
and must be measured, not guessed. Fixing 1 alone will not make real life work.

## The plan: five work packages, in this order

Do them in order. Each has its own acceptance. Commit after each one with
`git -c user.name="Roman Vaxman" -c user.email="roman@Romans-MacBook-Pro.local" -c core.hooksPath=artifacts/windows-native/no-hooks -c commit.gpgsign=false commit …`.
Push only to `redesign/windows-lean-beta`. No release publication.

### WP1. Readiness report: make the failure visible (do this first)

Add one server function `pcControlReadiness(db, owner, key)` in
`packages/agent/src/pcPermissionSettings.ts` (or a new `pcReadiness.ts` in core)
that returns plain facts, each `{ok, detail}`:

- `model`: configured provider/model name, `toolCalling`, `vision` from the stored probe; detail names the model.
- `toolServer`: `resolveMcpServerPath()` found a file (path shown) or not.
- `pcRegistered`: a `pc_control_settings` row exists for the live or only PC.
- `pcIdentity`: `pc_executor_identity` row exists for that PC.
- `pcPresence`: presence row unexpired (app open and announcing).
- `controlEnabled`, `fullControl`, `commandGrants` (count), `pendingRequests` (count).

Expose it three ways:
1. `GET /admin/pc-control/readiness` (super admin) in `pcControlRoutes.ts`.
2. In `pc_get_permissions` output as `readiness`, so the model can say exactly what is missing ("your model Haiku has no tool calling", "this PC has not approved its executor key").
3. In the native PC Control screen (`PcControl.cs`): a card at the top, "Is Josi able to control this PC?", one line per fact, green or red. The owner reads this instead of guessing.

Also: when `capabilities.toolCalling` is false, `assistantAgent.ts` must add one
sentence to the system prompt: "This model (<name>) cannot call tools, so you
cannot act on the PC or change settings; tell the owner to pick a model with
tool calling under Models." Honest, cheap, and it ends the generic refusal.

Acceptance: unit test for the readiness function (PGlite), route test, app builds,
the card renders on the installed build (owner looks at it).

### WP2. Fix the Claude Code system prompt transport

In `packages/llm/src/providers/claudeCli.ts`:
- Write `request.system` to a private temp file (reuse
  `packages/core/src/privateTemporaryDirectory.ts`; the harness already has a
  private directory and cleanup per turn: put the file next to the MCP config and
  delete it in the same `cleanup()`).
- Pass `--system-prompt-file <path>` (replaces the default; the pinned
  `claude-code-win32-x64` 2.1.258 binary contains the flag; the owner's doc link:
  https://code.claude.com/docs/en/cli-reference#system-prompt-flags).
- `renderClaudePrompt` / `renderClaudeStructuredInput` stop including `request.system`.
- `claudeVaultPolicy.ts`: `claudeSubscriptionArgs(model, mcpConfigPath, structured, systemPromptPath)` adds the flag; `validClaudeSubscriptionArgs` accepts it only as an absolute path with no control characters, and the guardian (`codexVaultGuardian.ts`, shared) must allow that file to be read: check how `mcpConfigPath` is allowed today and mirror it. Do not loosen anything else.
- Tests: `packages/llm/test/claudeVaultPolicy.test.ts` (args validate, old shape without the flag still validates when there is no system prompt), a new test that the runner receives stdin without the system text and the file with it, cleanup removes the file, `claudeImages.test.ts` still passes (structured path).

Acceptance: `npx vitest run packages/llm/test` green, `npx tsc -b` clean. Live:
after install, asking Josi "who are you and what can you do on this PC?" answers as
Josi, not as a coding assistant.

### WP3. Break the registration deadlock and move pairing into the flow

Native (`PcAuthority.cs`, `BrowserBridge.cs`):
- Announce the PC **before** pairing and regardless of `enabled`: add
  `PUT /admin/pc-control/executor/register` (no proof needed; session only) that
  upserts `pc_control_settings` for the PC id, so `pc_get_permissions` lists it
  with `connected:false, paired:false`. Call it once per sign-in from the loop.
- `Ensure` must never pop the password sheet from the background loop. Replace with:
  the loop sets `PcAuthority.NeedsApproval = true` and raises `Changed`; the PC
  Control screen and the ghost strip show "Approve this PC" with a button that
  opens the existing sheet. Chat: when `pc_control_enabled` is approved from a
  prepared card and the PC has no identity, the server's response to the native
  card approval says `needsPcApproval: true`, and the native app opens the sheet
  right then, in context, with the same wording. One click, one password, done.
- Presence stays gated on identity (security unchanged); only registration moves earlier.

Server (`pcControlRoutes.ts`, `pcPermissionSettings.ts`):
- Register route as above; `pcPermissionState` returns `paired` per device.
- `preparePcPermissionChange('pc_control_enabled')` works when the device is
  registered but not paired; its summary says "Josi on <pc> will then ask you to
  approve this PC once."

Tests: `apps/api/test/pcControlChat.test.ts` gains "a registered, unpaired PC can
have control enabled from chat"; `pcControlRoutes.test.ts` covers the register route.

Acceptance: fresh account state (delete the `pc_control_*` rows for the owner on a
dev database or use a new super admin): open Josi, say in chat "turn on PC control
for this computer", approve the card, approve the PC when asked. `pc_get_permissions`
then shows `connected:true`.

### WP4. Capability truth for the Claude subscription model

- Check how the probe is run for `anthropic_subscription` (`apps/api/src/http/llmRoutes.ts` around line 579 and `packages/llm/src/probe.ts`). If the probe ran before the harness/MCP path existed on Windows, the stored `cap_tool_calling` may be stale and false. Add "Check again" in the Models screen if it is missing, and make the readiness card (WP1) say "probe is older than this installation" when `probed_at` predates the build.
- If Haiku through the CLI genuinely fails the tool probe, say so in the readiness card and in chat; recommend Sonnet in Models. Do not fake it.
- Keep `--tools ""` and `--allowed-tools mcp__josi`; that is correct.

Acceptance: the readiness card shows `model: tool calling yes` for the model the
owner uses, or a clear instruction which model to pick.

### WP5. Build, install, live acceptance

- Build `1.2.5-preview.4` with the existing command (new version, the builder
  refuses existing folders):
  `node scripts/windows/run-background.mjs powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/windows/Build-Release.ps1 -Version 1.2.5-preview.4 -Sign -SkipProvision`
- The owner installs (Update) and runs the acceptance below while the agent reads
  the readiness card and the activity log with them. Record exact results in
  `WINDOWS_PC_CONTROL_ACCEPTANCE.md`.

Live acceptance (the only definition of done):
1. "who are you and what can you do on this PC?" → answers as Josi, lists PC abilities or the exact missing step.
2. "turn on PC control for this PC" → card → approve → PC approval sheet → `connected:true`.
3. "allow PowerShell under C:\Users\vaxma without asking" → card with password → saved.
4. "run git status in C:\Users\vaxma\Desktop\Windows Josi Native Redesign\Josi Windows PC control" → real output in chat, ghost strip showed "Running a command".
5. "open Notepad" → Notepad opens; "what's in my Downloads folder" → listing.
6. Take over by moving the mouse during a window action → Josi waits; Stop → work ends.

## Rules that still apply

- Owner's rules: no secrets typed or stored; no publishing; no service or admin
  changes on this PC without asking; ask before installing. Plain words.
- Do not reopen the Chrome extension, Mac, Linux or isolation work; those are
  separate tracks in `PC_CONTROL_CURRENT_HANDOFF.md` and `PC_CONTROL_PLAN.md`.
- Tests to run after each WP (from the workspace, with TEMP under
  `artifacts/windows-native/test-tmp` as the status doc shows):
  `npx.cmd vitest run packages/core/test/pcControl.test.ts packages/agent/test/pcDesktopTools.test.ts apps/api/test/pcControlRoutes.test.ts apps/api/test/pcControlChat.test.ts apps/api/test/settingsChanges.test.ts packages/llm/test -t '^(?!.*renders the actual browser page)'`,
  `npx.cmd tsc -b`, `npx.cmd tsc --noEmit -p apps/web/tsconfig.json`,
  `dotnet build apps/windows-native/Josi.Windows.csproj -c Release`,
  `dotnet run -c Release --project apps/windows-native/test/pcwork-probe`.
- Files are CRLF in this checkout; a CR count equal to the line count is normal.
- Known pre-existing failures: the Playwright "renders the actual browser page"
  test; native warnings Family.cs CS0183 and Voice.cs CS4014.

## Why not more

The long plan (restricted execution, isolation, phone pairing, overlay polish) is
real, but none of it matters until one owner request goes end to end on the
installed build. WP1 through WP5 are the shortest path to that, and WP1 makes
every later failure explainable in one glance instead of another guessing round.
