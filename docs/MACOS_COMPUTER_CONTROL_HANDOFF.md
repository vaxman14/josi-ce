# macOS computer-control source handoff

November 8, 2026. The Mac implementation, tests, installer/update changes and final ghost control bar are on `feature/macos-computer-control-20261108` in `vaxman14/josi-ce`. This is a separate branch based on `f2350a7645fac122b96126ba2c8489939ead3dde`; no Windows branch was changed by this handoff.

## Pick up from another machine

First inspect that machine's Git status, branches and worktrees. Preserve its current work. Fetch this branch and read the status directly without switching a dirty Windows checkout:

```sh
git fetch origin
git log -1 --oneline origin/feature/macos-computer-control-20261108
git show origin/feature/macos-computer-control-20261108:docs/MACOS_COMPUTER_CONTROL_STATUS.md
git diff --stat f2350a7645fac122b96126ba2c8489939ead3dde origin/feature/macos-computer-control-20261108
```

Use the fetched commit as the reference for deliberate integration into the Windows work. Inspect newer Windows commits before choosing merge or cherry-pick; do not replace that checkout or assume the branches are interchangeable. The Windows branch was observed at `cd4de3939e3d57e3c65b0ee784b95dbc9b6732bf` while preparing this handoff and may advance independently.

## Shared-code integration points

- `packages/protocol/src/computerControl.ts` defines additive `computer-control.2`; its currently implemented platform type is **macos only**. It does not turn `pc-control-chat.1` into a cross-platform contract. Preserve each platform's path, identity, permission and capture semantics when extending it.
- `packages/core/src/computerControl.ts` and `computerPolicy.ts` implement authenticated requests, protected approvals, device/workspace links, saved-policy intersection, budgets and leases. Explicit denials and local Stop must remain effective.
- `apps/api/src/http/computerControlRoutes.ts` connects the native executor. `packages/agent/src/computerControlTools.ts` and the trusted assistant loop integrate proposals/results and narrowly authorized capture projection. Captures are excluded from durable tool history and ordinary tool receipts.
- `packages/db/migrations/0116_computer_control_v2.sql` creates a separate encrypted store. Check the destination branch's migration numbering and history before integrating; do not silently renumber an already-applied migration.
- `apps/macos-native/Sources/Computer*.swift`, `Wire.swift` and `JosiInstaller.swift` are native Mac code. `scripts/macos/build-native-unified.py` and `packaging/macos/unified-preinstall.sh` build/sign/package the actual app and preserve its update lifecycle. The brand uses existing bundled ghost assets.

## Verification and limits

The detailed [status](MACOS_COMPUTER_CONTROL_STATUS.md) is the acceptance record: 47 automated tests across eight suites passed, native desktop/safety checks ran in the actual signed Mac app, the final bar's UI was inspected, and 11 installer-validation checks passed. All 17,948 packaged entries matched staging and extracted app signatures verified. Prior control checks and final UI/package checks are distinguished in the status.

This does **not** establish Windows acceptance or completion of the broader plan. Persistent shell sessions, remote-phone control, an administrator broker, some existing permission mappings and real configured-account/installed-upgrade acceptance remain open. No lock-screen or protected-password-prompt access is promised.

## Signed Mac artifact

The installer is stored on the Mac at `JosiDrive/Artifacts/Josi-1.2.4-macOS/Josi-1.2.4-macOS-arm64.pkg`, alongside `Source.tar.gz`, checksums, build metadata and evidence. It is not a Git blob or GitHub release asset. Signing keys, account data, build caches and credentials are not included in this handoff.

- Version: `1.2.4`, Apple Silicon.
- App and installer identity: Socal Receptionist LLC, team `LRH75YR6QW`.
- Installer SHA-256: `3900bc030276b5a12f30cc2e64c635d7dea0e64f3ee7e1b6eb8d71dc1a264c55`.
- Installer size: `727035917` bytes.
- Not installed, notarized or published as a release.

Only this handoff and status documentation changed after packaging; the native and shared implementation in this commit is the packaged source.
