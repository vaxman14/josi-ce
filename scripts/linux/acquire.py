"""Download only hash-pinned Linux runtime, model and native-build inputs."""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request
import urllib.parse

REPO=Path(__file__).resolve().parents[2]
CACHE=Path('/home/roman/JosiDrive/Caches/codex-linux-native-20261010')

def fetch(url,target,expected,size=None):
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists():
        actual=hashlib.sha256(target.read_bytes()).hexdigest()
        if actual==expected and (size is None or target.stat().st_size==size):return
        raise ValueError('Cached input does not match its lock: '+target.name)
    temporary=target.with_suffix(target.suffix+'.partial')
    with urllib.request.urlopen(url,timeout=120) as response,temporary.open('xb') as output:
        while block:=response.read(1024*1024):output.write(block)
    if hashlib.sha256(temporary.read_bytes()).hexdigest()!=expected or (size is not None and temporary.stat().st_size!=size):
        raise ValueError('Downloaded input does not match its lock: '+target.name)
    temporary.rename(target)

def main():
    architecture={'x86_64':'x86_64','aarch64':'aarch64'}[__import__('platform').machine()]
    base=json.loads((REPO/'packaging/linux/build-inputs.lock.json').read_text())
    for name in ('node','python','caddy'):
        if architecture not in base[name]:
            if name=='python':continue
            raise ValueError('Architecture missing from lock: '+name)
        item=base[name][architecture]
        filename=Path(urllib.parse.urlparse(item['url']).path).name
        if name=='caddy':filename='caddy-'+('amd64' if architecture=='x86_64' else 'arm64')+'.tar.gz'
        fetch(item['url'],CACHE/filename,item['sha256'])
    item=base['postgresql'];fetch(item['url'],CACHE/Path(item['url']).name,item['sha256'])
    if architecture in base['openblas']:
        item=base['openblas'][architecture];fetch(item['url'],CACHE/Path(item['url']).name,item['sha256'])
    for item in json.loads((REPO/'services/voice-box/models.lock.json').read_text())['files']:
        fetch(item['url'],CACHE/'models'/item['path'].replace('/','__'),item['sha256'],item['size'])
    for item in json.loads((REPO/'services/voice-box/sources.lock.json').read_text())['files']:
        if item.get('kind')=='native-source':fetch(item['url'],CACHE/'native-sources'/item['path'],item['sha256'],item['size'])
    print(json.dumps({'architecture':architecture,'cache':str(CACHE)}))

if __name__=='__main__':main()
