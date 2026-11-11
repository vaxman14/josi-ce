"""Build an unsigned Fedora/RHEL-family acceptance RPM without installing it."""
import json
import os
import shutil
import subprocess

from package_common import ARCH, BASE, BUILD_IMAGE, OUT, SOURCE_DATE_EPOCH, VERSION, package_names, populate_root, record_checksum, rpm_version_release


def main() -> None:
    root = BASE / 'rpm-root'
    populate_root(root, root / 'usr/share/licenses/josi-ce-server-setup/LICENSE')
    top = BASE / 'rpmbuild'
    shutil.rmtree(top, ignore_errors=True)
    for name in ('BUILD', 'BUILDROOT', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS'):
        (top / name).mkdir(parents=True)
    rpm_version, rpm_release = rpm_version_release()
    spec = top / 'SPECS/josi-ce-server-setup.spec'
    spec.write_text(f'''%global __os_install_post %{{nil}}
%global _build_id_links none
Name: josi-ce-server-setup
Version: {rpm_version}
Release: {rpm_release}
Summary: Native offline Josi CE Server runtime and CLI installer
License: AGPL-3.0-or-later
URL: https://github.com/vaxman14/josi-ce
BuildArch: {ARCH}
AutoReqProv: no
Requires: python3, systemd, rsync, acl, iproute, libstdc++

%description
Installs Josi's private PostgreSQL, Node, Python, Caddy and CPU Voice Box runtime.

%install
mkdir -p %{{buildroot}}
cp -a {root}/. %{{buildroot}}/

%files
/usr/bin/josi-ce-server-install
/usr/bin/josi-ce-native-status
/usr/lib/josi-ce-server-setup
/usr/share/licenses/josi-ce-server-setup/LICENSE
/usr/share/doc/josi-ce-server-setup
''')
    # Nothing is compiled here, so the build machine's own image packs the
    # files and --target names the architecture they are for.
    command = ['docker', 'run', '--rm', '--pull=never', '--user', f'{os.getuid()}:{os.getgid()}',
        '-e', f'SOURCE_DATE_EPOCH={SOURCE_DATE_EPOCH}', '-e', f'HOME={BASE}/rpm-home',
        '-v', f'{BASE}:{BASE}', BUILD_IMAGE, 'rpmbuild', '-bb', '--target', ARCH, '--define', f'_topdir {top}',
        '--define', '_binary_payload w19T0.zstdio', '--define', '_buildhost josi-build',
        '--define', 'use_source_date_epoch_as_buildtime 1', str(spec)]
    subprocess.run(command, check=True)
    built = next((top / 'RPMS' / ARCH).glob('josi-ce-server-setup-*.rpm'))
    package = OUT / package_names()['rpm']
    package.unlink(missing_ok=True)
    shutil.copy2(built, package)
    digest = record_checksum(package)
    print(json.dumps({'package': str(package), 'bytes': package.stat().st_size,
        'sha256': digest, 'signed': False, 'target': 'Fedora/RHEL-family ' + ARCH}))


if __name__ == '__main__':
    main()
