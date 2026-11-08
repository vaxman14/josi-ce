"""Shared deterministic filesystem staging for native Linux packages.

The build host, the input cache and the version come from the environment so
one checkout serves every release; the defaults are the paths of the first
Linux build machine. `scripts/linux/build-release.sh` sets all three.

One package, named `josi`, per distribution family and processor. A build
makes the packages for the processor of the runtime it staged
(JOSI_LINUX_ARCH, default this machine's).
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil


REPO = Path(__file__).resolve().parents[2]
BASE = Path(os.environ.get('JOSI_LINUX_BUILD_BASE', '/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010'))
CACHE = Path(os.environ.get('JOSI_LINUX_BUILD_CACHE', '/home/roman/JosiDrive/Caches/codex-linux-native-20261010'))
OUT = BASE / 'artifacts'
RUNTIME = BASE / 'stage/runtime'
VERSION = os.environ.get('JOSI_LINUX_VERSION', '1.0.0')
ARCH = os.environ.get('JOSI_LINUX_ARCH', {'x86_64': 'x86_64', 'aarch64': 'aarch64'}.get(platform.machine(), 'x86_64'))
SOURCE_DATE_EPOCH = '1735689600'
PACKAGE = 'josi'
# The GitHub release the packages are published under: one tag per version,
# shared with the Windows and Mac installers, so the download page finds every
# platform's file in one place.
RELEASE_TAG = 'v' + VERSION
RELEASE_BASE_URL = os.environ.get('JOSI_INSTALLER_BASE_URL',
    'https://github.com/vaxman14/josi-ce/releases/download/' + RELEASE_TAG).rstrip('/')
# What the web updater reads to learn about a newer release.
UPDATE_FEED_URL = os.environ.get('JOSI_UPDATE_FEED_URL',
    'https://github.com/vaxman14/josi-ce/releases/latest/download/linux-latest.json')
DEBIAN_ARCH = {'x86_64': 'amd64', 'aarch64': 'arm64'}


def package_names(version: str = VERSION) -> dict:
    """Every package file of a version, keyed family-processor."""
    pkgver = version.replace('-', '_')
    names = {}
    for processor in ('x86_64', 'aarch64'):
        names['arch-' + processor] = f'{PACKAGE}-{pkgver}-1-{processor}.pkg.tar.zst'
        names['debian-' + processor] = f'{PACKAGE}_{version}_{DEBIAN_ARCH[processor]}.deb'
    return names


def rpm_version_release(version: str = VERSION) -> tuple:
    """RPM keeps the version and the release apart and allows no hyphen in either."""
    if '-' in version:
        head, tail = version.split('-', 1)
        return head, tail.replace('-', '.')
    return version, '1'


def copy(source: Path, target: Path) -> None:
    if source.is_dir():
        shutil.copytree(source, target, symlinks=True, dirs_exist_ok=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def staged_architecture() -> str:
    inventory = json.loads((RUNTIME.parent / 'inventory.json').read_text())
    if inventory.get('architecture') != ARCH:
        raise SystemExit(f"The staged runtime is {inventory.get('architecture')}, not {ARCH}")
    return ARCH


def populate_root(root: Path, license_target: Path) -> None:
    if root.exists():
        shutil.rmtree(root)
    OUT.mkdir(parents=True, exist_ok=True)
    lib = root / 'usr/lib' / PACKAGE
    doc = root / 'usr/share/doc' / PACKAGE
    copy(RUNTIME, lib / 'runtime')
    copy(RUNTIME.parent / 'inventory.json', lib / 'inventory.json')
    copy(RUNTIME.parent / 'native-libraries.json', lib / 'native-libraries.json')
    for source, target in (
        (REPO / 'packaging/linux/install_cli.py', root / 'usr/bin/josi-ce-server-install'),
        (REPO / 'packaging/linux/josi-uninstall.sh', root / 'usr/bin/josi-uninstall'),
        (REPO / 'packaging/linux/status.py', root / 'usr/bin/josi-ce-native-status'),
        (REPO / 'packaging/linux/josi_update.py', lib / 'josi_update.py'),
        (REPO / 'packaging/linux/etc-README.txt', lib / 'etc-README.txt'),
        (REPO / 'LICENSE', license_target),
        (REPO / 'NOTICE', doc / 'NOTICE'),
        (REPO / 'packaging/linux/TEST-ME.txt', doc / 'TEST-ME.txt'),
        (REPO / 'packaging/linux/build-inputs.lock.json', doc / 'build-inputs.lock.json'),
    ):
        copy(source, target)
    (lib / 'update-defaults.json').write_text(json.dumps(
        {'feed': UPDATE_FEED_URL, 'allowHttp': UPDATE_FEED_URL.startswith('http://')}, indent=2) + '\n')
    for path in (root / 'usr/bin').iterdir():
        path.chmod(0o755)
    timestamp = int(SOURCE_DATE_EPOCH)
    for path in sorted(root.rglob('*'), reverse=True):
        os.utime(path, (timestamp, timestamp), follow_symlinks=False)
    os.utime(root, (timestamp, timestamp))


def record_checksum(package: Path) -> str:
    value = digest(package)
    checksums = OUT / 'SHA256SUMS.txt'
    existing = checksums.read_text().splitlines() if checksums.exists() else []
    lines = [line for line in existing if not line.endswith('  ' + package.name)]
    lines.append(value + '  ' + package.name)
    checksums.write_text('\n'.join(sorted(lines, key=lambda line: line.split('  ', 1)[-1])) + '\n')
    return value
