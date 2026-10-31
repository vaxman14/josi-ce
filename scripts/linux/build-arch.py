"""Build an unsigned Blade/Arch x86_64 acceptance package without installing it."""
import json
import shutil
import subprocess

from package_common import BASE, OUT, SOURCE_DATE_EPOCH, VERSION, populate_root, record_checksum


def main() -> None:
    root = BASE / 'arch-root'
    populate_root(root, root / 'usr/share/licenses/josi-ce-server-setup/LICENSE')
    size = sum(path.stat().st_size for path in root.rglob('*') if path.is_file())
    package_version = VERSION.replace('-', '_') + '-1'
    metadata = (
        "pkgname = josi-ce-server-setup\npkgbase = josi-ce-server-setup\n"
        f"pkgver = {package_version}\n"
        "pkgdesc = Native offline Josi CE Server runtime and CLI installer\n"
        "url = https://github.com/vaxman14/josi-ce\n"
        f"builddate = {SOURCE_DATE_EPOCH}\npackager = SOCAL RECEPTIONIST LLC\n"
        f"size = {size}\narch = x86_64\nlicense = AGPL-3.0-or-later\n"
        "depend = python\ndepend = systemd\ndepend = rsync\ndepend = acl\n"
        "depend = iproute2\ndepend = gcc-libs\n"
    )
    (root / '.PKGINFO').write_text(metadata)
    package = OUT / f'josi-ce-server-setup-{package_version}-x86_64.pkg.tar.zst'
    package.unlink(missing_ok=True)
    subprocess.run([
        'tar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner',
        f'--mtime=@{SOURCE_DATE_EPOCH}', '-I', 'zstd -19 -T0', '-cf', package,
        '-C', root, '.PKGINFO', 'usr',
    ], check=True)
    members = subprocess.run(
        ['tar', '-tf', package], check=True, capture_output=True, text=True,
    ).stdout.splitlines()
    if '.PKGINFO' not in members or './.PKGINFO' in members:
        raise RuntimeError('Arch package metadata must be stored as .PKGINFO at archive root')
    if shutil.which('pacman'):
        subprocess.run(['pacman', '-Qp', package], check=True, stdout=subprocess.DEVNULL)
    digest = record_checksum(package)
    print(json.dumps({'package': str(package), 'bytes': package.stat().st_size,
        'sha256': digest, 'signed': False, 'target': 'Blade/Arch x86_64'}))


if __name__ == '__main__':
    main()
