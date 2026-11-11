"""Build an unsigned Debian/Ubuntu acceptance package without installing it."""
import json
import os
import subprocess

import target
from package_common import ARCH, BASE, BUILD_IMAGE, OUT, SOURCE_DATE_EPOCH, VERSION, package_names, populate_root, record_checksum


def main() -> None:
    root = BASE / 'deb-root'
    populate_root(root, root / 'usr/share/doc/josi-ce-server-setup/copyright')
    size = sum(path.stat().st_size for path in root.rglob('*') if path.is_file()) // 1024
    control = root / 'DEBIAN'
    control.mkdir(mode=0o755)
    control.joinpath('control').write_text(
        "Package: josi-ce-server-setup\n"
        f"Version: {VERSION}\nArchitecture: {target.name('deb')}\n"
        "Maintainer: SOCAL RECEPTIONIST LLC <vaxman14@users.noreply.github.com>\n"
        "Depends: python3 (>= 3.10), systemd, rsync, acl, iproute2, libstdc++6\n"
        "Section: admin\nPriority: optional\n"
        f"Installed-Size: {size}\n"
        "Description: Native offline Josi CE Server runtime and CLI installer\n"
        " Installs Josi's private PostgreSQL, Node, Python, Caddy and CPU Voice Box runtime.\n"
    )
    package = OUT / package_names()['debian']
    package.unlink(missing_ok=True)
    environment = {**os.environ, 'SOURCE_DATE_EPOCH': SOURCE_DATE_EPOCH}
    # Packing is the same on any machine, so the build machine's own tools do it.
    if subprocess.run(['sh', '-c', 'command -v dpkg-deb'], capture_output=True).returncode == 0:
        command = ['dpkg-deb', '--root-owner-group', '-Zxz', '-z9', '--build', root, package]
    else:
        command = ['docker', 'run', '--rm', '--pull=never', '--user', f'{os.getuid()}:{os.getgid()}',
            '-e', f'SOURCE_DATE_EPOCH={SOURCE_DATE_EPOCH}',
            '-v', f'{BASE}:{BASE}', '-v', f'{OUT}:{OUT}', BUILD_IMAGE, 'dpkg-deb', '--root-owner-group', '-Zxz', '-z9',
            '--build', str(root), str(package)]
    subprocess.run(command, env=environment, check=True)
    digest = record_checksum(package)
    print(json.dumps({'package': str(package), 'bytes': package.stat().st_size,
        'sha256': digest, 'signed': False, 'target': 'Debian/Ubuntu ' + ARCH}))


if __name__ == '__main__':
    main()
