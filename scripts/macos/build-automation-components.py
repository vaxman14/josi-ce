"""Compile isolated-workspace host/guest libraries without installing or running."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
if platform.system() != "Darwin" or platform.machine() != "arm64":
    raise SystemExit("This component build requires an Apple Silicon Mac.")
output = args.output.resolve()
output.mkdir(mode=0o700)  # No replacement of a retained candidate.
source = root / "apps/automation-macos/Sources"
entries = []
for name, filename in (("JosiGuestDesktop", "GuestDesktopEngine.swift"), ("JosiWorkspaceMachine", "WorkspaceMachine.swift")):
    target = output / (name + ".dylib")
    subprocess.run([
        "xcrun", "swiftc", "-swift-version", "6", "-parse-as-library", "-emit-library", "-emit-module",
        "-module-name", name, "-target", "arm64-apple-macos14.2",
        "-module-cache-path", str(output / "module-cache"),
        "-emit-module-path", str(output / (name + ".swiftmodule")),
        "-o", str(target), str(source / filename),
    ], check=True, timeout=180)
    entries.append({"component": name, "source": filename, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
record = {"schemaVersion": 1, "components": entries, "installed": False, "executed": False,
          "productionAuthorityConnected": False, "developerSigned": False}
(output / "build.json").write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps(record))
