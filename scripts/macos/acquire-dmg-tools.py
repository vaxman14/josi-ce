"""Acquire two pinned pure-Python build tools over system curl's verified TLS."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile

out=Path(sys.argv[1]);target=out/'build-tools';target.mkdir()
downloads=out/'build-tool-downloads';downloads.mkdir()
records=[]
pins=json.loads((Path(__file__).resolve().parents[2]/'packaging/macos/dmg-tools.lock.json').read_text())
for row in pins:
    name,version=row['name'],row['version']
    archive=downloads/(name+'-'+version+'.whl')
    subprocess.run(['/usr/bin/curl','--fail','--silent','--show-error','--location','--max-time','60',row['url'],'-o',str(archive)],check=True)
    with archive.open('rb') as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
    if actual!=row['sha256']:raise ValueError('Build-tool hash mismatch')
    with zipfile.ZipFile(archive) as wheel:
        for entry in wheel.infolist():
            p=Path(entry.filename)
            if p.is_absolute() or '..' in p.parts or entry.file_size>1024*1024:raise ValueError('Unsafe build-tool wheel')
        wheel.extractall(target)
    records.append({'name':name,'version':version,'sha256':actual,'url':row['url']})
(out/'build-tool-lock.json').write_text(json.dumps(records,indent=2)+'\n')
print(json.dumps({'buildOnly':True,'tools':records}),flush=True)
