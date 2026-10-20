# P5 unified app — implementation checkpoint

The owner directed build-first work with functional testing after feature implementation. This checkpoint records implementation, not a completed P5 gate. No installation, live server mutation, signing, notarization or release publication is performed.

## Implemented

- The Josi start screen offers **On this Mac** and **On another computer**. The local status/recovery shell is independent of the CE web renderer and remains reachable through the Josi server menu.
- Local setup reads the existing protected installation receipt and the installing user's existing bootstrap handoff. The main process obtains and consumes a one-use setup token into the CE window's memory-only HTTP-only cookie session. It opens `/setup` inside Josi; there is no external setup page, temporary HTML file or token-bearing URL.
- Existing accounts go to the existing server login; setup completion is read from the server. Returning to controls and reopening the same server retains its in-memory login session. Switching servers clears the previous session. Durable Vault-backed client session migration is still P2 work.
- Local controls provide installation/update, start, stop, restart, journal-based repair and removal of the local server using the existing lifecycle and service identities. Removal retains data/recovery material and leaves the unified app available for remote connections. They are exposed only to the trusted local shell. A remote CE page has no new service-management IPC. Fixed signed application/helper paths and macOS administrator authorization protect privileged operations.
- Stop disables the owned jobs as well as stopping them, so a reboot respects the stopped state. Start re-enables them. Interrupted service operations remain recorded and repair resumes the same operation. Existing account, Vault, database and service roots are retained.
- Backups opens the existing authenticated server backup page. Copy diagnostics includes only selected application/version/readiness/service fields, never raw launchd output, credentials or chat content. Closing the client does not stop background services.
- Local installation/update shows the current component and recent setup activity inside the app. The main process creates a random attempt identifier and the privileged installer creates that exact root-owned log with a read-only ACL for the interactive user. The app reads a bounded tail and projects only known phase/component labels; raw diagnostics, paths and credentials never reach this view. A completed installation record and current service readiness remain separate. There is no invented percentage or elapsed-time completion claim.
- `scripts/macos/build-unified.py` assembles **Josi.app** from pinned local Electron and a supplied offline server runtime. It overlays current server packages, web build, migrations and native helpers, then refreshes the runtime inventory. APFS clones avoid duplicating the large engine/model payload by default. Explicit `--copy-mode copy` uses ordinary reads when cloning stalls; its preflight reserves space for the copied inputs, both package intermediates when requested, and source overlays. There is no silent clone-to-copy fallback. Build-stage messages show where assembly is working. The optional unsigned package has one required choice, with no optional-client component. Local server provisioning happens from the app after choosing local hosting; remote-only use does not create another server.

## Build inputs and limits

The new app identity is `com.heyjosi.ce.unified`, installed at `/Applications/Josi.app`. The server remains under the existing Josi CE Server support directory and existing `com.heyjosi.ce.*` jobs. The legacy installer stays available as migration input; the new builder does not reuse its separate client packaging.

The builder only writes a fresh output folder and never installs or signs it. A desktop-only development candidate may omit `--runtime`; creating an installer requires it. Supply `--node` with Node 22.12+ for the pinned ASAR/fuse tools. Build current TypeScript and the web application before packaging. The candidate records its source commit, dirty-tree flag, payload copy mode, Electron version/executable hash, desktop ASAR hash/fuse state, protected native helper hashes, and unvalidated/unsigned status. Final signing must update the byte inventory after nested code signing. The minimum macOS version is 14.2.

Desktop code sealing and protected helper packaging are described in the [P4/P5 native-host checkpoint](P4_P5_PROTECTED_HOST.md). The candidate contains no unpacked fallback app directory; protected signing still requires final trusted signing and app/server enrollment assembly.

Local-server management now recognizes that sealed `app.asar` path. The earlier unpacked-path check would have disabled local install/start/repair controls in the new package. The archive must be a regular, non-symlink file without group/world write permission. The existing full app signature check and OS administrator confirmation still run before privileged operations. Source tracing confirms the unified installer helper skips the legacy server companion and does not offer or install a second client.

The existing bootstrap file predates this checkpoint and is used only before the Vault/account setup is complete; this is not an additional secret authority. Its final lifecycle/revocation and production loopback service-identity verification remain part of the P2/P5 acceptance work.

## Still required

Functional local setup/resume and remote-client acceptance, real privileged start/stop/reboot/repair/removal checks, complete app/session migration and retirement of old visible apps, final app/data-erasure uninstall choices, signed product packaging/notarization and end-to-end release acceptance remain outstanding. This app session retains its installation attempt; reopening the app currently uses installation/service status and journal repair rather than reconnecting to a previous progress log. No P5 gate is marked complete from source or build success.

## Build record

The earlier assembly into ignored `build/unified-p5-candidate-20261019-1` stalled inside macOS `clonefileat`; its partial candidate was retained. A second attempt in a temporary output folder encountered the same syscall stall. Explicit ordinary-copy mode progressed through the retained current server runtime. A subsequent read stalled on an old generated `packages/llm/dist/ssrf.js`; rebuilding TypeScript with `tsc -b --force` completed, and the following assembly passed that point. These observations do not establish the underlying macOS cause.

The combined candidate is now assembled at `/private/tmp/josi-unified-app-20261019-4/payload/Applications/Josi.app`. Its inputs are pinned Electron 43.2.0 and the retained `pkg-candidate-20261016T074431Z` signed server runtime (version `0.1.78-macos.18`), overlaid with current source builds and migrations. Its refreshed runtime inventory contains 16,463 entries. It includes the sealed client and both native approval helpers; it does not yet include a connected automation-desktop runtime.

The build produced the one-choice unsigned installer at `/private/tmp/josi-unified-app-20261019-4/Josi-unsigned.pkg` (about 769 MiB). `pkgbuild` returned success but printed twelve `write: Permission denied` warnings; these persisted when the packaging step ran outside the sandbox. They are unresolved packaging evidence, not a clean acceptance result. The build retained both outputs, and no installer was run to investigate them.

Packaging, signature and functional status are separate: creating an app or package is not evidence that setup, migration or automation works. No app was installed or launched, no service was changed, and no functional suite ran. P5 acceptance remains open.
