"""Build an unsigned Debian/Ubuntu x86_64 acceptance package without installing it."""
import json
import os
import subprocess

from package_common import BASE, OUT, SOURCE_DATE_EPOCH, VERSION, populate_root, record_checksum


BUILD_IMAGE = 'local/josi-ce-linux-package-build:debian12'


def main() -> None:
    root = BASE / 'deb-root'
    populate_root(root, root / 'usr/share/doc/josi-ce-server-setup/copyright')
    size = sum(path.stat().st_size for path in root.rglob('*') if path.is_file()) // 1024
    control = root / 'DEBIAN'
    control.mkdir(mode=0o755)
    control.joinpath('control').write_text(
        "Package: josi-ce-server-setup\n"
        f"Version: {VERSION}\nArchitecture: amd64\n"
        "Maintainer: SOCAL RECEPTIONIST LLC <vaxman14@users.noreply.github.com>\n"
        "Depends: python3 (>= 3.10), systemd, rsync, acl, iproute2, libstdc++6\n"
        "Section: admin\nPriority: optional\n"
        f"Installed-Size: {size}\n"
        "Description: Native offline Josi CE Server runtime and CLI installer\n"
        " Installs Josi's private PostgreSQL, Node, Python, Caddy and CPU Voice Box runtime.\n"
    )
    package = OUT / f'josi-ce-server-setup_{VERSION}_amd64.deb'
    package.unlink(missing_ok=True)
    environment = {**os.environ, 'SOURCE_DATE_EPOCH': SOURCE_DATE_EPOCH}
    if subprocess.run(['sh', '-c', 'command -v dpkg-deb'], capture_output=True).returncode == 0:
        command = ['dpkg-deb', '--root-owner-group', '-Zxz', '-z9', '--build', root, package]
    else:
        command = ['docker', 'run', '--rm', '--pull=never', '--user', f'{os.getuid()}:{os.getgid()}',
            '-e', f'SOURCE_DATE_EPOCH={SOURCE_DATE_EPOCH}',
            '-v', f'{BASE}:{BASE}', BUILD_IMAGE, 'dpkg-deb', '--root-owner-group', '-Zxz', '-z9',
            '--build', str(root), str(package)]
    subprocess.run(command, env=environment, check=True)
    digest = record_checksum(package)
    print(json.dumps({'package': str(package), 'bytes': package.stat().st_size,
        'sha256': digest, 'signed': False, 'target': 'Debian/Ubuntu x86_64'}))


if __name__ == '__main__':
    main()
