#!/bin/bash
set -euo pipefail
# Build only the read-only acceptance utility. This is not the distribution.
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
build_root=/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009
artifact_root=/Volumes/JosiOS/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009
export TMPDIR="$build_root/tmp"
mkdir -p "$TMPDIR" "$build_root/swift-cache"
output="$artifact_root/status-tool-$(/bin/date -u +%Y%m%dT%H%M%SZ)"
mkdir "$output"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
sdk="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
"$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc" \
  -target arm64-apple-macos13.0 -sdk "$sdk" \
  -module-cache-path "$build_root/swift-cache" \
  "$repo_root/packaging/macos/ServiceStatus.swift" \
  -o "$output/josi-native-status" > "$output/build.log" 2>&1
/usr/bin/file "$output/josi-native-status" > "$output/architecture.txt"
/usr/bin/otool -L "$output/josi-native-status" > "$output/libraries.txt"
(cd "$output" && /usr/bin/shasum -a 256 josi-native-status > SHA256SUMS.txt)
printf '%s\n' "$output"
