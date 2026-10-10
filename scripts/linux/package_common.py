"""Shared deterministic filesystem staging for native Linux packages."""
import hashlib
import os
from pathlib import Path
import shutil


REPO = Path(__file__).resolve().parents[2]
BASE = Path('/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010')
OUT = BASE / 'artifacts'
RUNTIME = BASE / 'stage/runtime'
VERSION = '0.1.78-linux.3'
SOURCE_DATE_EPOCH = '1735689600'


def copy(source: Path, target: Path) -> None:
    if source.is_dir():
        shutil.copytree(source, target, symlinks=True, dirs_exist_ok=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def populate_root(root: Path, license_target: Path) -> None:
    if root.exists():
        shutil.rmtree(root)
    OUT.mkdir(parents=True, exist_ok=True)
    copy(RUNTIME, root / 'usr/lib/josi-ce-server-setup/runtime')
    copy(RUNTIME.parent / 'inventory.json', root / 'usr/lib/josi-ce-server-setup/inventory.json')
    copy(RUNTIME.parent / 'native-libraries.json', root / 'usr/lib/josi-ce-server-setup/native-libraries.json')
    for source, target in (
        (REPO / 'packaging/linux/setup.py', root / 'usr/bin/josi-ce-server-setup'),
        (REPO / 'packaging/linux/status.py', root / 'usr/bin/josi-ce-native-status'),
        (REPO / 'packaging/linux/com.heyjosi.ce.server.setup.desktop', root / 'usr/share/applications/com.heyjosi.ce.server.setup.desktop'),
        (REPO / 'packaging/linux/com.heyjosi.ce.server.setup.policy', root / 'usr/share/polkit-1/actions/com.heyjosi.ce.server.setup.policy'),
        (REPO / 'packaging/macos/Josi.png', root / 'usr/share/icons/hicolor/512x512/apps/com.heyjosi.ce.server.png'),
        (REPO / 'LICENSE', license_target),
        (REPO / 'NOTICE', root / 'usr/share/doc/josi-ce-server-setup/NOTICE'),
        (REPO / 'packaging/linux/TEST-ME.txt', root / 'usr/share/doc/josi-ce-server-setup/TEST-ME.txt'),
        (REPO / 'packaging/linux/build-inputs.lock.json', root / 'usr/share/doc/josi-ce-server-setup/build-inputs.lock.json'),
        (BASE / 'prefix/portable/josi-ce-setup-helper', root / 'usr/libexec/josi-ce-setup-helper'),
    ):
        copy(source, target)
    for path in (*list((root / 'usr/bin').iterdir()), root / 'usr/libexec/josi-ce-setup-helper'):
        path.chmod(0o755)
    timestamp = int(SOURCE_DATE_EPOCH)
    for path in sorted(root.rglob('*'), reverse=True):
        os.utime(path, (timestamp, timestamp), follow_symlinks=False)
    os.utime(root, (timestamp, timestamp))


def record_checksum(package: Path) -> str:
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    checksums = OUT / 'SHA256SUMS.txt'
    existing = checksums.read_text().splitlines() if checksums.exists() else []
    lines = [line for line in existing if not line.endswith('  ' + package.name)]
    lines.append(digest + '  ' + package.name)
    checksums.write_text('\n'.join(sorted(lines, key=lambda line: line.split('  ', 1)[-1])) + '\n')
    return digest
