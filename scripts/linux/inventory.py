"""Create the exact Linux payload inventory and record ELF dependencies."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys

import target

def digest(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def main(root):
    architecture=target.architecture()
    files=[];native=[]
    for path in sorted(root.rglob('*')):
        relative=path.relative_to(root).as_posix()
        if '__pycache__' in path.parts or path.suffix in ('.pyc','.pyo'):
            raise ValueError('Generated Python bytecode in payload: '+relative)
        if path.is_symlink():
            if not path.resolve().is_relative_to(root):raise ValueError('External payload link: '+relative)
            files.append({'path':relative,'link':os.readlink(path)});continue
        if path.is_dir():continue
        if not path.is_file() or path.stat().st_nlink!=1:raise ValueError('Special or hardlinked payload: '+relative)
        if re.search(r'(^|/)(?:docker|podman|\.env)(?:$|\.)|\.(?:dump|log|key)$',relative,re.I):raise ValueError('Prohibited payload entry: '+relative)
        with path.open('rb') as stream:magic=stream.read(4)
        if magic==b'\x7fELF':
            machine=subprocess.check_output(['readelf','-h',path],text=True)
            expected=target.name('elf')
            if 'Machine:' not in machine or expected not in machine:raise ValueError('Foreign ELF architecture: '+relative)
            dynamic=subprocess.run(['readelf','-d',path],capture_output=True,text=True,check=True).stdout
            needed=re.findall(r'\(NEEDED\).*?\[(.*?)\]',dynamic)
            native.append({'path':relative,'architecture':architecture,'needed':needed})
        elif magic[:2]==b'MZ':raise ValueError('Windows executable in Linux runtime: '+relative)
        files.append({'path':relative,'size':path.stat().st_size,'sha256':digest(path)})
    version=json.loads((root/'app/package.json').read_text())['version']
    inventory={'architecture':architecture,'version':version,'files':files}
    (root.parent/'inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
    (root.parent/'native-libraries.json').write_text(json.dumps(native,indent=2)+'\n')
    print(json.dumps({'files':len(files),'nativeFiles':len(native),'architecture':architecture}))
if __name__=='__main__':main(Path(sys.argv[1]).resolve())
