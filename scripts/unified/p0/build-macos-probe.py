"""Compile an ad-hoc signed probe; never use a developer private key or install it."""
from pathlib import Path
import platform
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
    str(source / "MacProbe.swift"), "-o", str(binary),
], check=True)
subprocess.run([
    "codesign", "--force", "--sign", "-", "--entitlements",
    str(source / "virtualization.entitlements.plist"), str(binary),
], check=True)
subprocess.run(["codesign", "--verify", "--strict", str(binary)], check=True)
print(binary)
