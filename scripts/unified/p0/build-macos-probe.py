"""Compile an ad-hoc signed probe; never use a developer private key or install it."""
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import json
import base64
import secrets

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
    *[str(source / name) for name in ("MacProbe.swift", "GuestDisplay.swift", "ProbeListener.swift", "ProbeWire.swift")], "-o", str(binary),
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

payload = output / "probe-payload"
payload.mkdir(mode=0o700, exist_ok=True)
fixture = payload / "fixture.json"
if not fixture.exists():
    fixture.write_text(json.dumps({"purpose": "disposable-josi-p0", "workspace": "p0-development-guest",
        "key": base64.b64encode(secrets.token_bytes(32)).decode()}))
    fixture.chmod(0o600)
subprocess.run([
    "xcrun", "swiftc", "-parse-as-library", "-swift-version", "5",
    "-target", "arm64-apple-macos14.0", "-sdk", sdk,
    "-module-cache-path", str(output / "module-cache"),
    str(source / "GuestProbe.swift"), str(source / "ProbeWire.swift"), "-o", str(payload / "guest-probe"),
], check=True)
subprocess.run(["codesign", "--force", "--sign", "-", str(payload / "guest-probe")], check=True)
subprocess.run(["codesign", "--verify", "--strict", str(payload / "guest-probe")], check=True)
subprocess.run(["hdiutil", "makehybrid", "-iso", "-joliet", "-default-volume-name", "josiprobe",
    "-o", str(output / "probe-payload.iso"), str(payload), "-ov"], check=True)
print("Generated read-only disposable guest fixture disk; no production enrollment material.")
