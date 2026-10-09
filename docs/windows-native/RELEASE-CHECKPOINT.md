# Native Windows engineering checkpoint

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
