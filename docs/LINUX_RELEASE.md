# Releasing Josi CE for Linux

One command builds the Linux release from a checkout: the three native
packages, the one-command installer, the portable graphical installer, a
checksum file, and the upload to the GitHub release that the Windows and Mac
installers share. This page is for the person who runs it.

```bash
scripts/linux/build-release.sh --version 1.0.0 --publish
```

Add `--arch aarch64` for the arm64 packages (Raspberry Pi 4 and 5 and other
arm64 machines); see "Building for arm64" below.

Leave out `--publish` to keep the result local. Add `--skip-provision` when
the pinned inputs were already built on this machine (second and later runs),
`--skip-code` when the server was just built, and `--skip-portable` to leave
out the AppImage and `.run` files. The output lands in
`<build base>/releases/<version>/`:

- `josi-ce-server-setup_<version>_amd64.deb`, `josi-ce-server-setup-<version>.x86_64.rpm`
  and `josi-ce-server-setup-<version>-1-x86_64.pkg.tar.zst`: the server for
  Debian/Ubuntu, Fedora/RHEL and Arch, each about 500 MB (PostgreSQL, Node,
  the private Python with the voice packages, the voice models, Caddy and the
  Josi server inside). The arm64 build adds `_arm64.deb`, `.aarch64.rpm` and
  `-aarch64.pkg.tar.zst`.
- `install-josi-ce-server.sh`: the one-command installer. It carries the
  version, the release address and the SHA-256 of each package, picks the
  package for the machine's package manager and processor, verifies it and
  installs it. It names every architecture built for the version on this
  machine; on a machine whose architecture was not built it says so and stops.
  `https://get.heyjosi.com/install.sh` redirects to this file on the latest
  release.
- `Josi-CE-Server-Installer-<version>-x86_64.AppImage` and `.run`: the portable
  graphical installer for people who prefer a window to a terminal (x86_64
  only).
- `SHA256SUMS.txt` and `RELEASE-NOTES.md`.

## The build machine

An x86_64 Linux machine with Docker, Node 24, npm, Python 3, `binutils` and
`zstd` (Bananana, the Ubuntu test host, fits); an arm64 machine works for the
arm64 packages. Native parts are compiled inside a
digest-pinned Debian 12 image so the result runs on Debian 12+, Ubuntu 22.04+,
RHEL 9+/Fedora and Arch (glibc 2.34 and newer).

The build uses two folders outside the checkout, both settable:

| Variable | Default | Holds |
|---|---|---|
| `JOSI_LINUX_BUILD_BASE` | `~/JosiDrive/BuildTemp/josi-ce-native-linux-20261010` | compiled PostgreSQL, Python, staged runtime, package roots, `artifacts/`, `releases/` |
| `JOSI_LINUX_BUILD_CACHE` | `~/JosiDrive/Caches/codex-linux-native-20261010` | the pinned downloads (Node, PostgreSQL source, Python, Caddy, OpenBLAS, voice models, npm cache) |

The portable installer also needs `linuxdeploy-x86_64.AppImage` and
`appimagetool-x86_64.AppImage` in `JOSI_LINUX_APPIMAGE_TOOLS` (default: a
`linux-appimage-tools` folder beside the cache).

## Building for arm64

```bash
scripts/linux/build-release.sh --version 1.0.0 --arch aarch64
```

The packages run on 64-bit arm machines with glibc 2.34 or newer: Raspberry Pi
OS (64-bit) 12 and 13 on a Pi 4 or Pi 5, Debian 12+, Ubuntu 22.04+ and Fedora
on arm64, and Arch Linux ARM. A Pi with 4 GB of memory or more is the sensible
floor; the 32-bit Raspberry Pi OS is refused by the installer.

Everything compiled (PostgreSQL, the setup helper, CTranslate2 and its Python
wheel) is built inside the arm64 flavour of the same pinned Debian 12 image.
On an arm64 build machine that is native. On an x86_64 build machine the
container is emulated, which needs two things once:

```bash
sudo apt-get install -y qemu-user-static binfmt-support
docker pull --platform linux/arm64 "$(sed -n 's/^FROM //p' scripts/linux/PackageBuild.Dockerfile)"
```

The first registers QEMU with the kernel so arm64 programs start; the second
fetches the arm64 flavour of the base image (the build itself never pulls).
The release script checks both and stops with a pointer here when either is
missing. Emulated compiling is slow: set `JOSI_LINUX_BUILD_JOBS` to the number
of processor threads to use (default 8) and expect one to two hours for the
first run.

The arm64 work folders live in `<build base>/aarch64`, so they never touch the
x86_64 ones. The packages of both architectures land in the same
`<build base>/artifacts`, and `<build base>/releases/<version>` is filled with
whatever has been built for that version: build x86_64 and aarch64 one after
the other (in either order) and the release folder, the checksum file and the
one-command installer cover both. Publish after the last one.

No graphical installer is built for arm64; those machines use the one command.

## What the script runs, in order

Every step is an existing script under `scripts/linux`; the release script
only orders them and names the version once (`JOSI_LINUX_VERSION`).

1. **Pinned inputs** (`acquire.py`): every download is checked against
   `packaging/linux/build-inputs.lock.json` and
   `services/voice-box/models.lock.json` by SHA-256.
2. **Private Python, PostgreSQL, the setup helper and the voice packages**
   (`build-base.sh python`, `build-base.sh portable`): compiled in the Debian
   12 image so the glibc floor stays at 2.34.
3. **Server and web build**: `npm ci`, `tsc -b`, the web app.
4. **Runtime staging** (`stage.py`): the offline runtime with a fresh
   `npm ci --omit=dev` and the exact payload inventory (`inventory.py`).
5. **Packages** (`build-arch.py`, `build-deb.py`, `build-rpm.py`): the same
   root, reproducibly packaged three ways (`SOURCE_DATE_EPOCH` is fixed).
6. **One-command installer** (`build-headless-installer.py`): the template
   `packaging/linux/install-josi-ce-server.sh` filled with the package hashes.
7. **Portable installer** (`build-universal-appimage.py`).
8. **Release folder**, `SHA256SUMS.txt`, `RELEASE-NOTES.md`.
9. With `--publish`: the draft GitHub release `v<version>` is created, or, when
   the Windows or Mac build created it first, the files are attached and the
   checksum lines merged into the shared `SHA256SUMS.txt`.

The release is published by hand on GitHub once all three platforms are
attached; the download page fills its Linux door from the latest final release.

## Checks before publishing

- `python3 -m unittest discover -s packaging/linux -p 'test_*.py'` passes on
  the build machine.
- `scripts/linux/test-isolated-install.py <staged runtime> <disposable root>`
  runs the bundled lifecycle (all six services, migrations, readiness) without
  touching the host's systemd.
- A clean VM per family (Debian or Ubuntu, Fedora, Arch): run the one
  command, finish setup in the browser, reboot, `systemctl status 'josi-ce-*'`.

## Known gaps in 1.0

- The packages are not signed with a distribution key; the installer verifies
  them by SHA-256 against the script it was downloaded with, and that script
  is served over HTTPS from GitHub.
- The arm64 packages are built and checked under emulation; a run on a real
  Raspberry Pi (install, setup in the browser, reboot, speech) is still owed.
  The Pi 5's 16 KB memory pages are the thing to watch there.
- The graphical installer is x86_64 only.
- No malware scanner is required or bundled, the same as the Windows and Mac
  installers: uploads, indexing and OCR use the bundled parsers. The stored
  ClamAV policy still applies to Docker installs.
