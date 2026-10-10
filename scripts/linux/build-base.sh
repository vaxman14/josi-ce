#!/bin/bash
set -euo pipefail
base=/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010
cache=/home/roman/JosiDrive/Caches/codex-linux-native-20261010
mkdir -p "$base/src" "$base/prefix" "$base/tmp"
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
  archive="$cache/cpython-3.12.15%2B20261009-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
  test "$(sha256sum "$archive" | cut -d' ' -f1)" = ffa8f85f1b56e88b687f08d743d817015524b86a9365fd921243132b80f1a36d
  rm -rf "$base/prefix/python.pending"
  mkdir "$base/prefix/python.pending"
  tar -xzf "$archive" --strip-components=1 -C "$base/prefix/python.pending"
  mv "$base/prefix/python.pending" "$base/prefix/python"
  ;;
*) exit 2;;
esac
