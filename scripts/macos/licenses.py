"""Preserve original notices and corresponding sources; emit a combined SBOM."""
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import subprocess
import zipfile

REPO=Path(__file__).resolve().parents[2]
BASE=Path('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port')
RUNTIME=BASE/'stage/runtime'
LICENSES=RUNTIME/'licenses';SOURCES=RUNTIME/'sources'
def copy(src,dst):
    dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
def verified(src,expected):
    with src.open('rb') as f:
        if hashlib.file_digest(f,'sha256').hexdigest()!=expected:raise ValueError('Unverified source '+str(src))
def main():
    LICENSES.mkdir(exist_ok=True);SOURCES.mkdir(exist_ok=True)
    for name in ('LICENSE','NOTICE','TRADEMARK.md'):copy(REPO/name,RUNTIME/name)
    copy(BASE/'src/postgresql-16.15/COPYRIGHT',RUNTIME/'postgresql/COPYRIGHT')
    copy(BASE/'source-closure/native/go-notice-1.26.8.txt',LICENSES/'Go-LICENSE.txt')
    for p in (REPO/'packaging/macos').glob('*lock.json'):copy(p,LICENSES/p.name)
    copy(REPO/'package-lock.json',LICENSES/'npm-package-lock.json')
    copy(REPO/'services/voice-box/models.lock.json',LICENSES/'models.lock.json')
    voice=json.loads((REPO/'packaging/macos/voice-inputs.lock.json').read_text())
    for row in voice:
        src=BASE/('wheels' if row['kind']=='wheel' else 'sources')/row['filename'];verified(src,row['sha256'])
        if row['kind']=='source':copy(src,SOURCES/'python'/row['filename'])
    rows=json.loads((REPO/'services/voice-box/sources.lock.json').read_text())['files']
    rows=[r for r in rows if not r['path'].startswith('debian/')]+json.loads((REPO/'packaging/macos/extra-sources.lock.json').read_text())
    for row in rows:
        src=BASE/'source-closure'/row['path'];verified(src,row['sha256']);copy(src,SOURCES/'closure'/row['path'])
    (LICENSES/'source-closure.lock.json').write_text(json.dumps(rows,indent=2)+'\n')
    go=json.loads((REPO/'packaging/macos/caddy-sources.lock.json').read_text())
    for row in go:
        src=BASE/'caddy-sources'/row['filename'];verified(src,row['sha256']);copy(src,SOURCES/'caddy'/row['filename'])
    for name,expected in [('Python-3.11.15.tar.xz','272179ddd9a2e41a0fc8e42e33dfbdca0b3711aa5abf372d3f2d51543d09b625'),('postgresql-16.15.tar.bz2','c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed')]:
        src=Path('/Volumes/JosiOS/JosiDrive/Caches/codex-macos-native-20261009')/name;verified(src,expected);copy(src,SOURCES/'base'/name)
    notices=[]
    def notice(name,data):
        if not data or len(data)>4*1024*1024:return
        notices.append('\n===== '+name+' =====\n'+data.decode('utf8',errors='replace'))
    for folder in (RUNTIME/'app/node_modules',RUNTIME/'python/lib/python3.11/site-packages',RUNTIME/'node',RUNTIME/'caddy',RUNTIME/'postgresql'):
        for p in folder.rglob('*'):
            if p.is_file() and not p.is_symlink() and p.name.upper().startswith(('LICENSE','LICENCE','COPYING','COPYRIGHT','NOTICE','THIRD_PARTY')):notice(p.relative_to(RUNTIME).as_posix(),p.read_bytes())
    for p in SOURCES.rglob('*'):
        if p.suffix=='.zip':
            with zipfile.ZipFile(p) as archive:
                for info in archive.infolist():
                    if Path(info.filename).name.upper().startswith(('LICENSE','COPYING','NOTICE')) and info.file_size<4*1024*1024:notice(p.name+':'+info.filename,archive.read(info))
        elif p.name.endswith('.tar.xz'):
            # The offline interpreter intentionally has no external liblzma.
            # Apple's bundled bsdtar can inspect this source format natively.
            names=subprocess.check_output(['/usr/bin/tar','-tf',str(p)],text=True).splitlines()
            for name in names:
                if Path(name).name.upper().startswith(('LICENSE','LICENCE','COPYING','NOTICE')) and not name.endswith('/'):
                    notice(p.name+':'+name,subprocess.check_output(['/usr/bin/tar','-xOf',str(p),name]))
        elif p.name.endswith(('.tar.gz','.tar.bz2','.crate')):
            with tarfile.open(p) as archive:
                for info in archive:
                    if info.isfile() and Path(info.name).name.upper().startswith(('LICENSE','LICENCE','COPYING','NOTICE','THIRD_PARTY')) and info.size<4*1024*1024:notice(p.name+':'+info.name,archive.extractfile(info).read())
    (LICENSES/'THIRD_PARTY_NOTICES.txt').write_text('Josi CE native macOS distribution — original dependency notices.\n'+''.join(notices))
    bom=json.loads((BASE/'npm-sbom.cdx.json').read_text())
    for row in voice:
        if row['kind']!='wheel' and row['name']!='docopt':continue
        bom['components'].append({'type':'library','name':row['name'],'version':row['version'],'purl':f"pkg:pypi/{row['name']}@{row['version']}",'hashes':[{'alg':'SHA-256','content':row['sha256']}],'properties':[{'name':'josi:input-artifact','value':row['filename']}]})
    for row in go:
        bom['components'].append({'type':'library','name':row['name'],'version':row['version'],'hashes':[{'alg':'SHA-256','content':row['sha256']}]})
    for name,version in [('Node.js','24.15.0'),('PostgreSQL','16.15'),('CPython','3.11.15'),('Caddy','2.11.7')]:bom['components'].append({'type':'application','name':name,'version':version})
    for row in json.loads((REPO/'services/voice-box/models.lock.json').read_text())['files']:
        bom['components'].append({'type':'data','name':row['path'],'version':row['sha256'][:12],'hashes':[{'alg':'SHA-256','content':row['sha256']}],'licenses':[{'license':{'id':row['license']}}]})
    (LICENSES/'runtime.cdx.json').write_text(json.dumps(bom,indent=2)+'\n')
    print(json.dumps({'noticeSections':len(notices),'sbomComponents':len(bom['components']),'correspondingSourceArchives':sum(p.is_file() for p in SOURCES.rglob('*'))}),flush=True)
if __name__=='__main__':main()
