#!/bin/bash
set -euo pipefail
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
base=/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port
export TMPDIR="$base/tmp"
out="$base/Josi CE Server Setup.app"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources" "$base/swift-cache"
sdk="$DEVELOPER_DIR/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
compiler="$DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"
"$compiler" -target arm64-apple-macos14.0 -sdk "$sdk" -module-cache-path "$base/swift-cache" packaging/macos/Setup.swift packaging/macos/DiagnosticLog.swift packaging/macos/ProgressState.swift packaging/macos/BrowserHandoff.swift -o "$out/Contents/MacOS/Josi CE Server Setup"
"$compiler" -target arm64-apple-macos14.0 -sdk "$sdk" -module-cache-path "$base/swift-cache" packaging/macos/BrowserHandoff.swift packaging/macos/HandoffTests.swift -o "$base/handoff-tests"
"$compiler" -target arm64-apple-macos14.0 -sdk "$sdk" -module-cache-path "$base/swift-cache" packaging/macos/ProgressState.swift packaging/macos/ProgressTests.swift -o "$base/progress-tests"
"$base/progress-tests"
"$compiler" -target arm64-apple-macos14.0 -sdk "$sdk" -module-cache-path "$base/swift-cache" packaging/macos/DiagnosticLog.swift packaging/macos/DiagnosticTests.swift -o "$base/diagnostic-tests"
"$base/diagnostic-tests" "$base/tmp"
"$compiler" -target arm64-apple-macos14.0 -sdk "$sdk" -module-cache-path "$base/swift-cache" packaging/macos/ServiceStatus.swift -o "$out/Contents/MacOS/josi-native-status"
if [ -e "$out/Contents/Resources/runtime" ]; then /bin/rm -rf "$out/Contents/Resources/runtime"; fi
/usr/bin/ditto "$base/stage/runtime" "$out/Contents/Resources/runtime"
/bin/cp "$base/stage/inventory.json" "$out/Contents/Resources/inventory.json"
/bin/cp packaging/macos/TEST-ME.txt "$out/Contents/Resources/TEST-ME.txt"
/bin/cat > "$out/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.heyjosi.ce.setup</string>
<key>CFBundleName</key><string>Josi CE Server Setup</string>
<key>CFBundleExecutable</key><string>Josi CE Server Setup</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.78</string>
<key>CFBundleVersion</key><string>20261009.1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHumanReadableCopyright</key><string>Copyright SOCAL RECEPTIONIST LLC. AGPL-3.0-or-later. See bundled licenses and sources.</string>
</dict></plist>
PLIST
/usr/bin/plutil -lint "$out/Contents/Info.plist"
/usr/bin/file "$out/Contents/MacOS/Josi CE Server Setup"
printf '%s\n' "$out"
