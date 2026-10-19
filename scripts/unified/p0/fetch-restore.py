"""Fetch one pinned Apple development image with resume, integrity and space checks."""
from pathlib import Path
import hashlib
import json
import os
import urllib.parse
import urllib.request

source = Path(__file__).resolve().parent
root = source.parents[2]
lock = json.loads((source / "restore-image.lock.json").read_text())
url = urllib.parse.urlparse(lock["url"])
assert url.scheme == "https" and url.hostname == "updates.cdn-apple.com"
assert not url.username and not url.password
directory = root / "build/unified-p0/downloads"
directory.mkdir(parents=True, exist_ok=True)
target = directory / "restore.ipsw"
partial = directory / "restore.ipsw.partial"


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


if target.exists():
    assert target.stat().st_size == lock["size"] and digest(target) == lock["sha256"]
    print("Pinned image already verified.")
    raise SystemExit(0)
assert not target.is_symlink() and not partial.is_symlink()
offset = partial.stat().st_size if partial.exists() else 0
assert offset <= lock["size"]
reserve = 8 * 1024**3
free = os.statvfs(directory)
if free.f_bavail * free.f_frsize < lock["size"] - offset + reserve:
    raise SystemExit("Not enough reported free space for this download plus an 8 GiB reserve.")
if offset < lock["size"]:
    request = urllib.request.Request(lock["url"], headers={"Range": f"bytes={offset}-"} if offset else {})
    with urllib.request.urlopen(request, timeout=60) as response:
        final = urllib.parse.urlparse(response.url)
        assert final.scheme == "https" and final.hostname == url.hostname
        if offset:
            assert response.status == 206
            assert response.headers["Content-Range"].startswith(f"bytes {offset}-")
        else:
            assert response.status == 200
        assert int(response.headers["Content-Length"]) == lock["size"] - offset
        with partial.open("ab") as stream:
            os.chmod(partial, 0o600)
            progress = offset
            last_report = progress
            while chunk := response.read(8 * 1024 * 1024):
                free = os.statvfs(directory)
                if free.f_bavail * free.f_frsize < reserve:
                    raise SystemExit("Download paused to preserve 8 GiB free space; partial file retained for resume.")
                stream.write(chunk)
                progress += len(chunk)
                if progress - last_report >= 1024**3:
                    print(f"Downloaded {progress / 1024**3:.1f}/{lock['size'] / 1024**3:.1f} GiB", flush=True)
                    last_report = progress
assert partial.stat().st_size == lock["size"]
assert digest(partial) == lock["sha256"], "Apple image digest mismatch; retained partial must not be installed."
partial.rename(target)
print("Pinned Apple restore image downloaded and SHA-256 verified.", flush=True)
