"""Assemble the hash-verifiable native Linux runtime from JosiDrive inputs."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

REPO=Path(__file__).resolve().parents[2]
BASE=Path('/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010')
CACHE=Path('/home/roman/JosiDrive/Caches/codex-linux-native-20261010')
RUNTIME=BASE/'stage/runtime';VERSION='0.1.78-linux.19'

def copy(source,target):
    if source.is_dir():shutil.copytree(source,target,symlinks=True,dirs_exist_ok=True)
    else:target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)

def extract(archive,target,strip=False):
    target.mkdir(parents=True,exist_ok=True)
    command=['tar','-xf',str(archive),'-C',str(target)]
    if strip:command.extend(['--strip-components=1'])
    subprocess.run(command,check=True)

def main():
    architecture={'x86_64':'x86_64','aarch64':'aarch64'}[platform.machine()]
    if RUNTIME.exists():shutil.rmtree(RUNTIME)
    app=RUNTIME/'app';app.mkdir(parents=True,exist_ok=True)
    for path in [REPO/'package.json',REPO/'package-lock.json',*REPO.glob('packages/*/package.json'),*REPO.glob('apps/*/package.json')]:copy(path,app/path.relative_to(REPO))
    env={**os.environ,'npm_config_cache':'/home/roman/JosiDrive/Caches/codex-linux-native-20261010/npm'}
    if not (app/'node_modules').exists():subprocess.run(['npm','ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=app,env=env,check=True)
    metadata=json.loads((app/'package.json').read_text());metadata.update(name='josi-ce-native-runtime',version=VERSION,type='module')
    (app/'package.json').write_text(json.dumps(metadata,indent=2)+'\n')
    for path in [*REPO.glob('packages/*/dist'),*REPO.glob('apps/*/dist'),REPO/'packages/db/migrate.mjs',REPO/'packages/db/migrations']:
        copy(path,app/path.relative_to(REPO))
    for path in (REPO/'packaging/linux').glob('*'):
        if path.name in ('PythonRuntime.py','Runtime.mjs','lifecycle.py','maintenance.py'):copy(path,app/'native'/path.name)
    for name in ('bounded_http.py','gateway.py','model_smoke.py','posix_helper.py','runtime_config.py','settings.py','tts.py','windows_helper.py'):
        copy(REPO/'services/voice-box'/name,app/'services/voice-box'/name)
    if sys.argv[1:]==['--code-only']:return
    locks=json.loads((REPO/'packaging/linux/build-inputs.lock.json').read_text())
    node_name='node-v24.15.0-linux-'+('x64' if architecture=='x86_64' else 'arm64')+'.tar.xz'
    for name in ('node','caddy'):
        if (RUNTIME/name).exists():shutil.rmtree(RUNTIME/name)
    extract(CACHE/node_name,RUNTIME/'node',True)
    copy(BASE/'prefix/portable/postgresql',RUNTIME/'postgresql');copy(BASE/'prefix/python',RUNTIME/'python')
    caddy_name='caddy-'+('amd64' if architecture=='x86_64' else 'arm64')+'.tar.gz'
    extract(CACHE/caddy_name,RUNTIME/'caddy')
    for item in json.loads((REPO/'services/voice-box/models.lock.json').read_text())['files']:
        copy(CACHE/'models'/item['path'].replace('/','__'),RUNTIME/'voice-models'/item['path'])
    for folder in RUNTIME.rglob('__pycache__'):shutil.rmtree(folder)
    for path in (RUNTIME/'python/lib/python3.12/site-packages').glob('pip*'):
        if path.is_dir():shutil.rmtree(path)
    for path in (RUNTIME/'python/bin').glob('pip*'):path.unlink()
    for path in (RUNTIME/'python/lib/python3.12/site-packages/setuptools').glob('*.exe'):path.unlink()
    for path in [RUNTIME/'python/lib/python3.12/test',RUNTIME/'python/lib/python3.12/ensurepip']:
        if path.exists():shutil.rmtree(path)
    for path in [RUNTIME/'node/include',RUNTIME/'node/share',RUNTIME/'postgresql/include']:
        if path.exists():shutil.rmtree(path)
    for path in (RUNTIME/'node/bin').iterdir():
        if path.name!='node':path.unlink()
    print(json.dumps({'runtime':str(RUNTIME),'architecture':architecture,'version':VERSION}))

if __name__=='__main__':main()
