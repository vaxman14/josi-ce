# Native Windows engineering checkpoint

## Continuous browser onboarding candidate `.6` — 2026-10-08

The new `0.1.78-native.6` is a private, **unsigned** offline acceptance candidate.
The accepted installed `.5` and its artifacts remain the baseline. No `.6`
installation/uninstallation, live database connection, SQL restore, secret rotation,
service change, reboot, firewall change, signing, push or publication was performed.

The production Inno entry installs or upgrades through the existing transaction
host, waits for database/API/proxy and all six services, then starts the separate
Windows launcher as the original non-elevated user. The Finish message is:
“Installation complete. Finish setting up Josi in your browser.” The Start-menu
Josi shortcut uses the same launcher to resume incomplete setup. Installation
requires normal Windows administrator consent; the read-only EXE verifier uses
`/CURRENTUSER /VERIFYONLY` and cannot install.

The launcher keeps the existing ACL-protected bootstrap document/configuration
unchanged, authenticates an explicit launch request in memory, and retrieves a
random, ten-minute, single-use capability. Default HTTP-browser association receives
only a user-private temporary HTML path, not the capability as a process argument.
The browser scrubs the fragment before React renders, consumes the capability under
the existing CSRF guard and receives an HttpOnly, SameSite=Strict setup-only cookie
with an eight-hour bound. Restart invalidates capabilities/cookies; fresh launcher
links resume persisted wizard answers. Browser-launch failure exposes one copyable
private link with Retry; Retry mints a fresh link. Temporary handoff documents have
protected ACLs and bounded cleanup. No token, password or recovery key enters logs.

Owner creation, vault initialization and owner-step progress commit atomically.
An owner left by an older interrupted setup must prove their existing password
before resuming; their account and vault values remain unchanged. Migration 0064
adds a nullable encrypted pending-recovery field without changing existing wraps,
ownership or permissions. New recovery keys can be presented again until confirmation,
then the pending presentation is cleared. Older unconfirmed keys that were never
retained cannot be recreated automatically. Native setup imports the installed
local address without replacing an existing address. Completion leads to ordinary
owner sign-in and Getting started, with optional service connections and an honest
companion-device availability explanation. No compatible companion build/pairing
is invented. Native malware scanning remains explicit Windows AMSI; Docker/Linux
antivirus behavior is unchanged and no native engine or definitions are bundled.

Automated evidence (under `artifacts/windows-native/evidence/`):

- `onboarding-focused-tests-final.json`: 106 passing tests across setup, verification,
  setup UI, handoff capabilities and native antivirus policy; zero failures.
- `onboarding-csrf-race-after.json`: one passing regression. The before record
  reproduced two concurrent CSRF requests; sharing initialization fixes the race.
  Total focused checks: 107. Root/API and web TypeScript checks pass.
- `onboarding-launcher.json`: net462 x64 GUI build and executable tests pass for
  readiness waiting/cancellation, link generation, completed-install behavior,
  errors, browser launch success/failure, actual fallback form, fresh-link retry,
  private-document ACLs and cleanup. No end-user compiler/SDK is required.
- `onboarding-runtime.json`: final compiled API/UI in a fresh disposable PostgreSQL
  cluster and headless Chrome. Real 63-to-64 migration before activation; unactivated
  writer refusal; retained fixture rows, grants and secrets; owner creation once;
  immediate fragment scrubbing; no browser token storage; HttpOnly cookie; recovery
  presentation survives reload; unchanged recovery wraps; fresh link resumes the
  model step. No fixed live ports or SCM operations are used.
- `installer-kit-tests.json`: all 16 embedded files load using OS PowerShell 5.1;
  four integrity rejection checks pass. `initial-configuration.json`: actual Caddy
  adaptation confirms local-only listeners.
- `native-package-inspection.json`: 18,565 application/runtime files hashed; native
  antivirus engine/services/definitions/downloads/ports and container recipes excluded.
- `release-sbom-validation.json`: CycloneDX 1.6 official schema and every format,
  354 components, unique identities/resolved graph, bad URI/timestamp rejection.
  Metadata validates 472 third-party notice files, three tested launcher source
  inputs and 71 retained source archives. Public license/source closure remains false.
- Final installer integrity, AMSI, delivery and preserved-original verification are
  recorded in `onboarding-installer-tests.json`, `onboarding-malware.json`,
  `onboarding-delivery.json` and `onboarding-preserved-inputs.json`.

The offline installer requires its six hash-bound ZIPs in the adjacent `payloads`
folder. No unpublished download or unsigned remote-catalog fallback is used. Only
explicit private offline acceptance permits installation without signing/public
license closure; signed remote-release gates remain enforced. Final EXE metadata,
SHA-256 and artifact location are in `onboarding-installer.json` and the delivery
record. Acceptance instructions are maintained in `packaging/windows/TEST-ME.txt`.

Delivered EXE:
`C:\Users\Roman\OneDrive\Desktop\Josi-Windows-Acceptance\Josi-CE-0.1.78-native.6-Windows-x64-acceptance.exe`
(2,347,953 bytes; file version `0.1.78.6`; Authenticode `NotSigned`). SHA-256:
`2e18621152f8c637ca4d6ec5ebeff79ed3c82e62bd85fcc948d534eb6e5509d7`.
The matching `.exe.sha256`, `SHA256SUMS.txt`, `TEST-ME.txt`, SBOM, license-gap record
and six `payloads` ZIPs are beside it. All delivered copies were hash-verified.
Final EXE read-only verification, local-cache reuse/tamper rejection and seven
archive-boundary rejections passed; installed service state remained unchanged.
AMSI returned **clean** for four explicit full-buffer scans: EXE, launcher, setup
bridge and service host. Preserved `.5`, original logical-dump and recovery-evidence
hashes matched after packaging/delivery. No physical acceptance is inferred.

Initial test issues are retained: sandbox loopback denial; an obsolete telemetry
allowlist rejecting fixed local metadata; a fixture contact missing its required
owner; an EXE version-string padding assertion; and a JSON BOM parser assumption.
These were corrected with focused reruns. Application rebuilds were limited to the
concrete owner-interruption and reproduced CSRF fixes. Five unchanged runtime ZIPs
are reused byte-for-byte after the final browser change.

Remaining acceptance: Roman's physical clean install on a separate PC/VM, upgrade
of accepted `.5`, original-user/default-browser behavior and UAC. Real provider
authentication, microphone/playback and second-device LAN remain unverified.
Listeners stay local-only. Historical startup-event ordering remains a supplemental
evidence gap. Existing license/source/Microsoft-recipient review gaps and three
moderate npm audit advisories (argparse, mammoth, sprintf-js; zero high/critical)
remain recorded, without dependency downgrades or public release approval. AMSI
evidence covers full EXE/embedded binaries; large payload archives have full hash,
inventory and CRC checks and are not claimed as fully AMSI-scanned.

The preserved-original record verifies accepted `.5` EXE, both original logical
dumps and recovery/ownership evidence hashes. Builds/tests never open installed
private data for writing. This is not a fresh byte comparison of a running database;
the accepted services may continue their normal housekeeping.

The accepted installed payload remains `0.1.78-native.5`. It is unsigned and
accepted for engineering use. There is no approved signed public Windows release.
The lossless `.4` transaction repair, single `.5` physical upgrade and reboot
runtime acceptance are preserved. No SQL restore, cluster replacement, secret
rotation, artifact replacement or live uninstall occurred during this continuation.

## Completed acceptance

- Post-reboot runtime acceptance: five automatic services and control-started
  speech, all six ready, five loopback listeners, preserved database/schema/
  permissions/secrets/artifacts/snapshots. Historical startup order remains
  unconfirmed: SCM event 7036 retrieval returned no matching events. The check
  distinguishes unavailable history from a query/access failure and never enables
  auditing or changes service configuration.
- `Test-NativeLifecycle.ps1`: one isolated real SCM fixture. A damaged Node binary
  was repaired with the original retained, service restart passed, untrusted repair
  inventory and unlisted uninstall files were refused before stopping services,
  uninstall removed the fixture service/runtime and retained sentinel data and ACLs.
  This is not full six-service thin-EXE lifecycle acceptance.
- `Test-NativeDiagnostics.ps1`: readiness, restricted identities, loopback listeners,
  CPU speech, fresh AMSI state, exact absence of all four protected secret values
  from export, refusal to overwrite installed data or an existing export.
- `Test-InstallerKit.ps1`: OS PowerShell 5.1 precompiled loading and four integrity
  rejection checks, now covering 15 embedded files. No end-user SDK/compiler needed.
- `Test-ReleaseSbom.mjs`: all 353 component identities and dependency references;
  CycloneDX 1.6 official schema plus every declared format; malformed URI and
  timestamp rejected. Validators are pinned to Ajv 8.20.0, ajv-formats 3.0.1 and
  ajv-formats-draft2019 1.6.1. Developer-only tools are outside runtime payloads.
- `Build-ReleaseAssets.py`: all 18,563 accepted files rehashed; six exact-version
  archives generated and read back with complete member/CRC verification. No
  antivirus engine, definitions, updater, service or port added. Native scanning
  continues to explicitly request AMSI from the locally installed provider and
  preserves clean/blocked/error/unavailable semantics. Failed/unavailable is never clean.
- `Test-NativeBootstrap.ps1`: physical read-only preview EXE ran without UAC;
  embedded kit/manifest verified, changed manifest and unsigned catalog refused,
  all four mutation operations stopped at the release gate, valid archive namespace
  accepted and seven unsafe archive cases refused before any extraction. The
  accepted six-service state was unchanged.

The preview EXE is 2,339,564 bytes with SHA-256
`715c37b34d269726afb0e3f18fef241306941bf8a339738a83b94fa02c87ec53`.
The concrete first EXE check failed because the 32-bit Inno bootstrap selected
32-bit PowerShell; it now selects native 64-bit OS PowerShell explicitly. The EXE
was rebuilt once for that failure. Test-runner exit-code handling and explicit
ZIP assembly loading were also corrected for OS PowerShell 5.1. The application
and accepted runtime were not rebuilt.

## One-approval grouping

Windows UAC does not grant an all-future approval. One temporary session grouped
the approved fixed lifecycle/diagnostics/startup checks. Unknown commands, wrong
session identities and additional request fields were rejected. The session is
closed. No permanent administrator task/service or UAC policy change was made.

Future session source snapshots use an administrator/SYSTEM-only protected parent
under ProgramData, avoiding writable workspace ancestors. Five in-memory ACL
boundary cases and OS PowerShell syntax passed. The hardened source-location
variant has not yet had its next physical UAC session; that limitation is explicit.
Changing the frozen source or allowed actions requires another reviewed approval.

## Local artifacts

All paths below are relative to ignored `artifacts/windows-native/`.

| Artifact | Path |
| --- | --- |
| Accepted upgrade | `evidence/native-candidate-acceptance.json` |
| Accepted reboot interpretation | `evidence/native-reboot-acceptance.json` |
| Original reboot run | `test-installations/reboot-acceptance-ca27d6e8e87e47b9b761d0f7ce12b5dc/result.json` |
| Isolated lifecycle | `evidence/native-lifecycle-accepted.json` |
| Diagnostics | `evidence/native-diagnostics-accepted.json` |
| SBOM and notices | `staging/release-metadata-332807a4990e45fd8c916caa7c0783f6/` |
| Full schema evidence | `evidence/release-sbom-validation.json` |
| Six archives and unsigned manifest/catalog | `staging/release-assets-1b8a70d3cc7a423496e5cfa37d77501a/` |
| Thin preview EXE | `installers/thin-engineering-e23c186792944d7d81b2628d61b2884c/Josi-CE-0.1.78-native.5-Windows-x64-engineering.exe` |
| Bootstrap test evidence | `evidence/native-bootstrap-tests.json` |
| Latest combined gate state | `evidence/release-gates-after-bootstrap.json` |
| Additional exact LGPL source provenance | `evidence/libheif-source-review.json` |

## Unfinished gates

The production bootstrap mutation paths have not passed a full isolated six-service
install/upgrade/repair/uninstall cycle. They are blocked in this preview's manifest
and are not activated by its UI. No automatic rollback or signed-install acceptance
is claimed. The test preserves the accepted live installation rather than using it
as an uninstall fixture.

The license gate remains false. Buffers 0.1.1 has no license statement in exact
package metadata, and chainsaw's complete publisher notice remains unresolved.
Traverse's complete original MIT notice was verified and retained, closing its
notice gap. Four libheif wrapper/build/library/libde265 source archives are now
retained with immutable revisions/hashes, but artifact-specific decoder composition,
rebuild/replacement instructions and the final corresponding-source asset remain
unfinished. Native Python/Torch/ONNX, PostgreSQL/OpenSSL/ICU, Caddy embedded libraries,
patched-wheel reconstruction and Microsoft recipient terms still require closure.
472 notice files and 71 previously retained source archives were verified for the
SBOM staging; the four newer libheif archives are recorded separately, not silently
counted as approved source closure.

Browser, physical microphone/authenticated assistant/playback and second-device LAN
acceptance remain. Listeners stay local-only. No temporary LAN configuration or
firewall change has been made. Signing has not started while release gates remain
unfinished; an unsigned manifest catalog is prepared and verified locally. No Azure
login, certificate-key access, public upload or fresh-download reinstall is claimed.
