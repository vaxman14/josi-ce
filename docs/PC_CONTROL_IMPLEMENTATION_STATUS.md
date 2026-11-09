# Windows computer control status — November 8, 2026

**Current work:** read [WINDOWS_PC_CONTROL_ACCEPTANCE.md](WINDOWS_PC_CONTROL_ACCEPTANCE.md) for preview.3 fixes, focused test results and signed installer status. The owner explicitly authorized testing and desktop control for this session on November 8, 2026. Continue only in the approved workspace below. [WINDOWS_PC_CONTROL_BUILD_NOTES.md](WINDOWS_PC_CONTROL_BUILD_NOTES.md) preserves the preview.2 feature scope and remaining design limits.

## Historical preview.1 record

Everything below describes preview.1. Its test results do **not** validate the newer source or preview.2 installer.

Read [PC_CONTROL_PLAN.md](PC_CONTROL_PLAN.md) for the approved direction. This preview implements the chat permission foundation and native takeover controls. It does **not** complete the full Windows plan.

The plan was pushed as `1649c1659b41edc7b08f0241d85b1fc35ee56ae4` on `redesign/windows-lean-beta`. The Mac session can start immediately; Windows verification does not block it.

## Workspace and installer inputs

Use only `C:\Users\vaxma\Desktop\Windows Josi Native Redesign\Josi Windows PC control`. This is an independent Git checkout containing the source, dependencies, pinned installer inputs and subscription CLI payloads. Do not resume work in the old C:\Dev folders. All 144 copied dependency junctions resolve inside the approved workspace.

Release scripts default to `artifacts/windows-native/tools/subscription-cli/node_modules`. Test/build temporary files belong under `artifacts/windows-native/test-tmp`. System SDKs/signing tools and existing OS sign-in remain system installations; no credentials were copied into the repository.

`scripts/windows/Test-ReleasePrerequisites.ps1 -CheckSigning` passed after relocation. It checks tooling, input hashes/sizes, signing configuration/tools and Azure account availability without installing or signing. Its report is `artifacts/windows-native/evidence/release-prerequisites.json`.

Existing 1.2.4 installer bytes were preserved. Release builds now refuse to overwrite an existing version folder. Installed 1.2.3 services remain unchanged. No release was published by this session.

## Signed local installer preview

`1.2.5-preview.1` built successfully from clean source commit `f346d5cae0ef7704f900d99449f354b1e93794d2`. Both installers have valid timestamped SoCal Receptionist Authenticode signatures, and both SHA-256 checksums match `SHA256SUMS.txt`.

Files are under `artifacts/windows-native/releases/1.2.5-preview.1/` in the approved workspace:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Josi-CE-1.2.5-preview.1-Windows-x64.exe` | 1017965720 | `e30e4ad00a37916f86bd2885653565b80fff1cc67cb7c7f27e18c7ebf4f9be07` |
| `Josi-Client-1.2.5-preview.1-Windows-x64.exe` | 80349280 | `0abdbe83d4c74d86add51c24a9fad1468859e1975b553819419689b0fa686c69` |

`BUILD-VERIFICATION.json` records the source commit, signatures, checksums and verification limits. The installer kit passed its loading check and all four tamper-rejection checks. The fresh source snapshot contains no generated probe binaries. Build log: `artifacts/windows-native/evidence/build-1.2.5-preview.1.log`.

This is a foundation preview. It has not been installed or published. Real-chat, upgrade, physical takeover/mixed-DPI and the remaining functionality below are not verified by the package build. Later documentation commits do not change the binary's recorded source commit.

## What works in this preview

- Chat inspects registered PCs and actual permissions even when control is off. Multiple devices require explicit selection for a permission proposal.
- Proposals pin authenticated owner, target PC and policy revision. Confirmation text comes from normalized policy data. Stale revisions, another owner, replay, unsupported restrictions and incompatible duration fields are refused.
- Chat prepares control on/off, the existing everyday preset, supported exact grants, revocation, and one-time approval/denial. Once approval creates no standing grant.
- Saving an allowance and approving its exact waiting operation is atomic. Other queued work is invalidated. Expired/mismatched/denied work is not substituted or revived. A timed grant cannot extend the waiting request beyond its expiry.
- Native blue monitor frames and a separate strip show Take over, Pause, Resume, Stop and Permissions. They remain independent of the main window and do not activate on appearance. Ctrl+Alt+Esc stops local work when available; a shortcut conflict is reported.
- Human takeover no longer expires after 20 seconds. Resume is explicit. Existing background commands continue during takeover; Pause/Stop cancel current work. Local pause/takeover state survives restart.
- The executor verifies authorization before starting and periodically during work. Connection/session loss, revocation or grant expiry ends work. Lease/result endpoints check the owner and claiming PC. This is **account/session binding, not cryptographic paired-device identity**.
- Native desktop tools refuse Josi's own approval/control windows and known Windows credential/elevation surfaces. Password fields are omitted from UI Automation observations and cannot be typed into. Dialogs/overlay request Windows capture exclusion. These measures are not an isolation boundary against a broad host shell.
- Existing one-shot PowerShell/cmd, app discovery/launch and mediated file operations remain available. Shell descriptions explain that the starting folder is **not a filesystem sandbox**.

## Proposal contract: `pc-control-chat.1`

This version identifies the **Windows adapter's current chat proposal semantics**, not the final cross-platform isolation/capability schema.

`pc_get_permissions({pc_id?})` returns the owner's device list and selected snapshot: `pcId`, `revision`, enabled/preset state, action catalog, policies, legacy tasks and pending requests. With multiple PCs and no selection, `selected` is null. The activity log is omitted.

`propose_josi_setting_change` supports:

| Area | Proposed change |
| --- | --- |
| `pc_control_enabled` | `{enabled:boolean}` |
| `pc_control_full_control` | `{enabled:boolean}` for the existing everyday preset |
| `pc_control_scope` | `{action,scope,mode,expiresAt?,taskId?,approveRequestId?}` |
| `pc_control_revoke` | `params.id` names one saved permission |
| `pc_control_decide` | `params.id` names one pending operation; `{approve:boolean}` |

`params.pcId` selects the PC. Prepared URLs carry `pcId`, `ownerId` and `revision`; clients must preserve them and show the server-prepared summary. Passwords stay in the existing protected form, never chat. The Windows client reuses that confirmation for the underlying permission route.

`approveRequestId` requires a matching grantable allowance; grant and preserved request commit together. Temporary/task expiry shortens, never extends, the original request expiry.

The core still uses exact Windows scopes, legacy task records and a 24-hour temporary limit. Normal desktop tools do not yet carry a trusted chat-task identity. Do not present storage of task grants as completed “current chat task” execution. Mac/Linux need versioned platform path/identity semantics; do not pass Unix paths to the existing Windows normalizer.

## Verified evidence

- Five relevant server/agent suites: **78 passed, one known browser-page test skipped**.
- TypeScript project build and web typecheck passed.
- Native Release build passed with pre-existing `Family.cs` CS0183 and `Voice.cs` CS4014 warnings.
- `pcwork-probe`: all command/file/program checks passed, including UTF-8, timeout, cancellation and scope rejection.
- `pccontrol-probe`: takeover beyond 20 seconds, explicit Resume, persistent pause, background work during takeover, local cancellation, protected own windows, frame creation, revoked lease canceling a real PowerShell process, and unavailable-server refusal all passed.
- Visually inspected WPF renders under `artifacts/windows-native/evidence/pc-control/pc-control-{working,takeover,paused}.png`. These prove layout, not physical input hooks or mixed-DPI interaction.

Run from the approved workspace:

```powershell
$env:TEMP = Join-Path (Get-Location).Path 'artifacts\windows-native\test-tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
npx.cmd vitest run packages/core/test/pcControl.test.ts packages/agent/test/pcDesktopTools.test.ts apps/api/test/pcControlRoutes.test.ts apps/api/test/pcControlChat.test.ts apps/api/test/settingsChanges.test.ts -t '^(?!.*renders the actual browser page)'
npx.cmd tsc -b
npx.cmd tsc --noEmit -p apps/web/tsconfig.json
dotnet build apps/windows-native/Josi.Windows.csproj -c Release
dotnet run -c Release --project apps/windows-native/test/pcwork-probe
dotnet run -c Release --project apps/windows-native/test/pccontrol-probe -- (Join-Path (Get-Location).Path 'artifacts\windows-native\evidence\pc-control')
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Test-ReleasePrerequisites.ps1 -CheckSigning
```

## Still required for the full Windows plan

1. Persistent/interactive terminals, streaming and OS-owned descendant lifetime. Existing one-shot `Process.Kill(true)` is not demonstrated containment for detached/reparented descendants.
2. Real isolation for restrictive file/app/network/elevation grants, protecting policy storage and the broker. Broad shells can cross mediated file/UI scopes.
3. The new granular capability model, trusted task/session binding, full duration choices, protected native authentication and separate administrator broker. Chat currently refuses saved administrator grants because they are unimplemented.
4. Cryptographic phone/controller pairing, device-bound approvals and execution target selection. Execution tools still choose the most recently live PC; proposal selection alone does not solve remote execution targeting.
5. Targeted capture excluding neighboring/occluding windows, scrolling/dragging, observation freshness, physical takeover, monitor changes and real mixed-DPI validation.
6. Complete chat permission cards, chat Resume, task-aware Permissions navigation, configurable shortcut and immediate authenticated conversational revocation. The existing protected popup is reused; Permissions opens chat without sending a message.
7. Real model/chat/native execution and an owner-approved upgrade retaining data/permissions. Builds, signatures and synthetic tests do not substitute for these checks.

The user is away. Do not silently install/publish a candidate or call synthetic tests a successful live-chat run.

Overlay references: Microsoft [capture exclusion](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity) and [global hotkeys](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey). Capture exclusion is a compositor feature, not a security guarantee.
