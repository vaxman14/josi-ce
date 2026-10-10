"""Fixed PKG entrypoint. Runs only on Roman's physical acceptance Mac.

The build inspects this file and exercises policy in disposable fixtures; it
never invokes this production entrypoint on the build Mac.
"""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parent))
from lifecycle import Lifecycle, PRODUCT, diagnostic, plain

LOGS=Path('/Library/Logs/Josi CE Server')
APP=Path('/Applications/Josi Server.app')
REQUIREMENT='=anchor apple generic and identifier "com.heyjosi.ce.server" and certificate leaf[subject.OU] = "LRH75YR6QW" and certificate leaf[subject.CN] = "Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)"'

def write_event(stream, value):
    stream.write(json.dumps(value,separators=(',',':'))+'\n');stream.flush();os.fsync(stream.fileno())

def run_install(instance, uid, event):
    event({'phase':'verifying'})
    try:instance.verify()
    except Exception as error:error.josi_operation='verification';raise
    try:
        transaction=instance.install(interactive_uid=uid,repair=True)
    except Exception:
        # Recover only an existing verified preactivation upgrade snapshot.
        # Lifecycle.recover refuses candidate writes and fresh provisioning.
        j=instance.journal
        if j and j.identity['from'] and not any(r['phase']=='activating' for r in j.records):
            try: instance.recover(j.folder);event({'previousVersionRestored':True})
            except Exception as recovery_error: event({'recovery':diagnostic(recovery_error)})
        raise
    event({'result':'success','phase':'committed','transaction':transaction.name})

def main():
    if sys.argv[1:]!=['install'] or os.getuid()!=0:raise PermissionError('Run through the Josi installer package')
    uid=os.stat('/dev/console').st_uid
    if uid<501:raise PermissionError('Sign in to your Mac before installing Josi')
    runtime=Path(__file__).resolve().parents[2]
    if runtime!=APP/'Contents/Resources/runtime':raise ValueError('Unexpected package location')
    plain(LOGS)
    LOGS.mkdir(mode=0o755,exist_ok=True)
    info=LOGS.stat()
    if info.st_uid!=0 or info.st_mode&0o022:raise PermissionError('Unprotected installer log folder')
    path=LOGS/('Install-'+str(uuid.uuid4())+'.jsonl')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    parent=os.open(LOGS,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(parent)
    finally:os.close(parent)
    with os.fdopen(fd,'w') as stream:
        event=lambda value:write_event(stream,{'time':time.time(),**value})
        event({'phase':'prepared','diagnosticPath':str(path),'pid':os.getpid()})
        # This opens only the status/folder/browser companion in the user's
        # session. The normal Installer remains the sole installation action.
        subprocess.run(['/bin/launchctl','asuser',str(uid),'/usr/bin/sudo','-H','-u','#'+str(uid),'/usr/bin/open',str(APP),'--args','--progress',str(path)],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict','-R',REQUIREMENT,str(APP)],check=True,capture_output=True)
            obj=Lifecycle(runtime,progress=lambda phase,service:event({'phase':phase,'service':service}))
            run_install(obj,uid,event)
        except Exception as error:
            event({'result':'failure','phase':'Stopped','operation':getattr(error,'josi_operation','installation'),**diagnostic(error)})
            print('Josi installation failed. Diagnostic log: '+str(path),flush=True)
            return 1
    print('Josi installation complete. Diagnostic log: '+str(path),flush=True)
    return 0

if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:
        print(json.dumps(diagnostic(error)),flush=True);sys.exit(1)
