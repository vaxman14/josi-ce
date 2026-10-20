# P5 unified app — implementation checkpoint

The owner directed build-first work with functional testing after feature implementation. This checkpoint records implementation, not a completed P5 gate. No installation, live server mutation, signing, notarization or release publication is performed.

## Implemented

- The Josi start screen offers **On this Mac** and **On another computer**. The local status/recovery shell is independent of the CE web renderer and remains reachable through the Josi server menu.
- Local setup reads the existing protected installation receipt and the installing user's existing bootstrap handoff. The main process obtains and consumes a one-use setup token into the CE window's memory-only HTTP-only cookie session. It opens `/setup` inside Josi; there is no external setup page, temporary HTML file or token-bearing URL.
- Existing accounts go to the existing server login; setup completion is read from the server. Returning to controls and reopening the same server retains its in-memory login session. Switching servers clears the previous session. Durable Vault-backed client session migration is still P2 work.
- Local controls provide installation/update, start, stop, restart, journal-based repair and removal of the local server using the existing lifecycle and service identities. Removal retains data/recovery material and leaves the unified app available for remote connections. They are exposed only to the trusted local shell. A remote CE page has no new service-management IPC. Fixed signed application/helper paths and macOS administrator authorization protect privileged operations.
- Stop disables the owned jobs as well as stopping them, so a reboot respects the stopped state. Start re-enables them. Interrupted service operations remain recorded and repair resumes the same operation. Existing account, Vault, database and service roots are retained.
- Backups opens the existing authenticated server backup page. Copy diagnostics includes only selected application/version/readiness/service fields, never raw launchd output, credentials or chat content. Closing the client does not stop background services.
- `scripts/macos/build-unified.py` assembles **Josi.app** from pinned local Electron and a supplied offline server runtime. It overlays current server packages, web build, migrations and native helpers, then refreshes the runtime inventory. APFS clones avoid duplicating the large engine/model payload. The optional unsigned package has one required choice, with no optional-client component. Local server provisioning happens from the app after choosing local hosting; remote-only use does not create another server.

## Build inputs and limits

The new app identity is `com.heyjosi.ce.unified`, installed at `/Applications/Josi.app`. The server remains under the existing Josi CE Server support directory and existing `com.heyjosi.ce.*` jobs. The legacy installer stays available as migration input; the new builder does not reuse its separate client packaging.

The builder only writes a fresh output folder and never installs or signs it. A desktop-only development candidate may omit `--runtime`; creating an installer requires it. Supply `--node` with Node 22.12+ for the pinned ASAR/fuse tools. Build current TypeScript and the web application before packaging. The candidate records its source commit, dirty-tree flag, Electron version/executable hash, desktop ASAR hash/fuse state, protected native helper hash, and unvalidated/unsigned status. Final signing must update the byte inventory after nested code signing. The minimum macOS version is 14.2.

Desktop code sealing and protected helper packaging are described in the [P4/P5 native-host checkpoint](P4_P5_PROTECTED_HOST.md). The candidate contains no unpacked fallback app directory; protected signing still requires final trusted signing and app/server enrollment assembly.

Local-server management now recognizes that sealed `app.asar` path. The earlier unpacked-path check would have disabled local install/start/repair controls in the new package. The archive must be a regular, non-symlink file without group/world write permission. The existing full app signature check and OS administrator confirmation still run before privileged operations. Source tracing confirms the unified installer helper skips the legacy server companion and does not offer or install a second client.

The existing bootstrap file predates this checkpoint and is used only before the Vault/account setup is complete; this is not an additional secret authority. Its final lifecycle/revocation and production loopback service-identity verification remain part of the P2/P5 acceptance work.

## Still required

Functional local setup/resume and remote-client acceptance, real privileged start/stop/reboot/repair/removal checks, complete app/session migration and retirement of old visible apps, final app/data-erasure uninstall choices, detailed installation progress, signed product packaging/notarization and end-to-end release acceptance remain outstanding. No P5 gate is marked complete from source or build success.

## Build record

JavaScript/Python syntax, the TypeScript build and public-data scanning passed at this checkpoint. No functional suites were run. Assembly into the ignored `build/unified-p5-candidate-20261019-1` folder stalled inside macOS `clonefileat` while cloning the offline runtime. A one-second process sample confirmed the syscall; the builder was stopped and its partial candidate retained. No runnable combined product or installer is claimed from that attempt. Use a temporary local staging directory for the next packaging pass rather than spending the feature-building session on this filesystem stall.
