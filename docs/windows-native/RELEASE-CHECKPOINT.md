# Native Windows engineering checkpoint

## Saved transaction-closure checkpoint — 2026-10-09

Roman explicitly approved closure of only the retained failed `.6` transaction.
The operation inventoried its three original records and verified all six installed
`.5` services before the first live write. It appended only these immutable,
hash-chained records in transaction `f8ecac89e0c846d1bcc87c0f04f69696`:

- `0004.json`: `rolling-back`, SHA-256
  `3b8b16ab34abb631365ace39b2d74b6017784e171df38ad9136b97ad523fc57c`.
- `0005.json`: `rolled-back`, SHA-256
  `73fbbed141af015caf23744fad8554600c1b885a51cce69c8a947939e12b3c8d`.

These close stale installer intent; no service/filesystem rollback or SQL restore
was needed. The transaction directory's modification timestamp advanced as expected
when the new records were published. Its ACL and all original record bytes, ACLs
and creation/write timestamps remained unchanged. The existing lifecycle lock's
bytes and ACL remained unchanged. All six `.5` services passed after closure with
the same process IDs and configuration. Application/database readiness, worker
heartbeat, CPU speech/control readiness and local-only listeners passed before and
after. Protected configuration/secrets and directory ownership/permissions matched.
All 19 original recovery-file hashes, seven delivered `.6` checksum entries and the
delivered `.7` EXE hash were verified. No file was deleted; all staged `.5`/`.6`
artifacts, dumps, snapshots and logs were retained. No live SQL client was used.

The first elevated launch did not reach preflight because the ISO UTC expiry
argument lost its formatting. Explicit quoted ISO UTC plus exact parsing fixed
the launch; an OS PowerShell guard regression passed and the second UAC operation
completed. This was an operational script correction, not an installer rebuild.

Detailed evidence remains local under ignored `artifacts/windows-native/`:
`evidence/native6-transaction-closure.json` and
`test-installations/native6-closure-806f261dbaff4fceb585bb3f5b8d28b1/`
contain the reviewed one-shot script, before/after/result records and verified
copies of the three original checkpoints. Databases, secrets, packages, private
evidence and recovery material are deliberately excluded from the Git checkpoint.

The stale transaction blocker is cleared. **Running `.7` still requires Roman's
separate approval.** `.7` has not been installed or uninstalled. No reboot, signing,
publication or security-setting change was performed. This save request authorizes
pushing the current source/documentation branch to GitHub; it does not authorize
deployment or a release. The existing unsigned candidate and acceptance folder
remain unchanged; no rebuild is necessary for this documentation checkpoint.

## Failed `.6` diagnosis and `.7` candidate — 2026-10-08

Roman's physical `.6` upgrade failed before service quiescence, not because a
runtime service failed readiness. Read-only elevated inspection found all six
services running with restricted identities and `.5` paths, zero exit codes,
successful direct/proxy readiness, healthy CPU speech and all five listeners on
127.0.0.1. The live configuration remains `.5`. No SQL client, installation,
uninstallation, recovery, service/configuration change or SQL restore was performed.

Transaction `f8ecac89e0c846d1bcc87c0f04f69696` reached `verified` and then
`recovery-required` 22 milliseconds later. It never reached `quiesced`, snapshot,
migration or activation. The first attempted operation was `Stop-NativeService
JosiProxy`: a fresh OS PowerShell 5.1 process does not load `System.ServiceProcess`
until requested. Constructing `ServiceController` therefore raises `TypeNotFound`
before querying or stopping the service. A fresh-process regression reproduces
this against the retained `.6` module and passes against the fixed module, with no
`Get-Service` warmup or SCM operations. This identifies the failing code path from
reproduction and the retained journal; the old installer did not retain the
underlying exception. `Runtime error (at 14:1329)` is the installer wrapper.

The module now explicitly loads the OS assembly. Failed setup also writes a
bounded, redacted, create-only failure summary containing stage, service and error
type/ID/line, never exception messages, arguments, SQL or credentials. The summary
is supplemental to the journal; sequence/hash validation remains strict and
unknown JSON files are still refused. Version metadata is derived from the
candidate, so the new EXE reports `0.1.78.7` rather than the old hardcoded `.6`.

New **unsigned**, private candidate:
`C:\Users\Roman\OneDrive\Desktop\Josi-Windows-Acceptance\native.7\Josi-CE-0.1.78-native.7-Windows-x64-acceptance.exe`
(2,348,157 bytes; Authenticode `NotSigned`; product version `0.1.78-native.7`).
SHA-256: `a1d9ae9d038ad80f68168e6af4377ac426e5417c8599830310159a99d7a1f080`.
Its checksum, TEST-ME, SBOM, license-gap record and six offline archives are beside
it. Existing `.6` delivery and `.5`/original dumps/recovery material are preserved.
The source build records parent revision `38c6775a0dcc7b8472884efa68502127a14703d5`
plus source inventory `c62c743f2c3adb9df656f93a4b73535ce58d25537eead941322c3ee281397011`;
that parent revision is not a claim that the subsequent fix commit was the build
revision. Five unchanged runtime archives were reused after full byte validation.

Validation performed for `.7`:

- Application dependency install, TypeScript/API/web checks, production web build,
  production dependency/SBOM generation and native-addon runtime check passed.
- `Test-InstallerServiceBootstrap.ps1`: two fresh OS PowerShell 5.1 probes passed,
  including reproduction against retained `.6`, with no service changes.
- `Test-Transactions.ps1`: journal/reopen/hash-chain tests and nine invalid-operation
  refusals passed; supplemental diagnostics do not change checkpoint validation.
- `Test-OnboardingRuntime.mjs`: actual packaged API/UI, 63-to-65 migration before
  activation, unactivated-writer refusal, retained rows/secrets/existing table
  ownership/grants, exact owner-only grants for four additive tables, readiness,
  single-owner creation, token scrubbing, HttpOnly session, recovery confirmation
  and fresh-link model-step resumption passed in a disposable cluster/Chrome.
  The first run exposed an outdated whole-inventory equality assertion; it was
  corrected to test old grants unchanged plus exact new-table grants, then passed.
- Installer kit: 16 embedded files load in OS PowerShell 5.1; four integrity
  rejection checks passed. Production EXE `/CURRENTUSER /VERIFYONLY` passed,
  seven unsafe archive boundaries were refused, and service state/disposable
  data/ACLs remained unchanged. This does not constitute a physical installation.
- 18,568 application/runtime files hashed and six archives fully checked, including
  inventory/hash/CRC checks. Native ClamAV binaries/services/definitions/downloads/
  ports and container recipes remain excluded.
- CycloneDX 1.6 schema/formats, 354 components, graph references, 475 notices and
  retained source hashes validated. Public license/source closure remains **false**.
- Explicit full-buffer AMSI scans returned **clean** for the final EXE, launcher,
  native helper and WinSW. Large ZIPs have integrity checks; full ZIP AMSI scanning
  is not claimed. No unavailable/failed scan is reported as clean.
- EXE metadata/checksum and every delivery copy verified. All 19 preserved original
  material hashes and previous `.6` delivery checksums matched. Public-data/secret
  scan passed. No claim is made that a running database's background bytes froze.

Evidence under `artifacts/windows-native/`: read-only inspection at
`test-installations/native6-failure-readonly-73c4d41efebe4852a793a72333d68304/result.json`;
`evidence/native7-root-cause.json`, `native7-service-bootstrap-regression.json`,
`native7-verification.json`, `transaction-journal.json`, `onboarding-runtime.json`,
`installer-kit-tests.json`, `onboarding-installer-tests.json`,
`native-package-inspection.json`, `release-sbom-validation.json`,
`onboarding-malware.json`, `onboarding-exe-metadata.json`, `onboarding-delivery.json`.
Earlier `.6` pointer records were retained byte-for-byte in the directory identified
by `evidence/native7-preserved-candidate6.json` before recording `.7` results.

**Next human gate:** separately approve running `.7`; the retained failed `.6`
transaction was losslessly closed as recorded above. Do not delete that transaction
or restore SQL; preserve the staged `.6` directory and all journal/recovery material.
The agent has not installed `.7`. Then Roman performs the
normal EXE/UAC and physical acceptance, plus clean-install testing on a separate
PC/VM. Browser/provider login, hardware audio and second-device LAN remain physical
gates; historical startup ordering remains a supplemental evidence gap. Three
moderate dependency advisories, unsigned status and public legal/source gaps remain.
Desktop bundling waits for successful `.7` native-server acceptance. No push,
signing, publication, reboot or Windows security-setting change was performed during
candidate creation. The later save request separately authorizes the GitHub push.

## PC-control permission source phase — 2026-10-08

Administration now includes PC control permissions: master off by default, 23
independent capabilities, exact browser/profile/origin and folder/application
scopes, all five modes, bounded task/temporary grants, separate per-action high-risk
decisions with owner-password confirmation, encrypted local policy/audit storage,
readable activity and key-independent emergency disable. Revocation invalidates
queued approvals and cancels active broker signals. Existing workspace/connector
policies remain unchanged. The additive 0065 migration is not applied to live data.

This source phase has no production PC executor. The UI states that control is
unavailable until the separate Windows desktop client connects. No fake successful
control, automatic administrator approval, UAC bypass or security-setting change
is claimed. Full design/contract and independent desktop-component acceptance plan:
[PC-CONTROL.md](PC-CONTROL.md). Bundling starts only after Roman's `.7` native-server
acceptance, with Hosting Server required and Desktop App selected by default but
optional. Server data and accounts remain canonical and independent of client
maintenance. `.5`, the delivered unsigned `.6` EXE and all payload/recovery artifacts
remain preserved; this phase does not rebuild, install or uninstall either candidate.

Focused evidence is `pc-control-core-tests.json`, `pc-control-http-tests.json` and
`pc-control-verification.json` under `artifacts/windows-native/evidence/`. These
records cover disposable-database policies and the actual browser settings UI;
they do not establish physical desktop-control or client lifecycle acceptance.

Final verification: **47 passed, zero failed** (30 new core permission tests,
five authenticated HTTP/real headless-Chrome checks, 12 existing approval-policy
regressions). Root API/package TypeScript compilation, web typecheck and production
web build pass. The public-data/secret scanner passes across 904 files. Hashes of
19 preserved original/recovery files and every delivered `.6` EXE/payload match.
No live database connection, service operation, PC control, UAC, signing or push
was performed. First-run fixture issues (single-super-admin rule, Windows sandbox
multi-file cache and durable-switch timing) were corrected; browser acceptance
also exposed select labels that were fixed with explicit accessible associations.

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
