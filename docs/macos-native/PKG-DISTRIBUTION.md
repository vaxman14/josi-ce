# Native PKG distribution

The macOS distribution now uses Apple's component/distribution PKG flow. Open
the branded DMG and double-click Install Josi.pkg. Installer owns authorization,
component selection and installation. Josi Server.app is a installed management
and progress companion, with no second Install button or manual Verify action.
The optional real Josi CE 0.6.5 desktop client is a separate package/app.

## Safety and normal-user flow

- Server is required; Desktop Client is initially unchecked in Customize.
  Existing separately installed desktop clients are preserved by refusing to
  overwrite them; use the server-only choice in that case.
- Startup disk only, arm64, macOS 14+, at least 6 GB free space, and a signed-in
  user. Existing data can require additional snapshot space. Introduction
  explains destination, several-minute duration and administrator authorization.
- Required product artwork is reused from the real desktop source: the white
  J on navy. ICNS and CFBundleIconFile are present. Finder background, volume
  icon and package position are authored using pinned build-only ds_store and
  mac_alias tools; no drag-to-Applications target is shipped.
- Signed code and inventory verification run automatically before lifecycle
  mutation. A progress companion shows plain task/service labels and elapsed
  activity. Only explicit helper success enables browser/client launch. Lost
  helpers and failures disable actions and expose redacted copyable diagnostics.
- A native folder chooser offers a read-only /workspace connection. Folder
  ownership, links, exact directory identity and readability as both the web
  and worker identities are checked. With explicit user consent, administrator
  authorization adds narrow, reversible reader grants on the selected folder
  and search-only grants on private parents. Existing permissions are preserved;
  descendants are not recursively rewritten. macOS privacy protection still
  applies. A recognized privacy denial offers Settings and exact-app Finder
  buttons; the user grants Full Disk Access manually. Service access failures
  are reported separately. Users can change the folder or decline access.
- Protected runtime configuration binds the original directory device/inode;
  the database continues to use the logical /workspace root. Native local-file
  operations retain descriptor-relative traversal and original grant checks.
  Folder replacement, links, revocation and unauthorized writes fail closed.
- The existing six service identities, local-only listeners, protected secrets,
  durable journal, verified cold snapshots and migrations-before-activation
  remain. Preactivation upgrade failures may recover a verified previous
  installation. Postactivation rollback still refuses to discard new writes.
- Folder changes record durable intent and can revert settings while retaining
  all database/user writes. Pending changes block new lifecycle actions until
  repair. Same-version repair installs run migrations/readiness before commit.
- Uninstall disables owned launchd jobs and retains data, program versions,
  service identities and uniquely named startup definitions. Reinstall can reuse
  that preserved state. The desktop app is removable separately using Trash.
  Server management app removal is optional after disabling the server.

## Build and evidence

Use full Xcode, the existing private arm64 Node/Python, external caches, and
an exclusive timestamped directory under the existing artifact root:

```sh
python3.11 -I -B scripts/macos/build-pkg.py prepare --output /absolute/exclusive/pkg-candidate-TIMESTAMP
# After committing source and Roman's Keychain authorization:
python3.11 -I -B scripts/macos/build-pkg.py sign --output /absolute/exclusive/pkg-candidate-TIMESTAMP
```

`prepare` preserves all prior artifacts. It validates the existing SOCAL-signed
server runtime/client, builds the native management app and logo resources,
generates client notices/SBOM and pinned Electron/FFmpeg corresponding source,
inspects arm64 library closure, and creates/expands an unsigned PKG. It does not
execute package scripts or install services. `sign` requires a clean commit,
signs actual candidate code and distribution with the exact SOCAL identities,
uses hardened runtime and timestamps where applicable, and produces a separate
new PKG/DMG plus source companion, checksums and TEST-ME. Neither command submits
notarization or publishes. Pause for Roman if private-key access is requested.

Finder presentation uses an HFS+ image, matching the legacy Finder alias format,
with explicit icon-view settings and a single Licenses and Sources folder.
If macOS blocks a mount within external staging, obtain the user's permission
for a temporary standard /Volumes mount and pass `sign --standard-mount`.
The helper verifies that the mount belongs to this candidate; physical image
data and all outputs remain on JosiDrive, and the volume is detached afterward.

Existing server notices/SBOM and 787-archive corresponding-source closure are
preserved. The client receives original Electron/Chromium and npm notices, an
additional CycloneDX SBOM, its application source and the pinned engine build
scripts/patches and LGPL FFmpeg source. Public sources are separate from
executable payload; operational evidence and generated credentials stay out.
No malware-engine verdict is inferred from hashes, signatures or Gatekeeper.

Tests include full application regressions, native workspace containment,
Swift state/diagnostic/progress checks, automatic-verification/failure policy,
settings rollback, retained-data uninstall and package expansion/choice checks.
`test-package.py --runtime <candidate-runtime>` runs the real bundled processes
in disposable external fixtures, including 65 migrations, engines/CPU speech,
browser handoff, selected /workspace reads, decline/write denial, migration
failure recovery, upgrade sentinel and uninstall/repair reinstall.

Physical clean installation, root account/ACL behavior, native folder chooser,
macOS privacy authorization, actual client launch, reboot and real uninstall
must be tested by Roman. Do not launch the installer on the build Mac. See
`packaging/macos/PKG-TEST-ME.txt`. A signed but unnotarized candidate may be
rejected by Gatekeeper; that verdict is recorded, never treated as acceptance.

## Root-cause evidence

macos.12 installs a separate `Uninstall Josi.app` and includes the same signed
app on the DMG. It carries its own minimal Python standard library and cleanup
code, so server startup and the management app are not dependencies. Keep-data
removal preserves server versions, identities, recovery copies and subscription
configuration for repair/reinstall; Complete removal also removes those, local
client state, the desktop encryption key and exact package receipts. Workspace
files and owner Codex/Claude installations are outside the deletion list.
Cleanup records its intent in a protected journal and can continue after partial
account deletion. Owned service definitions are validated before shutdown;
changed installation identities or unrelated app identifiers refuse removal.
The native window copies its helper into root-owned temporary staging, verifies
the SOCAL signature, and uses the standard macOS administrator prompt. It does
not install a persistent privileged background helper.

The Documents/RV failure reported `Expected “\"” but found unknown token (-2741)`.
JSONEncoder escaped path slashes as `\/`, which AppleScript rejects. The shared
authorization encoder escapes quotes and backslashes without JSON slash escapes;
tests compile the actual authorization script with Apple's parser, without
executing privileged operations. A failed folder change retains its heading
and diagnostic message even when the readiness poll succeeds.

Folder selection now explicitly asks to append read-only access for the web and
worker accounts to the selected directory and search-only access to private
parents owned by the selecting user. Original modes and unrelated ACL entries
are preserved. Only added entries are recorded and revoked, using pinned file
descriptors and inode checks. Existing descendants are not recursively rewritten
and macOS privacy restrictions remain in force. Failed changes restore the
previous grants and configuration. Codex's shell, local image viewer and agent
delegation built-ins are disabled so subscription file access uses Josi MCP
permission gates; supplied-image model input remains supported.

The native subscription environment must set `JOSI_MCP_SERVER` to the activated
version's `app/packages/agent/dist/mcp/server.js`. Without it, both subscription
providers fall back to Docker's `/app` path and refuse tool requests before
starting the vendor CLI, even when ordinary replies and account sign-in work.
The macos.11 package supplies this path for both web and worker roles.
`test-subscription-cli.mjs` checks the official Codex CLI's generated MCP
configuration and starts the real packaged server using each provider's
configuration. Initialization, tool listing, `record_number(7)` and the
completed-call ledger must all pass in the disposable installation. These
checks also read the selected native folder through both providers' MCP
configurations with a cleared child environment and the native protected
database-password reader. Codex's MCP launcher clears inherited variables,
so the harness explicitly passes only the required non-secret native paths
and filesystem identities; credentials remain in the private context file.
These checks do not establish an authenticated model-driven tool call; Roman must
repeat the setup capability test after upgrading.

Apple rejected notarization submission `a8d75303-666b-490b-b194-8b3f12046212`
because the source ZIP inside the DMG included Skia's legacy i386 `perfhost`
fixture. All three blocking findings (unsigned, missing secure timestamp and
missing hardened runtime) pointed to that upstream fixture. Corresponding
source archives must therefore ship beside the submitted DMG, with checksums
and a pointer inside `Licenses and Sources`. Preserve their pinned original
bytes; do not re-sign or edit upstream source fixtures to satisfy notarization.
The installer payload is unchanged by this packaging correction.

Roman's failed physical test used Verify only. Its stdout/stderr and launch
error were discarded, and helper output retained only the exception class.
The original Verify failure cause remains unrecoverable; preserved payload
verification now succeeds. A separate exact Install defect was reproduced:
`codesign -R` treated the unprefixed requirement string as a filename. All new
literal requirements use the documented `=anchor ...` syntax. This does not
retroactively explain the Verify-only failure.

The earlier report of zero Keychain identities was a sandbox access limitation.
Explicit read-only queries outside the sandbox show both exact SOCAL Developer
ID identities. Keychain settings and search lists have not been changed.

References: [Apple distribution schema](https://developer.apple.com/library/archive/documentation/DeveloperTools/Reference/DistributionDefinitionRef/Chapters/Distribution_XML_Ref.html),
[ds_store](https://ds-store.readthedocs.io/en/latest/), and the local `codesign`,
`pkgbuild`, `productbuild` and `pkgutil` manual pages.

macos.13 corrects complete-removal process classification. macOS can retain its
Apple-signed distnoted and containermanagerd agents under Josi service UIDs after
all Josi jobs have stopped. The helper uses proc_pidpath to inspect the kernel
executable path and excludes only those two exact paths after verifying Apple
signatures. It does not signal or wait for those OS agents. Other live service-
UID processes must still stop, and a timeout reports their PIDs/executable paths.
Roman’s macos.12 physical removal stopped at this gate before file deletion;
it was not evidence of a cold snapshot, folder or authorization failure.


macos.14 addresses the next physical Complete removal failure: Directory Service
returned exit 40 / eDSPermissionError while deleting the first service user.
Read-only inspection found all six service users/groups still present; the
first account had Secure Token disabled. macos.13 had already removed the apps
before reaching that denial. The uninstaller now declares the required
NSSystemAdministrationUsageDescription and the app/data removal purpose strings,
uses the explicit /Local/Default node, and reports the specific failure in its
window. It validates all target app identifiers first, then removes service
accounts before apps or product data, leaving the UI available if permission is
denied. The existing recorded retry and identity-collision checks still apply.

Roman ran a signed native access-check app with the uninstaller bundle identity
and system-administration purpose string. Through the same administrator helper
path it created and deleted one empty disposable group successfully. Existing
Josi accounts and data were untouched. This supports the corrected permission
path but does not prove actual Josi user deletion or complete removal. The
original denial was not captured in TCC logs, so its precise privacy attribution
remains an inference. Do not disable SIP, delete Directory Service database
files directly, or silently grant Full Disk Access as a workaround.

Apple documents NSSystemAdministrationUsageDescription as required for apps
using system-configuration APIs:
https://developer.apple.com/documentation/bundleresources/information-property-list/nssystemadministrationusagedescription


14 October follow-up: macos.14 still failed with eDSPermissionError. The exact
20:06:11 macOS log records "Failed to delete record: disallowed by sandbox"
and ODRecordDelete / ODErrorRecordPermissionError. Adding a usage description
is not a privacy grant, and the empty-group check did not exercise user-record
protection. After Roman explicitly enabled Full Disk Access for the running
Uninstall Josi app, actual user/group deletion completed. Its immediate final
verification then incorrectly reported "Service identity remains: database".
Fresh queries found all six users and groups absent; Retry completed successfully.

The next source revision queries /Local/Default with dscl for deletion presence
and final verification instead of passwd/group name caches. Only an explicit
exit 56 with eDSRecordNotFound means absent; other errors fail closed. A real
remaining user or group still fails verification. Account-ownership and UID/GID
collision checks are retained. Read-only checks after Roman's successful retry
confirmed all six identities/groups, launchd jobs, receipts, app bundles,
product data, cleanup journal and intended per-user profiles absent.

Account-deletion denial now carries a structured full-disk-access recovery tag.
The native window opens the appropriate Settings page only when the user clicks
its button, reveals its exact app for adding to the list, explains the broad
permission, and asks the user to quit/reopen before retry. Successful Complete
removal reminds the user to disable that access and provides the Settings button.
The app neither grants/revokes Full Disk Access nor edits the TCC database. The
standard administrator prompt continues to provide temporary root elevation.
This follow-up source is not in the immutable signed macos.14 artifacts.

Apple's system-configuration access instructions:
https://support.apple.com/en-hk/guide/mac-help/mchlccb25729/mac
Apple's guidance on testing access and directing the user to Full Disk Access:
https://developer.apple.com/videos/play/wwdc2019/701/


## macos.16 folder-access correction

On 15 October Roman's signed diagnostic found the web account denied while the
worker account could read both a disposable private folder and Documents/RV.
A local reproduction showed that `chmod +a ... /dev/fd/N` replaces existing ACL
entries on this Mac. The second reader grant erased the first. The previous
validation counted the new entry without detecting the lost one.

The corrected code updates the target directly using `acl_get_fd_np` and
`acl_set_fd_np`, appending only the requested read/search allow entry. Existing
ACL entries, order and inherited flags are preserved and the full result is
checked. Grant validation rejects any lost entry; revocation uses macOS's
`ACL_NEXT_ENTRY` value (-1). The connection is committed only after both web
and worker probes pass. Parent descriptors request traversal rather than a
listing of unrelated Documents contents. Recognized root-helper privacy errors
offer guided Full Disk Access settings; service read errors retain a separate
cause, so they do not repeatedly prescribe privacy changes as a universal fix.

Seventy focused tests passed, including real multi-principal grants with prior
deny/inheritance entries, revoke/restore, loss detection and worker-denial
rollback. Roman's signed v3 diagnostic then confirmed that both actual service
accounts could read RV and the disposable folder with the new grants. Both
lost access again after exact temporary-grant revocation. This is a real
service-account diagnostic result, not a packaged macos.16 installation or a
launchd daemon acceptance test. The new build still requires package testing
and notarization before distribution; immutable macos.15 artifacts are unchanged.

The released bug could also discard pre-existing ACL entries. Its old receipts
do not contain a full baseline; do not invent ACLs or recursively reset users'
folders to claim historical restoration. The fix preserves the permissions
present when it starts. File contents are not modified by folder connection.


## macos.17 document processing

On 15 October Roman explicitly requested removing the macOS scanner requirement.
The native Mac package now accepts uploads, indexes documents and performs OCR
without a separate malware scanner. The former mandatory Mac scanner adapter
and upload/extraction gates are removed. Shared ingestion does not require a
scanner on native Mac even when an upgraded database has a legacy enabled
ClamAV flag. Setup no longer emits the required-scanner warning, Admin Storage
has no Mac scanner prerequisite, and diagnostics report scanning disabled.
The legacy runtime scannerSocket field remains accepted to preserve existing
configuration compatibility; it is not exported to the application.

The packaged engine test calls real extractRichSegments OCR with native runtime
settings and no scanner. Regression coverage also exercises authenticated Mac
uploads and persisted extracted text, ingestion/index/search, both legacy policy
values, setup and admin responses. Other platforms retain their existing scan
policy. Document type/size/quota/ownership/archive and encryption checks remain.
There is no fabricated antivirus verdict for documents processed without one.

## macos.18 native Doctor

The system checkup now selects an in-process, read-only Mac adapter when the
fixed native launcher sets `JOSI_NATIVE_RUNTIME=1` on Darwin. It does not require
the container maintenance socket. It checks architecture, installed files and
version agreement, application data access, free disk space, database/key
readiness, the exact shipped migration ledger, the localhost proxy's readiness
JSON, worker heartbeat, speech helper, any selected workspace, backup history,
job backlog and notification delivery. Each failed probe produces a fixed,
redacted check result. Missing application backups are warnings; recorded
backups are not described as restore-verified.

Doctor does not gain launchd control or new privileged permissions. Native
service repairs continue through the signed installer and macOS authorization.
The page explains that boundary and routes individual failures to the relevant
settings. Container Doctor and its approved repair flow remain available on
container installations. Empty helper reports cannot appear healthy, and an
old approval cannot trigger a repair that the current diagnosis disallows.

Mac update status reports the active native version and explains the signed
installer update path. It ignores stale container release metadata, does not
query the container release channel, and refuses browser-triggered installation.
It does not claim to implement an automatic native updater.

Verification includes native probe fault tests, authenticated API regression
tests and packaged integration using disposable PostgreSQL/services with a
selected workspace. The packaged test pauses only its fixture worker to prove
that a stale heartbeat is detected and that a fresh one clears the failure.
Physical installation remains a separate acceptance step.

Native selected-folder discovery also retries reconciliation for the signed-in
installation owner. A folder that was unavailable at startup can become
connected after access is granted, without restarting the server. Discovery
locks the owner row in a transaction; parallel browser/MCP requests cannot
create duplicate grants. Capability revocation, paused mappings and explicit
unmapping are preserved. Members cannot trigger owner grants or see the native
selection metadata. A retained root that needs reconnection is connected by an
explicit owner action in Local Workspace.

Native mapping creation validates the logical `/workspace` root using pinned
Mac descriptors instead of looking for a physical container mount. The page
auto-selects a single active mapping, can refresh discovery, provides an
explicit connection form and explains unavailable native access. Doctor checks
both physical folder readability and active owner registration. Workspace AI
access claims require a current discovery/read result; empty discovery and the
vendor CLI's application working directory are not evidence of folder access.
Filename claims are checked against workspace tool results as well.

The Storage coding checkbox remains independent of folder connection consent.
If a capability row already disables local mapping, even first discovery does
not silently enable it. Local Workspace offers an explicit Connect folder
action for the signed-in installation owner. Its CSRF-protected native endpoint
accepts no path, owner, permission or other request options; it rechecks the
installer selection and physical folder, refuses paused connections, and
creates only the selected read-only mapping in a transaction. Existing coding
settings are retained. Normal discovery never reverses a prior revocation.
