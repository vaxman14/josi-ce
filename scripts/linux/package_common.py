"""Shared deterministic filesystem staging for native Linux packages.

The build host, the input cache and the version come from the environment so
one checkout serves every release; the defaults are the paths of the first
Linux build machine. `scripts/linux/build-release.sh` sets all three.
"""
import hashlib
import os
from pathlib import Path
import shutil


REPO = Path(__file__).resolve().parents[2]
BASE = Path(os.environ.get('JOSI_LINUX_BUILD_BASE', '/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010'))
CACHE = Path(os.environ.get('JOSI_LINUX_BUILD_CACHE', '/home/roman/JosiDrive/Caches/codex-linux-native-20261010'))
OUT = BASE / 'artifacts'
RUNTIME = BASE / 'stage/runtime'
VERSION = os.environ.get('JOSI_LINUX_VERSION', '1.0.0')
SOURCE_DATE_EPOCH = '1735689600'
# The GitHub release the packages are published under: one tag per version,
# shared with the Windows and Mac installers, so the download page finds every
# platform's file in one place.
RELEASE_TAG = 'v' + VERSION
RELEASE_BASE_URL = os.environ.get('JOSI_INSTALLER_BASE_URL',
    'https://github.com/vaxman14/josi-ce/releases/download/' + RELEASE_TAG).rstrip('/')


def package_names(version: str = VERSION) -> dict:
    """The file name of each native package for a version, by distribution family."""
    return {
        'arch': f'josi-ce-server-setup-{version.replace("-", "_")}-1-x86_64.pkg.tar.zst',
        'debian': f'josi-ce-server-setup_{version}_amd64.deb',
        'rpm': f'josi-ce-server-setup-{version}.x86_64.rpm',
    }


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


def populate_root(root: Path, license_target: Path) -> None:
    if root.exists():
        shutil.rmtree(root)
    OUT.mkdir(parents=True, exist_ok=True)
    copy(RUNTIME, root / 'usr/lib/josi-ce-server-setup/runtime')
    copy(RUNTIME.parent / 'inventory.json', root / 'usr/lib/josi-ce-server-setup/inventory.json')
    copy(RUNTIME.parent / 'native-libraries.json', root / 'usr/lib/josi-ce-server-setup/native-libraries.json')
    for source, target in (
        (REPO / 'packaging/linux/install_cli.py', root / 'usr/bin/josi-ce-server-install'),
        (REPO / 'packaging/linux/status.py', root / 'usr/bin/josi-ce-native-status'),
        (REPO / 'LICENSE', license_target),
        (REPO / 'NOTICE', root / 'usr/share/doc/josi-ce-server-setup/NOTICE'),
        (REPO / 'packaging/linux/TEST-ME.txt', root / 'usr/share/doc/josi-ce-server-setup/TEST-ME.txt'),
        (REPO / 'packaging/linux/build-inputs.lock.json', root / 'usr/share/doc/josi-ce-server-setup/build-inputs.lock.json'),
    ):
        copy(source, target)
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
