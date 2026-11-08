"""Build the unsigned Debian/Ubuntu package `josi` without installing it."""
import json
import os
import subprocess

from package_common import (BASE, DEBIAN_ARCH, OUT, PACKAGE, SOURCE_DATE_EPOCH, VERSION, package_names,
    populate_root, record_checksum, staged_architecture)


BUILD_IMAGE = 'local/josi-ce-linux-package-build:debian12'


def main() -> None:
    processor = staged_architecture()
    root = BASE / 'deb-root'
    populate_root(root, root / f'usr/share/doc/{PACKAGE}/copyright')
    size = sum(path.stat().st_size for path in root.rglob('*') if path.is_file()) // 1024
    control = root / 'DEBIAN'
    control.mkdir(mode=0o755)
    control.joinpath('control').write_text(
        f"Package: {PACKAGE}\n"
        f"Version: {VERSION}\nArchitecture: {DEBIAN_ARCH[processor]}\n"
        "Maintainer: SOCAL RECEPTIONIST LLC <vaxman14@users.noreply.github.com>\n"
        "Depends: python3 (>= 3.10), systemd, rsync, acl, iproute2, libstdc++6, ca-certificates\n"
        "Conflicts: josi-ce-server-setup\nReplaces: josi-ce-server-setup\n"
        "Section: admin\nPriority: optional\n"
        f"Installed-Size: {size}\n"
        "Description: Josi server, headless, run by systemd as josi.service\n"
        " Josi's private PostgreSQL, Node, Python, Caddy and CPU speech runtime. Setup,\n"
        " sign-in, chat, settings and updates all happen in the browser.\n"
    )
    # A removal stops Josi first; its data stays unless josi-uninstall --purge is used.
    prerm = control / 'prerm'
    prerm.write_text('#!/bin/sh\nset -e\nif [ "$1" = remove ] && [ -d /run/systemd/system ]; then\n'
        '  systemctl stop josi.service josi-update.path josi-update.timer >/dev/null 2>&1 || true\nfi\n')
    prerm.chmod(0o755)
    package = OUT / package_names()['debian-' + processor]
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
        'sha256': digest, 'signed': False, 'target': 'Debian/Ubuntu ' + processor}))


if __name__ == '__main__':
    main()
