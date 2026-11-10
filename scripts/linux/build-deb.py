"""Build the unsigned Debian/Ubuntu package `josi` without installing it."""
import json
import os
import subprocess

from package_common import (BASE, DEBIAN_ARCH, OUT, PACKAGE, SOURCE_DATE_EPOCH, debian_version, package_names,
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
        f"Version: {debian_version()}\nArchitecture: {DEBIAN_ARCH[processor]}\n"
        "Maintainer: SOCAL RECEPTIONIST LLC <vaxman14@users.noreply.github.com>\n"
        "Depends: python3 (>= 3.10), systemd, rsync, acl, iproute2, libstdc++6, ca-certificates\n"
        "Conflicts: josi-ce-server-setup\nReplaces: josi-ce-server-setup\n"
        "Section: admin\nPriority: optional\n"
        f"Installed-Size: {size}\n"
        "Description: Josi server, headless, run by systemd as josi.service\n"
        " Josi's private PostgreSQL, Node, Python, Caddy and CPU speech runtime. Setup,\n"
        " sign-in, chat, settings and updates all happen in the browser.\n"
    )
    # A removal (apt remove josi) stops and disables Josi first: its units live
    # in /etc/systemd/system and run the program kept in /var/lib/josi, so
    # left enabled they would start again at the next boot. Its data stays
    # unless josi-uninstall --purge is used. An upgrade leaves them alone.
    units = ('josi.service josi-update.path josi-update.timer josi-pc.service josi-browser.service '
        + ' '.join(f'josi-ce-{role}.service' for role in ('database', 'voice', 'voice-control', 'web', 'worker', 'proxy')))
    prerm = control / 'prerm'
    prerm.write_text('#!/bin/sh\nset -e\nif [ "$1" = remove ] && [ -d /run/systemd/system ]; then\n'
        f'  systemctl disable --now {units} >/dev/null 2>&1 || true\nfi\n')
    prerm.chmod(0o755)
    # Python caches are never part of the program: the payload check counts
    # every file, and dpkg keeps files it did not install, so one left by an
    # older version would stop every later upgrade.
    postinst = control / 'postinst'
    postinst.write_text('#!/bin/sh\nset -e\n'
        'find /usr/lib/josi/runtime -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true\n')
    postinst.chmod(0o755)
    postrm = control / 'postrm'
    postrm.write_text('#!/bin/sh\nset -e\ncase "$1" in remove|purge)\n'
        '  if [ -d /run/systemd/system ]; then\n'
        f'    systemctl disable {units} >/dev/null 2>&1 || true\n'
        '    systemctl daemon-reload >/dev/null 2>&1 || true\n  fi ;;\nesac\n')
    postrm.chmod(0o755)
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
