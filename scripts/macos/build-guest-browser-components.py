"""Build guest-only browser components; never register, install, launch or sign.

The unified app builder must embed and Socal-sign these components before they
can pass their runtime identity checks. Browser store publication is separate.
"""
import argparse
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

REPO = Path(__file__).resolve().parents[2]
SOURCES = REPO / "apps/automation-macos/Sources"
HELPERS = "/Applications/Josi Companion.app/Contents/Helpers"
SAFARI_ID = "com.heyjosi.ce.guestcompanion.workspace-safari"


def build(output, node):
    if sys.platform != "darwin":
        raise ValueError("The macOS developer tools are required")
    output = output.resolve()
    output.mkdir(mode=0o700)  # Existing candidates are never overwritten.
    evidence = output / "evidence"
    evidence.mkdir()

    def run(name, argv):
        print(name, flush=True)
        with (evidence / (name + ".log")).open("x") as log:
            completed = subprocess.run([str(value) for value in argv], cwd=REPO,
                                       stdout=log, stderr=subprocess.STDOUT, timeout=300)
        if completed.returncode:
            raise RuntimeError(f"Build stopped; inspect {evidence / (name + '.log')}")

    resources = output / "BrowserExtensions"
    run("extension-resources", [node, REPO / "scripts/unified/build-browser-extensions.mjs", resources])
    for executable, source in [("JosiBrowserHost", "GuestBrowserHost.swift"), ("JosiBrowserBroker", "GuestBrowserBroker.swift")]:
        run("compile-" + executable, ["xcrun", "swiftc", "-swift-version", "6", "-parse-as-library", "-O",
            "-target", "arm64-apple-macos14.2", "-module-cache-path", output / "module-cache",
            "-o", output / executable, SOURCES / source, SOURCES / "GuestBrowserIPC.swift"])

    name = "Josi Guest Browser"
    generated = output / "SafariProject"
    run("safari-project", ["xcrun", "safari-web-extension-packager", resources / "safari",
        "--project-location", generated, "--app-name", name, "--bundle-identifier", "com.heyjosi.ce.guestcompanion",
        "--swift", "--macos-only", "--copy-resources", "--no-open", "--no-prompt"])
    project_root = generated / name
    extension = project_root / (name + " Extension")
    handler = extension / "SafariWebExtensionHandler.swift"
    if not handler.is_file() or handler.is_symlink():
        raise ValueError("The generated Safari project layout changed")
    handler.write_text((SOURCES / "GuestBrowserIPC.swift").read_text() + "\n"
                       + (SOURCES / "GuestSafariExtension.swift").read_text())
    info_path = extension / "Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    if info.get("NSExtension", {}).get("NSExtensionPointIdentifier") != "com.apple.Safari.web-extension":
        raise ValueError("The generated project is not a Safari web extension")
    info["NSExtension"]["NSExtensionPrincipalClass"] = "JosiWorkspaceSafari.JosiSafariExtensionHandler"
    info_path.write_bytes(plistlib.dumps(info))
    run("compile-safari-extension", ["xcodebuild", "-project", project_root / (name + ".xcodeproj"),
        "-target", name + " Extension", "-configuration", "Release", "-sdk", "macosx",
        "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "CODE_SIGNING_ALLOWED=NO", "SWIFT_VERSION=6.0",
        "MACOSX_DEPLOYMENT_TARGET=14.2", f"PRODUCT_BUNDLE_IDENTIFIER={SAFARI_ID}",
        "PRODUCT_MODULE_NAME=JosiWorkspaceSafari", "EXECUTABLE_NAME=JosiWorkspaceSafari",
        f"CONFIGURATION_BUILD_DIR={output / 'Products'}", f"OBJROOT={output / 'Objects'}",
        f"SYMROOT={output / 'Build'}", "build"])
    built = output / "Products" / (name + " Extension.appex")
    target = output / "Josi Workspace.appex"
    shutil.copytree(built, target, symlinks=True)
    info = plistlib.loads((target / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != SAFARI_ID or info.get("CFBundleExecutable") != "JosiWorkspaceSafari":
        raise ValueError("Safari output identity did not match")
    entitlements = {"com.apple.security.app-sandbox": True,
                    "com.apple.security.temporary-exception.mach-lookup.global-name": ["com.heyjosi.ce.guestbrowser"]}
    (output / "Safari.entitlements").write_bytes(plistlib.dumps(entitlements))
    (output / "com.heyjosi.ce.guestbrowser.plist").write_bytes(plistlib.dumps({
        "Label": "com.heyjosi.ce.guestbrowser",
        "ProgramArguments": [HELPERS + "/JosiBrowserBroker"],
        "MachServices": {"com.heyjosi.ce.guestbrowser": True, "com.heyjosi.ce.guestbrowser.control": True},
        "ProcessType": "Interactive", "LimitLoadToSessionType": "Aqua",
    }))
    identity = json.loads((resources / "BrowserDistribution.json").read_text())
    manifests = output / "NativeMessagingHosts"
    manifests.mkdir()
    for family in ["chrome", "brave", "firefox"]:
        value = {"name": "com.heyjosi.workspace", "description": "Josi isolated browser workspace",
                 "path": HELPERS + "/JosiBrowserHost", "type": "stdio"}
        value.update({"allowed_extensions": [identity[family]]} if family == "firefox"
                     else {"allowed_origins": [f"chrome-extension://{identity[family]}/"]})
        (manifests / (family + ".json")).write_text(json.dumps(value, indent=2) + "\n")
    result = {"compiled": True, "signed": False, "installed": False, "browserEnabled": False,
              "workspaceAuthorityConnected": False, "functionalAcceptancePassed": False,
              "distribution": "unpacked-development", "safariBundleId": SAFARI_ID}
    (output / "build.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"output": str(output), **result}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    args = parser.parse_args()
    build(args.output, args.node.resolve(strict=True))
