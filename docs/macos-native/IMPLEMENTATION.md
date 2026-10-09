# Native macOS distribution

This is the Apple Silicon implementation derived from the verified Windows-native
server, not a container wrapper. The minimum macOS version is 14. All build inputs,
caches and acceptance fixtures for this run reside on JosiDrive. No live Josi
installation, launchd registration, service account or Keychain was modified.

## Architecture and security review

The Windows EXECPLAN/checkpoint, installer, runtime bootstrap, payload verification,
transaction journals, cold snapshots, migration runner, readiness, browser launcher,
service identities, secret readers, storage/OCR, speech manager, PostgreSQL and
Caddy paths were reviewed. The existing API, worker, database migrations, browser
setup/CSRF/handoff state machine, storage policies and CPU speech engines are reused.

| Boundary | Native macOS implementation |
| --- | --- |
| Installation | AppKit setup app; administrator authorization; private root staging; exact SOCAL designated requirement before any elevated helper executes. Unsigned verification needs no elevation. |
| Programs | Hash-verified offline payload; staged privately, ownership sealed to root, verified again, then exposed under versioned program directories. Existing unrelated roots/accounts/jobs are refused. |
| Service isolation | Six distinct hidden non-login identities and fixed system launchd definitions. Services cannot install/start arbitrary jobs or change executable paths. |
| Secrets | Root-owned per-role files, exact primary-group read access, no extended ACLs; descriptor-relative native secret reader. Passwords are absent from arguments and launchd environment. |
| Shared data | Explicit web/worker inherited ACLs; other service state is private. Speech control can write settings; the gateway can read them. Control and gateway tokens differ. |
| Storage containment | Darwin openat/renameat/linkat/unlinkat directory capabilities replace Linux procfs assumptions. No lexical-path fallback for held capabilities. |
| Transactions | Exclusive lock; immutable sequence/hash-linked records; durable phase intent; cold database snapshot with content/ownership/mode/ACL verification; failed data retained. |
| Migration/activation | All existing 65 SQL migrations run before candidate writers. PostgreSQL major 16 is checked for upgrades. Services independently wait for the migrated database. |
| Recovery | Before migration, restart untouched previous data. Before activation, restore only a verified cold snapshot and retain failed data. After activation, refuse automatic rollback to protect newer writes. Partial fresh provisioning requires review. |
| Readiness | Owned running PIDs; exact loopback TCP listeners; API and proxy /ready; fresh worker heartbeat; authenticated speech health or saved disabled state. |
| Browser | Reused setup protocol with CSRF cookie/header, protected root bootstrap credential, expiring one-use handoff, HttpOnly setup cookie and replay denial. Native HTTP client refuses redirects. Only a private HTML filename goes to the default HTTP browser. |
| Scanning | No ClamAV engine, signatures, updater, service or port. Mandatory fail-closed scanner policy overrides legacy disabled/on-index settings. Supported explicitly configured root-protected local Unix INSTREAM scanner only; every byte stream needs a clean verdict. |
| Speech | Private CPython; offline Kokoro, Silero and Whisper CPU models; authenticated loopback transport. Existing manager preserves settings/rollback. No SCM, launchctl or downloader authority in the manager. Darwin rapid rebind uses SO_REUSEADDR, never SO_REUSEPORT. |
| Progress | Main-thread AppKit timer, spinner and elapsed activity every half-second; bounded structured phase/service updates while privileged work runs asynchronously. Several-minute copy is explicit. |

`packaging/macos/TEST-ME.txt` is the human checklist, service inventory, scanner
configuration contract and separate clean-install/upgrade acceptance procedure.
Physical administrator authorization, launchd boot behavior, account/ACL creation,
default-browser launch, microphone/speaker, reboot and LAN gates remain unverified.
Isolated tests use the real payload and database, but cannot stand in for those gates.

## Inputs and redistribution

Node 24.15.0, PostgreSQL 16.15, CPython 3.11.15 and Caddy 2.11.7 are pinned.
PostgreSQL/CPython are built locally with full Xcode. PostgreSQL library paths are
made relative at link time, avoiding a post-link signing operation. Runtime Mach-O
files are arm64; universal wheel slices are reduced to arm64. Dynamic dependencies
must remain inside the bundle or Apple's system libraries/frameworks.

The voice lock pins 66 wheels plus the docopt source build. NumPy 2.2.6 uses the
macOS 14 Accelerate wheel, avoiding wheel-private GNU/OpenBLAS runtime copies.
CTranslate2's arm64 wheel uses Accelerate; no CUDA, MKL or external OpenMP runtime
is introduced. The existing hash-checked faster-whisper PCM adaptation is retained.
Both Whisper models, two Kokoro voice vectors, Silero and the English pronunciation
model are offline and pinned. No model is fetched by an installed service.

The installer carries original notices, combined CycloneDX metadata, exact npm,
Python/model/Go locks, corresponding copyleft source and the Josi build sources.
Go source zip content hashes are checked against the pinned Caddy binary's build
metadata. Extra native sources include the exact HEIF/libde265 build chain, Skia
and its selected font/image dependencies. Python copyleft materials include
num2words, certifi, tqdm and vendored setuptools/autocommand sources. The complete
PG/Python source archives and local adaptation/build scripts are included.
Source archives may describe other platforms; those platforms' executables are
not installed runtimes. No source archive is executed during installation.

Recipients retain the modification/reverse-engineering rights in the included
licenses. Editable sources and build recipes permit rebuilding/replacing covered
components. A modified installer may use the recipient's own signing requirement;
it must not impersonate SOCAL. SOCAL keys or Apple credentials are never included.

## Advisory review

The production npm audit reports one underlying moderate advisory,
GHSA-hp3w-g68c-fv3c (`sprintf-js`, unbounded precision), represented as three affected
dependency nodes through argparse and mammoth. Mammoth's public module is
`lib/index.js`; only its `bin/mammoth` CLI imports argparse. Josi imports the public
conversion API and does not execute that CLI. No high/critical finding was reported.
This is retained as an inherited, non-invoked CLI advisory, not called a zero-finding
scan and not "fixed" by downgrading the document parser to an obsolete release.
Scanner absence separately blocks document ingestion; it is not claimed as a
substitute for resolving future reachable parser vulnerabilities.

## The 15 prior full-suite failures

The original evidence remains in `logs/application-tests-continuation-1.log` under
the release root. Twelve failures were Darwin portability defects: two directory
containment tests and ten real workspace/SQL integration cases depended on procfs.
The descriptor-relative backend now passes all 31 workspace tests, including
rename pinning, approvals, replay/content changes, delete recovery, edits and moves.
The secret temporary-directory ACL test also passes in the finished source state;
its earlier concurrent source/checkpoint mismatch did not justify any exclusion.

Exactly two individual tests are now conditional on Linux: the browser installer
controller's Docker developer-workspace path probe, and the Doctor helper's Compose
background-update fixture with GNU sed. Their surrounding suites still run. Neither
is a native macOS installer/security check. The full applicable suite passed 3,203
checks with 47 skips (45 existing plus these two); final rerun evidence is retained
separately after final edits. No containment or product security test was weakened.

## Rebuilding and signing

Use DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer and the pinned private
Node/CPython under the approved BuildTemp tree. Do not change xcode-select or use a
global runtime. Acquire locked inputs with acquire-voice.mjs,
acquire-source-closure.mjs and acquire-caddy-sources.mjs. Build base runtimes with
build-base.sh, then build-voice.py. Run typecheck, web build, stage.py, licenses.py,
inventory.py and build-app.sh. The scripts use fixed external scratch paths.
`test-package.py` exercises real child processes, migrations, native browser
handoff, offline speech, failed-migration recovery and upgrade in disposable roots.
`test_lifecycle.py`, `test_voice.py` and the compiled Swift progress tests cover
focused lifecycle/permission/restart/UX contracts. Final archive/source inspection
and exact checksums accompany the artifact.

No codesign operation is authorized until Roman confirms logged-in Keychain access.
The later command is `scripts/macos/sign-candidate.py --roman-keychain-approved
<exact unsigned app path>`, run with the private build Python. It signs a new copy
with only Developer ID Application: Socal Receptionist LLC (LRH75YR6QW), hardened
runtime and timestamps; verifies each authority/team and deep/strict signatures;
records Gatekeeper's actual verdict; and emits a separate archive/checksum.
It stops on the first failure and never submits notarization or publishes anything.
