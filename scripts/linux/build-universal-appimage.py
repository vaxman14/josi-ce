#!/usr/bin/env python3
"""Build the portable distro-selecting GTK installer on a Debian 12 baseline."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess


REPO = Path(__file__).resolve().parents[2]
BASE = Path('/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010')
OUT = BASE / 'artifacts'
APPDIR = BASE / 'universal-appimage/AppDir'
TOOLS = Path('/home/roman/JosiDrive/Caches/linux-appimage-tools')
VERSION = '0.1.78-linux.20'
BASE_URL = os.environ.get('JOSI_INSTALLER_BASE_URL',
    f'https://github.com/vaxman14/josi-ce/releases/download/v{VERSION}/')
PACKAGES = {
    'arch': f'josi-ce-server-setup-{VERSION.replace("-", "_")}-1-x86_64.pkg.tar.zst',
    'debian': f'josi-ce-server-setup_{VERSION}_amd64.deb',
    'rpm': f'josi-ce-server-setup-{VERSION}.x86_64.rpm',
}


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def main() -> None:
    for tool in ('linuxdeploy-x86_64.AppImage', 'appimagetool-x86_64.AppImage'):
        if not (TOOLS / tool).is_file():
            raise SystemExit(f'Missing cached AppImage tool: {TOOLS / tool}')
    package_records = {}
    for family, name in PACKAGES.items():
        path = OUT / name
        if not path.is_file():
            raise SystemExit(f'Missing native package: {path}')
        package_records[family] = {'name': name, 'sha256': digest(path)}
    build = APPDIR.parent
    if build.exists():
        shutil.rmtree(build)
    APPDIR.mkdir(parents=True)
    manifest = {'version': VERSION, 'baseUrl': BASE_URL, 'packages': package_records}
    manifest_path = build / 'installer-manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    image = 'local/josi-ce-linux-package-build:debian12'
    script = r'''
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends python3 python3-gi gir1.2-gtk-4.0 libgtk-4-1 \
  adwaita-icon-theme hicolor-icon-theme shared-mime-info ca-certificates file fonts-dejavu-core >/dev/null
mkdir -p /build/AppDir/usr/share/josi-ce-server-installer \
  /build/AppDir/usr/lib/python3/dist-packages \
  /build/AppDir/usr/lib/x86_64-linux-gnu/girepository-1.0 \
  /build/AppDir/usr/share/glib-2.0/schemas \
  /build/AppDir/usr/share/icons/hicolor/512x512/apps /build/AppDir/etc/josi-fontconfig
cp /repo/packaging/linux/universal_installer.py /repo/packaging/linux/universal_installer_core.py \
  /build/AppDir/usr/share/josi-ce-server-installer/
cp /repo/packaging/linux/universal_root_install.sh /build/AppDir/usr/share/josi-ce-server-installer/
cp /build/installer-manifest.json /build/AppDir/usr/share/josi-ce-server-installer/
cp -a /usr/lib/python3.11 /build/AppDir/usr/lib/
cp -a /usr/lib/python3/dist-packages/gi /build/AppDir/usr/lib/python3/dist-packages/
cp -a /usr/lib/x86_64-linux-gnu/girepository-1.0/. /build/AppDir/usr/lib/x86_64-linux-gnu/girepository-1.0/
cp -a /usr/share/glib-2.0/schemas/gschemas.compiled /build/AppDir/usr/share/glib-2.0/schemas/
cp -a /usr/share/icons/Adwaita /build/AppDir/usr/share/icons/
cp /repo/packaging/linux/portable-fonts.conf /build/AppDir/etc/josi-fontconfig/
cp -a /usr/share/fonts /build/AppDir/usr/share/
cp -a /usr/share/fontconfig /build/AppDir/usr/share/
cp /repo/apps/web/public/icons/icon-512.png /build/AppDir/com.heyjosi.ce.server.installer.png
cp /repo/apps/web/public/icons/icon-512.png /build/AppDir/usr/share/icons/hicolor/512x512/apps/com.heyjosi.ce.server.installer.png
cp /repo/packaging/linux/com.heyjosi.ce.server.installer.desktop /build/AppDir/
cp /repo/packaging/linux/AppRun /build/AppDir/AppRun
chmod 0755 /build/AppDir/AppRun /build/AppDir/usr/share/josi-ce-server-installer/universal_installer.py \
  /build/AppDir/usr/share/josi-ce-server-installer/universal_root_install.sh
APPIMAGE_EXTRACT_AND_RUN=1 /tools/linuxdeploy-x86_64.AppImage --appdir /build/AppDir \
  --executable /usr/bin/python3 \
  --library /usr/lib/x86_64-linux-gnu/libgtk-4.so.1 \
  --library /usr/lib/python3/dist-packages/gi/_gi.cpython-311-x86_64-linux-gnu.so \
  --desktop-file /build/AppDir/com.heyjosi.ce.server.installer.desktop \
  --icon-file /build/AppDir/com.heyjosi.ce.server.installer.png
# linuxdeploy intentionally blacklists common desktop libraries, but a clean
# Debian server image does not contain them. Bundle the non-glibc GUI set so
# the installer remains a real portable GUI instead of a decorative promise.
for library in \
  libexpat.so.1 libfontconfig.so.1 libfreetype.so.6 libfribidi.so.0 \
  libharfbuzz.so.0 libwayland-client.so.0 libX11.so.6 libxcb.so.1 \
  libuuid.so.1 libz.so.1; do
  cp -L "/usr/lib/x86_64-linux-gnu/$library" /build/AppDir/usr/lib/
done
cc -O2 -s -Wall -Wextra -Werror /repo/packaging/linux/nofuse_launcher.c -o /build/nofuse-launcher
chown -R "$HOST_UID:$HOST_GID" /build
'''
    subprocess.run(['docker', 'run', '--rm', '--pull=never',
        '-e', f'HOST_UID={os.getuid()}', '-e', f'HOST_GID={os.getgid()}',
        '-v', f'{REPO}:/repo:ro', '-v', f'{build}:/build', '-v', f'{TOOLS}:/tools:ro',
        image, 'sh', '-lc', script], check=True)
    target = OUT / f'Josi-CE-Server-Installer-{VERSION}-x86_64.AppImage'
    target.unlink(missing_ok=True)
    environment = {**os.environ, 'ARCH':'x86_64', 'SOURCE_DATE_EPOCH':'1735689600'}
    subprocess.run([str(TOOLS/'appimagetool-x86_64.AppImage'), str(APPDIR), str(target)],
        env={**environment, 'APPIMAGE_EXTRACT_AND_RUN':'1'}, check=True)
    target.chmod(0o755)
    portable = OUT / f'Josi-CE-Server-Installer-{VERSION}-x86_64.run'
    with portable.open('wb') as output, (build/'nofuse-launcher').open('rb') as launcher, target.open('rb') as appimage:
        shutil.copyfileobj(launcher, output)
        shutil.copyfileobj(appimage, output)
        output.write(struct.pack('<Q', target.stat().st_size))
        output.write(b'JOSIAPP1')
    portable.chmod(0o755)
    print(json.dumps({'installer':str(portable), 'bytes':portable.stat().st_size,
        'sha256':digest(portable), 'appImage':str(target),
        'appImageSha256':digest(target), 'packages':package_records}, indent=2))


if __name__ == '__main__':
    main()
