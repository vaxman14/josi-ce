#!/bin/bash
# Build the Josi CE release for Linux and, if asked, attach it to the GitHub
# release the Windows and Mac installers share.
#
#   scripts/linux/build-release.sh --version 1.0.0 [--arch aarch64] [--publish] [--skip-provision] [--skip-code] [--skip-portable]
#
# Runs on a Linux machine with Docker, Node and npm. Every step is an existing
# script under scripts/linux; this one only orders them, names the version
# once, and collects the result in <build base>/releases/<version>.
#
# --arch names the machines the packages are for: x86_64 (the default on an
# x86_64 build machine) or aarch64 (arm64: Raspberry Pi 4 and 5, other arm64
# boards and servers). Building aarch64 on an x86_64 machine compiles inside an
# emulated container; see "Building for arm64" in docs/LINUX_RELEASE.md.
set -euo pipefail

version=; arch=; publish=0; provision=1; code=1; portable=1
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version=${2:-}; shift 2 ;;
    --arch) arch=${2:-}; shift 2 ;;
    --publish) publish=1; shift ;;
    --skip-provision) provision=0; shift ;;
    --skip-code) code=0; shift ;;
    --skip-portable) portable=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
fail() { printf 'build-release: %s\n' "$*" >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]] || fail 'use --version like 1.0.0'
[ "$(uname -s)" = Linux ] || fail 'a Linux build machine is required'
for tool in docker node npm python3 tar zstd; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"; done
[ "$publish" = 0 ] || command -v gh >/dev/null 2>&1 || fail 'gh (GitHub CLI, signed in) is required for --publish'

repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
host=$(python3 -B scripts/linux/target.py) || fail 'this build machine is neither x86_64 nor arm64'
arch=$(JOSI_LINUX_ARCH="${arch:-$host}" python3 -B scripts/linux/target.py) || fail 'use --arch x86_64 or --arch aarch64'
export JOSI_LINUX_ARCH="$arch"
export JOSI_LINUX_VERSION="$version"
export JOSI_LINUX_BUILD_BASE="${JOSI_LINUX_BUILD_BASE:-$HOME/JosiDrive/BuildTemp/josi-ce-native-linux-20261010}"
export JOSI_LINUX_BUILD_CACHE="${JOSI_LINUX_BUILD_CACHE:-$HOME/JosiDrive/Caches/codex-linux-native-20261010}"
# Packages and release folders of every architecture share one place; the
# compiled parts of anything but x86_64 live in a folder of their own.
root=$JOSI_LINUX_BUILD_BASE
export JOSI_LINUX_ARTIFACTS="$root/artifacts"
[ "$arch" = x86_64 ] || export JOSI_LINUX_BUILD_BASE="$root/$arch"
base=$JOSI_LINUX_BUILD_BASE
out=$JOSI_LINUX_ARTIFACTS
mkdir -p "$base" "$out"
if [ "$arch" != "$host" ]; then
  docker_platform=$(python3 -B scripts/linux/target.py docker)
  docker run --rm --pull=never --platform "$docker_platform" "$(sed -n 's/^FROM //p' scripts/linux/PackageBuild.Dockerfile)" true >/dev/null 2>&1 \
    || fail "this $host machine cannot run $arch containers yet: pull the base image for $docker_platform and register QEMU (docs/LINUX_RELEASE.md, Building for arm64)"
fi
if [ "$arch" != x86_64 ] && [ "$portable" = 1 ]; then
  portable=0; echo "The graphical installer (AppImage, .run) is built for x86_64 only; skipping it for $arch."
fi
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
  npx tsc -b
  npm --prefix apps/web run build
fi

step "Runtime staging and payload inventory ($version)"
rm -rf "$base/stage/runtime/app/node_modules"
python3 -B scripts/linux/stage.py

step "Packages for $arch: Arch, Debian/Ubuntu, Fedora/RHEL"
python3 -B scripts/linux/build-arch.py
python3 -B scripts/linux/build-deb.py
python3 -B scripts/linux/build-rpm.py

step 'One-command installer'
python3 -B scripts/linux/build-headless-installer.py

if [ "$portable" = 1 ]; then
  step 'Portable graphical installer (AppImage and .run)'
  python3 -B scripts/linux/build-universal-appimage.py
fi

step 'Release folder'
# The folder holds this version for every architecture built so far on this
# machine, so one upload carries them all and the installer's hashes match.
release=$root/releases/$version
rm -rf "$release"; mkdir -p "$release"
names=$(python3 -B -c "import sys; sys.path.insert(0,'scripts/linux'); import target; from package_common import package_names; print(' '.join(n for a in target.ARCHITECTURES for n in package_names(arch=a).values()))")
built=
for name in $names; do
  if [ -f "$out/$name" ]; then cp "$out/$name" "$release/"; built="$built $name"; fi
done
cp "$out/install-josi-ce-server.sh" "$release/"
for name in "Josi-CE-Server-Installer-$version-x86_64.AppImage" "Josi-CE-Server-Installer-$version-x86_64.run"; do
  if [ -f "$out/$name" ]; then cp "$out/$name" "$release/"; fi
done
case "$built" in
  *x86_64*aarch64*|*aarch64*x86_64*) machines='x86_64 and arm64 (Raspberry Pi 4 and 5 with a 64-bit system)' ;;
  *aarch64*) machines='arm64 (Raspberry Pi 4 and 5 with a 64-bit system)' ;;
  *) machines=x86_64 ;;
esac
(cd "$release" && sha256sum -- * | sort -k2 > SHA256SUMS.txt)
cat > "$release/RELEASE-NOTES.md" <<NOTES
Josi CE $version for Linux and NAS ($machines).

One command on Debian, Ubuntu, Fedora, RHEL or Arch, from your normal account:

    curl -fsSL https://get.heyjosi.com/install.sh | sh

It downloads the package for your distribution, checks its SHA-256, installs it with sudo, and prints the one-time address where you finish setup in a browser. The packages are also here for a manual install: .deb, .rpm and .pkg.tar.zst, plus a portable graphical installer for x86_64 (.AppImage, .run). All checksums are in SHA256SUMS.txt. The packages are not signed with a distribution key.

Source and help: https://github.com/vaxman14/josi-ce and https://get.heyjosi.com
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
