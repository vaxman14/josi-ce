# Native macOS checkpoint — 2026-10-09

Status: blocked at signing preflight; port implementation and acceptance artifact
are not complete. Do not treat the compiler probe as a product build.

Requested branch: `macos/native-distribution-20261009`.
Verified starting revision: `bb2d6ef6b6d5e2873ecb1fcd85966a7e0495f3bf`.
Host architecture: arm64. Full Xcode was selected per process with
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`; global xcode-select
was not changed. A minimal arm64 executable compiled with Xcode clang and its
MacOSX26.5 SDK after explicitly supplying the SDK sysroot. Build scratch and
compiler cache paths were on the external JosiDrive.

Read-only identity discovery outside the sandbox confirmed the exact required
identity, `Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)`.
One signing attempt on the isolated compiler probe used `--options runtime`
and `--timestamp`. It exited 1 with `errSecInternalComponent`. No retry or
alternative identity was used. The sandbox-only identity query had returned zero
identities; that result does not establish that the certificate is missing.

Required human action: log into the Mac's graphical session, unlock the login
Keychain, and approve `/usr/bin/codesign` access to the private key belonging to
the exact SOCAL Developer ID Application certificate when prompted. If access
still fails, verify in Keychain Access that this certificate has its matching
private key and permits codesign access. Do not substitute a different identity
or disable Keychain protections globally. Resume only after this human gate.

Local evidence root:
`/Volumes/JosiOS/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009/`.
Isolated probe:
`/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/signing-preflight/`.
Private operational evidence belongs outside source control and installer payloads.

Repository guidance, Windows-native plan and current release checkpoint were
reviewed initially. The full architecture/security/lifecycle audit remains due.
Reuse the existing API, worker, migrations, browser setup/recovery and backup
semantics; the Windows checkpoint records unresolved license/source closure and
must not be interpreted as approval to redistribute all Windows dependencies.

No macOS service labels have been implemented or installed. No product runtime,
unit/integration, migration, rollback, browser, local-listener, security, malware,
SBOM/license or package inspection gates have passed in this run. Deep/strict
signature verification, Authority/TeamIdentifier inspection and Gatekeeper
assessment of a final product remain pending. Clean-install and upgrade
acceptance must be separate; neither was performed. Reboot, microphone/speaker,
LAN and physical acceptance remain unverified. No acceptance artifact or checksum
exists. Nothing was pushed, published, notarization-submitted, installed system-wide,
or changed in an existing Josi installation.
