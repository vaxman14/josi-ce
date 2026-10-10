"""Inspect expanded bytes and package choices. Never executes package scripts."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import sys
import xml.etree.ElementTree as ET

def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def compare(source,target):
    files={p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file() or p.is_symlink()}
    actual={p.relative_to(target).as_posix() for p in target.rglob('*') if p.is_file() or p.is_symlink()}
    if files!=actual:raise ValueError('Payload inventory mismatch')
    if len({p.casefold() for p in files})!=len(files):raise ValueError('Case-colliding payload members')
    for name in files:
        a,b=source/name,target/name
        if b.is_symlink():
            if not a.is_symlink() or os.readlink(a)!=os.readlink(b) or not b.resolve().is_relative_to(target):raise ValueError('Unsafe payload link')
        elif a.is_symlink() or digest(a)!=digest(b):raise ValueError('Payload bytes mismatch: '+name)
        if any(part in {'.env','private-failure.txt','isolated-test.json','lifecycle.lock','transactions','database','secrets','diagnostics','__pycache__'} for part in Path(name).parts):
            # PostgreSQL program files have postgresql, not database; no data
            # cluster or protected service-secret folder belongs in this tree.
            raise ValueError('Private evidence entered payload: '+name)
    return len(files)

def main(out,expanded):
    distribution=ET.parse(expanded/'Distribution').getroot()
    choices={x.attrib['id']:x for x in distribution.findall('choice')}
    assert choices['server'].attrib['start_selected']=='true'
    assert choices['server'].attrib['start_enabled']=='false'
    assert choices['client'].attrib['start_selected']=='false'
    result={}
    for name,appname in [('server','Josi Server.app'),('client','Josi CE.app')]:
        payload=expanded/(name+'.pkg')/'Payload'
        source=out/('payload' if name=='server' else 'client-payload')
        result[name+'FilesVerified']=compare(source,payload)
        info=plistlib.loads((payload/'Applications'/appname/'Contents/Info.plist').read_bytes())
        assert info.get('CFBundleIconFile') and (payload/'Applications'/appname/'Contents/Resources'/info['CFBundleIconFile']).is_file()
        for script in (out/(name+'-scripts')).iterdir():
            assert digest(script)==digest(expanded/(name+'.pkg')/'Scripts'/script.name)
    post=(expanded/'server.pkg/Scripts/postinstall').read_text()
    assert 'pkg-driver.py' in post and '--verify --deep --strict' in post and "'=anchor" in post
    assert 'installer' not in post.splitlines()[-1] # No recursive Installer invocation.
    result.update(serverOnlyChoice=True,serverPlusRealClientChoice=True,scriptsMatch=True,iconsPresent=True,noSystemInstall=True)
    print(json.dumps(result,indent=2))
if __name__=='__main__':main(Path(sys.argv[1]),Path(sys.argv[2]))
