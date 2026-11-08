#!/usr/bin/env python3
"""Fail the build when a Josi package is missing any Ghost Stage file.

The web app plays the ghost from /ghost/<clip>.webm (Chrome, Firefox, Edge)
and /ghost/<clip>.mov (Safari), with arms-open.png as the still. The clip
list is read from apps/web/src/lib/ghost.ts, so a new clip is checked as soon
as the web app names it. Every file must be in apps/web/public/ghost, in the
staged runtime, and inside each package with the same size.

    python3 scripts/linux/check-ghost-assets.py [package ...]

With no arguments it checks the source, the staged runtime and every package
this build produced in the artifacts folder.
"""
from __future__ import annotations

import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from package_common import OUT, REPO, RUNTIME, VERSION, package_names  # noqa: E402

SOURCE = REPO / 'apps/web/public/ghost'
STILL = 'arms-open.png'
IN_PACKAGE = 'usr/lib/josi/runtime/app/apps/web/dist/ghost/'
IN_RUNTIME = RUNTIME / 'app/apps/web/dist/ghost'


def clips() -> list[str]:
    text = (REPO / 'apps/web/src/lib/ghost.ts').read_text(encoding='utf-8')
    names: list[str] = []
    for list_name in ('LOOP_CLIPS', 'ONE_SHOT_CLIPS'):
        match = re.search(rf'export const {list_name} = \[([^\]]*)\]', text)
        if not match:
            raise SystemExit(f'ghost check: {list_name} not found in apps/web/src/lib/ghost.ts')
        names += re.findall(r"'([a-z0-9-]+)'", match.group(1))
    if len(names) != 14 or len(set(names)) != 14:
        raise SystemExit(f'ghost check: expected 14 distinct clips in ghost.ts, found {len(set(names))}')
    return names


def expected() -> dict[str, int]:
    files = [f'{clip}.{ext}' for clip in clips() for ext in ('webm', 'mov')] + [STILL]
    sizes: dict[str, int] = {}
    missing = []
    for name in files:
        path = SOURCE / name
        if not path.is_file() or path.stat().st_size == 0:
            missing.append(name)
        else:
            sizes[name] = path.stat().st_size
    if missing:
        raise SystemExit(f'ghost check: apps/web/public/ghost is missing {", ".join(missing)}')
    tracked = subprocess.run(['git', '-C', str(REPO), 'ls-files', '--', 'apps/web/public/ghost'],
                             capture_output=True, text=True, check=False).stdout.split()
    if tracked:
        untracked = sorted(set(files) - {Path(p).name for p in tracked})
        if untracked:
            raise SystemExit(f'ghost check: not committed to git: {", ".join(untracked)}')
    return sizes


def members(package: Path) -> dict[str, int]:
    """name -> size of every file under the ghost folder inside a package."""
    if package.suffix == '.deb':
        data = package.read_bytes()
        if not data.startswith(b'!<arch>\n'):
            raise SystemExit(f'ghost check: {package.name} is not a Debian package')
        offset = 8
        while offset < len(data):
            header = data[offset:offset + 60]
            name = header[:16].decode().strip().rstrip('/')
            size = int(header[48:58].decode().strip())
            if name.startswith('data.tar'):
                with tempfile.NamedTemporaryFile(suffix='-' + name) as tmp:
                    tmp.write(data[offset + 60:offset + 60 + size]); tmp.flush()
                    return members_of_tar(Path(tmp.name))
            offset += 60 + size + (size % 2)
        raise SystemExit(f'ghost check: {package.name} has no data archive')
    return members_of_tar(package)


def members_of_tar(path: Path) -> dict[str, int]:
    found: dict[str, int] = {}
    if path.name.endswith('.zst'):
        listing = subprocess.run(['tar', '--zstd', '-tvf', str(path)], capture_output=True, text=True, check=True).stdout
        for line in listing.splitlines():
            parts = line.split(None, 5)
            if len(parts) == 6 and parts[0].startswith('-'):
                name = parts[5].removeprefix('./')
                if name.startswith(IN_PACKAGE):
                    found[name[len(IN_PACKAGE):]] = int(parts[2])
        return found
    with tarfile.open(path) as archive:
        for item in archive.getmembers():
            name = item.name.removeprefix('./')
            if item.isfile() and name.startswith(IN_PACKAGE):
                found[name[len(IN_PACKAGE):]] = item.size
    return found


def compare(where: str, want: dict[str, int], have: dict[str, int]) -> list[str]:
    problems = [f'{where}: missing {name}' for name in want if name not in have]
    problems += [f'{where}: {name} is {have[name]} bytes, source is {want[name]}'
                 for name in want if name in have and have[name] != want[name]]
    return problems


def main() -> None:
    want = expected()
    problems: list[str] = []
    packages = [Path(p) for p in sys.argv[1:]]
    if not packages:
        if IN_RUNTIME.is_dir():
            problems += compare('staged runtime', want, {p.name: p.stat().st_size for p in IN_RUNTIME.iterdir() if p.is_file()})
        packages = [OUT / name for name in package_names(VERSION).values() if (OUT / name).is_file()]
        packages += sorted(OUT.glob(f'josi-root-{VERSION}-*.tar.zst'))
        if not packages:
            raise SystemExit(f'ghost check: no packages for {VERSION} in {OUT}')
    for package in packages:
        problems += compare(package.name, want, members(package))
    if problems:
        print('ghost check FAILED:', *problems, sep='\n  ', file=sys.stderr)
        raise SystemExit(1)
    for package in packages:
        print(f'ghost check: {package.name} has all {len(want)} ghost files')


if __name__ == '__main__':
    main()
