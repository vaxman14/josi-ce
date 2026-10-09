#!/bin/bash
set -euo pipefail
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export PATH="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin"
base=/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port
cache=/Volumes/JosiOS/JosiDrive/Caches/codex-macos-native-20261009
export TMPDIR="$base/tmp"
export CLANG_MODULE_CACHE_PATH="$base/clang-cache"
mkdir -p "$TMPDIR" "$base/src" "$base/prefix" "$CLANG_MODULE_CACHE_PATH"
sdk="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
export CC="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"
export CXX="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++"
export CFLAGS="-arch arm64 -isysroot $sdk -mmacosx-version-min=13.0 -O2"
export CPPFLAGS="-isysroot $sdk"
export LDFLAGS="-arch arm64 -isysroot $sdk -mmacosx-version-min=13.0"
check() { actual=$(/usr/bin/shasum -a 256 "$cache/$1"); test "${actual%% *}" = "$2"; }
case "${1:-}" in
 postgres)
 check postgresql-16.15.tar.bz2 c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed
 /usr/bin/tar -xjf "$cache/postgresql-16.15.tar.bz2" -C "$base/src"
 cd "$base/src/postgresql-16.15"
 # Link relocatably at build time. Post-link install_name_tool would invalidate
 # the linker's arm64 signature and would require an unauthorized codesign run.
 /usr/bin/sed -i '' "s|'\$(libdir)/lib\$(NAME)\.|'@rpath/lib\$(NAME).|" src/Makefile.shlib
 export LDFLAGS="$LDFLAGS -Wl,-rpath,@loader_path/../lib"
 ./configure --prefix="$base/prefix/postgresql" --without-readline --without-icu --without-zlib
 /usr/bin/make clean
 /usr/bin/make -j6
 /usr/bin/make install
 ;;
 python)
 check Python-3.11.15.tar.xz 272179ddd9a2e41a0fc8e42e33dfbdca0b3711aa5abf372d3f2d51543d09b625
 /usr/bin/tar -xf "$cache/Python-3.11.15.tar.xz" -C "$base/src"
 cd "$base/src/Python-3.11.15"
 # Offline speech runtime: no SSL/network downloads or readline dependency.
 ./configure --prefix="$base/prefix/python" --with-ensurepip=install --without-static-libpython
 /usr/bin/make -j6
 /usr/bin/make install
 ;;
 *) exit 2;;
esac
