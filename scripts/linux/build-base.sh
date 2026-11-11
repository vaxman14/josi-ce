#!/bin/bash
# Run from the checkout. JOSI_LINUX_ARCH (x86_64 or aarch64) names the target;
# unset, it is this machine. Another architecture is compiled in an emulated
# container, which needs QEMU registered with the kernel (docs/LINUX_RELEASE.md).
set -euo pipefail
base=${JOSI_LINUX_BUILD_BASE:-/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010}
cache=${JOSI_LINUX_BUILD_CACHE:-/home/roman/JosiDrive/Caches/codex-linux-native-20261010}
export JOSI_LINUX_BUILD_BASE="$base" JOSI_LINUX_BUILD_CACHE="$cache"
mkdir -p "$base/src" "$base/prefix" "$base/tmp"
export TMPDIR="$base/tmp"
arch=$(python3 -B scripts/linux/target.py)
platform=$(python3 -B scripts/linux/target.py docker)
image=$(python3 -B scripts/linux/target.py image)
jobs=${JOSI_LINUX_BUILD_JOBS:-8}
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
  # The archive name and its hash come from the lock, per architecture.
  read -r name expected < <(python3 -B -c "
import json,sys,urllib.parse
item=json.load(open('packaging/linux/build-inputs.lock.json'))['python'][sys.argv[1]]
print(urllib.parse.urlparse(item['url']).path.rsplit('/',1)[1],item['sha256'])" "$arch")
  archive="$cache/$name"
  test "$(sha256sum "$archive" | cut -d' ' -f1)" = "$expected"
  rm -rf "$base/prefix/python.pending" "$base/prefix/python"
  mkdir "$base/prefix/python.pending"
  tar -xzf "$archive" --strip-components=1 -C "$base/prefix/python.pending"
  mv "$base/prefix/python.pending" "$base/prefix/python"
  ;;
portable)
  docker build --quiet --pull=false --platform "$platform" -t "$image" -f "$PWD/scripts/linux/PackageBuild.Dockerfile" "$PWD"
  test "$(sha256sum "$cache/postgresql-16.15.tar.bz2" | cut -d' ' -f1)" = c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed
  mkdir -p "$base/src-portable" "$base/prefix/portable"
  docker run --rm --pull=never --platform "$platform" --user "$(id -u):$(id -g)" -e JOBS="$jobs" \
    -v "$base:/work" -v "$cache:/cache:ro" -v "$PWD:/repo:ro" "$image" bash -euo pipefail -c '
      rm -rf /work/src-portable/postgresql-16.15 /work/prefix/portable/postgresql.pending
      tar -xjf /cache/postgresql-16.15.tar.bz2 -C /work/src-portable
      cd /work/src-portable/postgresql-16.15
      ./configure --prefix=/work/prefix/portable/postgresql.pending --disable-rpath --without-readline --without-icu --without-zlib
      make -s -j"$JOBS"
      make -s install
      gcc -O2 -fPIE -pie -Wl,-z,relro,-z,now -Wall -Wextra -Werror -o /work/prefix/portable/josi-ce-setup-helper /repo/packaging/linux/helper.c
      rm -rf /work/prefix/portable/postgresql
      mv /work/prefix/portable/postgresql.pending /work/prefix/portable/postgresql
    '
  docker run --rm --pull=never --platform "$platform" --user "$(id -u):$(id -g)" \
    -e JOSI_PORTABLE_BUILD=1 -e JOSI_LINUX_BUILD_BASE="$base" -e JOSI_LINUX_BUILD_CACHE="$cache" -e JOSI_LINUX_BUILD_JOBS="$jobs" \
    -v "$base:$base" -v "$cache:$cache" -v "$PWD:$PWD:ro" \
    -w "$PWD" "$image" "$base/prefix/python/bin/python3" scripts/linux/build-voice.py
  ;;
*) exit 2;;
esac
