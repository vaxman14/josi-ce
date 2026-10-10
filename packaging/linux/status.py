#!/usr/bin/env python3
"""Read-only native Linux service status. A PID alone is not health."""
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path('/var/lib/josi-ce-server');ROLES=('database','voice','voice-control','web','worker','proxy')
def main():
    config=json.loads((ROOT/'data/config/runtime.json').read_text())
    result=[];failed=False
    for role in ROLES:
        unit='josi-ce-'+role+'.service'
        show=subprocess.run(['/usr/bin/systemctl','show',unit,'--property=LoadState,ActiveState,SubState,MainPID,UnitFileState','--value'],capture_output=True,text=True,timeout=10)
        values=show.stdout.splitlines();running=show.returncode==0 and len(values)==5 and values[1]=='active' and values[2]=='running' and values[3].isdigit() and int(values[3])>0
        result.append({'service':role,'running':running,'pid':int(values[3]) if running else None,'enabled':len(values)==5 and values[4]=='enabled'})
        failed|=not running
    print(json.dumps({'version':config['version'],'services':result,'health':'not-verified'}))
    return 1 if failed else 0
if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:print(json.dumps({'error':type(error).__name__,'health':'inspection-failed'}));raise SystemExit(2)
