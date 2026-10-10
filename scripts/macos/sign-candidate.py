"""Run only after Roman confirms logged-in Keychain/private-key approval.
Signs a new copy, never retries a failed signing operation, never notarizes.
"""
import datetime
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

IDENTITY='Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)'
RELEASE=Path('/Volumes/JosiOS/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009')
REPO=Path(__file__).resolve().parents[2]
def main():
    if len(sys.argv)!=3 or sys.argv[1]!='--roman-keychain-approved':raise ValueError('Roman must explicitly confirm Keychain approval before this command runs')
    source=Path(sys.argv[2]).resolve()
    if not source.is_relative_to(RELEASE) or source.name!='Josi CE Server Setup.app':raise ValueError('Unexpected acceptance artifact')
    source_archive=source.parent/'Josi-CE-Server-macos-arm64-corresponding-sources.zip'
    if not source_archive.is_file():raise ValueError('Missing corresponding-source companion archive')
    output=RELEASE/('socal-signed-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));output.mkdir()
    app=output/source.name;shutil.copytree(source,app,symlinks=True)
    env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','DEVELOPER_DIR':'/Applications/Xcode.app/Contents/Developer','TMPDIR':'/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp'}
    with (output/'signing.log').open('x') as log:
        def run(args,accepted=(0,)):
            result=subprocess.run(args,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            log.write('COMMAND '+repr(args)+'\n'+result.stdout+'\n');log.flush();os.fsync(log.fileno())
            if result.returncode not in accepted:
                print('Signing/check stopped without retry. Unlock the login Keychain in Roman’s logged-in Mac session and allow codesign to use the SOCAL private key. Evidence: '+str(output/'signing.log'))
                raise RuntimeError('Signing/check failed; see append-only evidence')
            return result
        natives=[]
        for p in app.rglob('*'):
            if not p.is_file() or p.is_symlink():continue
            with p.open('rb') as stream:magic=stream.read(4)
            if magic==b'\xcf\xfa\xed\xfe':natives.append(p)
        for index,p in enumerate(sorted(natives,key=lambda p:len(p.parts),reverse=True)):
            args=['/usr/bin/codesign','--force','--sign',IDENTITY,'--options','runtime','--timestamp']
            if p.name=='node':args+=['--entitlements',str(REPO/'packaging/macos/node-entitlements.plist')]
            args+=[str(p)];print(f'Signing {index+1}/{len(natives)}: {p.relative_to(app)}',flush=True);run(args)
        spec=importlib.util.spec_from_file_location('inventory',REPO/'scripts/macos/inventory.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        module.inventory(app/'Contents/Resources/runtime',False)
        run(['/usr/bin/codesign','--force','--sign',IDENTITY,'--options','runtime','--timestamp',str(app)])
        run(['/usr/bin/codesign','--verify','--deep','--strict','--verbose=4',str(app)])
        for p in [app,*natives]:
            result=run(['/usr/bin/codesign','-d','--verbose=4',str(p)])
            if 'Authority='+IDENTITY not in result.stdout or 'TeamIdentifier=LRH75YR6QW' not in result.stdout or 'Timestamp=' not in result.stdout or '(runtime)' not in result.stdout:raise ValueError('Wrong identity, team, hardened runtime or timestamp')
        # A non-notarized app may be rejected. Record the exact verdict; never
        # convert it to an acceptance claim or submit to Apple automatically.
        run(['/usr/sbin/spctl','--assess','--type','execute','--verbose=4',str(app)],accepted=(0,1,3))
        archive=output/'Josi-CE-Server-macos-arm64-SOCAL.zip'
        run(['/usr/bin/ditto','-c','-k','--sequesterRsrc','--keepParent',str(app),str(archive)])
        source_copy=output/source_archive.name;shutil.copy2(source_archive,source_copy)
        with archive.open('rb') as stream:app_digest=hashlib.file_digest(stream,'sha256').hexdigest()
        with source_copy.open('rb') as stream:source_digest=hashlib.file_digest(stream,'sha256').hexdigest()
        (output/'SHA256SUMS.txt').write_text(app_digest+'  '+archive.name+'\n'+source_digest+'  '+source_copy.name+'\n')
        print(output)
if __name__=='__main__':main()
