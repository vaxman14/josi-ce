# Native macOS unsigned acceptance checkpoint — 2026-10-09

Branch: `macos/native-distribution-20261009`. This continuation implements the
native distribution from clean checkpoint `a7febd0`, preserving the Windows
baseline `bb2d6ef6b6d5e2873ecb1fcd85966a7e0495f3bf` architecture. See
[IMPLEMENTATION.md](IMPLEMENTATION.md) for the completed architecture/security
audit and [TEST-ME](../../packaging/macos/TEST-ME.txt) for physical procedures.
The earlier EXECPLAN is retained as historical preimplementation evidence.

Roman's scanner decision is implemented: **no ClamAV is bundled**. Native
upload/ingestion/OCR fail closed unless an explicitly configured, protected,
healthy scanner returns a clean verdict for the exact document. Availability
alone never authorizes parsing. The installer can finish with ingestion blocked;
the UI explains the block and cannot disable the enforced native policy.

The real AppKit application is `Josi CE Server Setup.app`, arm64, macOS 14+.
It packages private Node 24.15.0, PostgreSQL 16.15, CPython 3.11.15, Caddy 2.11.7,
offline CPU Kokoro/Silero/Whisper, OCR and native application dependencies.
Pinned hashes, original notices and the SBOM accompany the runtime. Exact
corresponding source archives ship as a separately checksummed companion ZIP so
Apple notarization does not recursively treat upstream source/test fixtures as
executable runtime payload. There is no dependency on a global runtime or
package manager.

Implemented: six isolated launchd identities; protected secrets and ACLs;
local-only listeners; live installer phase/service and elapsed progress;
immutable durable transaction journal; cold verified rollback snapshot;
65 migrations before activation; readiness and owned-PID listener checks;
conservative recovery that never automatically discards postactivation writes;
authenticated CSRF-protected single-use browser handoff; descriptor-relative
macOS workspace operations; saved CPU speech enablement and restart handling.

## Local verification

- Applicable full suite: **3,203 passed, 47 skipped**, repeated after final
  application edits (`full-suite-3.log`). All 15 prior failures were investigated:
  12 procfs portability failures fixed, one secret/ACL regression verified fixed,
  and only two specific Linux/container fixtures narrowly skipped on non-Linux.
  No product security assertion was weakened.
- Final focused macOS regressions: **96 passed**; lifecycle **9 passed**;
  Darwin speech restart regression passed for both server classes; Swift
  progress regressions **7 passed**. Typecheck and production web build passed.
- Isolated packaged acceptance (`package-tests-5.log`) passed all six real
  processes, loopback ownership, 65 migrations, CPU speech synthesis/VAD/
  transcription, Argon2/canvas, offline OCR, HEIF conversion, missing-scanner
  denial, native Swift/browser handoff and replay denial, injected migration
  failure with verified snapshot recovery, and a separate isolated upgrade
  retaining a database sentinel. All owned test children were stopped.
- Runtime inspection: 241 Mach-O runtime files are arm64 with no external
  library/build-prefix dependencies. Source/license closure includes 787 source
  archives, 1,757 notice sections and a combined 494-component CycloneDX SBOM.
  Final packaging additionally includes this repository's committed source.
- Secret scan including new source passed. Production npm audit has no
  high/critical findings; one inherited moderate sprintf-js advisory reaches
  Mammoth's unused CLI through argparse. Josi invokes Mammoth's library API,
  not that CLI. This is recorded rather than described as a clean audit.
- All six production launchd labels are **NOT REGISTERED**. No live installation
  was performed. Isolated process tests do not establish root account/ACL,
  launchd reboot or physical acceptance.

## Artifact and evidence contract

`scripts/macos/finalize.py` requires a clean local commit and produces a unique
`unsigned-acceptance-<UTC timestamp>/` directory below:

`/Volumes/JosiOS/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009/`

It contains the app, `Josi-CE-Server-macos-arm64-unsigned.zip`, the separately
verified `Josi-CE-Server-macos-arm64-corresponding-sources.zip`, `SHA256SUMS.txt`,
`SOURCE-COMMIT.txt`, `TEST-ME.txt`, native dependency inventory and private
`evidence/`. Every installer ZIP member is compared with the app, every source
ZIP member is compared with its staging tree, paths/links are checked, and
private operational evidence is excluded. The final report provides exact
paths; `SOURCE-COMMIT.txt` is the authoritative packaged revision.
Build/test logs and failed intermediate runs are retained outside the installer.

Unsigned Gatekeeper/stapler results are evidence of current rejection/no ticket,
not signature acceptance. Source/hash/archive and native platform preflight do
not constitute a malware-engine clean verdict. No scanner is bundled or invoked
as a substitute for explicit document scanning.

## Remaining human and physical gates

Signing has **not been retried**. The historical isolated compiler-probe attempt
with the required SOCAL identity failed once with `errSecInternalComponent`.
Roman must log into the Mac graphical session, unlock the login Keychain, and
approve `/usr/bin/codesign` access to the private key under **Developer ID
Application: Socal Receptionist LLC (LRH75YR6QW)**. Verify that the certificate
has its matching private key. Do not substitute any other identity or disable
Keychain protections. Roman must confirm completion before another attempt.

After that confirmation, use the private Python with:

```sh
/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/prefix/python/bin/python3.11 -B scripts/macos/sign-candidate.py --roman-keychain-approved '/absolute/path/to/unsigned-acceptance-TIMESTAMP/Josi CE Server Setup.app'
```

The script creates a separate signed copy, signs nested Mach-O files with the
exact identity, hardened runtime and timestamps, refreshes the manifest, signs
the outer app, verifies deep/strict signatures and every Authority/TeamIdentifier,
and records Gatekeeper's actual result. It stops at the first signing failure.
It does not submit notarization; that requires Roman's separate approval.

Still unverified: SOCAL signatures/timestamps and Gatekeeper acceptance;
notarization; actual clean installation and actual upgrade (separate TEST-ME
procedures); reboot/launchd, privileged identities/ACLs, physical default-browser
handoff, microphone/speaker/privacy permissions, LAN and a real configured
scanner. No claim of physical acceptance is made.

Nothing was pushed, published, submitted for notarization or installed
system-wide. Existing Josi apps, data, Keychains and artifacts were preserved.
