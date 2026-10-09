"""Install only the exact offline wheel set into the privately built CPython."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
BASE=Path('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port')
REPO=Path(__file__).resolve().parents[2]
python=BASE/'prefix/python/bin/python3.11'
rows=json.loads((REPO/'packaging/macos/voice-inputs.lock.json').read_text())
env={'PATH':'/usr/bin:/bin','TMPDIR':str(BASE/'tmp'),'PYTHONPYCACHEPREFIX':str(BASE/'pycache'),'PIP_CONFIG_FILE':'/dev/null','PIP_DISABLE_PIP_VERSION_CHECK':'1'}
wheels=[]
for row in rows:
    p=BASE/('wheels' if row['kind']=='wheel' else 'sources')/row['filename']
    with p.open('rb') as f:
        if hashlib.file_digest(f,'sha256').hexdigest()!=row['sha256']:raise ValueError('Speech input pin mismatch')
    if row['kind']=='wheel':wheels.append(str(p))
subprocess.run([str(python),'-B','-m','pip','install','--no-index','--no-cache-dir','--no-deps','--no-compile',*wheels],env=env,check=True)
docopt=next(x for x in rows if x['name']=='docopt' and x['kind']=='source')
subprocess.run([str(python),'-B','-m','pip','install','--no-index','--no-cache-dir','--no-deps','--no-compile','--no-build-isolation',str(BASE/'sources'/docopt['filename'])],env=env,check=True)
subprocess.run([str(python),'-B',str(REPO/'services/voice-box/patch_whisper.py')],env=env,check=True)
subprocess.run([str(python),'-B','-m','pip','--no-cache-dir','check'],env=env,check=True)
