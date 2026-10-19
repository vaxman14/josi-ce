"""Exercise encrypted workspace storage with synthetic data and a memory-only key.

This proves the OS storage primitive, not integration with Josi's vault. It never
uses Keychain, a real credential, a personal browser profile, or a production VM.
"""
from pathlib import Path
import json
import os
import secrets
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
parent = root / "build/unified-p0"
parent.mkdir(parents=True, exist_ok=True)
directory = Path(tempfile.mkdtemp(prefix="encrypted-workspace-", dir=parent))
os.chmod(directory, 0o700)
mount = directory / "mounted"
mount.mkdir(mode=0o700)
image = directory / "workspace.sparsebundle"
key = secrets.token_urlsafe(48).encode() + b"\0"
sample = secrets.token_bytes(128)
attached = False


def run(args, password=None, expected=0):
    result = subprocess.run(["/usr/bin/hdiutil", *map(str, args)], input=password,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if expected is not None and result.returncode != expected:
        # The command carries no credentials. Suppress tool output to prevent
        # unexpected prompts or diagnostics from leaking any supplied input.
        raise RuntimeError(f"hdiutil {args[0]} failed with exit {result.returncode}")
    return result


try:
    run(["create", "-size", "128m", "-fs", "APFS", "-type", "SPARSEBUNDLE",
         "-volname", "JosiP0Vault", "-encryption", "AES-256", "-stdinpass",
         "-nospotlight", image], key)
    run(["attach", "-stdinpass", "-nobrowse", "-noautoopen", "-mountpoint", mount, image], key)
    attached = True
    (mount / "synthetic-browser-session.bin").write_bytes(sample)
    run(["detach", mount]); attached = False
    assert not (mount / "synthetic-browser-session.bin").exists()
    denied = run(["attach", "-stdinpass", "-nobrowse", "-noautoopen", "-mountpoint", mount, image], b"incorrect-p0-fixture\0", expected=None)
    attached = denied.returncode == 0
    assert denied.returncode != 0, "Incorrect key unexpectedly mounted the workspace"
    run(["attach", "-stdinpass", "-nobrowse", "-noautoopen", "-mountpoint", mount, image], key)
    attached = True
    assert (mount / "synthetic-browser-session.bin").read_bytes() == sample
    run(["detach", mount]); attached = False
    result = {
        "probe": "encrypted-workspace-storage", "passed": True,
        "wrongKeyDenied": True, "dataSurvivesRemount": True,
        "unmountedDataUnavailable": True, "keyStoredInKeychain": False,
        "keyPersistedByProbe": False, "realBrowserTested": False,
        "vaultIntegrationTested": False,
    }
    (directory / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
finally:
    if attached:
        run(["detach", mount])
