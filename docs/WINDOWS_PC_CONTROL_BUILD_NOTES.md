# Windows computer control preview.2 — November 8, 2026

**Historical preview.2 record.** The owner subsequently authorized focused tests and desktop control. See [WINDOWS_PC_CONTROL_ACCEPTANCE.md](WINDOWS_PC_CONTROL_ACCEPTANCE.md) for preview.3 fixes, completed checks and the fresh installer. The restrictions and untested labels below describe the earlier build, not the current session.

## Owner instructions

Work only in `C:\Users\vaxma\Desktop\Windows Josi Native Redesign\Josi Windows PC control`.

Build in the background. **No tests, probes, app launches, screenshots, control overlays, screen takeover or installation without explicit owner approval.** Full filesystem access does not authorize desktop takeover. Do not start the generated Josi executable to inspect it. Do not alter installed services or publish a release.

The [approved plan](PC_CONTROL_PLAN.md) still governs Windows, Mac and Linux. Mac work can proceed independently; it does not wait for Windows acceptance.

## Source implemented for this preview

- Persistent PowerShell, PowerShell 7 and Command Prompt sessions using ConPTY. Shell state survives inputs; output has bounded history and cursor-based reads. A manually opened native terminal viewer shows output and can close sessions. Each session has an owner, PC, opening request, policy revision and maximum lifetime.
- Job objects own one-shot and interactive process trees from process creation. Stop, Pause, connection loss, policy changes and expiry cancel owned work. This controls process lifetime, not filesystem or network isolation.
- Separate one-shot administrator helper, started through Windows UAC, bound to the exact request and parent process over a current-user pipe. Ordinary commands refuse an elevated main app. A command grant and administrator grant are both required.
- Chat permission proposals for selected scopes and broad presets: all apps, all terminals, or all supported operations except protected credentials. Task, timed (up to 24 hours) and saved grants are supported; once approval is tied to an immutable waiting action. Administrator allowance is separate. Existing Never/Ask rules remain effective.
- Explicit PC selection for execution tools. Multiple connected computers no longer silently select the most recent one. Work-goal IDs are passed as trusted task context; ordinary chat without a work goal has no such task context.
- Signed Windows executor requests using an approved nonexportable CNG key, timestamp, nonce, method, path and body hash. Initial local key approval uses a protected native password form; revoking its identity stops execution.
- Web/phone chat permission cards showing the server-generated proposal, selected PC and revision. Approval uses an existing account passkey with required user verification, or a protected password form. Challenges bind the exact proposal and owner. Passwords never enter chat.
- Native control bar with the animated ghost and Take over, Pause, Resume, Stop and Permissions. All five buttons remain present. The bar persists between operations and can be shown manually. Blue monitor borders appear during screen control. The existing Ctrl+Alt+Esc shortcut remains.
- Target-window capture with PrintWindow; scrolling and dragging; observations tied to window geometry, process and DPI, consumed by actions and expired after 60 seconds. Password fields and Josi approval/control windows are refused by mediated desktop tools.
- File operations hold parent handles, reject reparse points/hardlinks and Josi authority folders, and verify resolved file handles before writing. Optional expected-file hashes protect against stale writes.
- Durable offline Stop state and cancellation on Windows lock/disconnect. Human takeover leaves background work running; Pause and Stop end owned terminals and current work.

These are implemented source paths, **not runtime-verified behavior**.

## Shared Mac work incorporated

Fetched `origin/feature/macos-computer-control-20261108` at `84616597560445ebdbfe2a123ccaafb0a5b7fc09`. Imported its shared core policy/approval code, protocol, agent tools, API routes, migration 0116, accompanying test sources and Mac handoff documents. The tests were copied, not run.

The Mac native app, automation adapter, packaging and scripts remain on their Mac branch; they were not used to replace this branch's existing Mac files. The Mac session's signed 1.2.4 package is described in [MACOS_COMPUTER_CONTROL_STATUS.md](MACOS_COMPUTER_CONTROL_STATUS.md).

Windows chat semantics are now `pc-control-chat.2`; Mac's separate typed contract remains `computer-control.2` with platform `macos`. Do not pass Unix paths to the Windows normalizer or describe these adapters as a single finished cross-platform backend.

New Windows tables: migration 0117 (executor keys/nonces) and 0118 (passkey approval challenges). The installer includes migrations; this development session does not apply them to the installed server.

## Permission contract additions

`pc_control_preset` accepts `{access:"apps"|"terminal"|"full", administrator:boolean, mode:"always"|"temporary"|"task", expiresAt?, taskId?}`. Apps-only presets require administrator=false. The reviewed administrator switch changes the broad administrator rule; exact exclusions remain. Choosing administrator=false blocks the helper until that rule is changed, independently of the other preset's duration.

`pc_control_scope` also accepts an explicit `target:"*"`; for an all-target browser/command scope, `application:"*"` is supported, and browser `profile:"*"` is supported. Matching Never wins, then Ask. Folder and command starting-folder policies match descendants. These are explicit broad grants, not glob patterns in paths.

Full presets disable the old everyday toggle so it cannot outlive their duration. Other existing exact grants retain their own durations. A host command is refused while incompatible non-command Never exclusions exist, because a normal host shell cannot enforce those exclusions.

## Build-only packaging

Root TypeScript and native Release compilation succeeded with the two existing native warnings in Family.cs (CS0183) and Voice.cs (CS4014). Web typechecking also succeeded during implementation. No tests or probes were run for these changes. No generated Josi app was started for validation.

The release scripts now support `-SkipRuntimeChecks`. It omits launcher tests and setup-bridge runtime probes and marks their evidence as untested. It cannot be combined with `-Publish`. Source must be committed and clean before packaging.

```powershell
node scripts/windows/run-background.mjs powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/windows/Build-Release.ps1 -Version 1.2.5-preview.2 -Sign -SkipProvision -SkipRuntimeChecks
```

This runner hides console windows and keeps temporary files/npm and NuGet caches under the approved workspace. Package hash/signature inspection is metadata inspection; do not execute the installers. It explicitly supplies OS PowerShell modules: the initial packaging attempt stopped at `Get-FileHash : The term 'Get-FileHash' is not recognized`; setting the child module path fixed the build environment.

## Completed local installers

Both signed installers were built from clean source commit `8be39dc0f176cf307ca84014d13287a922599bb4`. Output is under `artifacts/windows-native/releases/1.2.5-preview.2/` in the approved workspace.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Josi-CE-1.2.5-preview.2-Windows-x64.exe` | 1019145064 | `1ad3b44bc97014ca4794f0f748b1a2b0973722b4668766294e5978ddb3646a78` |
| `Josi-Client-1.2.5-preview.2-Windows-x64.exe` | 80383968 | `adad0c18d81e09d146e72d6ce906da7cd6d6aa1140f74446d27f4ca995d90044` |

Both have valid timestamped SoCal Receptionist Authenticode signatures. Their hashes match `SHA256SUMS.txt`. `BUILD-RECEIPT.json` records the source, metadata and explicit `testsRun:false`, `desktopAcceptanceRun:false`, `installed:false`, and `published:false`. Build log: `artifacts/windows-native/evidence/build-1.2.5-preview.2-retry.log`. Documentation-only commits after the source commit do not change these binary bytes.

These are local, untested previews. Neither installer was executed; the generated Josi app and control bar were not launched for acceptance. No release was published and installed services were not changed.

## Remaining limits and owner-approved acceptance

- The complete isolation design in the plan is not implemented: broad host commands and broad application control have the signed-in user's authority. Starting folders are not sandboxes; mediated file checks cannot constrain arbitrary scripts. Same-user host code can interact with local credentials/authority outside these mediated tools. Nonexportable executor keys are not an absolute boundary against code running as that same user.
- Phone approval authenticates the account and exact proposal with a passkey/password. It is not yet a separately revocable physical-phone pairing system; synced passkeys may exist on multiple devices.
- Administrator execution is one-shot; persistent elevated terminals are not implemented. OS UAC remains owned by Windows. Ordinary chat tasks without a work-goal ID do not automatically acquire task-scoped authority.
- Permissions opens chat, but automatic task-specific conversation selection, immediate conversational Stop/Resume and configurable emergency shortcuts remain unfinished. Current revocation proposals require applying their card; the local Stop button acts immediately.
- PrintWindow compatibility, physical-input takeover, mixed DPI, terminal interactivity, UAC cancellation, passkey approval, migration/upgrade and full model-to-native execution require owner-approved runtime acceptance. Existing test fixtures also need to be adapted to the new executor identity and permission semantics before any approved test run.
- Linux implementation remains a separate machine phase. No claim is made that the full multi-platform plan is finished.

Web implementation used Modern Web Guidance's `passkeys` and `passkey-reauthentication` guides: "developers MUST rely on vetted open source libraries" and "Constrain Credentials". Local guide copy is in the workspace artifacts; the maintained SimpleWebAuthn server verifier, owner-bound credentials and native browser WebAuthn APIs are used.
