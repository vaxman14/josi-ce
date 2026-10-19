"""Package/compile a synthetic Safari fixture without installing or enabling it."""
from pathlib import Path
import json
import shutil
import subprocess

source = Path(__file__).resolve().parent
root = source.parents[2]
output = root / "build/unified-p0/safari"
name = "Josi P0 Browser Proof"
project = output / name / f"{name}.xcodeproj"
if not project.exists():
    subprocess.run([
        "xcrun", "safari-web-extension-packager", str(source / "browser-extension"),
        "--project-location", str(output), "--app-name", name,
        "--bundle-identifier", "com.socalreceptionist.josi.p0", "--swift",
        "--macos-only", "--copy-resources", "--no-open", "--no-prompt",
    ], check=True, timeout=180)
handler = output / name / f"{name} Extension/SafariWebExtensionHandler.swift"
assert handler.is_file() and not handler.is_symlink()
shutil.copyfile(source / "SafariWebExtensionHandler.swift", handler)
# Xcode 27's packager substitutes the display name into the app identifier,
# while retaining the requested prefix for the extension. Normalize only this
# known generated value so embedded-binary validation checks the intended IDs.
settings = project / "project.pbxproj"
text = settings.read_text()
text = text.replace("com.socalreceptionist.josi.Josi-P0-Browser-Proof", "com.socalreceptionist.josi.p0")
settings.write_text(text)
log = root / "build/unified-p0/safari-build.log"
with log.open("w") as stream:
    result = subprocess.run([
        "xcodebuild", "-project", str(project), "-scheme", name,
        "-configuration", "Debug", "-derivedDataPath", str(output / "DerivedData"),
        "-destination", "generic/platform=macOS", "CODE_SIGNING_ALLOWED=NO",
        "MACOSX_DEPLOYMENT_TARGET=14.0", "build",
    ], stdout=stream, stderr=subprocess.STDOUT, timeout=300)
if result.returncode:
    raise SystemExit(f"Safari compile failed ({result.returncode}); inspect {log}")
record = {"probe": "safari-packaging", "compiled": True, "installed": False,
          "browserRoundTripTested": False, "developerPrivateKeyUsed": False}
(output / "result.json").write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps(record, indent=2))
