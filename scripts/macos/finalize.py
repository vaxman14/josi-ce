"""Create the unsigned acceptance artifact from a clean local commit.
No install, launchd, account, codesign, Keychain, notarization or publication call.
"""
import hashlib
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import zipfile

REPO=Path(__file__).resolve().parents[2]
BASE=Path('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port')
RELEASE=Path('/Volumes/JosiOS/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009')
OUT=RELEASE/('unsigned-acceptance-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
ENV={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','DEVELOPER_DIR':'/Applications/Xcode.app/Contents/Developer','TMPDIR':str(BASE/'tmp')}

def digest(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def inspect_archive(archive,app):
    seen=set();total=0
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            parts=Path(info.filename).parts
            if not parts or parts[0]!=app.name or '..' in parts or info.filename.startswith('/'):raise ValueError('Archive traversal')
            if info.is_dir():continue
            name=Path(*parts[1:]).as_posix()
            if name in seen:raise ValueError('Duplicate archive file')
            seen.add(name);p=app/name
            if not p.resolve().is_relative_to(app):raise ValueError('Archive link escapes app')
            if any(part in ('__pycache__','.env','isolated-test.json','private-failure.txt','lifecycle.lock') for part in parts) or name.endswith(('.p12','.mobileprovision','.log')):raise ValueError('Private/build evidence entered installer')
            with z.open(info) as stream:
                if p.is_symlink():
                    if not stat.S_ISLNK(info.external_attr>>16) or stream.read().decode()!=os.readlink(p):raise ValueError('Archive link mismatch')
                elif hashlib.file_digest(stream,'sha256').hexdigest()!=digest(p):raise ValueError('Archive bytes mismatch')
            total+=info.file_size
    actual={p.relative_to(app).as_posix() for p in app.rglob('*') if p.is_file() or p.is_symlink()}
    if seen!=actual:raise ValueError('Incomplete archive')
    return {'files':len(seen),'uncompressedBytes':total,'allArchiveBytesVerified':True,'privateEvidenceBundled':False}

def inspect_tree_archive(archive,root):
    seen=set();total=0
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            parts=Path(info.filename).parts
            if not parts or parts[0]!=root.name or '..' in parts or info.filename.startswith('/'):raise ValueError('Source archive traversal')
            if info.is_dir():continue
            name=Path(*parts[1:]).as_posix()
            if name in seen:raise ValueError('Duplicate source archive file')
            seen.add(name);p=root/name
            if not p.resolve().is_relative_to(root) or p.is_symlink():raise ValueError('Unsafe source archive entry')
            with z.open(info) as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest()!=digest(p):raise ValueError('Source archive bytes mismatch')
            total+=info.file_size
    actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if seen!=actual:raise ValueError('Incomplete source archive')
    return {'files':len(seen),'uncompressedBytes':total,'allArchiveBytesVerified':True}

def main():
    subprocess.run(['/usr/bin/git','diff','--exit-code','--quiet'],cwd=REPO,check=True)
    subprocess.run(['/usr/bin/git','diff','--cached','--exit-code','--quiet'],cwd=REPO,check=True)
    if subprocess.check_output(['/usr/bin/git','ls-files','--others','--exclude-standard'],cwd=REPO):raise ValueError('Commit all intended source before final packaging')
    commit=subprocess.check_output(['/usr/bin/git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
    runtime=BASE/'stage/runtime'
    sources=BASE/'stage/corresponding-sources'
    subprocess.run([str(BASE/'prefix/python/bin/python3.11'),'-B',str(REPO/'scripts/macos/stage.py'),'--code-only'],cwd=REPO,env=ENV,check=True)
    if not sources.is_dir() or not (sources/'sources').is_dir():raise ValueError('Corresponding source staging is missing')
    subprocess.run(['/usr/bin/git','archive','--format=tar.gz','--prefix=josi-ce-source/','-o',str(sources/'sources/josi-ce-source.tar.gz'),commit],cwd=REPO,check=True)
    (runtime/'licenses/build.json').write_text(json.dumps({'sourceCommit':commit,'architecture':'arm64','minimumMacOS':'14.0','scannerBundled':False,'signing':'deferred pending Roman Keychain approval'},indent=2)+'\n')
    spec=importlib.util.spec_from_file_location('inventory',REPO/'scripts/macos/inventory.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.inventory(runtime)
    with (BASE/(OUT.name+'-build.log')).open('x') as log:
        subprocess.run(['/bin/bash',str(REPO/'scripts/macos/build-app.sh')],cwd=REPO,env=ENV,stdout=log,stderr=subprocess.STDOUT,check=True)
    OUT.mkdir()
    app=OUT/'Josi CE Server Setup.app'
    shutil.copytree(BASE/app.name,app,symlinks=True)
    (OUT/'SOURCE-COMMIT.txt').write_text(commit+'\n')
    shutil.copyfile(BASE/'stage/native-libraries.json',OUT/'native-libraries.json')
    shutil.copyfile(REPO/'packaging/macos/TEST-ME.txt',OUT/'TEST-ME.txt')
    evidence=OUT/'evidence';evidence.mkdir(mode=0o700)
    def record(name,args,accepted=(0,)):
        with (evidence/name).open('x') as log:
            result=subprocess.run([str(x) for x in args],env=ENV,stdout=log,stderr=subprocess.STDOUT)
        with (evidence/'command-results.jsonl').open('a') as log:log.write(json.dumps({'evidence':name,'exitCode':result.returncode,'command':[str(x) for x in args]})+'\n')
        if result.returncode not in accepted:raise RuntimeError('Final inspection failed: '+name)
    packaged=app/'Contents/Resources/runtime'
    record('packaged-verification.log',[packaged/'python/bin/python3.11','-I','-B',packaged/'app/native/lifecycle.py','verify'])
    record('service-status.json',[app/'Contents/MacOS/josi-native-status'],(1,))
    record('gatekeeper-unsigned.log',['/usr/sbin/spctl','--assess','--type','execute','--verbose=4',app],(0,1,3))
    record('notary-tool-version.log',['/usr/bin/xcrun','notarytool','--version'])
    record('stapler-unsigned.log',['/usr/bin/xcrun','stapler','validate',app],(0,65,66))
    archive=OUT/'Josi-CE-Server-macos-arm64-unsigned.zip'
    record('archive-build.log',['/usr/bin/ditto','--norsrc','--noextattr','-c','-k','--keepParent',app,archive])
    report=inspect_archive(archive,app)
    source_archive=OUT/'Josi-CE-Server-macos-arm64-corresponding-sources.zip'
    record('source-archive-build.log',['/usr/bin/ditto','--norsrc','--noextattr','-c','-k','--keepParent',sources,source_archive])
    source_report=inspect_tree_archive(source_archive,sources)
    report.update({'sourceCommit':commit,'architecture':'arm64','nativeRuntimeFiles':241,'SOCALSigned':False,'notarized':False,'correspondingSources':source_report,'malwareEngineScan':False,'malwareInspection':'source/manifest/archive and native platform preflight; no clean-engine verdict claimed'})
    (evidence/'archive-inspection.json').write_text(json.dumps(report,indent=2)+'\n')
    (OUT/'SHA256SUMS.txt').write_text(digest(archive)+'  '+archive.name+'\n'+digest(source_archive)+'  '+source_archive.name+'\n'+digest(packaged.parent/'inventory.json')+'  Josi CE Server Setup.app/Contents/Resources/inventory.json\n')
    # Retain build/test/audit output outside the installer, with no overwrites.
    logs=evidence/'build-tests';logs.mkdir(mode=0o700)
    for p in BASE.iterdir():
        if p.is_file() and (p.suffix=='.log' or p.name in ('npm-audit-1.json','npm-sbom.cdx.json','service-status-1.json')):shutil.copyfile(p,logs/p.name)
    print(json.dumps({'app':str(app),'archive':str(archive),'correspondingSources':str(source_archive),'checksums':str(OUT/'SHA256SUMS.txt'),'sourceCommit':commit,'archiveInspection':report},indent=2),flush=True)

if __name__=='__main__':main()
