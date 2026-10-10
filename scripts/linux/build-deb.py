"""Build an unsigned Debian acceptance package without installing it."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess

REPO=Path(__file__).resolve().parents[2]
BASE=Path('/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010')
ROOT=BASE/'deb-root';OUT=BASE/'artifacts';RUNTIME=BASE/'stage/runtime'

def copy(source,target):
    if source.is_dir():shutil.copytree(source,target,symlinks=True,dirs_exist_ok=True)
    else:target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)

def main():
    if ROOT.exists():shutil.rmtree(ROOT)
    OUT.mkdir(parents=True,exist_ok=True)
    copy(RUNTIME,ROOT/'usr/lib/josi-ce-server-setup/runtime')
    copy(RUNTIME.parent/'inventory.json',ROOT/'usr/lib/josi-ce-server-setup/inventory.json')
    copy(RUNTIME.parent/'native-libraries.json',ROOT/'usr/lib/josi-ce-server-setup/native-libraries.json')
    copy(REPO/'packaging/linux/setup.py',ROOT/'usr/bin/josi-ce-server-setup')
    copy(REPO/'packaging/linux/status.py',ROOT/'usr/bin/josi-ce-native-status')
    copy(REPO/'packaging/linux/com.heyjosi.ce.server.setup.desktop',ROOT/'usr/share/applications/com.heyjosi.ce.server.setup.desktop')
    copy(REPO/'packaging/linux/com.heyjosi.ce.server.setup.policy',ROOT/'usr/share/polkit-1/actions/com.heyjosi.ce.server.setup.policy')
    copy(REPO/'packaging/macos/Josi.png',ROOT/'usr/share/icons/hicolor/512x512/apps/com.heyjosi.ce.server.png')
    copy(REPO/'LICENSE',ROOT/'usr/share/doc/josi-ce-server-setup/copyright')
    copy(REPO/'NOTICE',ROOT/'usr/share/doc/josi-ce-server-setup/NOTICE')
    copy(REPO/'packaging/linux/TEST-ME.txt',ROOT/'usr/share/doc/josi-ce-server-setup/TEST-ME.txt')
    copy(REPO/'packaging/linux/build-inputs.lock.json',ROOT/'usr/share/doc/josi-ce-server-setup/build-inputs.lock.json')
    helper=ROOT/'usr/libexec/josi-ce-setup-helper';helper.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run(['gcc','-O2','-fPIE','-pie','-Wl,-z,relro,-z,now','-Wall','-Wextra','-Werror','-o',helper,REPO/'packaging/linux/helper.c'],check=True)
    for path in (ROOT/'usr/bin').iterdir():path.chmod(0o755)
    helper.chmod(0o755)
    size=sum(path.stat().st_size for path in ROOT.rglob('*') if path.is_file())//1024
    control=("Package: josi-ce-server-setup\nVersion: 0.1.78-linux.1\nArchitecture: amd64\n"
        "Maintainer: Socal Receptionist LLC <packages@example.invalid>\n"
        "Depends: python3 (>= 3.10), python3-gi, gir1.2-gtk-4.0, policykit-1, systemd, rsync, acl, xdg-utils\n"
        "Section: admin\nPriority: optional\nInstalled-Size: %d\n"
        "Description: Native offline setup and lifecycle manager for Josi CE Server\n"
        " Installs Josi's private PostgreSQL, Node, Python, Caddy and CPU Voice Box runtime.\n"%size)
    metadata=BASE/'deb-metadata';shutil.rmtree(metadata,ignore_errors=True);metadata.mkdir()
    (metadata/'control').write_text(control)
    for archive in (BASE/'control.tar.xz',BASE/'data.tar.xz'):
        if archive.exists():archive.unlink()
    subprocess.run(['tar','--sort=name','--owner=0','--group=0','--numeric-owner','--mtime=@1735689600','-cJf',BASE/'control.tar.xz','-C',metadata,'.'],check=True)
    subprocess.run(['tar','--sort=name','--owner=0','--group=0','--numeric-owner','--mtime=@1735689600','-cJf',BASE/'data.tar.xz','-C',ROOT,'.'],check=True)
    deb=OUT/'Josi-CE-Server-0.1.78-linux.1-amd64-acceptance.deb'
    if deb.exists():deb.unlink()
    (BASE/'debian-binary').write_text('2.0\n')
    subprocess.run(['ar','rcD',deb,BASE/'debian-binary',BASE/'control.tar.xz',BASE/'data.tar.xz'],check=True)
    digest=hashlib.sha256(deb.read_bytes()).hexdigest();(OUT/'SHA256SUMS.txt').write_text(digest+'  '+deb.name+'\n')
    print(json.dumps({'package':str(deb),'bytes':deb.stat().st_size,'sha256':digest,'signed':False}))
if __name__=='__main__':main()
