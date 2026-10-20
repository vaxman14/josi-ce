# P5 native Mac app — 20 October 2026

The owner requested a native replacement after installing the unfinished Electron candidate, and explicitly authorized signing with this Mac's Socal Receptionist LLC identities. This checkpoint replaces the Mac UI implementation with SwiftUI/AppKit. It is not a completed P5 or release-acceptance gate.

## Implemented

- `apps/macos-native` compiles a native application with a Josi icon, native windows, menus, navigation, forms and chat/task views. No Electron or WebView renders the interface.
- Local hosting and remote CE connections use the existing server API. HTTPS is required for remote connections. Per-connection authentication cookies and CSRF tokens remain in an ephemeral session, with redirects rejected and no persistent credentials in preferences.
- Local first-time setup exchanges the protected bootstrap handoff for a one-use setup session inside the app. Native forms cover host checks, owner, domain, provider/model selection, SMTP, folder/security options, telemetry, review and completion. Recovery material is displayed only in memory unless the owner explicitly saves their recovery copy.
- Password/MFA login, conversations and durable turn submission are connected. A lost submission reply retains the original message identifier/body for an explicit retry during the current app session.
- Chat progress cards and the native Task Manager consume the server's work-goal records. Pause, resume with instructions, cancellation and completion confirmation use the current goal revision.
- Fixed local lifecycle controls provide install/update, start, stop, restart and journal recovery using macOS administrator authorization and Socal signature verification. Closing the window leaves server hosting independent.
- The package includes the native **Uninstall Josi.app**, with keep-data and complete-removal choices. Its existing removal machinery now recognizes the unified app and installer receipt.
- Installing the package over a recorded existing server invokes the normal recovery-copy/migration lifecycle. A new or remote-only install adds the app without automatically provisioning a local server.
- Existing protected-key and server-consent helpers accept the signed native host identity. They retain their installed-path, signature, hardened-runtime and entitlement checks. Their native UI coordination is still to be ported; packaging them alone does not enable permanent policy changes.

## Packaging and observed behavior

`scripts/macos/build-native-unified.py` requires a fresh output folder and an offline server runtime. It overlays current built server packages/migrations, compiles the app and native helpers, creates Josi's icon, refreshes inventories and signs with:

- Developer ID Application: **Socal Receptionist LLC (LRH75YR6QW)**
- Developer ID Installer: **Socal Receptionist LLC (LRH75YR6QW)**

Creating an installer requires `--sign --package`. The builder does not install, alter live server data, or notarize. It retains build logs separately from the payload. After packaging it extracts the installer, compares every file's bytes/mode and every link against staging, and verifies both extracted app signatures.

The first signed native build is in `/private/tmp/josi-native-unified-20261020-1`. Swift 6 compilation succeeded. The app, uninstaller and approval helpers were signed; deep/strict verification and exact Socal authority, team and timestamp checks passed. The installer signature also passed. Its 17,604 file/link entries matched staging, including executable modes.

`pkgbuild` printed twelve `write: Permission denied` warnings while returning success. The original source of those warnings remains unknown. Extraction completed and the complete byte/mode/link comparison passed. A signature check inside the restricted sandbox reported an invalid signature; both extracted apps passed the same verification outside the sandbox. Do not interpret that sandbox verdict as package corruption or suppress real failures in a signing-capable environment.

The staged signed app actually launched through the computer-use tool and displayed its native **Welcome to Josi** window, local/remote connection controls and the existing public server receipt version `0.1.78-macos.17`. This is evidence of launch and receipt reading, not server health or functional acceptance. The staging app cannot manage services because it is outside `/Applications/Josi.app`. No installer or uninstaller was run, no provider call was made, and no live server data was changed.

## Remaining work

Native administrator settings, device enrollment and protected approval coordination, full work-memory/task detail controls, provider-specific subscription setup parity and automation-desktop integration remain open. Existing CE web and remote APIs are retained. Authenticated sessions are currently memory-only; a durable client session must use the accepted Vault authority design.

Functional setup/login/chat, service operations, real upgrade/recovery and uninstallation acceptance remain unverified. Notarization and final release acceptance are outstanding. The owner asked to defer functional suites until features are built; the targeted launch and packaged-signature checks address the immediate broken-app report.
