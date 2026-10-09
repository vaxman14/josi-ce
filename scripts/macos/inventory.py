"""Offline payload inspection: architecture, library closure and exact bytes."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import struct
import sys

def digest(p):
    with p.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def inventory(root,inspect_native=True):
    files=[];native=[]
    for p in sorted(root.rglob('*')):
        rel=p.relative_to(root).as_posix()
        if p.is_symlink():
            if not p.resolve().is_relative_to(root):raise ValueError('External link: '+rel)
            files.append({'path':rel,'link':os.readlink(p)});continue
        if p.is_dir():continue
        if not p.is_file() or p.stat().st_nlink!=1:raise ValueError('Special or hardlinked file: '+rel)
        public_ca=rel=='python/lib/python3.11/site-packages/certifi/cacert.pem'
        if not public_ca and re.search(r'(^|/)(?:clamd|clamscan|freshclam|docker|\.env)(?:$|\.)|\.(?:cvd|cld|dump|log|pem|key)$',rel,re.I):raise ValueError('Prohibited payload entry: '+rel)
        with p.open('rb') as stream:magic=stream.read(4)
        if magic[:2]==b'MZ' or magic==b'\x7fELF':raise ValueError('Foreign executable in runtime: '+rel)
        if inspect_native and magic in (b'\xcf\xfa\xed\xfe',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca',b'\xfe\xed\xfa\xcf'):
            arch=subprocess.check_output(['/usr/bin/lipo','-archs',str(p)],text=True).strip().split()
            if 'arm64' not in arch:raise ValueError('Foreign architecture: '+rel)
            if arch!=['arm64']:
                temp=p.with_name(p.name+'.arm64');mode=p.stat().st_mode
                subprocess.run(['/usr/bin/lipo',str(p),'-thin','arm64','-output',str(temp)],check=True)
                temp.chmod(mode);os.replace(temp,p)
            with p.open('rb') as stream:
                header=stream.read(32);count,size=struct.unpack_from('<II',header,16)
                if size>1024*1024:raise ValueError('Unbounded Mach-O load commands')
                commands=stream.read(size)
            offset=0;rpaths=[];minimum=None
            for _ in range(count):
                command,length=struct.unpack_from('<II',commands,offset)
                if length<8 or offset+length>len(commands):raise ValueError('Invalid Mach-O load command')
                if command==0x8000001c:
                    index=struct.unpack_from('<I',commands,offset+8)[0]
                    path=commands[offset+index:offset+length].split(b'\0')[0].decode()
                    if not path.startswith(('@loader_path','@executable_path')):raise ValueError('External runtime search path: '+rel)
                    rpaths.append(path)
                if command==0x32:minimum=struct.unpack_from('<I',commands,offset+12)[0]
                elif command==0x24:minimum=struct.unpack_from('<I',commands,offset+8)[0]
                offset+=length
            if minimum and minimum>0x000e0000:raise ValueError('Runtime requires newer macOS than 14: '+rel)
            ids=subprocess.check_output(['/usr/bin/otool','-D',str(p)],text=True).splitlines()[1:]
            libs=[line.strip().split(' (')[0] for line in subprocess.check_output(['/usr/bin/otool','-L',str(p)],text=True).splitlines()[1:]]
            for lib in libs:
                if lib in ids:continue
                if not lib.startswith(('/usr/lib/','/System/Library/','@rpath/','@loader_path/','@executable_path/')):raise ValueError('External library: '+rel+' -> '+lib)
                if lib.startswith('@loader_path/') and not (p.parent/lib[len('@loader_path/'):]).resolve().is_relative_to(root):raise ValueError('Escaping loader path')
            native.append({'path':rel,'architecture':'arm64','libraries':libs,'rpaths':rpaths,'minimumOSPacked':minimum})
        files.append({'path':rel,'size':p.stat().st_size,'sha256':digest(p)})
    version=json.loads((root/'app/package.json').read_text())['version']
    result={'architecture':'arm64','minimumMacOS':'14.0','version':version,'files':files}
    (root.parent/'inventory.json').write_text(json.dumps(result,indent=2)+'\n')
    if inspect_native:(root.parent/'native-libraries.json').write_text(json.dumps(native,indent=2)+'\n')
    print(json.dumps({'files':len(files),'nativeArm64Files':len(native),'externalLibraries':False,'scannerBundled':False}),flush=True)

if __name__=='__main__':inventory(Path(sys.argv[1]).resolve(),'--hash-only' not in sys.argv[2:])
