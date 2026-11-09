# Josi macOS computer control — 1.2.4

Updated November 8, 2026. This build integrates the native Mac adapter with existing Vault permissions and packages it in the actual signed Josi app. It is not completion of every stage in the broader computer-control plan; unsupported features are listed below.

## Workspace and authorization

Worktree: `JosiDrive/Projects/worktrees/josi-ce-mac-pc-control`, branch `feature/macos-computer-control-20261108`, base `f2350a7645fac122b96126ba2c8489939ead3dde`. The plan and status were fetched and inspected through `f346d5c`. Existing checkouts and uncommitted work were preserved. This branch contains the source handoff; the signed 1.2.4 installer and source archive were built before the handoff commit. See [MACOS_COMPUTER_CONTROL_HANDOFF.md](MACOS_COMPUTER_CONTROL_HANDOFF.md) for the other-machine pickup instructions and artifact checksum.

Host: Apple Silicon, macOS 27.0.1 (26A434), Xcode 27.0. The owner authorized local Socal Receptionist signing and actual-app Mac tests. No installation, service replacement, notarization, publication, account credential changes or TCC changes were performed by this session. The actual signed Josi app reused its existing Accessibility, Screen Recording and Input Monitoring grants. The separate acceptance-app workflow was abandoned.

## Existing permissions

- The adapter reads and authenticates the current encrypted Vault automation policy, Cardinal policy, protected-device enrollment, desktop workspace and target registrations under the existing Vault transaction lock. Locked, unreconciled or invalid records refuse execution; Stop remains available.
- Existing hardware enrollment is linked with a one-use P-256 possession challenge through the existing Secure Enclave/protected-key helper. The signed challenge binds the exact new Mac executor key, original owner/server/device/workspace, current Vault record, nonce and deadline. Linking neither replaces the hardware identity nor copies or broadens saved grants. This path reuses the existing protected biometric proof.
- Current saved app permissions map to exact registered bundle path, bundle id, signing id, signing team and code hash. The native executor verifies the pinned installation. Existing denials, disabled policies, Cardinal restrictions and narrower Ask rules remain effective. New adapter restrictions intersect with saved permissions.
- Ask approval applies to one exact operation and policy revision. Timed permissions and task limits bound native leases. Actions and byte reservations are charged transactionally at dispatch, retained across failures and history pruning, and rechecked during execution. Durable task limits use the owned work goal's server creation time.
- Captured content is absent from tool/MCP receipts and durable tool history. The trusted conversation loop projects it into one request to the exact registered current primary model, with current model-transmission permission, current routing/credential version, local-only rules and no fallback. Permission/configuration changes or Stop before dispatch refuse delivery; transmission budgets are charged at dispatch. A native Ask approval does not approve model transmission.
- Saved file-root/runtime UUIDs cannot safely be inferred from POSIX paths. Such legacy scopes remain refused until an explicit verified mapping exists. Generic desktop input is also refused when it cannot establish compliance with narrower saved restrictions.

## Native capability

The additive `computer-control.2` contract uses Mac paths and identities without changing an older platform's path handling. Executor requests carry Ed25519 proofs binding owner, device, method, exact body, time and one-use nonce. Local Keychain enrollment and protected permission cards remain explicit. The model cannot enroll or approve itself.

Implemented capabilities: environment and signed app inventory; app launch; bounded file list/read/create/edit; structured Accessibility observation, press and text entry; targeted window scroll/drag/close; ScreenCaptureKit capture of one uniquely matched approved window. File access uses descriptor-relative operations, refuses links and special files, checks edit digests and excludes authority/credential storage. Observations bind app, process, window, display layout, task, generation and time. Protected windows, secure fields and lock-screen control are refused.

Every action passes the local gate. Short monotonic execution leases and the original permission lifetime bound execution even after clock rollback. Physical input triggers takeover, and local Stop works without HTTP. Reconnect cannot clear Stop; a pending Stop is flushed before local Resume. Resume does not rewrite grants. Lost input monitoring or a changed desktop fails closed.

The control bar now matches the approved concept: a full plum capsule, bright gold edge and wordmark, larger animated ghost extending above the bar, and custom pill controls with gold Take over and coral Stop. It uses the existing Josi ghost clips, with no new animation dependency. The complete layout scales together on smaller displays. The Josi menu includes **Show Control Bar**, which shows the stopped controls without enrolling a device or requesting permissions and explicitly focuses the buttons for keyboard access. Automatic overlay presentation remains nonactivating. Enabled button text has a minimum calculated contrast ratio of 5.41:1 across the button gradients. The status shows plain-language control state instead of raw operation names; full details remain available through accessibility and the status tooltip. The ghost thinks during work and floats when idle; Reduce Motion uses its existing still pose. Take over and Stop remain prominent. The blue screen border continues to indicate computer control. The bar and border allow ordinary screenshots at the owner's request; remote captures remain explicitly filtered to the approved target app window.

## Actual-app verification and fixes

The shipping Josi app contains an optional local **Check Computer Control…** support command. It has no HTTP entry point and uses only its own disposable TextEdit document. It does not create a second app identity or alter account permissions.

The signed actual Josi app passed these checks on this Mac:

1. All three existing OS permissions reported granted.
2. Scoped file create/read matched exactly.
3. TextEdit signature and input-monitor availability verified.
4. Actual Accessibility observation succeeded.
5. Structured text input matched exactly in the disposable document.
6. Actual ScreenCaptureKit screenshot succeeded.
7. Targeted scrolling dispatched to the approved window.
8. Reusing a consumed observation was refused.
9. External input caused takeover through the real event tap.
10. Takeover invalidated the execution lease.
11. Offline local Stop prevented another action.
12. Close targeted only the disposable document.

Evidence: `Josi-Control-Check-e297bab9-5d00-49ee-ab21-d1edf6a115d5/result.json` and its own-window JPEG, copied into the deliverable evidence folder. This check exercises production native control code with bounded local fixture authority, not the owner's configured chat account. The packaged app was checked again after branding: all eleven control/safety checks passed; further physical input correctly interrupted the optional document-close cleanup. Its report is `Josi-Control-Check-85672d16-832d-4347-bd46-e7c172461fb6/result.json`. The bar was subsequently shown for the owner's picture, then stopped and closed at their request. The final delivery adds screenshot-friendly window flags and clearer local-cancellation wording; these UI-only changes were rebuilt and signed without repeating desktop actions.

Two real failures were found and fixed before delivery: a surviving unretained event-tap callback after the diagnostic owner was released caused a crash; the monitor now shuts down and invalidates its source before release. ScreenCaptureKit included a one-point window border on each side that Accessibility omitted; capture now requires unique matching owner/title and all four frame edges within one point. The original ambiguity check remains strict.

The 1.2.4 restyle was checked in the actual Socal-signed Josi app: **Show Control Bar** focused the real controls, **Pause** displayed “Paused · You are in control”, **Stop** displayed “Stopped locally”, and **Permissions** opened the existing panel with all three OS grants intact. The check did not enable control, enroll a device or change OS permissions. A capsule-edge alignment issue found during visual inspection was corrected before final packaging; the final signed build's actual window screenshot confirmed the full gold outline, animated ghost, wordmark and all five buttons without clipping. The app was then quit. Source hashes confirm only the overlay, app menu and this status document changed since 1.2.3. Desktop authority code was unchanged by this restyle; the earlier native-action and automated evidence is retained as prior verification, rather than represented as a new run.

Automated verification includes owner isolation, proof/replay rejection, exact protected approvals, denial precedence, hardware linking, locked/corrupt Vault refusal, app pinning, task pause and budgets, permission/lease expiry, model-transmission denial and revocation, one-request screenshot projection in the real assistant loop, absence of captured content in later hops/receipts, pinned subscription dispatch, and a compiled Swift executor's HTTP file round trip against disposable local server storage. The final automated run passed 47 tests across eight suites. The earlier 27 native gate/file checks remain relevant; final logs are bundled with this build.

## Installer and update path

Version `1.2.4`; bundle `com.heyjosi.ce.unified`; team `LRH75YR6QW`. App: **Developer ID Application: Socal Receptionist LLC**. Installer: **Developer ID Installer: Socal Receptionist LLC**. The protected-key helper's existing provisioning profile is retained. Private signing keys were not exported.

The build expanded the final signed 1.2.4 installer, compared every payload file, mode and link with staging, and verified the extracted app and uninstaller signatures. All 17,948 entries matched. Eleven production update-validator checks passed, including signature/product/version validation against the actual final 1.2.4 package. The deliverable manifest records final checksums and comparison evidence.

**Install Downloaded Update…** validates a private copy, requires the Socal installer certificate and Josi product identifier, and rejects a downgrade before handing it to macOS Installer. The existing update check reports private/unavailable feeds honestly. Installer preflight validates installed identity and version/build; the package asks Josi to close, then uses the existing backup/migration/recovery lifecycle and preserves server data and settings. Fresh installation does not automatically grant control or start a new server.

The update handoff was exercised through signature confirmation and Installer's Read Me. The final package also passed the production update validator's signature/product/version checks. Installation was not started. Installed 1.2.2 data, protected hardware enrollment and retained-data upgrade/rollback have not been exercised against this new installer. The installed app has root-readable sealed archives, so complete installed-signature preflight is performed by Installer with its normal administrator authorization, not by weakening those file permissions.

This is a locally supplied signed installer. It has not been notarized or published.

## Remaining scope and acceptance limits

- Persistent PTY/shell sessions, verified detached-descendant containment, paired-phone remote approval/control and an administrator broker are not implemented or advertised. A working directory is not a shell sandbox.
- Existing file-root/runtime identity mapping, asynchronous chat continuation after a long approval wait, and owner-managed history retention remain outstanding.
- Real configured-account enrollment/Touch ID linkage, real model screenshot interpretation, retained-data installation/rollback, denied/revoked TCC, lock/unlock, display changes/mixed scale and live app replacement have not been accepted on this Mac. Fixture tests do not establish those results.
- No access through a lock screen or protected password prompt is promised.

## Reproduce

```sh
node_modules/.bin/tsc -b
node_modules/.bin/vitest run packages/core/test/computerControl.test.ts packages/core/test/computerPolicy.test.ts packages/agent/test/computerControlTools.test.ts packages/agent/test/computerProjection.test.ts packages/core/test/workControls.test.ts apps/api/test/computerControlRoutes.test.ts apps/api/test/computerControlNative.test.ts packages/llm/test/subscriptionCapture.test.ts
```

Build the actual app/installer with `scripts/macos/build-native-unified.py`; use a fresh output folder outside File Provider-managed Documents for codesigning. Signing and notarization are separate actions.

Native API references: [ScreenCaptureKit windows](https://developer.apple.com/documentation/screencapturekit/scwindow), [window-targeted capture](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:)), [LocalAuthentication](https://developer.apple.com/documentation/localauthentication/lacontext/evaluatepolicy(_:localizedreason:reply:)), [CGEvent taps](https://developer.apple.com/documentation/coregraphics/cgevent/tapcreate(tap:place:options:eventsofinterest:callback:userinfo:)).
