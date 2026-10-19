"""Compile an ad-hoc signed probe; never use a developer private key or install it."""
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess

root = Path(__file__).resolve().parents[3]
source = Path(__file__).resolve().parent
if platform.system() != "Darwin" or platform.machine() != "arm64":
    raise SystemExit("The P0 macOS guest proof requires an Apple Silicon Mac.")
output = root / "build/unified-p0"
output.mkdir(parents=True, exist_ok=True)
sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip()
binary = output / "mac-probe"
subprocess.run([
    "xcrun", "swiftc", "-parse-as-library", "-swift-version", "5",
    "-target", "arm64-apple-macos14.0", "-sdk", sdk,
    "-module-cache-path", str(output / "module-cache"),
    str(source / "MacProbe.swift"), str(source / "GuestDisplay.swift"), "-o", str(binary),
], check=True)
subprocess.run([
    "codesign", "--force", "--sign", "-", "--entitlements",
    str(source / "virtualization.entitlements.plist"), str(binary),
], check=True)
subprocess.run(["codesign", "--verify", "--strict", str(binary)], check=True)
print(binary)
app = output / "Josi P0 Guest.app"
contents = app / "Contents"
(contents / "MacOS").mkdir(parents=True, exist_ok=True)
shutil.copy2(binary, contents / "MacOS/mac-probe")
(contents / "Info.plist").write_bytes(plistlib.dumps({
    "CFBundleIdentifier": "com.socalreceptionist.josi.p0.guest-view",
    "CFBundleName": "Josi P0 Guest", "CFBundleExecutable": "mac-probe",
    "CFBundlePackageType": "APPL", "CFBundleVersion": "1",
    "CFBundleShortVersionString": "0.0.1", "LSMinimumSystemVersion": "14.0",
    "NSHighResolutionCapable": True, "NSPrincipalClass": "NSApplication",
}))
# Finder/iCloud can decorate this generated bundle after its first launch.
# Remove only signing-incompatible Finder metadata from our own build output.
for entry in [app, *app.rglob("*")]:
    attributes = subprocess.check_output(["xattr", str(entry)], text=True).splitlines()
    for attribute in ("com.apple.FinderInfo", "com.apple.ResourceFork"):
        if attribute in attributes:
            subprocess.run(["xattr", "-d", attribute, str(entry)], check=True)
subprocess.run(["codesign", "--force", "--sign", "-", "--entitlements",
                str(source / "virtualization.entitlements.plist"), str(app)], check=True)
subprocess.run(["codesign", "--verify", "--strict", str(app)], check=True)
print(app)
