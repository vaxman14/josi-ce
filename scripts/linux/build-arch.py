"""Build an unsigned Blade/Arch x86_64 acceptance package without installing it."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

REPO=Path(__file__).resolve().parents[2]
BASE=Path('/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010')
ROOT=BASE/'arch-root';OUT=BASE/'artifacts';RUNTIME=BASE/'stage/runtime'

def copy(source,target):
    if source.is_dir():shutil.copytree(source,target,symlinks=True,dirs_exist_ok=True)
    else:target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)

def main():
    if ROOT.exists():shutil.rmtree(ROOT)
    OUT.mkdir(parents=True,exist_ok=True)
    copy(RUNTIME,ROOT/'usr/lib/josi-ce-server-setup/runtime')
    copy(RUNTIME.parent/'inventory.json',ROOT/'usr/lib/josi-ce-server-setup/inventory.json')
    copy(RUNTIME.parent/'native-libraries.json',ROOT/'usr/lib/josi-ce-server-setup/native-libraries.json')
    for source,target in [
        (REPO/'packaging/linux/setup.py',ROOT/'usr/bin/josi-ce-server-setup'),
        (REPO/'packaging/linux/status.py',ROOT/'usr/bin/josi-ce-native-status'),
        (REPO/'packaging/linux/com.heyjosi.ce.server.setup.desktop',ROOT/'usr/share/applications/com.heyjosi.ce.server.setup.desktop'),
        (REPO/'packaging/linux/com.heyjosi.ce.server.setup.policy',ROOT/'usr/share/polkit-1/actions/com.heyjosi.ce.server.setup.policy'),
        (REPO/'packaging/macos/Josi.png',ROOT/'usr/share/icons/hicolor/512x512/apps/com.heyjosi.ce.server.png'),
        (REPO/'LICENSE',ROOT/'usr/share/licenses/josi-ce-server-setup/LICENSE'),
        (REPO/'NOTICE',ROOT/'usr/share/doc/josi-ce-server-setup/NOTICE'),
        (REPO/'packaging/linux/TEST-ME.txt',ROOT/'usr/share/doc/josi-ce-server-setup/TEST-ME.txt'),
        (REPO/'packaging/linux/build-inputs.lock.json',ROOT/'usr/share/doc/josi-ce-server-setup/build-inputs.lock.json')]:copy(source,target)
    helper=ROOT/'usr/libexec/josi-ce-setup-helper';helper.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run(['gcc','-O2','-fPIE','-pie','-Wl,-z,relro,-z,now','-Wall','-Wextra','-Werror','-o',helper,REPO/'packaging/linux/helper.c'],check=True)
    for path in (*list((ROOT/'usr/bin').iterdir()),helper):path.chmod(0o755)
    size=sum(path.stat().st_size for path in ROOT.rglob('*') if path.is_file())
    metadata=("pkgname = josi-ce-server-setup\npkgbase = josi-ce-server-setup\npkgver = 0.1.78_linux.1-1\n"
        "pkgdesc = Native offline setup and lifecycle manager for Josi CE Server\nurl = https://github.com/vaxman14/josi-ce\n"
        "builddate = 1735689600\npackager = Socal Receptionist LLC\n"
        f"size = {size}\narch = x86_64\nlicense = AGPL-3.0-or-later\n"
        "depend = python-gobject\ndepend = gtk4\ndepend = polkit\ndepend = systemd\ndepend = rsync\n"
        "depend = acl\ndepend = xdg-utils\ndepend = gcc-libs\n")
    (ROOT/'.PKGINFO').write_text(metadata)
    package=OUT/'josi-ce-server-setup-0.1.78_linux.1-1-x86_64.pkg.tar.zst'
    if package.exists():package.unlink()
    subprocess.run(['tar','--sort=name','--owner=0','--group=0','--numeric-owner','--mtime=@1735689600','-I','zstd -19 -T0','-cf',package,'-C',ROOT,'.'],check=True)
    digest=hashlib.sha256(package.read_bytes()).hexdigest()
    checksums=OUT/'SHA256SUMS.txt';existing=checksums.read_text() if checksums.exists() else ''
    lines=[line for line in existing.splitlines() if not line.endswith('  '+package.name)]+[digest+'  '+package.name]
    checksums.write_text('\n'.join(lines)+'\n')
    print(json.dumps({'package':str(package),'bytes':package.stat().st_size,'sha256':digest,'signed':False,'target':'Blade/Arch x86_64'}))

if __name__=='__main__':main()
