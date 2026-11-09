# Windows computer control preview.3 — November 8, 2026

The owner authorized focused testing, desktop control and a fresh signed installer: “you can test. take over, do what you want. finish and send me the fresh signed isntaller when you are done. and dont get into a 10000000 tests, just what you need.” This supersedes the earlier no-testing instruction for this session.

All source, fixtures, logs and installer output remain in `C:\Users\vaxma\Desktop\Windows Josi Native Redesign\Josi Windows PC control`. The isolated desktop fixture has been closed, its mock server stopped and its synthetic Credential Manager entry removed. Installed Josi services were not changed.

## Fixes from the focused checks

- Persistent PowerShell now attaches to ConPTY when the parent launcher redirects standard input/output. Explicit null standard handles prevent inherited pipes from bypassing the terminal. The native probe confirms that a variable assigned in one input survives into a later input. The Windows behavior is described in [Microsoft's terminal discussion](https://github.com/microsoft/terminal/discussions/15814).
- Stop now says “Stopped · You are in control” in the ghost bar and reports stopped in the main window. Idle status no longer says Josi is working. Stopped controls suppress the working animation and blue borders.
- The optional expected-file SHA-256 tool argument now has an explicit maximum length.
- Demo-mode settings, executor pause state, device IDs, trusted certificates and tunnel pairings use the workspace fixture directory. Production paths are unchanged. The native overlay probe loads the same theme resources as the app.
- Existing test fixtures now sign executor requests and match the approved permission contract. Additional focused cases cover signed-request tampering/replay, password/passkey approval cards, policy expiry and terminal grant revocation.

## Completed checks

| Check | Result | Evidence under `artifacts/windows-native/evidence/` |
| --- | --- | --- |
| Windows core policy, agent tools, API routes, chat approvals and settings | 71 passed, 1 skipped | `pc-preview3-focused-rerun.log` |
| Imported shared Mac policy, routes and agent tools | 37 passed, 1 skipped | `pc-preview3-shared-tests.log` |
| Native command, file and program probe | All passed | `pc-preview3-work-probe.log` |
| Native persistent PowerShell open/input/state/close | All passed after the ConPTY fix | `pc-preview3-terminal-fixed.log` |
| Native overlay and executor cancellation | All passed | `pc-preview3-overlay-fixed.log` |
| Root TypeScript and native Release compilation | Passed; existing Family.cs CS0183 and Voice.cs CS4014 warnings | `pc-preview3-typescript.log`, `pc-preview3-native-final.log` |
| Live native ghost-bar buttons | Pause, Resume, Take over, Stop and Permissions checked; stopped status rechecked after fix | Isolated app on mock API port 8801 |

The 108 passing server/agent checks include synthetic WebAuthn assertions verified through the actual HTTP approval endpoints. The two skipped checks are the documented pre-existing browser-page test on this PC and the macOS-only Swift integration case. No attempt was made to run the Mac native app on Windows.

The overlay probe also checks persistent human takeover, Pause/Stop process cancellation, cancellation after lease loss, refusal when the server is unreachable, protected Josi control windows and blue monitor frames. The manual check used the actual compiled native app with a synthetic signed-in account and scripted activity; it confirms layout and button wiring, not production model execution.

## Signed packaging

Completed version: `1.2.5-preview.3`, built from clean source commit `85000c3298c02505acf74bc3a659d2f465c08c2c` using:

```powershell
node scripts/windows/run-background.mjs powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/windows/Build-Release.ps1 -Version 1.2.5-preview.3 -Sign -SkipProvision
```

The release pipeline passed its launcher, setup-bridge and installer-kit runtime checks. It kept temporary files and caches inside the approved workspace and signed the app, launcher and installers. The server and native payloads record the same source commit. Packaged TypeScript and web typechecking/build also passed.

Both installers have valid timestamped SoCal Receptionist Authenticode signatures. Their SHA-256 values match `SHA256SUMS.txt`. Output is under `artifacts/windows-native/releases/1.2.5-preview.3/`:

| Installer | Bytes | SHA-256 |
| --- | ---: | --- |
| `Josi-CE-1.2.5-preview.3-Windows-x64.exe` (full server and app) | 1019146128 | `925c12589a4b3a9ce9937c9bd0a83f83072b30535ddffeba2611bab29af60fba` |
| `Josi-Client-1.2.5-preview.3-Windows-x64.exe` (client app) | 80385688 | `063d2ee93472830a41180dfbfa10f49855cf96a90cf073b4d6bc2dbdf68843c9` |

`BUILD-RECEIPT.json` records signatures, hashes, source identity, completed checks and explicit acceptance limits. The build log is `artifacts/windows-native/evidence/build-1.2.5-preview.3.log`. Earlier installers are preserved. Later documentation-only commits do not change these binary bytes.

## Acceptance limits

No installer has been executed in this session. Upgrade/migration, production model-to-native chat, Windows UAC approval/cancellation, physical-phone approval and mixed-DPI behavior remain unverified. Synthetic passkey coverage is not a physical-phone test. The [preview.2 design limits](WINDOWS_PC_CONTROL_BUILD_NOTES.md#remaining-limits-and-owner-approved-acceptance) still apply, including ordinary host-shell authority and the absence of separately revocable physical-phone pairing. The full Windows/Mac/Linux plan is not complete.

No GitHub release is published. Windows acceptance does not block independent Mac development.
