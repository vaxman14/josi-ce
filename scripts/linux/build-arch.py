"""Build an unsigned Blade/Arch x86_64 acceptance package without installing it."""
import json
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
        "pkgdesc = Native offline setup and lifecycle manager for Josi CE Server\n"
        "url = https://github.com/vaxman14/josi-ce\n"
        f"builddate = {SOURCE_DATE_EPOCH}\npackager = SOCAL RECEPTIONIST LLC\n"
        f"size = {size}\narch = x86_64\nlicense = AGPL-3.0-or-later\n"
        "depend = python-gobject\ndepend = gtk4\ndepend = polkit\ndepend = systemd\n"
        "depend = rsync\ndepend = acl\ndepend = xdg-utils\ndepend = gcc-libs\n"
    )
    (root / '.PKGINFO').write_text(metadata)
    package = OUT / f'josi-ce-server-setup-{package_version}-x86_64.pkg.tar.zst'
    package.unlink(missing_ok=True)
    subprocess.run([
        'tar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner',
        f'--mtime=@{SOURCE_DATE_EPOCH}', '-I', 'zstd -19 -T0', '-cf', package, '-C', root, '.',
    ], check=True)
    digest = record_checksum(package)
    print(json.dumps({'package': str(package), 'bytes': package.stat().st_size,
        'sha256': digest, 'signed': False, 'target': 'Blade/Arch x86_64'}))


if __name__ == '__main__':
    main()
