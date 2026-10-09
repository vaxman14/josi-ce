# Native Windows distribution execution plan

## Status and evidence standard

PC-control permissions phase, 2026-10-08: implement the encrypted exact-scope policy,
owner approval UI, activity log and fail-safe stop/broker boundary described in
[PC-CONTROL.md](PC-CONTROL.md). The desktop executor is unavailable in this checkout;
no desktop component is bundled or run. **Next bounded packaging phase begins only
after Roman accepts the current `.6` native-server candidate**: required Hosting
Server and default-selected optional Desktop App, independent client maintenance,
secure local pairing and trusted effect-manifest enforcement. Preserve the accepted
live `.5`, `.6` EXE/payloads, all data and recovery evidence. Migration 0065 is tested
only on disposable databases. No live deployment, installer rebuild or security
setting change is part of this permissions phase.

Persistent engineering work, started 2026-10-07 (America/Los_Angeles). The `.5`
unsigned engineering candidate is accepted; no signed Windows release is approved.
Planned controls below are requirements until supported by executable evidence.

Onboarding continuation, 2026-10-08: `.6` is a new private unsigned offline acceptance
candidate, separate from the installed accepted `.5`. Installer readiness and
original-user browser handoff, ten-minute single-use links, immediate scrubbing,
setup-only HttpOnly cookies, resumable encrypted recovery presentation, atomic owner
creation and authenticated interrupted-owner resumption are implemented. Focused
tests, disposable packaged-browser acceptance, installer integrity, SBOM/license
inventories, archive checks and explicit AMSI evidence are recorded in
RELEASE-CHECKPOINT.md. The final candidate must not be installed or uninstalled by
the agent. Roman's next gate is normal double-click/UAC and physical acceptance,
with a separate clean PC/VM for clean-install testing. Preserve the adjacent offline
payloads, `.5`, private data and all rollback/original-dump material. No signing,
push, publication or Windows security-setting changes are authorized by this work.

Baseline: `7e0842bfeb72d4a37d68fb990ad15eb1d748f9e8`, verified against
`git ls-remote origin refs/heads/main` after a fresh clone and fetch. Initial tree
was clean. Branch: `windows/native-distribution-20261007`. Workspace:
`C:\Users\Roman\OneDrive\Desktop\Josi_Win_Server_Native`. The user's revised
request explicitly selects this workspace instead of JosiDrive. Never alter the
other checkout at `C:\Users\Roman\josi-ce`.

Repository instructions: CONTRIBUTING.md, SECURITY.md, LICENSE, NOTICE and
TRADEMARK.md; no tracked AGENTS.md and no AGENTS.md found in workspace ancestors.
All large/generated output goes under ignored `artifacts/windows-native/` with
cache, tools, staging, test-installations, logs, screenshots, installers, symbols,
evidence and sources subdirectories. Installed product uses Program Files and
ProgramData. No GitHub Actions and no virtualization at build/test/runtime.

Host observed: Windows 11 Pro x64 build 26300, 66,191,249,408 bytes RAM, internal
NTFS volume with approximately 1.34 TB free; Node 24.15.0 and .NET SDK 10.0.202
already present as development tools. This is not proof of product compatibility
with other builds/editions. Runtime independence must be tested by process,
module, file, service and network evidence; never remove unrelated prerequisites.

## Milestones and next action

- [x] Locate authorized workspace, preserve other work, verify clean main baseline.
- [ ] M1: finish architecture/assumption audit and maintained-component preflight.
- [ ] M2: real native CPU Kokoro -> Silero -> Whisper inference, then microphone
  -> authenticated assistant -> local playback; prove all other native dependencies.
- [ ] M3: narrow portability adapters, service entry points, existing regression suite.
- [x] M4: private PostgreSQL/migrations, API, separate worker, proxy, voice, OCR, AV.
- [ ] M5: transactional install/upgrade/repair/rollback/backup/restore/uninstall.
- [ ] M6: locally build thin EXE; physical acceptance, failure injection and reboot.
- [ ] M7: existing local Azure Artifact Signing after unsigned acceptance; verify
  Authenticode/timestamp, Defender, freshly downloaded hashes and clean reinstall.

Immediate priority: finish the production thin-installer lifecycle and legal/source
closure, then browser/audio/LAN and signing gates. Isolated repair/uninstall and
diagnostics passed; the thin EXE is a read-only engineering preview. Earlier
implementation notes below are history.
The CPU voice build now works with workspace-local pinned Microsoft supplements;
the earlier Build Tools UAC request is no longer needed. A successful
import is insufficient. Linux CPU approval does not approve different Windows
artifacts. No public publishing before Roman approves the physically
tested, signed candidate. Stage release assets locally until that gate is met.

### Historical source checkpoint and preserved recovery state (2026-10-08)

The checkpoint contains source, build recipes, pinned dependencies, tests and
this plan. Secrets, databases, recovery snapshots, downloaded inputs, compiled
packages and temporary evidence remain outside Git under the ignored artifact
root or the protected installed-data folder. This is an engineering checkpoint,
not release approval or a claim that every lifecycle operation is complete.

Candidate `0.1.78-native.5` built and passed real private-runtime acceptance,
including explicit AMSI, OCR, CPU speech, backup verification and restore. Its
migration runner accepts the retained baseline configuration before activation;
unactivated web and worker processes still refuse to start. Source inventory:
`5a82dd3f048dbfb67c72daddf093373ff100e64690522b9a7c28fd171842783b`.
Package inspection verified 18,563 files with no bundled antivirus, definitions,
updater, antivirus service or antivirus port. Installer-kit loading and four
integrity rejection checks passed (`logs/installer-kit-tests3.log`).

The physical `.4` test proved stopped-writer backup, restricted-role SQL restore,
artifact restoration and service DACLs, readiness after restart, and rollback.
Its subsequent successful-upgrade attempt stopped before migrations because the
old configuration version did not match the new runtime. The fixed `.5` migration
entry passed the application test; the physical upgrade has not been rerun.
The unfinished `.4` journal is retained at `backup-verified`, with its receipt,
snapshot, baseline binaries and data. All six test registrations were removed.

Next action: inspect and recover that exact owned transaction, then rerun `.5`
physical upgrade. Recovery must first establish that retained snapshots and live
data match the recorded operation and no later data would be discarded. Do not
initialize the existing database, rotate secrets, discard snapshots, or infer
rollback success from a launched process. Elevated Windows access is required;
stop for Roman's UAC participation or any risk to existing data. The `.5` physical
test script's recovery path is pending that inspection and execution evidence.
Repair/uninstall, diagnostics, final thin EXE, legal/source closure, browser,
microphone/playback, reboot, LAN, signing and fresh-download reinstall remain.

### Bounded lossless recovery acceptance (2026-10-08)

The read-only logical comparison verified a copy of the stopped live cluster:
2,056 files and 76,816,927 bytes. All 148 tables, 129 rows, schema, sequence
state and 864 recorded ownership entries matched the retained SQL snapshot.
Timestamp representations differed across 19 tables but preserved the same
instants and all six fractional digits. Historical grants, database ACLs and
roles were not present in the snapshot; current permissions were captured.
All temporary instances and copied credentials were removed. Both logical
dumps, permission records, original byte/ACL inventories and source audits
remain private under the ignored logical-comparison artifact folders.

Roman authorized lossless transaction repair followed by one physical `.5`
upgrade. `Test-LosslessNativeUpgrade.ps1` is the current bounded acceptance
entry, replacing the older destructive synthetic restore path for this retained
installation. It must never initialize, restore SQL, replace the cluster,
rotate secrets, restore artifacts, or discard rollback material. It rechecks
the live offline bytes/ACLs, recreates baseline services, proves connectivity
and unchanged data/permissions, checks baseline readiness and closes only the
exact pre-migration `.4` journal. The `.5` path verifies installed payloads,
takes a fresh stopped-writer snapshot, runs migrations before activation and
checks all six services, loopback listeners, worker AMSI, clean/blocked AMSI
requests, OCR and CPU TTS/VAD/STT. Normal worker scheduling changes are limited
to the queue and schedules; all other rows, schema and permissions must match.
Existing successful rollback evidence is retained rather than repeating a SQL
restore over the preserved installation. Registration remains demand-start
until verified health; activation then enables automatic startup for five
services while leaving speech on demand. Only checks directly required by
these operations run. No passing application or regression suite is rebuilt
or repeated without a concrete implementation failure.

The baseline readiness check exposed two comparison details, both resolved
against retained dumps without restoring data: offset-only `timestamptz`
representations need the existing type-aware UTC normalization, and API address
reconciliation touches only `deployment_config.updated_at` when the address is
unchanged. Acceptance records that operational timestamp explicitly while
comparing every other deployment field. Baseline connectivity, all 63 recorded
migrations, schema/rows/sequences, permissions and readiness passed. The exact
`.4` journal reached `rolled-back` without SQL restore or artifact replacement.
The single `.5` physical upgrade is now committed and accepted as an unsigned
engineering candidate. Evidence: `evidence/native-candidate-acceptance.json` and
the private `lossless-upgrade-2b856e914b2f4fe38460d394744c0a2f` run. Both baseline
and candidate inventories verified 18,563 files. Migrations ran once before
activation, with all 63 already present and no schema changes. All six restricted
services, five loopback listeners, the Worker's explicit AMSI request, actual
clean/blocked AMSI requests, OCR, and CPU TTS/VAD/STT passed. All recorded database
permissions matched and all existing user rows remained intact. Normal runtime
changes were the readiness timestamp, four new housekeeping jobs, four advanced
next-run times, and the matching queue sequence advancement from 4 to 8. Every
original queue row remained unchanged. These concrete comparison classifications
were corrected offline from retained dumps; the upgrade and passing feature
checks were not rerun. No SQL restore, cluster replacement, secret rotation or
artifact replacement occurred. `.4` rollback material, the fresh `.5` snapshot,
secrets, artifacts, and both original logical dumps are retained.

After acceptance the changed installer kit was rebuilt once for the new startup
activation code; OS PowerShell loading and its four integrity rejection checks
passed. Five services now use automatic startup; speech remains on demand under
the control service. Registrations are retained and all services are stopped.
The next acceptance deliverable is actual reboot startup. Its boot baseline and
`Test-NativeReboot.ps1` are prepared; the latter only reads owned service state,
application/database readiness, loopback listeners, a fresh Worker AMSI result,
and CPU speech readiness. It refuses a same-boot run and performs no repair or
service mutation. Roman must perform the actual reboot before that check can
run. No reboot, browser owner setup, physical microphone/playback, LAN, signed
thin EXE or full release acceptance is claimed. Repair/uninstall, diagnostics,
final EXE, legal closure and the remaining physical gates remain unfinished.

### Evidence collected during the first implementation pass

### Post-reboot acceptance and resumed release gates (2026-10-08)

Roman accepted the post-reboot runtime checks. Boot was `2026-10-08T20:01:10.5000000Z`.
The five automatic services started, demand-start speech resumed under its control
service, all six services passed readiness, and all five listeners remained on
`127.0.0.1`. CPU speech models and fresh explicit Worker AMSI availability passed.
The read-only comparison verified all 148 tables, schema, all 63 migrations,
permissions, prior rows, secrets, artifacts, snapshots and 2,030 preserved file/ACL
entries. Allowed runtime differences were 1,094 added housekeeping jobs (queue
sequence 8 to 1,102), four advanced schedule times and the readiness timestamp.
No SQL restore, configuration change or service repair occurred.

The private run `reboot-acceptance-ca27d6e8e87e47b9b761d0f7ce12b5dc/result.json`
has `passed=false` only because the supplementary SCM 7036 event query found no
matching records. Preserve that original result. Historical startup ordering is
unconfirmed, explicitly an evidence gap, not a runtime failure. The revised query
classifies only `NoMatchingEventsFound` as unavailable; access or other query
errors still fail. It never changes logging/service policy or claims ordering
from missing events. Accepted summary: `evidence/native-reboot-acceptance.json`.

Release work must preserve the live installation and original logical dumps.
Repair/uninstall tests use a separate disposable identity and runtime, never the
accepted six registrations or PostgreSQL directory. No push, publication,
reboot, live uninstall, destructive recovery or authenticated signing is authorized
without its applicable human gate. Bounded validation remains required.

Resumed gate checkpoint: the four startup-evidence boundary tests passed through
OS PowerShell 5.1 with normal log access. A sandboxed log query was correctly
refused, then the authorized read-only host query returned no matching events.
The first disposable lifecycle attempt refused an older host hash before service
registration. The next attempt registered only
`JosiAcceptance_4c44ad663b3545eca093876a2acd3d30` in separate standard test folders;
it refused repair before stopping because of PowerShell 5.1 JSON array handling.
That parser issue is corrected. The subsequent ownership check correctly refused
the fixture's unquoted path, caused by PowerShell's native CLI quoting. A structured
Windows service-path correction and isolated retry are prepared; the latest UAC
launch was canceled, so neither that correction nor the protected diagnostics
test executed. The disposable service remains running; its data and evidence
are retained. All six accepted services remain running and unchanged. Lifecycle
and diagnostics source remain uncommitted drafts pending physical evidence.
The next action is approval of the prepared Windows PowerShell UAC prompt, which
targets only that disposable identity plus read-only live diagnostics. Thin EXE,
license/SBOM closure, browser/audio/LAN and signing gates remain unfinished.

Roman then authorized consolidating UAC work. One temporary, fixed-action
elevated session completed the disposable retry and live read-only diagnostics.
The prior fixture's unquoted path was corrected through the structured Windows
service API after exact ownership checks; only its disposable service/runtime
were removed, with data and evidence retained. The new physical fixture
`9ad02d50aa804890b3e2abbff962f914` passed damaged-file repair (one replacement,
original retained), service restart/readiness, and data-retaining uninstall.
Untrusted inventory and unlisted-file removal were refused before service stop.
Every fixture data file and its permissions stayed unchanged, and all accepted
service registrations remained running and identical. Scope is one isolated real
SCM service with binary/data sentinels, not six-service EXE lifecycle acceptance.
Evidence: `evidence/native-lifecycle-accepted.json`.

Structured diagnostics passed six-service/readiness/local-listener reporting,
CPU speech/control and fresh AMSI availability, exact absence of all four secret
values, installation-write refusal and prior-export preservation. It excludes
SQL, raw logs, environment, command lines, hostnames and profile paths by design.
Evidence: `evidence/native-diagnostics-accepted.json`.

The temporary elevation accepted only fixed lifecycle/diagnostics/startup-event
actions and finish, with no command/path parameters or live mutation action.
Unknown commands, wrong session and extra command arguments were all refused
(`evidence/admin-session-boundaries.json`). The completed session was closed.
No UAC policy, scheduled task, permanent administrator service or signing
credential was created. Future sessions freeze approved source under an
administrator-owned ProgramData parent; changes to source/scope need fresh approval.

### Current Windows antivirus revision (2026-10-08)

- Native scanning now uses explicit `AmsiScanBuffer` requests to the installed
  Windows antivirus. The private bounded helper returns clean, blocked, error,
  or unavailable; unknown verdicts, HRESULT failures, malformed responses and
  timeouts never pass the required ingestion gate. Optional scanning preserves
  base installation and reports availability separately from document verdicts.
- Removed the previously planned native engine, signature seeding, update
  configuration, seventh service, listener, download and runtime dependency.
  Existing optional Linux/container scanning and compatible database policy
  fields remain unchanged. Windows has no antivirus updater or database.
- Worker availability is established by an actual harmless request, published
  to a fixed ACL-protected state file. The admin page reports error/unavailable
  explicitly; stale or unsafe records become unavailable. The minimal scanner
  environment must include the OS system drive: without it the installed AMSI
  provider returned initialization HRESULT `0x80070103` on this PC. Adding only
  that OS value resolved the failure without inheriting the interactive profile.
- Real clean and in-memory EICAR requests passed; source bytes remain unchanged.
  The 95 focused protocol, timeout, optional/required policy, Windows filesystem
  and ingestion tests passed. Three independent result-boundary tests passed.
  Full regression passed: 3,180 tests, 160 suites, eight intentional Windows
  skips. The subsequent visible setup-warning change passed 63 focused setup
  tests and typecheck. Optional scanning warns and permits setup; required
  scanning fails the setup check until a recent explicit probe succeeds.
- Candidate `0.1.78-native.2` replaces the old unsigned engineering payload.
  Runtime inventory: 11,815 files, 1,067,507,888 bytes; SHA-256
  `aff5616291b9e9486aedaca3ea11c404d4f7b8f058f56979b028331c479ddbae`.
  First combined inspection verified 18,563 exact file hashes and rejected engine,
  definition, updater, port, service and container components. The corrected
  candidate and the next setup-warning candidate were reinspected successfully.
  Historical payloads
  are withdrawn from acceptance; their earlier antivirus evidence is obsolete.
- Standard-folder cleanup/revision passed after actual UAC approval. Ownership
  and all payload hashes were checked; fixed retired engine paths and identity
  grants were removed. Database, secrets, artifacts and recovery material were
  preserved. Thirteen obsolete workspace download/tool/test targets were removed.
  Old engine evidence is obsolete; unrelated historical logs remain retained.
- Physical six-service acceptance passed: database initialization under its
  virtual account, restricted application role, migrations, service restart,
  speech SCM control, five loopback listeners and loaded-module checks. The real
  Worker SID explicitly requested an AMSI scan and reported available. Both
  installed Defender modules carried valid Microsoft signatures. Test service
  registrations were removed afterward; data remains intact. Evidence:
  `native-test-revision.json`, `native-services.json`, `application-runtime.json`.
- Fixed PowerShell 5.1's conversion of a null backup path during atomic config
  replacement; the managed bridge keeps that null inside CLR code. Recovery
  journal tests passed through both source and a locally precompiled x64 bridge.
  The final installer can load the bridge using the existing Windows CLR without
  compiling source or requiring an end-user SDK. Final installer integration,
  signature and physical release acceptance are still pending.
- Remaining priority: bind verified snapshots, stopped writers and restored
  service ACLs to the real upgrade/rollback transaction. A non-mutating retained
  snapshot verifier and fixed maintenance bridge are being tested. No claim of
  completed installer upgrade/rollback or signed release is made.
- Candidate `0.1.78-native.4` passed actual relocated private-runtime acceptance,
  including the fixed `Snapshot.mjs` create/verify/restore commands. Verification
  was proved not to change SQL; restore recovered SQL and all three artifact
  roots. Source inventory SHA-256:
  `956bf39cbf4e260eb4ebd7e971b921596e23ffacea9805ac46625f2188a3f26a`.
  Latest package inspection rehashed 18,563 files and also checked the successful
  owned-installation cleanup receipt. Evidence: `native-package-inspection.json`,
  `application-runtime.json`, `logs/native-application-runtime-recovery5.log`.
- The installer kit now contains a precompiled x64 Windows CLR bridge and fixed
  modules, with no C# source in the kit. Its loader checks the exact embedded
  inventory hash, every component hash, and the complete file set before loading
  modules. A separate OS PowerShell 5.1 process loaded it successfully with no
  source compilation. Evidence: `installer-kit.json`. The final EXE still needs
  to supply that trusted hash; no signed bootstrap or release acceptance is
  inferred from this local kit test.

### Current recovery and service-account acceptance pass (2026-10-08)

- Offline installer snapshots retain the existing gzip SQL backup bytes and add
  a checked inventory of `chat-attachments`, `roots`, and `versions`. Every file
  is copied through pinned Win32 handles, rejects links/hard links, and is hashed
  before restore. The manifest is flushed and published last. Secrets and master
  keys are excluded. This does not change the existing browser backup format.
- Actual PostgreSQL tests restore conversations, deployment configuration, an
  upload, a managed document, and a recovery copy. Snapshot corruption is refused
  before SQL or live-file mutation; hardlinked input is refused. A real Windows
  sharing lock interrupts the second folder swap after the first succeeds;
  retrying the persisted attempt ID completes the restore and retains displaced
  files. Evidence: `logs/native-snapshots-postgres3.log` and the updated
  `evidence/postgres-spike.json`. Service DACL restoration remains an installer
  requirement and is not yet claimed as tested.
- The interruption test exposed MAX_PATH in the native handle layer. Extended
  local-drive API paths now support long paths without changing Windows policy.
  Twelve real handle/secret tests pass (`logs/native-snapshot-handles.log`).
- The journal also recovers an empty or pending-only folder left before the first
  durable checkpoint. It validates all content before nonrecursive removal;
  unexpected content remains an error. `logs/native-transactions3.log` passes.
- Application build 6 succeeds with the fixed one-shot database role provisioning
  entry and current recovery code. Source inventory SHA-256:
  `4ea96c8230faef8cfa6d8e8cf5bd4f850800e47e9fb5841f88a618afc71f8bc1`.
  No installer EXE or installable signed release manifest exists yet.
- The physical SCM test registered all seven services with their virtual accounts.
  PostgreSQL `initdb` completed under `NT SERVICE\JosiDatabase`, but unmodified
  WinSW requested SCM All access while reporting child completion. Windows denied
  that request and the initializer timed out. All seven test registrations were
  removed; protected test binaries/data remain. No database-role, migration, or
  full service acceptance is claimed from this test.
- A narrow WinSW patch requests SCM Connect instead. The local source build also
  replaces unsupported log4net 2.x with pinned log4net 3.5.0 and targets net462
  using Windows 11's existing Framework. Reviewed host bytes are pinned separately
  in `packaging/windows/service-host.lock.json`; service policy tests pass. The
  patched-host UAC prompt was canceled, so that test did not start. Human approval
  of the next Windows PowerShell UAC prompt remains pending.
- The full repository regression run passes: 158 files passed, one skipped;
  3,152 tests passed, eight skipped (`logs/windows-unit-pass10.log`).
- Exact upstream source archives are retained for 64 of 69 Python components,
  with available installed license files (`evidence/python-source-closure.json`).
  Four packages lack a unique PyPI sdist and the language model needs provenance
  review. This is evidence collection, not a completed native-library source or
  redistribution review; the CTranslate2 patches/build inputs are retained
  separately.

### CPU build, runtime independence and service policy follow-up

- Completed the CPU-only CTranslate2 build using the existing signed MSVC compiler,
  existing Windows SDK and three SHA-pinned official Microsoft VSIX inputs extracted
  into the workspace. No system compiler installation or security change was needed.
  `Build-VoiceNative.ps1 -UseLocalSupplement` is the reproducible local build entry.
- The first real Ruy inference exposed a shutdown deadlock after successful
  transcription. Backported only three native files from upstream commit
  `639afb3c4141a1146af476dd00af3102d60fcbfc` (upstream issue/PR #2076).
  The complete reviewed patch is retained, SHA-256
  `c523d2157bde1814db0ce3bb3d09296d51e47e3dcf7008f6242ead11b9957a0c`.
  Patched variant `4.8.2+josi.windows2`, wheel SHA-256
  `cd586aa78398e26ff094d92352321de7fcc048c53cc6290bc2d9ba5c7994e567`,
  1,545,982 bytes. UTF-8 compilation removes the feature-separator encoding warning.
- Real Kokoro -> Silero -> Base English and Tiny English inference, including
  releasing both model instances, passes in 4.17 seconds with the patched engine.
  Every loaded module was enumerated: private Python tree or Windows, plus the
  Microsoft-signed Defender AMSI module. All four C++ runtime libraries load from
  the private Python directory, not a global redistributable or compiler tree.
  Evidence: `evidence/voice-spike.json`, `logs/voice-cpu-inference7.log` beneath
  `artifacts/windows-native`. Failed build/test logs remain separate. This does
  not prove microphone, assistant, installed service, or redistribution acceptance.
- Six fixed service definitions now include JosiDatabase, JosiWeb, JosiWorker,
  JosiVoice, JosiVoiceControl and JosiProxy. Each uses its own
  virtual account. Only VoiceControl can query/start/stop Voice. AMSI scanning
  uses the locally installed antivirus. The scanner is a bounded worker child over
  anonymous pipes; no scanner TCP listener is planned. Service definitions and
  protected directory/file DACL policy tests pass (`evidence/service-definitions.json`);
  actual SCM installation and service-account access testing remain due.
- The native recovery journal now publishes flushed immutable checkpoints using
  Windows write-through rename, checks a SHA-256 chain and closed fields, and holds
  an exclusive lifecycle lock. Eight invalid operations, interrupted publication,
  reopened recovery state, tampering and all four operation sequences pass under
  Windows PowerShell 5.1 (`evidence/transaction-journal.json`). These are journal
  tests, not evidence of an installed upgrade or successful database rollback.
- AMSI adapter startup installs and verifies a Windows Job Object limiting it to
  1 GiB aggregate committed memory, two CPU cores' equivalent capacity and one
  process before loading the Windows scan interface. Explicit clean/EICAR scans,
  byte/concurrency bounds and unavailable failure pass (`logs/native-amsi1.log`).
- Private runtime staging reconstructs the original pinned Python interpreter and
  69 locked runtime distributions, verifies every copied wheel file against RECORD,
  includes the locally built CPU engine, and generates a Python CycloneDX SBOM and
  full file inventory. It excludes the compiler, npm/pip launchers and build-only
  packages. Source/notices completeness is still a release gate. The Microsoft
  runtime's conditional redistribution evidence is in MICROSOFT-RUNTIME-REVIEW.md.
- Expanded relocated testing exercised real PythonRuntime gateway/control, speech
  streaming, model inference, AV, OCR, API and worker. Its first library-closure
  check correctly failed because a Node add-on loaded a global C++ runtime. Private
  runtime copies are now also included beside Node; the corrected full
  closure initially still failed because libuv's altered DLL search path skips
  the executable directory for add-ons. The application builder now puts the
  pinned Microsoft DLLs beside each native `.node` file as well. The corrected
  full functional and loaded-module test passes (`logs/native-application-runtime5.log`,
  `evidence/application-runtime.json`); five listeners are loopback-only. It still
  does not claim SCM, firewall/LAN vantage, browser completion or physical mic.
- Initial setup uses a protected local HTML handoff opened as the original
  interactive user, then the existing `#setup=` fragment/sessionStorage flow.
  Only its file path may enter the browser process command line; neither a bearer
  token nor master key may be a command argument. The file is readable only by the
  original user and administrators/SYSTEM. Actual original-user opening, ACLs and
  post-setup cleanup remain acceptance requirements.
- A relocated application payload passes 63 migrations, real private PostgreSQL,
  API/worker/Caddy readiness, setup-token handling, an actual queued job, Argon2,
  native master-key ACL validation, artifact CRUD and OCR. Three private listeners
  and each runtime process path were inspected. Evidence `evidence/application-runtime.json`.
  PostgreSQL C++ DLL closure, SCM, browser setup and full external-file recovery
  still require additional acceptance; a private executable alone is insufficient.

Historical observations below describe earlier intermediate builds; the above
records supersede the earlier compiler/UAC blocker and upstream-wheel-only result.

- Locked npm dependencies installed locally; baseline `npm run typecheck` passed.
- Python 3.13.13 rejected by approved Misaki 0.9.4 (`Requires-Python <3.13`).
  Selected maintained relocatable CPython 3.12.15 from python-build-standalone
  release 20261003 for the spike; archive SHA-256
  `4b6f0beebbb695a0f3ea237b8c3eaa5bd424f47a7bc25b2fbe3a43390c770f08`.
  Product redistribution review remains separate from execution feasibility.
- All approved models downloaded against the existing size/hash lock. Fixed
  Kokoro vocabulary JSON decoding to explicit UTF-8 (Windows CP1252 failed).
- Real Kokoro speech -> Silero VAD -> both Whisper Base/Tiny English CPU inference
  passed in 4.62 seconds; each transcribed the apples/tomorrow fixture correctly.
  Evidence: `artifacts/windows-native/evidence/voice-spike.json` and WAV. This does
  not claim microphone, playback, assistant, service, or final wheel acceptance.
- Windows additions colorama 0.4.6 and pyreadline3 3.5.4 pinned by SHA-256; `pip
  check` passes. Linux dependency lock remains unchanged.
- Native bearer-authenticated loopback gateway implemented. Real HTTP streaming
  passes speech-start/partial/final, local TTS, rejected unauthenticated readiness
  and session requests, 600-character TTS bound and four-session capacity limit.
  Evidence: `artifacts/windows-native/evidence/voice-gateway.json`.
- Node 24.15.0 and private 24.21.0 both crash with Windows threaded PGlite tests
  (`0xC0000005`). Forked test processes pass the focused test and all 59 setup
  tests. Vitest now uses forks only on Windows and proper file-URL conversion.
- Setup used hardcoded `/tmp`; replaced with platform temporary directory and
  an exclusive random probe filename. Native startup binds API to loopback;
  worker heartbeat accepts its private configured path. Container defaults stay.
- Official PostgreSQL 16.15-5 Windows archive and publisher SHA-256 located:
  `https://get.enterprisedb.com/postgresql/postgresql-16.15-5-windows-x64-binaries.zip`
  (373254386 bytes, `43bb45f173a6f08cf1d29a97a6d8deb119e8e8093a24c00d2d1001a0ccaa8281`).
- CTranslate2 source reconstruction reuses all six reviewed source archive hashes.
  Local Windows CPU build is in progress; upstream wheel used only for spike.

- Native PostgreSQL now passes all 63 migrations and an actual dump/restore with
  non-ASCII data, loopback binding and generated SCRAM credential. The temporary
  cluster is stopped and credential files removed afterward. Evidence:
  `artifacts/windows-native/evidence/postgres-spike.json`. The follow-up below
  additionally tests the actual gzip SQL product format and conversation rows.
- Storage portability checks pass 100 tests; setup passes 59 tests; TypeScript
  build and Vite web build pass. Web prebuild regenerated unrelated help pages;
  only those task-generated tracked outputs were restored to the clean baseline.
- Actual bundled Tesseract image recognition returns `JOSI WINDOWS OCR 314159`.
  No writable working-directory language cache; image OCR still requires opt-in.
  Evidence: `artifacts/windows-native/evidence/ocr-spike.json`.
- Caddy 2.11.7 successfully forwards HTTP. Windows socket inspection confirms one
  loopback listener and disabled admin API. TLS and SCM operation remain untested.
  Evidence: `artifacts/windows-native/evidence/caddy-spike.json`.
- Native Windows scanning uses explicit `AmsiScanBuffer` calls with complete
  document bytes. No antivirus engine or signature database is bundled. The
  adapter returns clean, blocked, error or unavailable; administrator policy
  blocks are blocked, provider errors and unknown elevated risk are never clean.
  Anonymous inherited pipes authorize the bounded worker child; it has no TCP
  port, filename selection, shell, update logic or document logging. A scan must
  succeed when the existing storage policy requires it. With optional scanning,
  base installation continues and antivirus availability is reported separately.
  Windows service identity acceptance remains required.
- Broad Windows run reached 47 passing files / 1,696 passing tests before a Unix
  executable-fixture failure. Fixed that fixture to use an explicit Node launcher.
  Three Bash/POSIX-mode tests are skipped on Windows only; their static assertions
  remain active. Native DACL and disk-space replacement acceptance remains due.
  Evidence: `artifacts/windows-native/logs/windows-unit-pass5.log`.

Full regression suite is still in progress. No service installation, installer,
upgrade/rollback, physical microphone, reboot, signing or release acceptance yet.

### Storage, privacy and tooling follow-up

- Inno Setup 7.1.0 compiler prepared in its documented `/PORTABLE=1` mode under
  `artifacts/windows-native/tools/inno-7.1.0`. Upstream installer SHA and valid
  Pyrsys Authenticode signature checked before execution. Select Inno for the
  installer UI/uninstaller; additional download/transaction requirements still
  need implementation and tests, not an assumption about built-in behavior.
- WinSW 2.12.0 .NET461 official binary, sample and MIT license retrieved. SHA
  `b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f`, 655872 bytes.
  Upstream has no published digest and the EXE is unsigned: recorded hash is a
  local measurement of the official GitHub download, not a publisher signature.
  Prefer this OS-serviced Framework wrapper over a new service manager; still
  require SCM, virtual-account, graceful-stop and process-tree acceptance.
- Koffi 3.3.2 MIT, current exact release, adds native Win32 file/ACL bindings;
  pinned optional npm dependency, loaded only on Windows. Version 3.1.3/3.1.4's
  reported Windows crash was reviewed; 3.3.2 passed actual calls on this machine.
  Upstream changelog and license retained by npm. Final notices/source/SBOM due.
- Directory and file pinning uses GENERIC_READ handles denying FILE_SHARE_DELETE,
  with OPEN_REPARSE_POINT and checked file attributes/link count. Attributes-only
  access did NOT prevent rename in the spike and is deliberately not used.
  Attachments, cleanup and local workspace now have native guarded traversal.
  Exclusive upload copying preserves an existing destination on collision.
- Private harness directories now receive a protected DACL AT creation: current
  service identity, SYSTEM and Administrators only, inherited by context/call
  files. POSIX mode checks replaced with real Windows ACL inspection on Windows.
  Native SID allocation/UTF-16 conversion bugs found in the initial adapter were
  fixed before the passing run; failed logs retained rather than represented as
  passes. Combined file/containment/privacy suites: 38 tests pass; evidence
  `artifacts/windows-native/logs/native-files-privacy.log`.
- Broad run 6 reached 66 passing suites / 2109 tests before the privacy failure.
  Full run 7 completed: 150 suites pass, 5 fail; 3120 tests pass, 22 fail, 3 skip.
- Production dependency audit flags 7 inherited advisories (including transitive
  proxy-addr <2.0.8). Supported updates and reachability review are in progress;
  do not ship this dependency set as release-ready. Audit JSON retained under
  `artifacts/windows-native/evidence/npm-production-audit.json`.
- C++ toolchain remains incomplete. Earlier Microsoft-signed Build Tools UAC
  request was canceled; another human checkpoint is pending before reopening it.
  This blocks the reviewed CPU-only CTranslate2 build, not independent code/tests.

### Native backup and control integration follow-up

- PostgreSQL backup writer uses explicit private tool paths on Windows, never
  PATH lookup. Passwords go through an exclusive DACL-protected temporary pgpass
  file, removed afterward. Child environment excludes provider credentials and
  inherited libpq options; psql ignores user startup files. Existing gzip SQL
  archive format retained. Portable `/data/...` database names resolve only at
  filesystem boundaries into the configured Windows data directory.
- Real product writer/reader restored a two-message conversation and deployment
  configuration in PostgreSQL 16.15 after deliberate mutations. A syntactically
  invalid restore rolled back its preceding mutation. PATH was empty and hostile
  inherited PGOPTIONS ignored. Evidence: `logs/native-product-backup.log` and
  `evidence/postgres-spike.json` under artifacts/windows-native. External artifact
  file backup/restore and service identity remain unverified. Existing writer
  ignores uploads/recoveryCopies flags and archives only database SQL; lifecycle
  snapshots must include actual files, and the product's full-backup claim needs
  resolution without silently breaking old archives.
- All 17 portable failures from full run 7 fixed: native link fixtures, temporary
  root grant, Obsidian separator normalization and guarded file access. The five
  remaining tests specifically execute POSIX ownership/Compose mount/Bash Doctor
  behavior and now skip only on Windows. Total intentional Windows skips: eight.
  Native installer ACL, mount-selection, repair and update equivalents are still
  release gates, not claimed replacements. Focused run: 133 pass, 5 skipped;
  `logs/windows-portability-pass8.log`. TypeScript and web typecheck pass.
- Codex image staging now uses the same protected native temporary directories
  as the MCP harness. File pinning explicitly refuses DOS device names and returns
  an unsafe-link classification distinct from access denied.
- Updated multer to 2.4.0, proxy-addr to 2.0.8, supported brace-expansion patch
  branches, nodemailer to 10.0.16 in both root and mail workspace, and source-map-js.
  Node 22 Docker baseline remains compatible with nodemailer's Node >=20 floor.
  Upstream evidence: expressjs/multer GHSA-3pph-fpjx-jg34, jshttp/proxy-addr
  GHSA-jqcg-44mw-7w3h, nodemailer/nodemailer release v10.0.16. npm audit still reports
  Mammoth's CLI-only argparse/sprintf-js chain and build-only Tailwind 3 dependencies;
  do not describe the overall audit as clean. No forced downgrade to Mammoth 0.x.
- Native voice helper implemented with fixed loopback/authentication, separate
  gateway/control credentials, closed settings vocabulary, bounded HTTP and
  exact JosiVoice SCM QUERY/START/STOP rights. No service configuration changes,
  command execution or runtime downloads. Voice service is demand-start; the
  auto-start helper restores the enabled state, preserving disablement after a
  reboot. Settings changes require real readiness and recover previous settings
  on failure. Runtime updates remain part of the whole Josi installer. Real
  process/control testing passes with real models, including settings rollback,
  failure recovery and disablement persisted through helper recreation. Evidence:
  `evidence/voice-control.json`, `logs/voice-control-limited.log`. Windows Job Object
  enforces 4 GiB aggregate committed memory, four processes and at most four CPU
  cores worth of CPU time before model imports. Limits are queried back from the
  kernel before process assignment; full inference/control suite still passes.
  SCM identity/DACL/reboot and microphone are not proved.
- Full regression run 9 passes: **3143 tests, 156 suites; 8 intentional Windows
  skips** (157 files total), `logs/windows-unit-pass9.log`. Separate native secret
  scanner/voice transport run passes six tests. Native scanner consumes the
  existing Bash policy rather than duplicating its credential rules, preserves
  its exact hostname exceptions and reports no matched secret values. Scan of
  795 tracked/untracked source files is clean. Container scripts stay available.
- Repeated faster-whisper PCM patch validates its already-modified module and
  RECORD hashes. Model preparation rehashes cached files rather than downloading
  again. Both repeat patch verification and complete cached model revalidation
  pass; `logs/voice-cached-model-verification.log`.
- Bootstrap payload module uses maintained Windows BITS, not a custom transfer
  engine. Pinned release manifest rejects missing/extra/duplicate components,
  renamed assets, mutable or non-Josi origins, wrong architecture, invalid size,
  hash and missing licensing evidence. Production entry requires an Authenticode
  catalog plus the exact manifest hash embedded in the signed EXE. Signature
  acceptance is still untested because signing has not begun.
- Real BITS test downloads a pinned public Josi desktop checksum file, verifies
  exact size/hash and reuses the verified cache. A separate 106 MB desktop EXE
  transport fixture is canceled after partial bytes, retains a suspended BITS
  job, resumes and verifies the published digest. **The desktop EXE is never
  executed and is not a native-server payload.** Evidence: `logs/native-payload-
  resume.log`, `evidence/payload-download.json`. Proxy setting is SystemDefault;
  TLS certificate and revocation checks remain enabled, HTTPS downgrade is not
  permitted. No execution policy was changed; inbox PowerShell is RemoteSigned.
  Download deadlines/retries are bounded; cancel retains only owned resumable
  state. Actual proxy deployment and outage acceptance remain pending.
- Win32 attribute-tag inspection distinguishes OneDrive's non-redirecting cloud
  metadata on the user-selected development ancestor from junctions/symlinks.
  Name-redirection and unreviewed reparse tags are refused; a real junction
  rejection test passes. Product installation still targets Program Files/Data.

Maintained-component references used for these adapters:
[WinSW 2.12 configuration](https://raw.githubusercontent.com/winsw/winsw/v2.12.0/doc/xmlConfigFile.md),
[BITS transfer API](https://learn.microsoft.com/en-us/powershell/module/bitstransfer/start-bitstransfer?view=windowsserver2025-ps),
[Windows resource limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information),
[Windows reparse tags](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-tags).

## Current architecture and portability inventory

### Relocated application runtime and secret-file evidence (2026-10-08 UTC)

- `scripts/windows/Build-Application.mjs` snapshots tracked and non-ignored source
  into an isolated build directory, installs only locked dependencies without
  lifecycle scripts, stamps CE, compiles TypeScript and the web app, and emits a
  production CycloneDX dependency graph plus source/payload SHA-256 inventories.
  The payload contains physical workspace packages, never development junctions.
  Native candidate `0.1.78-native.1` remains unsigned and unapproved; no installer
  or public release exists. Latest build: `evidence/application-build.json`.
- Production audit after the compatible dependency updates has no high/critical
  findings and three moderate dependency entries for one transitive issue:
  Mammoth -> argparse -> sprintf-js. Mammoth's library entry does not import its
  CLI argument parser; final reachability/write-up and package closure remain due.
  The build's `reports/npm-audit.log` contains the exact report.
- `packaging/windows/Runtime.mjs` starts only web, worker, or migrations from the
  private executable, validates a closed configuration schema, clears inherited
  environment settings, derives credential-file paths, and uses ProgramData state.
  It never accepts executable names, commands or plaintext credentials from config.
- `readWindowsSecret` verifies the actual opened file's owner/DACL, permits only
  administrators and the fixed Josi service readers, rejects service write rights,
  broad grants, unknown ACE types, links, hard links, oversized data and ambiguous
  names. It reads through the same handle. API/worker master-key and database
  loading use it in native mode. Existing container behavior remains unchanged.
  Real ACL and master-key regression checks: 16 pass in
  `logs/native-secret-permissions.log`. Python and helper-token readers still
  require the final installer ACL/service-account acceptance.
- `Test-Application.mjs` copied the application, private Node (renamed
  JosiRuntime.exe), PostgreSQL and Caddy into a protected independent fixture.
  It passed 63 migrations under a non-superuser database role, API/proxy readiness,
  a real queued background job, first-run token authorization, native Argon2,
  real OCR, artifact write/read/delete, and local MIME rendering without sending.
  Hostile inherited database/master-key settings were ignored. All three observed
  listeners were loopback-only, and observed product processes ran from the fixture.
  Generated credentials were absent from logs and removed after stopping the stack.
  Evidence: `evidence/application-runtime.json`, `logs/native-application-runtime2.log`.
- Initial relocated initdb crashed (`0xC0000409`) without COMSPEC. Explicit Windows
  System32 COMSPEC/PATH fixed it; no developer PATH is supplied. PostgreSQL's
  initialization internally needs the OS command processor; users do not open it.
- **Runtime independence is not yet complete:** PE inspection found PostgreSQL
  imports VCRUNTIME140.dll but EDB's server bin directory does not bundle it. This
  PC supplies that redistributable globally. Node itself imports OS libraries only.
  Package/verify the required Microsoft runtime and its redistribution terms, then
  collect module-load evidence; do not misrepresent the successful process-path
  test as complete native-library independence. Microsoft guidance:
  https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
  and https://learn.microsoft.com/en-us/cpp/windows/determining-which-dlls-to-redistribute .
  Python's retained LICENSE.txt also contains Windows redistributable conditions.
- Handle security evidence follows
  https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo .
  Windows service installation, graceful SCM stop, identity/ACL isolation, browser
  completion, microphone, reboot and the installer lifecycle are still unverified.

| Existing location | Observed assumption | Windows work required |
| --- | --- | --- |
| docker-compose.yml / release.yml | PostgreSQL 16, migration one-shot, API, worker, Caddy; network isolation and secrets are Compose features | SCM lifecycle and dependency order; ACL secrets and loopback binding |
| apps/api/src/server.ts | API `listen(PORT)` binds all interfaces; PostgreSQL defaults to `db`; password file supported | explicit loopback host for native distribution, preserve container default |
| apps/worker/src/main.ts | independent Node worker; PostgreSQL connection through shared code | separate noninteractive Windows service, graceful shutdown |
| packages/db/migrate.mjs | SQL migrations transactionally recorded in `_migrations`; password file supported | same SQL/ledger; exclusive lifecycle lock and real backup before upgrade |
| services/voice-box/gateway.py | hardcoded `/models`, `/run/voice`; UnixStreamServer; bearer token; bounded PCM and sessions | configurable trusted paths, authenticated loopback or ACL named pipe, same bounded API |
| services/voice-box/host_helper.py | privileged Docker orchestration over Unix socket | bounded native lifecycle adapter; never accept arbitrary commands/URLs |
| services/voice-box/Dockerfile and native.lock.json | Python 3.12; Debian runtimes; source-built CTranslate2 4.8.2+josi.cpu1 without MKL/CUDA/DNNL | native CPU build and artifact-level license review; retain approved models |
| services/voice-box/patch_whisper.py | exact-source-hash PCM-only patch removes codec dependency | reproduce and verify on Windows without changing model behavior |
| services/voice-box/models.lock.json | exact model URLs/sizes/SHA-256/licenses, offline inference | reuse reviewed bytes; verified redistribution to versioned Josi GitHub assets |
| services/ocr/Dockerfile | placeholder exits; not evidence of functioning OCR | use actual application OCR implementation |
| packages/storage/src/extract.ts | Tesseract.js with bundled English data; createWorker | Windows-native Node/WASM execution and actual image fixture verification |
| packages/storage/src/workspaceMount.ts | `/proc/self/mountinfo` for a mounted workspace | explicit Windows root identity/reparse-point policy; preserve traversal boundary |
| packages/storage/src/chatAttachments.ts | `/data` default and chmod | configured ProgramData artifact root, ACL checks instead of POSIX modes |
| packages/core/src/masterKey.ts | `/run/secrets`, chmod diagnostics, advisory POSIX permission check | Windows ACL verification; no environment/argument key material |
| packages/ops/src/pgWriter.ts | launches pg_dump and psql from PATH; encrypted backup format | absolute bundled executable paths, same backup bytes and restore semantics |
| API voice/doctor/maintenance/NAS helper clients | HTTP socketPath and host helper contracts | authenticated Windows IPC and implementation of fixed operations |
| Bash installer and runtime test scripts | shell, Docker/Compose, POSIX file modes/signals | native automation and equivalent physical evidence; retain old distribution |
| browser setup/recovery | existing owner/encryption/recovery semantics | reuse browser UI and private setup link; no terminal steps |

This inventory is in progress; scan every spawn/exec/path/permission/helper and
the full backup/artifact/diagnostics flow before declaring M1 complete.

## Maintained-components preflight (decisions provisional)

| Component | Evidence reviewed | Direction / remaining proof |
| --- | --- | --- |
| WiX/Burn vs Inno Setup | https://docs.firegiant.com/wix/whatsnew/ and https://docs.firegiant.com/wix/whatsnew/faqs/ ; https://jrsoftware.org/isinfo.php and https://jrsoftware.org/isdl-verify.php | Burn has package cache/rollback/download support. Inno supports verified downloads and archive extraction. Review current licenses and exact versions before selection; no custom installer framework. |
| Service hosts vs WinSW | https://github.com/winsw/winsw and /releases | WinSW MIT, stable 2.12.0; v3 prerelease uses obsolete .NET 7. Evaluate stable Framework wrapper versus small direct SCM .NET host, including graceful stop and job resource bounds. No custom service manager. |
| PostgreSQL | https://www.postgresql.org/download/windows/ | Official page delegates Windows binaries to EDB; retain major 16 for backup compatibility. Inspect exact binary/source licenses before mirroring; native pg_ctl SCM support. |
| Caddy | https://caddyserver.com/docs/install and /docs/command-line | Official Windows release; pin version/hash and license. Bind intended entry only, disable public admin endpoint. |
| Node | https://nodejs.org/en/download | Official x64 ZIP; current LTS 24 line, exact security patch to be pinned with published checksums. Retain MIT and all third-party notices. |
| Python | https://docs.python.org/3.12/using/windows.html | Embeddable distribution supported; choose maintained patch with Windows wheels, PSF notices. Do not ship pip-driven runtime installs. |
| Voice dependencies | services/voice-box/LICENSES.md and locks | Reviewed Linux build intentionally excludes proprietary static MKL/CUDA and codecs. Windows wheel is not automatically equivalent. New native lock, complete sources/notices, model inference and license review required. |
| OCR | packages/storage/src/extract.ts | Existing Tesseract.js runtime/data avoids unnecessary external OCR replacement. Prove actual OCR under bundled Node. |
| Windows antivirus | https://learn.microsoft.com/en-us/windows/win32/api/amsi/nf-amsi-amsiscanbuffer | User-directed AMSI integration with the locally installed antivirus. Explicit buffer scan and honest four-state results; no bundled engine, definitions, updater, service or port. |

Every final payload must record name/version/architecture/upstream URL/Josi tag,
asset URL/size/SHA-256/license/redistribution evidence and update policy. No blank,
inferred or placeholder hashes in an installable manifest. Developer discovery
may inspect current releases; install-time URLs must never resolve `latest`.

## Chosen architecture boundaries

Reuse TypeScript API/worker and existing browser app, migrations, crypto, owner
rules and backup format. Narrow native packaging/lifecycle adapters are the only
new product layer. Package private Node, Python, PostgreSQL, Caddy and models.
All components selected above remain subject to native execution proof.

Proposed SCM identities: `NT SERVICE\JosiDatabase`, `JosiWeb`, `JosiWorker`,
`JosiVoice`, `JosiVoiceControl`, `JosiProxy`; unique service SIDs and minimum ACLs.
PostgreSQL uses its native SCM implementation; others use the selected host.
Elevated installer performs machine changes, never a long-lived application as
Administrator, LocalSystem or the interactive user. Any required privileged
maintenance operation has a fixed allowlist and authenticated, authorized IPC.

Proposed internal ports (subject to collision checks): database 15432, API 18080,
voice 18081 and voice control 18082, bound to 127.0.0.1 only. Caddy alone exposes configured
HTTP/HTTPS entry. Loopback is not user authentication: voice retains random bearer
secret, database SCRAM, privileged helper requires ACL pipe/peer authorization.
AMSI scan requests use private inherited pipes and create no network listener.

Layout: `%ProgramFiles%\Josi CE Server\versions\<version>` immutable binaries;
`%ProgramData%\Josi CE Server\` contains distinct config, secrets, database,
artifacts, backups, logs, cache, transactions and staging. Disable inherited broad
write/read rights where sensitive; SYSTEM/Administrators administer, individual
service SIDs receive only required access. Refuse unsafe reparse points and
unexpected ownership; never recursively delete a computed unchecked path.

Secrets: cryptographic random DB/service/setup credentials and master key;
tightly ACL-protected files compatible with existing file-secret readers, DPAPI
where appropriate without breaking recovery/backup portability. No secret values
in arguments, logs, source, diagnostic exports or dumps. Recovery stays browser
first; no hidden new recovery dependency. Disable service crash dumps containing
secrets via targeted product configuration, never system security weakening.

## Threat model

Protect against malicious release/CDN content, local unprivileged users,
unauthenticated LAN clients, malicious uploads/audio, hostile configuration and
interrupted transactions. Signed versioned manifest rooted in the signed EXE;
verify exact asset name, size, hash, version, architecture and license before use.
No arbitrary downloads, execution, archive traversal, IPC commands, redirects to
plaintext, or mutable fallback mirrors. Refuse extra/missing/renamed payloads.
Constrain subprocess trees/resources and request sizes; no runtime model network
access. Windows Firewall/Defender/UAC/SmartScreen/TLS remain enabled.

## Installer transaction and lifecycle design

Preflight OS/architecture/RAM/disk/ports/reboot/prior product state before mutation.
Download over HTTPS to versioned staging with bounded retries/resume/proxy support
and cancellation. Cache only verified artifacts; rehash before reuse/execution.
Check signed manifest trust before trusting its hashes. Signed GitHub asset
redirects permitted; bytes remain untrusted until verification. Never execute
from the browser download folder. Network outage yields a precise retryable error.

Durable journal: prepared -> verified -> backup verified -> services quiesced ->
migrated -> activated -> health verified -> committed. Record recoverable failure
states. Keep previous binaries and compatible database backup until acceptance.
If schema changed, rollback requires proven DB/artifact restore, not just old EXEs.
Serialize lifecycle operations and recover safely after power interruption.

Backups preserve existing encrypted format, conversations/configuration/artifacts
and recovery semantics; test with actual DB/files. Repair restores only verified
non-data components. Updates retain secrets, connectors and user material.
Uninstall removes registered product services/tasks/firewall rules/listeners and
owned partial files; data retained by default. Separate explicit full-removal
confirmation, canonical path/ownership checks, no traversal into unrelated data.

## Tests, release evidence and remaining risks

Run repository unit/integration/typecheck/build/secret/browser checks. Bash/Compose
distribution tests cannot be represented as native results; document each and
implement equivalent native coverage. Test service lifecycle/crash/reboot, ACLs,
IPC authorization, LAN reachability, first-run owner/recovery, signed downloads,
wrong assets, interruption, cancellation, migration and failed-upgrade rollback.

Require real speech/model inference early; final acceptance includes physical mic,
authenticated assistant, local speaker output. Require actual OCR and malware
fixture, real backup/restore, damaged-binary repair, upgrade and uninstall tests.
Prove no prerequisite/toolchain/runtime virtualization dependency on this PC.
Human checkpoints only when unavoidable: mic/speaker interaction, reboot timing,
second LAN vantage point, UAC or Azure/certificate login. Continue independent work.

Release package: EXE, SHA256SUMS, signed payload manifest, SBOMs, preserved sources,
third-party notices, operator runbook, troubleshooting, release notes and evidence
report. Every test records command, exit code, time, source revision and artifacts;
redact credentials/personal data. Defender and signed timestamp/hash checks must
run on the final bytes, followed by a fresh-download physical reinstall.

Unresolved highest risks: CPU CTranslate2 Windows build/licensing, Python wheel
closure, secure helper replacements, privilege separation, migration rollback,
existing Linux-only backup/storage assumptions, signed release asset staging,
actual microphone/reboot/LAN/Azure checkpoints. No support claims beyond tested
Windows 11 x64 configuration; determine older baseline only from dependency and
physical evidence.
