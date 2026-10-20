# P5 native Mac app — 20 October 2026

The owner requested a native replacement after installing the unfinished Electron candidate, and explicitly authorized signing with this Mac's Socal Receptionist LLC identities. This checkpoint replaces the Mac UI implementation with SwiftUI/AppKit. It is not a completed P5 or release-acceptance gate.

## Implemented

- `apps/macos-native` compiles a native application with a Josi icon, native windows, menus, navigation, forms and chat/task views. No Electron or WebView renders the interface.
- Local hosting and remote CE connections use the existing server API. HTTPS is required for remote connections. Per-connection authentication cookies and CSRF tokens remain in an ephemeral session, with redirects rejected and no persistent credentials in preferences.
- Local first-time setup exchanges the protected bootstrap handoff for a one-use setup session inside the app. Native forms cover host checks, owner, domain, provider/model selection, SMTP, folder/security options, telemetry, review and completion. Recovery material is displayed only in memory unless the owner explicitly saves their recovery copy.
- Password/MFA login, conversations and durable turn submission are connected. A lost submission reply retains the original message identifier/body for an explicit retry during the current app session.
- Chat progress cards and the native Task Manager consume the server's work-goal records. Pause, resume with instructions, cancellation and completion confirmation use the current goal revision.
- The native Task Manager has Active, Needs You / Waiting and History views, continuation questions and scheduled rechecks. Expand a goal for completion criteria, the owner's correction, current progress notes, paginated activity/plan/outcome history and the original conversation.
- Work-memory correction, pin/unpin and clearing, requested-outcome changes and obsolete-step retirement use the existing owner-scoped APIs. An edit retains its original revision and requires explicit review of newer work before submission; server conflict checks remain authoritative.
- Super-admin native settings display current Cardinal Rules, permission scopes/limits and enrolled devices from the Vault. Rule drafts have explicit action/scope/restriction forms, deterministic **Test Validity**, password/MFA-protected Vault saving, exact provider/content preview and an explicit model-review request. Saved advice remains inactive. Unsupported saved draft shapes cannot be silently rewritten by the editor.
- Fixed local lifecycle controls provide install/update, start, stop, restart and journal recovery using macOS administrator authorization and Socal signature verification. Closing the window leaves server hosting independent.
- The package includes the native **Uninstall Josi.app**, with keep-data and complete-removal choices. Its existing removal machinery now recognizes the unified app and installer receipt.
- Installing the package over a recorded existing server invokes the normal recovery-copy/migration lifecycle. A new or remote-only install adds the app without automatically provisioning a local server.
- Existing protected-key and server-consent helpers accept the signed native host identity. They retain their installed-path, signature, hardened-runtime and entitlement checks.
- Native permanent-rule activation/retirement and device revocation now use the protected server challenge flow: fresh administrator verification, hardware host proof, complete native presentation, genuine biometric authentication through the existing key helper, current-Vault checks around signing, and one commit attempt. Closing/cancelling the review kills its owned helper; expiry uses wall and monotonic clocks. Lost commit responses require inspecting refreshed settings, never automatic replay. An already enrolled device is required.
- Native device enrollment connects the existing begin/prepare/review/status/commit APIs. The target Mac creates its hardware wrapping key and signs possession after native review and biometrics. The server Mac separately approves through its installed, signed app and the protected local consent socket. A remote HTTP response cannot substitute for server-local consent. Enrollment grants no automation access; cancellation and uncertain commit responses require fresh review instead of replay.

## Packaging and observed behavior

`scripts/macos/build-native-unified.py` requires a fresh output folder and an offline server runtime. It overlays current built server packages/migrations, compiles the app and native helpers, creates Josi's icon, refreshes inventories and signs with:

- Developer ID Application: **Socal Receptionist LLC (LRH75YR6QW)**
- Developer ID Installer: **Socal Receptionist LLC (LRH75YR6QW)**

Creating an installer requires `--sign --package`. The builder does not install, alter live server data, or notarize. It retains build logs separately from the payload. After packaging it extracts the installer, compares every file's bytes/mode and every link against staging, and verifies both extracted app signatures.

The first signed native build is in `/private/tmp/josi-native-unified-20261020-1`. Swift 6 compilation succeeded. The app, uninstaller and approval helpers were signed; deep/strict verification and exact Socal authority, team and timestamp checks passed. The installer signature also passed. Its 17,604 file/link entries matched staging, including executable modes.

`pkgbuild` printed twelve `write: Permission denied` warnings while returning success. The original source of those warnings remains unknown. Extraction completed and the complete byte/mode/link comparison passed. A signature check inside the restricted sandbox reported an invalid signature; both extracted apps passed the same verification outside the sandbox. Do not interpret that sandbox verdict as package corruption or suppress real failures in a signing-capable environment.

The staged signed app actually launched through the computer-use tool and displayed its native **Welcome to Josi** window, local/remote connection controls and the existing public server receipt version `0.1.78-macos.17`. This is evidence of launch and receipt reading, not server health or functional acceptance. The staging app cannot manage services because it is outside `/Applications/Josi.app`. No installer or uninstaller was run, no provider call was made, and no live server data was changed.

## Remaining work

New permission-target selection, remaining administrator/settings parity, channel-delivery status, provider-specific subscription setup parity and automation-desktop integration remain open. Existing CE web and remote APIs are retained. Authenticated sessions are currently memory-only; a durable client session must use the accepted Vault authority design. Device enrollment is assembled; actual biometric/local-and-remote acceptance and abandoned-key reconciliation remain open.

The follow-up work/task and rule-editor sources compiled successfully with Swift 6. No authenticated functional flow or model review was run on the owner's server. The native package version advances to `0.7.0-native.2`; its installer version is `0.7.0.3`.

That signed installer is retained at `/Users/roman/Documents/Josi Mac Native/JosiDrive/Artifacts/josi-native-unified-20261020-2/Install Josi.pkg`, with clean source revision `db33e6d3f38d89d70241c11519b9ea6a6aac1e6b`, checksums, current application source and retained runtime dependency sources. Its extracted file comparison and both app signature checks passed. This package predates the native protected-approval connection described above.

The later protected-approval sources compile with Swift 6. A bounded, local compatibility check compared the actual native encoder with the CE protocol implementation: a hardware host challenge and three full protected presentations, including quotes, slashes, newline/tab and Unicode text, produced identical signed bytes. No hardware key was created/read, no biometric prompt was opened and no rule/device was changed. Real protected-flow acceptance remains open.

Functional setup/login/chat, service operations, real upgrade/recovery and uninstallation acceptance remain unverified. Notarization and final release acceptance are outstanding. The owner asked to defer functional suites until features are built; the targeted launch and packaged-signature checks address the immediate broken-app report.

## Protected helper provisioning

The native key helper uses the macOS data-protection Keychain. Apple's [Keychain guidance](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains) and [restricted-entitlement signing guidance](https://developer.apple.com/documentation/xcode/signing-a-daemon-with-a-restricted-entitlement) require profile-authorized entitlements and an app-like bundle. The earlier bare signed helper was not sufficient evidence of usable key access.

The builder now embeds `JosiProtectedKeyHost.app` with a Developer ID profile and only its own application identifier, team identifier and Keychain group. `--protected-profile` checks the Socal team, macOS platform, distribution eligibility, expiry, exact existing signing certificate, authorized group and absence of debugging entitlements before building. The main app records whether provisioning was included and disables protected flows when it was not. There is no fallback to another team, software wrapping keys or the file-based Keychain.

On 20 October the owner explicitly approved registering this Mac with Socal Receptionist LLC. Xcode's exact-Mac build registered it and produced a development profile containing its identifier; the owner approved the system Keychain prompt. Archive/export then produced a Developer ID profile for `com.heyjosi.ce.protected-key`, team `LRH75YR6QW`, authorizing the selected existing Socal Developer ID certificate. The helper's signed entitlement uses only `LRH75YR6QW.com.heyjosi.ce.protected-key`, even though the profile permits the team's wildcard group. No certificate was revoked and no other team was selected.

The enrollment and profile-gated Swift 6 sources compile. The local protocol comparison now covers seven native/CE signed messages and three consent decode/re-encode round trips, including Unicode and escaped text. No real enrollment, biometric signing, Vault mutation or installation was performed. The next package is `0.7.0-native.3` / installer `0.7.0.4`; artifact production is recorded separately when complete.

That package is now retained at `/Users/roman/Documents/Josi Mac Native/JosiDrive/Artifacts/josi-native-unified-20261020-3/Install Josi.pkg`. It contains clean source revision `d709887ead6dc7da13151de8337d518be8b446e3`, the provisioned helper, native enrollment and protected approval. All 17,607 extracted file/link entries match staging and both extracted app signatures passed. Its folder includes hashes, current source, runtime dependency source and the Apple-issued profile needed to reproduce helper signing. This package is not installed, functionally accepted or notarized.

## Existing permission editing

The subsequent native editor opens a server-validated saved policy and retains its original Vault reference. It supports policy enable/disable, unmatched-action behavior, deny/ask/task/until/standing modes, independent explicit unlimited or whole-number limits, and rule removal/restoration before saving. Identity, exact scopes/revisions and stable grant IDs are preserved; changing limits does not reset prior consumption. Untouched expiry text is preserved exactly. Unsupported policy shapes cannot be silently rewritten.

Changes must pass the server validator again before native protected confirmation becomes available. Any field change invalidates that check. A changed connection, administrator or Vault reference blocks saving; the server repeats authority and version checks inside its existing transaction. The final protected review shows the complete before/after meaning. Removing a denial is explicitly identified as a possible widening.

The editor currently changes **existing** grants. Creating new policies and selecting new browser profiles, applications, folders, runtimes or credential destinations still depends on the production workspace/target catalog. It does not fabricate selectable targets from arbitrary IDs. Swift 6 compilation and the pre-commit public-data scan passed. This source is later than the `native.3` installer and remains subject to functional acceptance.

## Native Vault controls

The native sidebar now includes the owner's credential list and super-admin Master Vault controls. The existing CE routes provide five-minute list unlock, encrypted credential creation/replacement, integrity checks, explicitly confirmed deletion, Vault initialization, master lock/unlock, legacy credential inventory/migration and offline recovery. Existing secret values are never returned or displayed. New secrets, passwords and recovery inputs remain in transient view state and clear on submission or navigation; no second credential store was added.

Recovery initialization opens a native one-time-key sheet that requires the owner's saved-copy acknowledgment. Normal quit is blocked while a setup or Master Vault recovery key is awaiting acknowledgment. An explicit Save dialog writes a private `0600` temporary file, syncs it and renames it into the owner's chosen destination; the initial setup recovery export uses the same implementation. Nothing automatically exports the key. Abrupt OS termination or an unconfirmed initialization response still requires recovery investigation; the UI is not a durability guarantee.

Vault refreshes pause while the app is inactive or a mutation is running. Connection/owner checks, cancellation and a local generation prevent late reads from restoring a stale view after a mutation or navigation. Master health remains independently accessible when personal credential access fails. Swift 6 compilation passed; no real credentials were changed and functional acceptance remains deferred. This source is later than the `native.3` installer.

## Native backups and connected-server health

The super-admin Backups page connects full/portable creation, retained history and live progress to the existing CE routes. Unconfirmed creation responses require inspecting history; there is no automatic retry. The separately stored installation-key requirement stays visible. Creating backups continues to use the server's configured destination; changing an off-site destination remains separate native parity work.

Completed archives save through an explicit native file picker and the existing authenticated session. Downloads accept only the selected backup UUID, same-origin non-redirected ZIP response and exact recorded byte count. Free storage is checked first; streaming uses a bounded 256 KiB buffer and a private `0600` temporary file. The selected destination is replaced only after the complete stream and current client context are checked and the file is synced. Cancellation, errors and truncated or excess data remove the temporary file. Cancel requests during response-header waits take effect when the response arrives or the session times out. No archive or recovery key is opened automatically.

The Server page now shows the connected server's Josi Doctor checks and date separately from controls for the Mac running the client. Failures are shown before warnings and passes, with full expandable details. System checks run on page opening or explicit request; no automatic repair/model call/update is added. Local lifecycle changes continue through the existing signed, administrator-authorized helper.

The assembled Swift 6 app compiles and the pre-commit public-data scan passes. The next installer is `0.7.0-native.4` / package `0.7.0.5`, incorporating existing-grant editing, Vault management, backups and health. No backup, credential mutation, diagnostic request or installation has been executed on the user's server by this implementation work. Functional acceptance remains deferred.
