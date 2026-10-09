# Native macOS checkpoint — 2026-10-09

Status: source portability groundwork and architecture audit completed; native
distribution and acceptance artifact are still incomplete. A scanner product
decision is pending. Signing is deferred and was not retried. Do not treat either
the compiler probe or the new read-only status utility as a product build.

## Continuation checkpoint

The continuation explicitly allowed unsigned work despite the Keychain gate.
The branch already existed and was retained. No existing Josi application,
database, Keychain, service or artifact was changed.

Completed source work:

- Native API loopback binding, macOS translation of portable `/data` records.
- Descriptor-based macOS secret reads: root ownership, service-group modes,
  extended ACL inspection, no symlink traversal/hardlinks, bounded file size.
- Private temporary directory ACL removal before writing secrets/documents.
- Native macOS PostgreSQL tool path enforcement, clean child environment and
  private temporary pgpass transport with cleanup.
- Architecture/security/lifecycle audit and explicit remaining work in EXECPLAN.
- Read-only Swift status utility, pinned local Node build input and draft TEST-ME
  with separate clean-install and upgrade procedures and proposed service labels.

Verification:

- Official Node 24.15.0 darwin-arm64 archive SHA-256 matched its upstream list:
  `372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4`.
  Node and npm are isolated on JosiDrive, not globally installed.
- Final focused regressions: **25 passed**, including actual macOS ACL/link
  rejection and inherited-ACL removal, an ephemeral loopback listener, portable
  paths and a real fake-pg_dump child testing credential isolation. This is not
  PostgreSQL migration or backup/restore acceptance.
- TypeScript/API/package build plus web typecheck and production web build passed.
- Initial full application suite: **3,185 passed, 15 failed, 45 skipped** across
  168 files. Twelve failures are the Linux procfs workspace backend; two are
  container-oriented fixtures (missing Docker probe and GNU sed expectation).
  One permission regression from the in-progress source run does not reproduce
  in the final focused run. The full suite is **not green** and was not rerun.
  No Docker executable/container was run or installed.
- Production npm audit: three moderate advisories (argparse, mammoth, sprintf-js),
  no high/critical. Generated npm CycloneDX 1.5 inventory has 257 components; it
  is not a complete native release SBOM or license/source closure.
- Repository secret/public-data scan including new files passed (917 files).
- Full Xcode compiled the status utility as arm64 with only Apple system-library
  dependencies. Read-only launchctl queries found all six proposed labels absent.
  No label was registered or changed. No codesign invocation, final Authority/
  TeamIdentifier verification, Gatekeeper or notarization submission occurred.

Private evidence root remains the approved JosiDrive artifact directory.
Logs include `macos-focused-final-2.log`, `application-tests-continuation-1.log`,
`typecheck-continuation-3.log`, `web-build-continuation-1.log` and initial failures;
all earlier records were retained. Dependency reports are in `evidence/`.
The status utility that was executed is at
`status-tool-20261009T073047Z/josi-native-status`, SHA-256
`cd36d2ba6145597a96e1af9732459ff14363f129c826c8131d899ae55e0578a0`.
Its sibling files contain checksum, architecture, dylib and service-query evidence.
A second build using the direct full-Xcode compiler path is retained in
`status-tool-20261009T073406Z/`; its checksum is separate. Neither is an installer.

**Required product action:** choose whether to bundle ClamAV plus its signature
updater/source/license materials, or explicitly keep native document ingestion
blocked pending a supported scanner. See EXECPLAN for the security and service
implications. No default was selected while waiting for Roman's answer.

No unsigned or SOCAL-signed acceptance app/package exists yet, so there is no
acceptance checksum or concrete final app available to sign. The intended final
app name is `Josi CE Server Setup.app`. After completing the port and receiving
Roman's Keychain confirmation, sign each nested Mach-O component with the exact
SOCAL identity and its reviewed entitlements, then sign the enclosing app with:

```sh
/usr/bin/codesign --force --options runtime --timestamp \
  --sign 'Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)' \
  '/Volumes/JosiOS/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009/acceptance/Josi CE Server Setup.app'
```

That path is a future target, not a claim that an artifact exists. Do not use
`--deep` as a substitute for nested signing. Deep/strict verification and
Gatekeeper assessment follow signing; notarization submission remains separately
unauthorized. macOS launchd registration/lifecycle, packaged runtime, migration,
rollback, browser handoff, progress UI, OCR/scanner/speech, native SBOM/license/
archive/malware checks, clean install, upgrade, reboot, microphone/speaker, LAN
and physical acceptance all remain unverified. Nothing was pushed, published,
notarized or installed system-wide.

## Historical signing preflight

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
or disable Keychain protections globally. Retry signing only after this human gate;
the continuation above authorized independent unsigned work.

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
