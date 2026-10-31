# Releasing Josi CE for Mac

One command on the Mac builds the Mac release from a checkout: the signed and
notarized installer with the server and the app inside, a checksum file, and
the upload to the GitHub release that the Windows and Linux installers share.
This page is for the person who runs it.

```bash
python3 scripts/macos/build-release.py --version 1.0.0 \
  --runtime "$HOME/Documents/Josi Mac Native/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/stage/runtime" \
  --protected-profile "<the Apple-issued profile for com.heyjosi.ce.protected-key>" \
  --notarize-profile josi-notary --publish
```

Leave out `--publish` to keep the result local, and use `--skip-notarize` for
a quick local test build (a download from the web needs the notarized one, or
macOS refuses to open it). The output lands in
`~/Documents/Josi Mac Native/JosiDrive/Artifacts/releases/<version>/`:

- `Josi-CE-<version>-macOS-arm64.pkg`: the installer (about 700 MB; it embeds
  PostgreSQL, Node, the private Python with the voice packages, the voice
  models, Caddy, the Josi server and the native Josi app with its uninstaller
  and approval helpers). Apple Silicon, macOS 14.2 or newer.
- `SHA256SUMS.txt`, `RELEASE-NOTES.md` and `build.json`.

The full build folder with the evidence logs stays beside it as
`josi-ce-<version>-macos-<time>/`.

## One-time preparation on the Mac

- Xcode with the command-line tools, and the **Developer ID Application** and
  **Developer ID Installer** certificates of Socal Receptionist LLC
  (LRH75YR6QW) in the login keychain. They are already there on the build Mac.
- The Apple-issued provisioning profile for the Touch ID key helper
  (`com.heyjosi.ce.protected-key`); see the "Protected helper provisioning"
  section of [P5_NATIVE_APP.md](unified/P5_NATIVE_APP.md). Without it the
  build still works but protected approvals are disabled in the app.
- Notarization credentials, saved once in the keychain under a profile name,
  typed by the account holder, never stored in the repository:

  ```bash
  xcrun notarytool store-credentials josi-notary --apple-id <Apple ID email> --team-id LRH75YR6QW
  ```

  It asks for an app-specific password (made at appleid.apple.com).
- The staged offline runtime from `scripts/macos/stage.py` (Node, PostgreSQL,
  Python with the voice packages, Caddy, the voice models). It exists on the
  build Mac from the earlier builds; the release script overlays the current
  server packages, migrations, web build and native helpers onto it, so it
  only needs rebuilding when a runtime input changes. If `package-lock.json`
  changed since the runtime was staged, delete `stage/runtime/app/node_modules`
  and run `stage.py --code-only` first so the bundled dependencies match.
- `gh` signed in to GitHub for `--publish`.

## What the script runs, in order

1. **Server and web build**: `npm ci`, `tsc -b`, the web app
   (`--skip-code` skips it).
2. **Signed app and installer** (`scripts/macos/build-native-unified.py
   --version <v> --sign --package`): compiles the SwiftUI app, the uninstaller
   and the helpers, bundles the runtime, refreshes the inventories, signs
   everything with the Socal identities (hardened runtime, timestamps),
   builds `Install Josi.pkg`, signs it, then expands it again and compares
   every file, mode and link with the staging tree and re-verifies both app
   signatures. The version goes into the app (`CFBundleShortVersionString`),
   the package and the bundled runtime; the build number is the UTC time.
3. **Notarization**: `xcrun notarytool submit --wait`, then `stapler staple`,
   `stapler validate` and a Gatekeeper assessment of the stapled installer.
   Anything but "Accepted" stops the build and saves Apple's log in the
   evidence folder.
4. **Release folder** with the public file name, `SHA256SUMS.txt`,
   `RELEASE-NOTES.md`.
5. With `--publish`: the draft GitHub release `v<version>` is created, or, when
   the Windows or Linux build created it first, the installer is attached and
   the checksum line merged into the shared `SHA256SUMS.txt`.

The release is published by hand on GitHub once all three platforms are
attached; the download page fills its Mac door from the latest final release.

## Checks before publishing

- Open the installer on a Mac that did not build it. Gatekeeper must show it
  as from Socal Receptionist LLC with no warning.
- Install on a clean Mac (or a fresh user on the build Mac is not enough: the
  services are system-wide). Josi opens, setup finishes in the app, the six
  services run, `curl --fail http://localhost:8080/ready` answers, reboot and
  check again. `Uninstall Josi.app` with "keep data", then reinstall.
- The native app's Models page lists the providers and a chat answers.

## Known gaps in 1.0

- The app is Apple Silicon only (macOS 14.2+). Intel Macs are not covered.
- The automation desktop and browser-control features assembled on the Mac
  branch are not functionally accepted; they stay in the build as they were
  on 20 October 2026 and are not advertised on the download page.
- The runtime staging script still carries the first build Mac's folder
  paths; use `--runtime` to point at the staged runtime wherever it is.
