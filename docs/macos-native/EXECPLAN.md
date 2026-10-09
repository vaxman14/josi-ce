> Historical preimplementation audit retained from checkpoint a7febd0.
> The implementation and scanner decision are now recorded in
> [IMPLEMENTATION.md](IMPLEMENTATION.md) and
> [RELEASE-CHECKPOINT.md](RELEASE-CHECKPOINT.md). Statements below about pending
> implementation describe that earlier checkpoint, not the current candidate.

# Native macOS architecture and continuation audit

Baseline: Windows-native `bb2d6ef6b6d5e2873ecb1fcd85966a7e0495f3bf`;
continuation starts at `fd6af57c981c9923bc11caaf5a2d317a6d1f9743` on
`macos/native-distribution-20261009`. This is an implementation checkpoint,
**not a completed distribution or approval to install it**.

## Audit findings and reuse boundaries

| Area / source reviewed | Guarantee to preserve / macOS work |
| --- | --- |
| Windows EXECPLAN and RELEASE-CHECKPOINT | The accepted `.5`, failed `.6` and fixed `.7` are different evidence sets. The last checkpoint closed stale pre-quiescence intent without restoring SQL. Do not transplant Windows physical acceptance claims to macOS. Public license/source closure remains incomplete. |
| JosiWindows.iss, Initialize-NativeSetup.ps1, Invoke-NativeSetup.ps1 | Bind executable installer, kit, manifest and every offline payload by hash before privilege or extraction. Mac needs an arm64 AppKit installer and a fixed privileged helper, with no user-supplied command execution. Developer ID Application can sign the app; do not use that identity as a Developer ID Installer certificate for a flat pkg. |
| Payloads.psm1, upstream-lock.json and build scripts | Cache reuse rehashes bytes; remote catalogs require independent trust. Archive traversal, duplicate/case-colliding names, links, special files, unlisted files and size expansion must be rejected. Windows EXEs and Linux archives cannot become macOS runtimes merely by changing their names. |
| Services.psm1, DataLayout.psm1 | Six distinct service identities; web/worker share only intentional application authority, proxy has no secrets, database owns cluster, voice/control are separate. Mac needs root-owned LaunchDaemons with non-login service users and narrow groups, no root API/worker and no interactive-user LaunchAgent substitute. Account collisions must refuse adoption. |
| Configuration.psm1, Runtime.mjs, PythonRuntime.py | Fixed entry points, scrubbed environment, file credentials and version checks. Migrations may run using retained old config; unactivated long-lived writers must refuse. API bind and `/data` translation were Windows-only: corrected in this checkpoint. Native secret reads now inspect macOS descriptor ownership, modes, extended ACLs, links and size. |
| Transactions.psm1, NativeFileAttributes.cs | Exclusive lifecycle lock; immutable sequenced hash-chained journal; durable intent before mutation; refuse incomplete earlier transaction. Port requires `flock`, descriptor-relative operations, exclusive publication, file and directory durability including macOS full flush. An atomic rename alone is not crash durability. Not implemented yet. |
| Maintenance.psm1, Lifecycle.psm1, Snapshot.mjs, nativeSnapshot.ts | Stop writers before snapshot; verify database plus artifact inventory and preserve credentials/permissions; migrations precede activation; readiness precedes commit. Native snapshot code explicitly uses Windows handles and must receive a real POSIX descriptor backend. Never remove the platform guard and treat that as a port. No automatic restore may discard post-snapshot data. Mac lifecycle implementation remains due. |
| Database.psm1, DatabaseBootstrap.mjs, packages/db/migrate.mjs | Initialize only an empty owned cluster under database identity. SCRAM loopback authentication, restricted application owner, revoke bootstrap login. Reuse all 65 numbered migration files and existing transaction-per-migration runner. Add native protected password reading at the migration boundary; prohibit ordinary runtime activation until migration completion. Mac PostgreSQL acquisition/build and isolated cluster tests remain due. |
| pgWriter.ts, backup.ts, restore code | Reuse database backup/restore semantics, preserving key separation and restricted-role restore. Mac native tools now require an absolute bundled directory and pass credentials via private `PGPASSFILE`, without inherited provider/libpq environment. Mac temporary directories clear inherited ACLs before private file creation. |
| API server, setup/publicAddress, readiness, worker/main | Reuse API, static web, worker queue, readiness and heartbeat. A running process is not healthy. Native API now binds 127.0.0.1; proxy, database and voice must do the same. launchd has no SCM dependency ordering: entry points must wait for readiness with bounded retries. Status utility deliberately reports running with health unverified. |
| launcher/JosiLauncher.cs, onboarding routes and web setup | Reuse authenticated launch endpoint, ten-minute one-use handoff, immediate fragment scrubbing, HttpOnly setup cookie, single owner and encrypted pending recovery confirmation. Mac GUI must launch the original user's default browser with a private document path, never a bearer token in argv, logs or plist. Failed launch needs a copyable link and fresh-link retry. Mac handoff implementation/tests remain due. |
| storage gates, nativeScanner.ts, nativeScannerHealth.ts, windows_amsi.py, hostChecks.ts | AMSI is Windows-only. Availability probes are not clean document verdicts. Required scanning must fail closed, including OCR/indexing/uploads. XProtect/Gatekeeper assessments do not substitute for per-document results. A scanner product decision is pending; do not disable the policy or report missing scanning as healthy. |
| localWorkspace.ts, localWorkspace tests | The non-Windows implementation traverses `/proc/self/fd`, which macOS does not provide. Twelve full-suite failures reproduce this. Port with real descriptor-relative `openat`/`renameat`/`linkat`/`unlinkat` and directory enumeration, keeping exact-scope approval, recovery copies, inode checks and rename-race tests. Substituting lexical paths or simply using `/dev/fd` is not an established equivalent. Not implemented yet; workspace operations fail closed. |
| voice-box gateway, windows_helper.py, PythonRuntime.py, model/requirements/source locks, LICENSES.md | Reuse Kokoro/Silero/Whisper CPU inference, bounded HTTP, separate control/gateway credentials, settings and rollback state. Extract SCM control from the manager, replace with a narrow macOS lifecycle mechanism; never grant web/control arbitrary launchctl/root access. Keep model hashes/licenses; Linux/Windows binary/source approval does not approve macOS wheels. No speech, microphone or audio acceptance yet. |
| StartupEvidence.psm1 and TEST-ME | Distinguish boot history, current process status, application health and physical acceptance. Read-only status tool queries exact proposed labels. No reboot evidence can be manufactured by restarting services. |

## Scanner decision required from Roman

Windows depends on an installed AMSI provider. Apple's documented
[XProtect mechanisms](https://support.apple.com/guide/security/sec469d47bd8/web)
and Endpoint Security detection events do not establish an AMSI-equivalent
per-document scan interface for this implementation. No undocumented XProtect
invocation or `spctl` success will be counted as a clean document verdict.

Choose either:

1. Bundle ClamAV and its updater, carrying pinned definitions, corresponding
   source and all applicable notices. This adds a maintained engine, update
   policy, storage footprint and potentially additional service identity/label.
   [ClamAV installation documentation](https://docs.clamav.net/manual/Installing.html)
   describes its native macOS artifacts; they must be extracted into the private
   payload, never installed system-wide during this build.
2. Keep native document ingestion blocked until a supported scanner is configured.
   This is an explicit product capability limitation requiring honest UI and
   readiness handling, not a silent security bypass.

This choice affects the final payload, service list, readiness, license/source
closure and acceptance checklist. Neither option is selected by elapsed time.
Signing remains a separate deferred gate; do not retry codesign until Roman
confirms the Keychain action. The source changes in this checkpoint do not depend
on that signing gate.

## Native permissions contract

Program, configuration and secret parent directories must be root-owned and not
group/world writable, with no extended ACL grants. Dedicated group-readable
secret files are root-owned 0640 and readable only by the service's primary
group; owner-only files are 0600 or 0400. Service groups must not contain unrelated
accounts. Separate root-owned copies may be provisioned for roles requiring the
same credential without merging their runtime identities. Secret readers traverse
every component with `openat`/`O_NOFOLLOW`, check the opened descriptor, reject
hardlinks and any extended ACL, and bound reads to 4096 bytes. An unreadable or
unsupported ACL query fails closed. Production owner trust is fixed to root.

Tests use an explicit temporary-directory anchor and the test user's uid/gid;
this bypass is not exported through the application package's public index.
It does not establish production installer permissions. JosiDrive's existing
group-writable ancestors are not modified to make tests pass.

## Remaining implementation and verification

- Build/pin/license-review arm64 PostgreSQL, Caddy, private Python, voice native
  dependencies/models, and the selected scanner. Audit Mach-O slices and every
  dylib/rpath; reject Homebrew/global developer runtime dependencies.
- Implement installer ownership records, service identities, launchd plists,
  environment sanitization, journals, migration gate, recovery and readiness.
- Implement the AppKit installer with an animated progress indicator and a
  monotonic elapsed-time label refreshed independently of subprocess output.
  Copy must say installation may take several minutes. Show phase and service;
  detect lost helper/EOF, preserve redacted diagnostics, never freeze on a long
  download, migration or model check. Add heartbeat, cancellation, stall and
  phase-transition regressions plus real UI acceptance.
- Preserve reusable browser onboarding; test actual packaged API/UI and native
  private-document handoff on disposable data.
- Produce a sealed offline unsigned acceptance app only after dependency and
  payload review. Include TEST-ME, complete source/license material, SBOM and
  checksum; exclude operational logs, databases, secrets and recovery evidence.
- Run packaged migrations, restore/rollback failure injection, listener and
  permission tests, actual OCR and CPU speech, scanner clean/blocked/unavailable
  cases, archive/SBOM/license inspection and malware/notarization preflight.
- Separately perform final SOCAL signing after the human Keychain gate, then
  deep/strict verification, Authority/TeamIdentifier inspection and Gatekeeper.
  Notarization submission, publication and physical install need later authority.

The only native executable built at this checkpoint is the read-only status
utility. It is not the server, installer, signed release or acceptance candidate.
