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
  ownership, links, exact directory identity and readability as the server
  identity are checked. macOS privacy-protected or unreadable folders can be
  refused. The installer does not change selected-folder permissions or silently
  grant Full Disk Access. Users can change the folder or decline access.
- Protected runtime configuration binds the original directory device/inode;
  the database continues to use the logical /workspace root. Native local-file
  operations retain descriptor-relative traversal and original grant checks.
  Folder replacement, links, revocation, writes and scanner bypass fail closed.
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
