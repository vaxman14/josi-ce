#!/bin/bash
# Build the Josi CE release for Linux and, if asked, attach it to the GitHub
# release the Windows and Mac installers share.
#
#   scripts/linux/build-release.sh --version 1.0.0 [--publish] [--skip-provision] [--skip-code] [--skip-portable] [--arm64]
#
# --arm64 also builds the arm64 (aarch64) packages, for a Raspberry Pi and other
# ARM machines. The parts that must be compiled run in an arm64 Debian image
# under emulation, so Docker needs it switched on once per boot:
#   docker run --privileged --rm tonistiigi/binfmt --install arm64
# They are compiled the first time and kept in <build base>-aarch64.
#
# Runs on an x86_64 Linux machine with Docker, Node and npm. Every step is an
# existing script under scripts/linux; this one only orders them, names the
# version once, and collects the result in <build base>/releases/<version>.
set -euo pipefail

version=; publish=0; provision=1; code=1; portable=0; arm64=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version=${2:-}; shift 2 ;;
    --publish) publish=1; shift ;;
    --skip-provision) provision=0; shift ;;
    --skip-code) code=0; shift ;;
    --skip-portable) portable=0; shift ;;
    --portable) portable=1; shift ;;
    --arm64) arm64=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
fail() { printf 'build-release: %s\n' "$*" >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || fail 'use --version like 1.0.0'
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail 'an x86_64 Linux build machine is required'
for tool in docker node npm python3 tar zstd; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"; done
[ "$publish" = 0 ] || command -v gh >/dev/null 2>&1 || fail 'gh (GitHub CLI, signed in) is required for --publish'

repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
export JOSI_LINUX_VERSION="$version"
export JOSI_LINUX_BUILD_BASE="${JOSI_LINUX_BUILD_BASE:-$HOME/JosiDrive/BuildTemp/josi-ce-native-linux-20261010}"
export JOSI_LINUX_BUILD_CACHE="${JOSI_LINUX_BUILD_CACHE:-$HOME/JosiDrive/Caches/codex-linux-native-20261010}"
base=$JOSI_LINUX_BUILD_BASE
out=$base/artifacts
step() { printf '\n== %s\n' "$*"; }

if [ "$provision" = 1 ]; then
  step 'Pinned inputs (Node, PostgreSQL source, Python, Caddy, OpenBLAS, voice models)'
  python3 -B scripts/linux/acquire.py
  step 'Private Python'
  bash scripts/linux/build-base.sh python
  step 'PostgreSQL, the setup helper and the voice packages, built in the Debian 12 image'
  bash scripts/linux/build-base.sh portable
fi

if [ "$code" = 1 ]; then
  step 'Server and web build'
  npm ci --no-audit --no-fund
  # The publisher's licence verification key, as the Windows build stamps it
  # (scripts/windows/Build-Application.mjs). Without it this build refuses
  # every licence, so a paid module could never be switched on. A public key:
  # it verifies licences and cannot sign one. The source file is put back
  # afterwards so the checkout stays clean.
  stamp=packages/core/src/buildStamp.ts
  cp "$stamp" "$stamp.unstamped"
  trap 'mv -f "$repo/$stamp.unstamped" "$repo/$stamp" 2>/dev/null || true' EXIT
  node scripts/stamp-edition.mjs --licence-key "$(tr -d '[:space:]' < publisher/licence-verification-key.b64)"
  npx tsc -b
  mv -f "$stamp.unstamped" "$stamp"
  trap - EXIT
  grep -q 'BUILD_LICENCE_PUBLIC_KEY = "' packages/core/dist/buildStamp.js || fail 'the licence key was not stamped into the build'
  npm --prefix apps/web run build
fi

# stage.py also builds the browser extension (scripts/unified/build-browser-extensions.mjs)
# into a new folder and stages its chrome/ part as app/browser-extension/chrome.
step "Runtime staging, browser extension and payload inventory ($version)"
rm -rf "$base/stage/runtime/app/node_modules"
python3 -B scripts/linux/stage.py

step 'Packages: Arch (pacman) and Debian/Ubuntu'
rm -f "$out/SHA256SUMS.txt" "$out"/josi*.deb "$out"/josi*.pkg.tar.zst "$out"/josi-root-*.tar.zst
python3 -B scripts/linux/build-arch.py
python3 -B scripts/linux/build-deb.py
# The Ghost Stage needs all 14 clips in both formats and the still.
python3 -B scripts/linux/check-ghost-assets.py

if [ "$arm64" = 1 ]; then
  # A second runtime and its packages, in a build folder of their own. The
  # compiled server and web app are the ones built above: they are the same
  # for every processor.
  arm_base=$base-aarch64
  (
    export JOSI_LINUX_ARCH=aarch64 JOSI_LINUX_BUILD_BASE="$arm_base"
    if [ "$provision" = 1 ] || [ ! -f "$arm_base/prefix/.complete" ]; then
      step 'arm64: pinned inputs, private Python, then PostgreSQL, the setup helper and the voice packages (emulated, slow)'
      [ -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ] \
        || fail 'arm64 emulation is off: run  docker run --privileged --rm tonistiigi/binfmt --install arm64'
      rm -f "$arm_base/prefix/.complete"
      python3 -B scripts/linux/acquire.py
      bash scripts/linux/build-base.sh python
      bash scripts/linux/build-base.sh portable
      touch "$arm_base/prefix/.complete"
    fi
    step "arm64: runtime staging and payload inventory ($version)"
    rm -rf "$arm_base/stage/runtime/app/node_modules"
    python3 -B scripts/linux/stage.py
    step 'arm64: packages, Arch (pacman) and Debian/Ubuntu'
    rm -f "$arm_base/artifacts/SHA256SUMS.txt" "$arm_base/artifacts"/josi*.deb "$arm_base/artifacts"/josi*.pkg.tar.zst "$arm_base/artifacts"/josi-root-*.tar.zst
    python3 -B scripts/linux/build-arch.py
    python3 -B scripts/linux/build-deb.py
    python3 -B scripts/linux/check-ghost-assets.py
  )
  cp "$arm_base/artifacts"/josi*_arm64.deb "$arm_base/artifacts"/josi-*-aarch64.pkg.tar.zst "$arm_base/artifacts"/josi-root-*-aarch64.tar.zst "$out/"
fi

step 'One-command installer (linux) and update feed (linux-latest.json)'
python3 -B scripts/linux/build-headless-installer.py

# The graphical AppImage installer belongs to the earlier desktop-setup
# layout and is not part of the headless server; it stays off unless asked.
if [ "$portable" = 1 ]; then
  step 'Portable graphical installer (AppImage and .run)'
  python3 -B scripts/linux/build-universal-appimage.py
fi

step 'Release folder'
release=$base/releases/$version
rm -rf "$release"; mkdir -p "$release"
names=$(python3 -B -c "import sys; sys.path.insert(0,'scripts/linux'); from package_common import package_names; print(' '.join(package_names().values()))")
for name in $names; do [ -f "$out/$name" ] && cp "$out/$name" "$release/"; done
cp "$out/linux" "$out/linux-latest.json" "$out/PKGBUILD" "$out/josi.install" "$out"/josi-root-*.tar.zst "$release/"
# install.sh: run from a copy of this folder to install with no download (--from).
install -m 755 packaging/linux/offline-install.sh "$release/install.sh"
if [ "$portable" = 1 ]; then
  cp "$out/Josi-CE-Server-Installer-$version-x86_64.AppImage" "$out/Josi-CE-Server-Installer-$version-x86_64.run" "$release/"
fi
(cd "$release" && sha256sum -- * | sort -k2 > SHA256SUMS.txt)
cat > "$release/RELEASE-NOTES.md" <<NOTES
Josi $version server for Linux (headless, systemd).

One command on Arch, Debian or Ubuntu:

    curl -fsSL ${JOSI_INSTALL_HOST:-https://<install host>}/linux | sudo bash

It installs what Josi needs, checks the package's SHA-256, installs it, starts josi.service and prints the address to open in a browser, where setup, sign-in, chat, settings and updates happen. The packages are here for a manual install too (.deb, .pkg.tar.zst, and a PKGBUILD for makepkg). Remove with \`sudo josi-uninstall\` (keeps the data) or \`sudo josi-uninstall --purge\`. All checksums are in SHA256SUMS.txt. The packages are not signed with a distribution key.
NOTES
echo "Release files in $release:"; (cd "$release" && ls -l)

if [ "$publish" = 1 ]; then
  tag=v$version
  step "GitHub release $tag"
  assets=()
  for file in "$release"/*; do case "$(basename "$file")" in SHA256SUMS.txt|RELEASE-NOTES.md) ;; *) assets+=("$file") ;; esac; done
  if gh release view "$tag" --repo vaxman14/josi-ce >/dev/null 2>&1; then
    # The Windows or Mac build created the draft first: add our files and merge
    # our lines into the shared checksum file instead of replacing it.
    merged=$(mktemp -d)
    gh release download "$tag" --repo vaxman14/josi-ce --pattern SHA256SUMS.txt --dir "$merged" >/dev/null 2>&1 || true
    cat "$release/SHA256SUMS.txt" "$merged/SHA256SUMS.txt" 2>/dev/null | awk 'NF == 2 && !seen[$2]++' | sort -k2 > "$merged/SHA256SUMS.merged"
    cp "$merged/SHA256SUMS.merged" "$merged/SHA256SUMS.txt"
    gh release upload "$tag" --repo vaxman14/josi-ce --clobber "${assets[@]}" "$merged/SHA256SUMS.txt"
    echo "Attached to the existing release $tag (still a draft if it was one)."
  else
    gh release create "$tag" --repo vaxman14/josi-ce --draft --title "Josi CE $version" --notes-file "$release/RELEASE-NOTES.md" "${assets[@]}" "$release/SHA256SUMS.txt"
    echo "Draft release $tag created. Attach the Windows and Mac installers, then press Publish on GitHub."
  fi
fi
