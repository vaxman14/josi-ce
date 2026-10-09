"""Assemble offline runtime using previously hash-verified local inputs.
Never registers services or invokes codesign. Run with the private Python.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

REPO=Path(__file__).resolve().parents[2]
BASE=Path('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port')
STAGE=BASE/'stage'
RUNTIME=STAGE/'runtime'
NODE=BASE.parent.parent/'node-v24.15.0-darwin-arm64'
VERSION='0.1.78-macos.1'

def copy(src,dst):
    if src.is_dir():shutil.copytree(src,dst,symlinks=True,dirs_exist_ok=True)
    else:dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)

def main():
    if sys.platform!='darwin' or os.uname().machine!='arm64':raise ValueError('Native Apple Silicon required')
    RUNTIME.mkdir(parents=True,exist_ok=True)
    app=RUNTIME/'app';app.mkdir(exist_ok=True)
    for p in [REPO/'package.json',REPO/'package-lock.json',*REPO.glob('packages/*/package.json'),*REPO.glob('apps/*/package.json')]:copy(p,app/p.relative_to(REPO))
    env={'PATH':str(NODE/'bin')+':/usr/bin:/bin','TMPDIR':str(BASE/'tmp'),'npm_config_cache':'/Volumes/JosiOS/JosiDrive/Caches/codex-macos-native-20261009/npm','DEVELOPER_DIR':'/Applications/Xcode.app/Contents/Developer'}
    if not (app/'node_modules').exists():
        subprocess.run([str(NODE/'bin/npm'),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=app,env=env,check=True)
    meta=json.loads((app/'package.json').read_text());meta.update(name='josi-ce-native-runtime',version=VERSION,type='module')
    (app/'package.json').write_text(json.dumps(meta,indent=2)+'\n')
    for p in [*REPO.glob('packages/*/dist'),*REPO.glob('apps/*/dist'),REPO/'packages/db/migrate.mjs',REPO/'packages/db/migrations']:
        copy(p,app/p.relative_to(REPO))
    copy(REPO/'packaging/macos/install-help.html',app/'apps/web/dist/help/install/index.html')
    if (app/'native').exists():shutil.rmtree(app/'native')
    for p in (REPO/'packaging/macos').glob('*'):
        if p.name in ('PythonRuntime.py','Runtime.mjs','lifecycle.py'):copy(p,app/'native'/p.name)
    if (app/'services/voice-box').exists():shutil.rmtree(app/'services/voice-box')
    for name in ('bounded_http.py','gateway.py','macos_helper.py','model_smoke.py','runtime_config.py','settings.py','tts.py','windows_helper.py'):
        copy(REPO/'services/voice-box'/name,app/'services/voice-box'/name)
    if sys.argv[1:]==['--code-only']:return
    for name,source in [('node',NODE),('postgresql',BASE/'prefix/postgresql'),('python',BASE/'prefix/python')]:
        if (RUNTIME/name).exists():shutil.rmtree(RUNTIME/name)
        if name=='node':
            archive=Path('/Volumes/JosiOS/JosiDrive/Caches/codex-macos-native-20261009/node-v24.15.0-darwin-arm64.tar.gz')
            with archive.open('rb') as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest()!='372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4':raise ValueError('Node pin mismatch')
            (RUNTIME/name).mkdir()
            subprocess.run(['/usr/bin/tar','-xzf',str(archive),'--strip-components=1','-C',str(RUNTIME/name)],check=True)
        else:copy(source,RUNTIME/name)
    caddy=RUNTIME/'caddy';caddy.mkdir(exist_ok=True)
    archive=BASE/'caddy_2.11.7_mac_arm64.tar.gz'
    if hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()!='cda3030e5d5b13eb9f0b6fb541037f633bddd958c070c5f561d7a5cccb581665':raise ValueError('Caddy pin mismatch')
    subprocess.run(['/usr/bin/tar','-xzf',str(archive),'-C',str(caddy)],check=True)
    for item in json.loads((REPO/'services/voice-box/models.lock.json').read_text())['files']:
        src=BASE/'models'/item['path'].replace('/','__')
        if hashlib.file_digest(src.open('rb'),'sha256').hexdigest()!=item['sha256']:raise ValueError('Model pin mismatch')
        copy(src,RUNTIME/'voice-models'/item['path'])
    # Remove development-only interpreter tools/caches; retain runtime metadata
    # and license texts. No executable is resolved from an external prefix.
    for folder in RUNTIME.rglob('__pycache__'):shutil.rmtree(folder)
    for path in (RUNTIME/'python/lib/python3.11/site-packages').glob('pip*'):
        if path.is_dir():shutil.rmtree(path)
    for path in (RUNTIME/'python/lib/python3.11/site-packages').glob('*/direct_url.json'):path.unlink()
    for path in (RUNTIME/'python/bin').glob('pip*'):path.unlink()
    # Unused Windows entry-point launcher templates in the pure Python wheel.
    for path in (RUNTIME/'python/lib/python3.11/site-packages/setuptools').glob('*.exe'):path.unlink()
    for path in [RUNTIME/'python/lib/python3.11/test',RUNTIME/'python/lib/python3.11/ensurepip',RUNTIME/'node/lib',RUNTIME/'node/include',RUNTIME/'node/share',RUNTIME/'postgresql/include']:
        if path.exists():shutil.rmtree(path)
    for p in (RUNTIME/'node/bin').iterdir():
        if p.name!='node':p.unlink()
    print(json.dumps({'staged':str(RUNTIME),'version':VERSION}),flush=True)

if __name__=='__main__':main()
