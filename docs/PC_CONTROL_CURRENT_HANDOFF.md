# Current handoff — November 8, 2026 (America/Los_Angeles)

## Stop instruction

The owner's latest instruction is: **“dont do anything. commit everything you know to the repo and then stop.”** This checkpoint records existing findings only. Do not continue implementation, testing, desktop control or building until the owner resumes the work. Earlier permission to test/take over does not override this stop.

## Workspace and owner requirements

- Use only `C:\Users\vaxma\Desktop\Windows Josi Native Redesign\Josi Windows PC control` for development, dependencies, fixtures and build output. Do not return to the old `C:\Dev` checkout.
- Repository: `https://github.com/vaxman14/josi-ce.git`; branch: `redesign/windows-lean-beta`.
- Commit as `Roman Vaxman <roman@Romans-MacBook-Pro.local>` using per-command Git configuration, never global configuration. Recent commits used `-c core.hooksPath=artifacts/windows-native/no-hooks -c commit.gpgsign=false`.
- No owner passwords, tokens or secrets may be typed, copied or stored by the agent. No release publication without explicit instruction. No unapproved service/admin changes.
- The requested product is full computer control: terminals/PowerShell, applications, files, browser and desktop, with a visible ghost control bar and blue screen-control indicator.
- Permissions must be adjustable through Josi chat: selected apps or all apps, selected operations or broad access, terminal access separately from elevation; once, task, timed or saved duration. OS authentication prompts are acceptable. Remote phone control needs secure device approval.
- Plan Windows, Mac and Linux in sequence, but do not make the Mac session wait for Windows acceptance. The owner will build Mac on the Mac.
- Keep testing focused. The owner previously prohibited testing/takeover, then explicitly authorized it for preview.3. That work is complete; the latest stop instruction now controls.

## Latest delivered Windows build

Signed preview `1.2.5-preview.3` was built from clean source commit `85000c3298c02505acf74bc3a659d2f465c08c2c`. Documentation commit `40d212eb1050178f9948f519adff912be3ea3c60` was pushed afterward. Both were on the remote branch before this handoff.

Local files under `artifacts/windows-native/releases/1.2.5-preview.3/`:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Josi-CE-1.2.5-preview.3-Windows-x64.exe` | 1019146128 | `925c12589a4b3a9ce9937c9bd0a83f83072b30535ddffeba2611bab29af60fba` |
| `Josi-Client-1.2.5-preview.3-Windows-x64.exe` | 80385688 | `063d2ee93472830a41180dfbfa10f49855cf96a90cf073b4d6bc2dbdf68843c9` |

Both had valid timestamped SoCal Receptionist Authenticode signatures and matched `SHA256SUMS.txt`. `BUILD-RECEIPT.json` records verification and limits. The installers are local ignored artifacts, not Git-tracked files and not published GitHub releases. Earlier installer versions were preserved.

Build command:

```powershell
node scripts/windows/run-background.mjs powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/windows/Build-Release.ps1 -Version 1.2.5-preview.3 -Sign -SkipProvision
```

Do not rerun this version: the builder deliberately refuses existing release folders. A later fixed installer needs a new version. The runner hides console windows, uses workspace temporary/cache folders, and supplies the correct OS PowerShell module path. Build log: `artifacts/windows-native/evidence/build-1.2.5-preview.3.log`.

The agent did not install it. The owner subsequently tested it: a read-only process inspection confirmed the running native app at `C:\Program Files\Josi CE Server\versions\1.2.5-preview.3\Josi.exe`, started at approximately 16:45 on November 8. Josi services were running. **The installed backend's exact loaded revision was not independently established.** Do not assume the app path proves every service is updated.

## Completed acceptance and its gap

See [WINDOWS_PC_CONTROL_ACCEPTANCE.md](WINDOWS_PC_CONTROL_ACCEPTANCE.md) for exact commands/evidence. In brief:

- Windows policy/tools/API/settings suites: 71 passed, one documented pre-existing browser-page case skipped.
- Imported shared Mac policy/API/tool suites: 37 passed, one macOS-only Swift case skipped on Windows.
- Native command/file/program probe passed.
- Persistent ConPTY PowerShell probe passed after fixing inherited redirected standard handles. Variable state survives separate inputs; the owned terminal closes correctly.
- Native executor/overlay probe passed: persistent human takeover, Pause/Stop cancellation, revoked-lease cancellation, unreachable-server refusal and protected Josi controls.
- Actual native ghost-bar buttons were checked against a synthetic mock API on port 8801. Pause, Resume, Take over, Stop and Permissions worked. A misleading Stop/idle label was fixed and visually rechecked.
- Root TypeScript, native Release, packaged web typecheck/build, launcher, setup bridge and installer-kit checks passed. Existing native warnings: Family.cs CS0183 and Voice.cs CS4014.
- The isolated fixture app/server were closed and its synthetic Credential Manager entry removed. Files remain under `artifacts/windows-native/preview3-ui/`; do not confuse that fixture with the installed app.

**The real model-to-native chat path was not accepted before delivery. The owner then demonstrated a failure in that path. Passing probes do not establish that the chat feature works.** Production UAC, physical-phone approval, mixed DPI and installer upgrade acceptance were also not performed by the agent.

## Blocking owner-reported chat failure

While testing preview.3, the owner supplied `Screenshot 2026-11-08 164711.png` and said “what the fuck?” Their description of the triggering message was: **“i asked it to change setting to control this pc”.**

Josi replied:

> I can't do that — I don't have system control or the ability to change my own permissions. I'm a text-based assistant working within specific, fixed boundaries.

A read-only accessibility snapshot of the installed Josi window showed model label **haiku**, Local server, signed-in workspace/chat, `pc=off`, and `popup-result=password:cancelled`. The full reply continued by describing itself as a software-engineering assistant able to run terminal commands/read work-folder files. The cancellation status might be old; it does not prove the cause or that the owner intentionally rejected PC pairing. No UI input or chat message was sent during this investigation.

Expected behavior: use the available Josi settings and PC discovery tools to prepare a permission proposal/card; report a specific missing connection, device registration or authentication step if necessary. Control being off should not cause a generic claim that settings cannot be changed.

### Confirmed source defect; causal hypothesis still to verify

`packages/llm/src/providers/claudeCli.ts` places `request.system` at the start of `renderClaudePrompt()` and sends that combined text on stdin as a user message. The structured image path uses the same flattened text. `claudeSubscriptionArgs()` in `claudeVaultPolicy.ts` does not supply a system-prompt replacement. Thus Josi's system instructions are ordinary user content to the CLI while Claude Code keeps its default coding-assistant system instructions. This is a concrete transport defect and is consistent with the observed reply, but a live corrected run has not proved it is the only cause.

Anthropic documents `--system-prompt-file` as replacing the default prompt and distinguishes replacement for a different product identity from appending coding guidance: [official CLI reference](https://code.claude.com/docs/en/cli-reference#system-prompt-flags).

No fix has been made. Proposed implementation considerations for when work resumes:

1. Carry Josi's trusted system instructions through the actual system-prompt interface for both text and image turns. Keep conversation text on stdin. Avoid placing private prompt content in process arguments or logs.
2. Use the existing private temporary storage/cleanup machinery or supervised private-file projection. Do not relax CLI tool/credential restrictions to solve a prompt problem.
3. Update the strict argument validator and guardian together. The Claude consumer currently forbids `privateFiles`; that path cannot be reused silently.
4. Add a focused regression proving system/user separation, private-file cleanup, preserved images and preserved MCP tools. Verify the real installed model can discover the PC and prepare the settings card before calling the feature fixed.
5. Check actual provider capability flags, MCP startup and the loaded service revision. A failed capabilities probe or missing PC registration could be a second blocker.

Relevant implementation points:

- `packages/llm/src/providers/claudeCli.ts`: `renderClaudePrompt`, `renderClaudeStructuredInput`, `claudeCliProvider.chat`.
- `packages/llm/src/providers/claudeVaultPolicy.ts`: pinned strict CLI argument builder/validator.
- `packages/llm/src/providers/codexVaultRuntime.ts` and `codexVaultGuardian.ts`: shared guardian also handles Claude; validates args, isolated work directory, credential projection and cleanup. There are no separate `claudeVaultGuardian.ts`/`claudeVaultRuntime.ts` files.
- `packages/llm/src/harness.ts`: private MCP context/config, offered tool names, trusted user/turn context and executed-call receipts.
- `packages/core/src/privateTemporaryDirectory.ts`: Windows private DACL / POSIX private directory creation.
- Existing focused tests: `packages/llm/test/claudeVaultPolicy.test.ts`, `claudeImages.test.ts`, `harness.test.ts`, `subscription.test.ts`.
- Pinned packaged Claude Code is `2.1.258`. A help-only attempt against `@anthropic-ai/claude-code/bin/claude.exe` failed with exact error **`Error: spawn UNKNOWN`**. This is not evidence that the prompt flag is unsupported. The release builder actually uses `@anthropic-ai/claude-code-win32-x64/claude.exe`. The help log is `artifacts/windows-native/evidence/claude-cli-help.txt`. No model request/authentication was performed by this attempt.

### PC tool routing already present

`packages/agent/src/assistantAgent.ts` assembles PC tools only when the stored model capability `toolCalling` is true. It appends `PC_DESKTOP_PROMPT` when PC tools are available and `SETTINGS_CHANGE_PROMPT` when tool calling is enabled. Settings-change tools are included in `TASK_TOOLS` through `packages/agent/src/tools.ts`.

`pcDesktopToolAvailability()` in `pcDesktopTools.ts` offers `pc_get_permissions` to a super administrator even when control is off or no live PC is found, provided a master key is available and its DB reads succeed. It currently catches errors by returning no tools. This could hide a database/schema problem and needs diagnosis rather than assumption.

`settingsChangeTools.ts` already tells the model to call `list_josi_settings`, then `propose_josi_setting_change`; PC permission changes additionally require `pc_get_permissions` and the selected PC ID. `pc_control_enabled`, broad presets, exact scopes and once approval are implemented. It is not necessary to give Claude unrestricted built-in terminal tools to expose these.

`BrowserBridge.cs` drives the native executor loop: binds the signed-in owner, calls `PcAuthority.Ensure`, announces presence, claims requests, renews leases and reports results. `JosiApi.cs` automatically signs executor routes through `PcAuthority.Proof`; plain-looking `api.Request` calls in the bridge are not proof of missing signatures. Pairing/authentication must succeed before presence is sent.

## Chrome extension investigation (unfinished)

Before the chat failure, the owner asked to check the existing Chrome extension in the repos and upgrade it. That investigation was set aside for the chat blocker. No extension files were edited, built, installed or tested.

Found the active implementation in this checkout:

- `apps/browser-extension/src/background.js`, `native-channel.js`, `page-agent.js`, `popup.js`, `popup.html`, `popup.css`, and icons.
- `apps/browser-extension/development-identity.json`.
- `scripts/unified/build-browser-extensions.mjs`: version **0.8.0**, generated Manifest V3, unpacked Chrome/Brave/Edge/Firefox/Safari resources and Chrome/Edge/Firefox store ZIPs.
- Windows bridge: `apps/windows-native/src/BrowserHost.cs` and `BrowserBridge.cs`; Mac has separate native adapters.
- `docs/BROWSER_EXTENSION_STORES.md` is the existing store/distribution guide. Some details need updating. `docs/unified/P7_BROWSER_CONTROL.md` contains older VM architecture history; do not treat it as the current Windows design.
- `scripts/unified/p0/browser-extension/` is an older disposable proof, not the production extension.

Repository checks: refreshed `origin` refs and inspected extension history. The newest extension-specific commit found was `8f6980a` (October 24: store packages), preceded by `ece49fa` (reattach after Josi restart). The extension/build-script paths had no difference between this Windows branch and `origin/feature/macos-computer-control-20261108` at inspection. `origin/main` does not contain these extension paths. GitHub inspection also found the active related `josi-app` mobile repo and `josi-ce-internal`; their main root/app listings did not expose a newer browser extension. This was not an exhaustive search of every file/branch in every repo.

Existing behavior: one explicitly attached tab, per-site optional host access, native host authorization per command, bounded observations, navigation, click, text fill, draft, scroll and image capture. It refuses stale observations and reports uncertain outcomes instead of replaying commands. The popup asks for site access directly from the click handler. Built-in browser/page restrictions still apply.

Concrete upgrade candidates found in source:

1. **Reconnect state survives worker suspension.** `reattach` is only a global variable. An alarm can wake a fresh MV3 worker with no remembered plan. A native port keeps an active worker alive, but after host loss that is no longer enough. [Chrome lifecycle documentation](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle/) confirms global-state loss and native-port behavior.
2. **Stop cancels pending reconnect.** The popup's Stop path calls `stop()` without `cancelReattach()`. A remembered reattach plan needs explicit cancellation and safe restoration rules. Distinguish reconnecting transport from regaining permission or replaying an action.
3. **Store IDs need consistent native registration.** `BrowserHost.ChromiumExtensionIds` is a list, but `Origin`, `IsLaunch()` and the registered `allowed_origins` currently use the single development `ExtensionId`. Adding another ID to the list alone does not wire the native host fully. [Chrome native messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) describes exact allowed origins.
4. **Richer browser operations.** The page agent observes only the top document (`frameId: 0`), reports `framesUnsupported`, and does not traverse shadow roots. Fill is limited to selected input types/textareas. Select controls, contenteditable, frame-aware targets, uploads/downloads and multi-tab work need deliberate capability and permission design.
5. **Chat-managed granularity and shared controls.** Align browser/profile/site/tab scopes, once/task/timed/saved duration and revocation with the new PC-control plan. Check how browser work appears in the ghost bar and how local Stop/Pause/takeover affects it. Do not claim this integration is verified.
6. **Connection diagnostics and distribution.** The popup collapses many failures into “No current Josi connection.” Provide actionable host-not-found, pairing, wrong-version, permission and unsupported-page states. Reconcile store IDs/versioning/privacy copy and build integration before any submission.

The extension can remain a focused browser-control adapter; the Josi chat/native permission system should own authority. Native messaging uses `com.heyjosi.browser`; Chromium development ID is `peopadjeldgefmbfllgjgdndhabbagpl`, Firefox ID `josi-browser@heyjosi.com`. These are public application identifiers, not secrets.

Skills consulted: Chrome Extensions and Computer Use. Modern Web Guidance's skill instructions were read, but no guide search or frontend implementation occurred in this investigation. Before later frontend changes, perform its required focused search. No subagents were used.

## Final state at stop

No implementation changes were made after preview.3. The working tree was clean before writing this handoff. Only documentation changes belong to this checkpoint. No build/test/model request is intentionally running for this investigation. The UI was read through the existing Computer Use connection without sending input. Do not close the owner's installed Josi or change its permissions as cleanup.

The immediate unresolved problem is the owner's real chat failing to prepare PC-control settings. The Chrome extension upgrade remains a separate requested follow-up. Preserve both tasks when the owner resumes; do not report either as completed.
