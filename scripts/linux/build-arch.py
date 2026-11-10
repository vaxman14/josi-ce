"""Build the unsigned Arch package `josi` and the PKGBUILD that describes it.

The package is assembled directly (tar plus .PKGINFO) because the build runs
in a Debian container without makepkg. packaging/linux/arch/PKGBUILD makes the
same package with makepkg on an Arch machine, from the staged tree this script
also leaves in the artifacts folder; its checksum is filled in here.
"""
import json
import shutil
import subprocess

from package_common import (BASE, OUT, PACKAGE, REPO, SOURCE_DATE_EPOCH, VERSION, digest, package_names,
    populate_root, record_checksum, staged_architecture)

DEPENDS = ('python', 'systemd', 'rsync', 'acl', 'iproute2', 'gcc-libs', 'curl')


def main() -> None:
    processor = staged_architecture()
    root = BASE / 'arch-root'
    populate_root(root, root / f'usr/share/licenses/{PACKAGE}/LICENSE')
    size = sum(path.stat().st_size for path in root.rglob('*') if path.is_file())
    pkgver = VERSION.replace('-', '_')
    metadata = (
        f"pkgname = {PACKAGE}\npkgbase = {PACKAGE}\n"
        f"pkgver = {pkgver}-1\n"
        "pkgdesc = Josi server, headless, run by systemd as josi.service\n"
        "url = https://github.com/vaxman14/josi-ce\n"
        f"builddate = {SOURCE_DATE_EPOCH}\npackager = SOCAL RECEPTIONIST LLC\n"
        f"size = {size}\narch = {processor}\nlicense = AGPL-3.0-or-later\n"
        "conflict = josi-ce-server-setup\nreplaces = josi-ce-server-setup\n"
        + ''.join(f'depend = {name}\n' for name in DEPENDS)
    )
    (root / '.PKGINFO').write_text(metadata)
    shutil.copy2(REPO / 'packaging/linux/arch/josi.install', root / '.INSTALL')
    package = OUT / package_names()['arch-' + processor]
    package.unlink(missing_ok=True)
    subprocess.run([
        'tar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner',
        f'--mtime=@{SOURCE_DATE_EPOCH}', '-I', 'zstd -19 -T0', '-cf', package,
        '-C', root, '.PKGINFO', '.INSTALL', 'usr',
    ], check=True)
    members = subprocess.run(
        ['tar', '-tf', package], check=True, capture_output=True, text=True,
    ).stdout.splitlines()
    if '.PKGINFO' not in members or './.PKGINFO' in members:
        raise RuntimeError('Arch package metadata must be stored as .PKGINFO at archive root')
    if shutil.which('pacman'):
        subprocess.run(['pacman', '-Qp', package], check=True, stdout=subprocess.DEVNULL)
    # The same tree for makepkg, with a filled-in PKGBUILD beside it.
    tree = OUT / f'{PACKAGE}-root-{VERSION}-{processor}.tar.zst'
    tree.unlink(missing_ok=True)
    subprocess.run(['tar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner',
        f'--mtime=@{SOURCE_DATE_EPOCH}', '-I', 'zstd -19 -T0', '-cf', tree, '-C', root, 'usr'], check=True)
    pkgbuild = (REPO / 'packaging/linux/arch/PKGBUILD').read_text()
    for key, value in {'@PKGVER@': pkgver, '@VERSION@': VERSION, '@ARCH@': processor,
                       '@SHA256@': digest(tree)}.items():
        pkgbuild = pkgbuild.replace(key, value)
    (OUT / 'PKGBUILD').write_text(pkgbuild)
    shutil.copy2(REPO / 'packaging/linux/arch/josi.install', OUT / 'josi.install')
    value = record_checksum(package)
    print(json.dumps({'package': str(package), 'bytes': package.stat().st_size, 'pkgbuild': str(OUT / 'PKGBUILD'),
        'sha256': value, 'signed': False, 'target': 'Arch ' + processor}))


if __name__ == '__main__':
    main()
