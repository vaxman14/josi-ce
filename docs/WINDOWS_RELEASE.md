# Releasing Josi CE for Windows

One command builds the Windows release from a checkout: a single installer
that carries the server, the app and every runtime, a checksum file, and a
draft GitHub release. This page is for the person who runs it.

```bash
powershell -ExecutionPolicy Bypass -File scripts\windows\Build-Release.ps1 -Version 1.0.0 -Sign -Publish
```

Leave out `-Sign` for an unsigned test build and `-Publish` to keep the result
local. The output lands in `artifacts\windows-native\releases\<version>\`:

- `Josi-CE-<version>-Windows-x64.exe`: the installer (about 1 GB; it embeds
  PostgreSQL, Node, the private Python with the voice packages, the voice
  models, Caddy, ffmpeg, the Codex and Claude CLIs, the Josi server and the
  Josi app).
- `SHA256SUMS.txt` and `RELEASE-NOTES.md`.

## What the script runs, in order

Every step is an existing script under `scripts\windows`; the release script
only orders them and signs in between.

1. **Pinned inputs** (`Get-UpstreamSpikes.ps1` and direct downloads, all
   verified by size and SHA-256 against the locks in `packaging\windows`):
   Caddy, Inno Setup (installed per-user into the tools folder), WinSW source,
   Node, PostgreSQL, the Python standalone archive, ffmpeg, the MSVC
   redistributable, the voice models.
2. **Service host** (`Build-ServiceHost.ps1`): upstream WinSW at the pinned
   commit plus the one-line least-privilege patch, built with the .NET SDK.
   The build is not bit-for-bit reproducible across machines, so the hash in
   `service-host.lock.json` is the hash of the build on the release machine;
   a new machine updates it once after reviewing the build.
3. **Setup bridge, launcher and app** (`Build-NativeSetupHelper.ps1`,
   `Build-OnboardingLauncher.ps1`, `Build-NativeApp.ps1`). The bridge is
   loaded once in Windows PowerShell 5.1 to prove it needs no compiler.
4. **Signing the app and the launcher** (with `-Sign`), before the kit binds
   their hashes.
5. **Installer kit** (`Build-InstallerKit.ps1`): the setup scripts, the
   bridge, the launcher, the service host and the app, with an inventory.
6. **Application payload** (`Build-Application.mjs`, run with the pinned
   Node): an isolated source snapshot, `npm ci`, TypeScript, the web app,
   production dependencies only, the licence key stamped in.
7. **Runtime payload** (`build_runtimes.py`, run with the private Python):
   Node, Python with the voice packages verified against their wheel
   RECORDs, PostgreSQL, Caddy, the voice models, each with the MSVC runtime
   beside it.
8. **Component archives** (`Build-ReleasePayloads.mjs`): one compressed zip
   per component (josi, node, python, postgresql, caddy, voice-models, cli,
   ffmpeg), each with its file inventory inside, every third-party notice
   collected under `licenses/`, and `release-manifest.json`. The CLI binaries
   are verified against `subscription-cli.lock.json` by hash and by their
   vendor signatures before they enter.
9. **Installer** (`Build-Installer.ps1`): compiles `packaging\windows\JosiCE.iss`
   with the pinned Inno Setup. The setup host verifies the kit and the manifest
   before touching anything, and every archive by hash before extraction.
10. **Signing the installer**, the checksum file, the release notes, and with
    `-Publish` a draft GitHub release `v<version>` through the gh CLI.

## One-time preparation of the release PC

- Git, Node.js 24, the .NET SDK (8, or 10 plus the 8 desktop runtime),
  Visual Studio Build Tools with the Windows 10 SDK (for `signtool`), the
  Azure CLI, the gh CLI.
- The private Python with the voice packages:
  `scripts\windows\Prepare-VoiceSpike.ps1` (everything it downloads is
  pinned). Result: `artifacts\windows-native\tools\python-3.12.15`.
- The pinned subscription CLIs in a `node_modules` folder: the dev server's
  `C:\Dev\josi-dev\cli` after `npm ci` there (pass another folder with
  `-CliRoot`).
- For signing: the Trusted Signing client tools
  (`winget install Microsoft.Azure.TrustedSigningClientTools`), an
  `az login` as the publisher, and `publisher\windows-signing.json` with the
  endpoint, the signing account name and the certificate profile name. No
  secret is stored; the Azure session does the signing.

## Checks before publishing

- Run the installer with `/VERIFYONLY /CURRENTUSER` on the build PC: it
  verifies its own kit and manifest without administrator rights and without
  installing anything.
- Install on a clean Windows 11 PC or VM, finish the first run, sign in, set
  up a model, attach a browser tab, make a backup, restore it on a second
  clean PC. Then upgrade an older installation with the new installer and
  check that the accounts and conversations are still there.
- Properties › Digital Signatures on the installer shows SOCAL RECEPTIONIST
  LLC; `SHA256SUMS.txt` matches.

## Known gaps in 1.0

- The CTranslate2 wheel is the upstream CPU build (the one the dev server
  runs). The patched source build (`+josi.windows2`, the Windows shutdown
  fix) is a later release gate; `build_runtimes.py` says so.
- The installer carries everything, so it is large. A smaller installer that
  downloads the voice runtime on demand is a later change.
- The licence gates in the older acceptance pipeline (`Build-ReleaseMetadata.py`,
  `Build-ReleaseAssets.py`, the SBOM validation) are not run by the release
  script; the notices are collected, the formal review is not.
