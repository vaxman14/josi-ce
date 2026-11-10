"""Assemble the hash-verifiable native Linux runtime from JosiDrive inputs."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

REPO=Path(__file__).resolve().parents[2]
BASE=Path(os.environ.get('JOSI_LINUX_BUILD_BASE','/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010'))
CACHE=Path(os.environ.get('JOSI_LINUX_BUILD_CACHE','/home/roman/JosiDrive/Caches/codex-linux-native-20261010'))
RUNTIME=BASE/'stage/runtime';VERSION=os.environ.get('JOSI_LINUX_VERSION','1.0.0')
# The one version shape every part accepts (lifecycle.py, Runtime.mjs, the updater).
if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-z0-9.]+)?',VERSION):raise SystemExit('Invalid JOSI_LINUX_VERSION: '+VERSION)

def copy(source,target):
    if source.is_dir():shutil.copytree(source,target,symlinks=True,dirs_exist_ok=True)
    else:target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)

def extract(archive,target,strip=False):
    target.mkdir(parents=True,exist_ok=True)
    command=['tar','-xf',str(archive),'-C',str(target)]
    if strip:command.extend(['--strip-components=1'])
    subprocess.run(command,check=True)

def bundle_cli(architecture):
    """The pinned, unmodified Codex and Claude Code CLIs, as on the Mac and Windows.

    The subscription providers run them; without them "Sign in with ChatGPT"
    and "Sign in with Claude" have nothing to start. Each npm tarball is checked
    against packaging/linux/subscription-cli.lock.json before it is unpacked.
    """
    import base64,tarfile
    rows={row['id']:row for row in json.loads((REPO/'packaging/linux/subscription-cli.lock.json').read_text())}
    target=RUNTIME/'cli'
    if target.exists():shutil.rmtree(target)
    (target/'bin').mkdir(parents=True)
    for name in ('codex','claude'):
        row=rows[name+'-'+architecture];path=CACHE/'subscription-cli'/row['filename']
        if not path.is_file():
            path.parent.mkdir(parents=True,exist_ok=True)
            subprocess.run(['curl','-fsSL','--proto','=https','-o',str(path),row['url']],check=True)
        data=path.read_bytes()
        if hashlib.sha256(data).hexdigest()!=row['sha256'] or 'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()!=row['integrity']:
            raise ValueError('CLI artifact pin mismatch: '+row['id'])
        destination=target/name;destination.mkdir()
        with tarfile.open(path) as archive:
            for entry in archive:
                parts=Path(entry.name).parts
                if not parts or parts[0]!='package' or '..' in parts or Path(entry.name).is_absolute() or not (entry.isfile() or entry.isdir()):
                    raise ValueError('Unsafe vendor artifact entry')
                output=destination.joinpath(*parts[1:])
                if entry.isdir():output.mkdir(parents=True,exist_ok=True);continue
                output.parent.mkdir(parents=True,exist_ok=True)
                with archive.extractfile(entry) as source,output.open('xb') as stream:shutil.copyfileobj(source,stream)
                output.chmod(0o755 if entry.mode&0o111 else 0o644)
    triple=rows['codex-'+architecture]['triple']
    (target/'bin/codex').symlink_to('../codex/vendor/'+triple+'/bin/codex')
    (target/'bin/rg').symlink_to('../codex/vendor/'+triple+'/codex-path/rg')
    (target/'bin/claude').symlink_to('../claude/claude')
    copy(REPO/'packaging/linux/subscription-cli.lock.json',target/'inputs.lock.json')

def stage_browser_extension(app):
    """The unpacked Chrome extension Josi's own browser loads
    (JOSI_BROWSER_EXTENSION=<version>/app/browser-extension/chrome). The
    builder refuses an existing folder, so it gets a new one each time."""
    import tempfile
    # The builder zips the store packages with the compiled packages/ops.
    if not (REPO/'packages/ops/dist/zip.js').is_file():
        raise SystemExit('Build the code first (npx tsc -b): the browser extension build needs packages/ops/dist/zip.js')
    with tempfile.TemporaryDirectory(prefix='josi-extensions-') as scratch:
        output=Path(scratch)/'out'
        subprocess.run(['node',str(REPO/'scripts/unified/build-browser-extensions.mjs'),str(output)],cwd=REPO,check=True,stdout=subprocess.DEVNULL)
        chrome=output/'chrome'
        if not (chrome/'manifest.json').is_file():raise SystemExit('The browser extension build made no chrome/manifest.json')
        target=app/'browser-extension/chrome'
        if target.exists():shutil.rmtree(target)
        shutil.copytree(chrome,target,symlinks=False)

def main():
    architecture={'x86_64':'x86_64','aarch64':'aarch64'}[platform.machine()]
    if RUNTIME.exists():shutil.rmtree(RUNTIME)
    app=RUNTIME/'app';app.mkdir(parents=True,exist_ok=True)
    for path in [REPO/'package.json',REPO/'package-lock.json',*REPO.glob('packages/*/package.json'),*REPO.glob('apps/*/package.json')]:copy(path,app/path.relative_to(REPO))
    env={**os.environ,'npm_config_cache':str(CACHE/'npm')}
    if not (app/'node_modules').exists():subprocess.run(['npm','ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=app,env=env,check=True)
    metadata=json.loads((app/'package.json').read_text());metadata.update(name='josi-ce-native-runtime',version=VERSION,type='module')
    (app/'package.json').write_text(json.dumps(metadata,indent=2)+'\n')
    for path in [*REPO.glob('packages/*/dist'),*(path for path in REPO.glob('apps/*/dist') if path.parent.name!='hosted'),REPO/'packages/db/migrate.mjs',REPO/'packages/db/migrations']:
        copy(path,app/path.relative_to(REPO))
    for path in (REPO/'packaging/linux').glob('*'):
        if path.name in ('PythonRuntime.py','Runtime.mjs','lifecycle.py','maintenance.py'):copy(path,app/'native'/path.name)
    # The PC control executor (josi-pc.service runs <version>/node/bin/node
    # <version>/app/packaging/linux/pc-executor/josi-pc.mjs as the chosen user).
    executor=REPO/'packaging/linux/pc-executor'
    if (executor/'josi-pc.mjs').is_file():
        for path in executor.rglob('*'):
            if path.is_file() and not path.name.startswith('test') and '__pycache__' not in path.parts:
                copy(path,app/'packaging/linux/pc-executor'/path.relative_to(executor))
    else:print('warning: packaging/linux/pc-executor/josi-pc.mjs is missing; this build has no PC control',file=sys.stderr)
    stage_browser_extension(app)
    for name in ('bounded_http.py','gateway.py','model_smoke.py','posix_helper.py','runtime_config.py','settings.py','tts.py','windows_helper.py'):
        copy(REPO/'services/voice-box'/name,app/'services/voice-box'/name)
    if sys.argv[1:]==['--code-only']:return
    locks=json.loads((REPO/'packaging/linux/build-inputs.lock.json').read_text())
    node_name='node-v24.15.0-linux-'+('x64' if architecture=='x86_64' else 'arm64')+'.tar.xz'
    for name in ('node','caddy'):
        if (RUNTIME/name).exists():shutil.rmtree(RUNTIME/name)
    extract(CACHE/node_name,RUNTIME/'node',True)
    bundle_cli(architecture)
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
    subprocess.run([sys.executable,str(REPO/'scripts/linux/inventory.py'),str(RUNTIME)],check=True)
    print(json.dumps({'runtime':str(RUNTIME),'architecture':architecture,'version':VERSION}))

if __name__=='__main__':main()
