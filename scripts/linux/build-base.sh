#!/bin/bash
set -euo pipefail
base=${JOSI_LINUX_BUILD_BASE:-/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010}
cache=${JOSI_LINUX_BUILD_CACHE:-/home/roman/JosiDrive/Caches/codex-linux-native-20261010}
export JOSI_LINUX_BUILD_BASE="$base" JOSI_LINUX_BUILD_CACHE="$cache"
mkdir -p "$base/src" "$base/prefix" "$base/tmp"
# The processor being built for. On another processor's machine the portable
# step runs its Debian image under emulation (docker --platform).
arch=${JOSI_LINUX_ARCH:-$(uname -m)}
case "$arch" in
  x86_64) platform=linux/amd64; tag=debian12
    python_sha=ffa8f85f1b56e88b687f08d743d817015524b86a9365fd921243132b80f1a36d
    image_base=debian:12-slim@sha256:f3034a6ec3c1205360777c4aae76234998866ad18806ae62b63a3f84ccad782b ;;
  aarch64) platform=linux/arm64; tag=debian12-arm64
    python_sha=2e1ba0e7f22e01c534caebf7f09e7820322bc0d055271d3434af671e8400f96f
    image_base=debian:12-slim@sha256:0c8bbb8e987a035fe1d9704eb2e571b7e9a836e1caa46345290674b45b69e417 ;;
  *) echo "unknown processor: $arch" >&2; exit 2 ;;
esac
export TMPDIR="$base/tmp"
case "${1:-}" in
postgres)
  test "$(sha256sum "$cache/postgresql-16.15.tar.bz2" | cut -d' ' -f1)" = c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed
  test -d "$base/src/postgresql-16.15" || tar -xjf "$cache/postgresql-16.15.tar.bz2" -C "$base/src"
  cd "$base/src/postgresql-16.15"
  if test -f GNUmakefile; then make distclean; fi
  ./configure --prefix="$base/prefix/postgresql" --disable-rpath --without-readline --without-icu --without-zlib
  make -j8
  make install
  ;;
python)
  archive="$cache/cpython-3.12.15%2B20261009-$arch-unknown-linux-gnu-install_only_stripped.tar.gz"
  test "$(sha256sum "$archive" | cut -d' ' -f1)" = "$python_sha"
  rm -rf "$base/prefix/python.pending" "$base/prefix/python"
  mkdir "$base/prefix/python.pending"
  tar -xzf "$archive" --strip-components=1 -C "$base/prefix/python.pending"
  mv "$base/prefix/python.pending" "$base/prefix/python"
  ;;
portable)
  image=local/josi-ce-linux-package-build:$tag
  docker build --quiet --pull=false --platform "$platform" --build-arg BASE="$image_base" -t "$image" -f "$PWD/scripts/linux/PackageBuild.Dockerfile" "$PWD"
  test "$(sha256sum "$cache/postgresql-16.15.tar.bz2" | cut -d' ' -f1)" = c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed
  mkdir -p "$base/src-portable" "$base/prefix/portable"
  docker run --rm --pull=never --platform "$platform" --user "$(id -u):$(id -g)" \
    -v "$base:/work" -v "$cache:/cache:ro" -v "$PWD:/repo:ro" "$image" bash -euo pipefail -c '
      rm -rf /work/src-portable/postgresql-16.15 /work/prefix/portable/postgresql.pending
      tar -xjf /cache/postgresql-16.15.tar.bz2 -C /work/src-portable
      cd /work/src-portable/postgresql-16.15
      ./configure --prefix=/work/prefix/portable/postgresql.pending --disable-rpath --without-readline --without-icu --without-zlib
      make -s -j8
      make -s install
      gcc -O2 -fPIE -pie -Wl,-z,relro,-z,now -Wall -Wextra -Werror -o /work/prefix/portable/josi-ce-setup-helper /repo/packaging/linux/helper.c
      rm -rf /work/prefix/portable/postgresql
      mv /work/prefix/portable/postgresql.pending /work/prefix/portable/postgresql
    '
  docker run --rm --pull=never --platform "$platform" --user "$(id -u):$(id -g)" \
    -e JOSI_PORTABLE_BUILD=1 -e JOSI_LINUX_BUILD_BASE="$base" -e JOSI_LINUX_BUILD_CACHE="$cache" \
    -v "$base:$base" -v "$cache:$cache" -v "$PWD:$PWD:ro" \
    -w "$PWD" "$image" "$base/prefix/python/bin/python3" scripts/linux/build-voice.py
  ;;
*) exit 2;;
esac
