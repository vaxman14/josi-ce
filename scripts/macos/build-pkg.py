"""New, exclusive PKG/DMG staging. No install, notarization or publication.

prepare creates a reviewable unsigned product. sign finishes that same new
directory after Roman authorizes Keychain use. Stop at the first signing error.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import zipfile

REPO=Path(__file__).resolve().parents[2]
BASE=Path('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port')
RELEASE=Path('/Volumes/JosiOS/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009')
PREVIOUS=RELEASE/'socal-signed-20261010T021606Z/Josi CE Server Setup.app'
CLIENT_ROOT=Path('/Volumes/JosiOS/JosiDrive/Projects/worktrees/josi-desktop-macos-0.6.5-e1d28de')
CLIENT=CLIENT_ROOT/'release-public-20261001-2321/mac-arm64/Josi CE.app'
APP_IDENTITY='Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)'
PKG_IDENTITY='Developer ID Installer: Socal Receptionist LLC (LRH75YR6QW)'
KEYCHAIN='/Users/roman/Library/Keychains/login.keychain-db'
VERSION='0.1.78-macos.3'
SDK='/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'
SWIFTC='/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'
ENV={**os.environ,'DEVELOPER_DIR':'/Applications/Xcode.app/Contents/Developer','TMPDIR':str(BASE/'tmp'),'CLANG_MODULE_CACHE_PATH':str(BASE/'clang-cache'),'npm_config_cache':'/Volumes/JosiOS/JosiDrive/Caches/codex-macos-native-20261009/npm'}

def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def runner(out):
    def run(name,args,accepted=(0,),cwd=REPO):
        print('Checking/building '+name,flush=True)
        path=out/'evidence'/name
        with path.open('x') as log:
            result=subprocess.run([str(x) for x in args],cwd=cwd,env=ENV,stdout=log,stderr=subprocess.STDOUT)
        with (out/'evidence/commands.jsonl').open('a') as f:
            f.write(json.dumps({'command':[str(x) for x in args],'log':name,'exitCode':result.returncode})+'\n')
        if result.returncode not in accepted:raise RuntimeError('Stopped at '+str(path))
        return path.read_text(errors='replace')
    return run

def compile(run,out,name,sources):
    run(name+'.compile.log',[SWIFTC,'-parse-as-library','-target','arm64-apple-macos14.0','-sdk',SDK,'-module-cache-path',BASE/'swift-cache',*[REPO/'packaging/macos'/s for s in sources],'-o',out/name])

def component_plan(out,name):
    path=out/(name+'-component.plist')
    if not path.exists():
        path.write_bytes(plistlib.dumps([{'RootRelativeBundlePath':'Applications/'+('Josi Server.app' if name=='server' else 'Josi CE.app'),'BundleIsRelocatable':False,'BundleIsVersionChecked':False,'BundleHasStrictIdentifier':True,'BundleOverwriteAction':'upgrade'}]))
    return path

def distribution():
    return '''<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
 <title>Josi Server</title>
 <options customize="always" require-scripts="false" hostArchitectures="arm64" rootVolumeOnly="true"/>
 <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
 <allowed-os-versions><os-version min="14.0"/></allowed-os-versions>
 <welcome file="welcome.html" mime-type="text/html"/>
 <license file="license.txt"/>
 <conclusion file="conclusion.html" mime-type="text/html"/>
 <background file="Josi.png" alignment="bottomleft" scaling="proportional"/>
 <choices-outline><line choice="server"/><line choice="client"/></choices-outline>
 <choice id="server" title="Josi Server" description="Required. Installs the local server and Josi Server management app. Your existing server data is retained." start_selected="true" start_enabled="false"><pkg-ref id="com.heyjosi.ce.server.pkg"/></choice>
 <choice id="client" title="Desktop Client (optional)" description="Adds the real Josi CE desktop app. It can be removed separately. Leave unchecked if you already have this client." start_selected="false"><pkg-ref id="com.heyjosi.ce.desktop.pkg"/></choice>
 <pkg-ref id="com.heyjosi.ce.server.pkg" version="0.1.78.3" onConclusion="none">server.pkg</pkg-ref>
 <pkg-ref id="com.heyjosi.ce.desktop.pkg" version="0.6.5" onConclusion="none">client.pkg</pkg-ref>
</installer-gui-script>
'''

def prepare(out):
    out.mkdir();(out/'evidence').mkdir(mode=0o700)
    run=runner(out)
    run('baseline-app-signature.log',['/usr/bin/codesign','--verify','--deep','--strict','-R','=anchor apple generic and certificate leaf[subject.OU] = "LRH75YR6QW" and certificate leaf[subject.CN] = "'+APP_IDENTITY+'"',PREVIOUS])
    run('baseline-client-signature.log',['/usr/bin/codesign','--verify','--deep','--strict','-R','=anchor apple generic and certificate leaf[subject.OU] = "LRH75YR6QW" and certificate leaf[subject.CN] = "'+APP_IDENTITY+'"',CLIENT])
    app=out/'payload/Applications/Josi Server.app';resources=app/'Contents/Resources';resources.mkdir(parents=True)
    shutil.copytree(PREVIOUS/'Contents/Resources/runtime',resources/'runtime',symlinks=True)
    runtime=resources/'runtime'
    for p in REPO.glob('packages/*/dist'):
        destination=runtime/'app'/p.relative_to(REPO)
        if destination.exists():shutil.rmtree(destination)
        shutil.copytree(p,destination)
    for p in REPO.glob('apps/*/dist'):
        destination=runtime/'app'/p.relative_to(REPO)
        if destination.exists():shutil.rmtree(destination)
        shutil.copytree(p,destination)
    for name in ['lifecycle.py','maintenance.py','pkg-driver.py','Runtime.mjs']:
        shutil.copyfile(REPO/'packaging/macos'/name,runtime/'app/native'/name)
    meta=json.loads((runtime/'app/package.json').read_text());meta['version']=VERSION
    (runtime/'app/package.json').write_text(json.dumps(meta,indent=2)+'\n')
    shutil.copyfile(REPO/'packaging/macos/Josi.png',resources/'Josi.png')
    icons=out/'Josi.iconset';icons.mkdir()
    for size in [16,32,128,256,512]:
        for scale in [1,2]:
            name=f'icon_{size}x{size}'+('@2x' if scale==2 else '')+'.png'
            run('icon-'+name+'.log',['/usr/bin/sips','-z',size*scale,size*scale,resources/'Josi.png','--out',icons/name])
    run('iconutil.log',['/usr/bin/iconutil','-c','icns',icons,'-o',resources/'Josi.icns'])
    macos=app/'Contents/MacOS';macos.mkdir()
    compile(run,out,'JosiServer',['ServerApp.swift','InstallerState.swift','DiagnosticLog.swift','ProgressState.swift','BrowserHandoff.swift'])
    shutil.copyfile(out/'JosiServer',macos/'JosiServer');(macos/'JosiServer').chmod(0o755)
    plist={'CFBundleIdentifier':'com.heyjosi.ce.server','CFBundleName':'Josi Server','CFBundleDisplayName':'Josi Server','CFBundleExecutable':'JosiServer','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.1.78','CFBundleVersion':'20261010.3','CFBundleIconFile':'Josi.icns','LSMinimumSystemVersion':'14.0','NSHighResolutionCapable':True,'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True},'NSHumanReadableCopyright':'Copyright SOCAL RECEPTIONIST LLC. AGPL-3.0-or-later; bundled notices and corresponding sources apply.'}
    (app/'Contents/Info.plist').write_bytes(plistlib.dumps(plist))
    for executable,sources in [('state-tests',['InstallerState.swift','InstallerStateTests.swift']),('diagnostic-tests',['DiagnosticLog.swift','DiagnosticTests.swift']),('progress-tests',['ProgressState.swift','ProgressTests.swift'])]:
        compile(run,out,executable,sources)
        run(executable+'.log',[out/executable,*([out] if executable=='diagnostic-tests' else [])])
    compile(run,out,'brand-resources',['BrandResources.swift'])
    run('brand.log',[out/'brand-resources',resources/'Josi.png',out/'background.png'])
    run('background-pixels.log',['/usr/bin/sips','-z',440,720,out/'background.png'])
    run('dmg-build-tools.log',[BASE/'prefix/python/bin/python3.11','-I','-B',REPO/'scripts/macos/acquire-dmg-tools.py',out])
    # The client is reused unchanged, with its original signature and identity.
    client=out/'client-payload/Applications/Josi CE.app'
    shutil.copytree(CLIENT,client,symlinks=True)
    legal=out/'client-legal';legal.mkdir()
    electron_archive=Path('/Users/roman/Library/Caches/electron/9c4e224684594fb9a8cbda18d3e2b7bf0c3c023d1462402a4031f8b4cc25e621/electron-v43.2.0-darwin-arm64.zip')
    expected=json.loads((CLIENT_ROOT/'node_modules/electron/checksums.json').read_text())['electron-v43.2.0-darwin-arm64.zip']
    if digest(electron_archive)!=expected:raise ValueError('Cached Electron archive does not match its pinned package checksum')
    # Read the existing cache only; all new dependency copies/evidence stay on JosiDrive.
    with zipfile.ZipFile(electron_archive) as archive:
        for name in ['LICENSE','LICENSES.chromium.html']:
            (legal/name).write_bytes(archive.read(name))
    node=BASE.parent.parent/'node-v24.15.0-darwin-arm64'
    run('client-sbom.log',[node/'bin/node',node/'lib/node_modules/npm/bin/npm-cli.js','sbom','--omit=dev','--sbom-format','cyclonedx'],cwd=CLIENT_ROOT)
    sbom=json.loads((out/'evidence/client-sbom.log').read_text())
    if sbom.get('bomFormat')!='CycloneDX':raise ValueError('Client SBOM generation failed')
    shutil.copyfile(out/'evidence/client-sbom.log',legal/'desktop-sbom.cdx.json')
    lock=json.loads((CLIENT_ROOT/'package-lock.json').read_text())
    notices=[]
    for location,entry in lock['packages'].items():
        if not location or entry.get('dev'):continue
        folder=CLIENT_ROOT/location
        for text in sorted(folder.glob('*')):
            if text.is_file() and text.name.lower().startswith(('license','copying','notice','copyright')):
                notices.append('\n\n=== '+location+'/'+text.name+' ===\n'+text.read_text(errors='replace'))
    (legal/'Josi-Desktop-Notices.txt').write_text('Josi CE desktop client 0.6.5 — original dependency notices\n'+''.join(notices))
    (legal/'provenance.json').write_text(json.dumps({'desktopVersion':'0.6.5','asarSha256':digest(client/'Contents/Resources/app.asar'),'electron':'43.2.0','electronArchiveSha256':expected,'notices':len(notices)},indent=2)+'\n')
    run('client-corresponding-source.log',[BASE/'prefix/python/bin/python3.11','-I','-B',REPO/'scripts/macos/acquire-client-sources.py',out])
    closure=json.loads((out/'client-source-closure/source-lock.json').read_text())
    for name,version,license_name in [('electron','43.2.0','MIT'),('chromium',closure['chromium'],'BSD-3-Clause'),('ffmpeg',closure['ffmpegRevision'],'LGPL-2.1-or-later')]:
        sbom['components'].append({'type':'library','name':name,'version':version,'bom-ref':'desktop-engine-'+name,'licenses':[{'license':{'id':license_name}}]})
    (legal/'desktop-sbom.cdx.json').write_text(json.dumps(sbom,indent=2)+'\n')
    scripts=out/'server-scripts';scripts.mkdir()
    for name in ['preinstall','postinstall']:
        shutil.copyfile(REPO/'packaging/macos/pkg'/name,scripts/name);(scripts/name).chmod(0o755)
    scripts=out/'client-scripts';scripts.mkdir()
    shutil.copyfile(REPO/'packaging/macos/pkg/client-preinstall',scripts/'preinstall');(scripts/'preinstall').chmod(0o755)
    resources_pkg=out/'package-resources';resources_pkg.mkdir()
    shutil.copyfile(REPO/'LICENSE',resources_pkg/'license.txt');shutil.copyfile(resources/'Josi.png',resources_pkg/'Josi.png')
    style='<style>body{font:14px -apple-system;line-height:1.5;color:#0b192b}h1{font-size:25px}</style>'
    (resources_pkg/'welcome.html').write_text(style+'<h1>Welcome to Josi Server</h1><p>Your private server runs on this Mac. Choose Server only, or add the optional desktop client in Customize.</p><p>Requires Apple Silicon, macOS 14 or later, and at least 6 GB free space on the startup disk. Files go in Applications and Library/Application Support/Josi CE Server.</p><p>Installation may take several minutes. Installer will request administrator authorization to add local background services. Files are checked automatically; existing Josi data is retained.</p><p>A Josi progress window shows the current task and elapsed time. After installation, choose a local folder as /workspace or decline access, then open the browser setup page. Folder access is read only. Protected folders may be unavailable.</p><p>Document indexing requires a separately configured supported scanner. This installer keeps that protection enabled.</p>')
    (resources_pkg/'conclusion.html').write_text(style+'<h1>Finish setting up Josi</h1><p>Use the Josi Server window, or open <a href="file:///Applications/Josi%20Server.app">Josi Server in Applications</a>. Choose a workspace folder or decline access, then click Open Josi in Browser.</p><p>The optional Josi CE desktop client is separate. Connect it to http://localhost:8080 after owner setup.</p><p>To uninstall the server, open Josi Server and choose Uninstall Server. Your data and recovery copies are kept. Remove the desktop client separately by moving Josi CE.app to Trash.</p><p>For failures, use Copy Diagnostics. Installer logs are in /Library/Logs/Josi CE Server. See TEST-ME for physical acceptance.</p>')
    (out/'Distribution.xml').write_text(distribution())
    spec=importlib.util.spec_from_file_location('inventory',REPO/'scripts/macos/inventory.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    m.inventory(runtime)
    run('unsigned-runtime-integrity.log',[runtime/'python/bin/python3.11','-I','-B',runtime/'app/native/lifecycle.py','verify'])
    packages=out/'unsigned-packages';packages.mkdir()
    for name,identifier,version in [('server','com.heyjosi.ce.server.pkg','0.1.78.3'),('client','com.heyjosi.ce.desktop.pkg','0.6.5')]:
        root=out/('payload' if name=='server' else 'client-payload')
        run('unsigned-'+name+'-pkg.log',['/usr/bin/pkgbuild','--root',root,'--component-plist',component_plan(out,name),'--install-location','/','--ownership','recommended','--identifier',identifier,'--version',version,'--scripts',out/(name+'-scripts'),packages/(name+'.pkg')])
    run('unsigned-productbuild.log',['/usr/bin/productbuild','--distribution',out/'Distribution.xml','--resources',out/'package-resources','--package-path',packages,out/'Install Josi-unsigned.pkg'])
    run('unsigned-package-expand.log',['/usr/sbin/pkgutil','--expand-full',out/'Install Josi-unsigned.pkg',out/'expanded-unsigned-pkg'])
    shutil.copyfile(REPO/'packaging/macos/PKG-TEST-ME.txt',out/'TEST-ME.txt')
    (out/'prepared.json').write_text(json.dumps({'version':VERSION,'candidate':False,'notarized':False,'installed':False},indent=2)+'\n')
    print(out,flush=True)

def sign(out,standard_mount=False):
    if not (out/'prepared.json').is_file():raise ValueError('Prepare first')
    run=runner(out);app=out/'payload/Applications/Josi Server.app'
    subprocess.run(['/usr/bin/git','diff','--exit-code','--quiet'],cwd=REPO,check=True)
    subprocess.run(['/usr/bin/git','diff','--cached','--exit-code','--quiet'],cwd=REPO,check=True)
    if subprocess.check_output(['/usr/bin/git','ls-files','--others','--exclude-standard'],cwd=REPO):raise ValueError('Commit intended source before signing')
    commit=subprocess.check_output(['/usr/bin/git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
    (app/'Contents/Resources/runtime/licenses/build.json').write_text(json.dumps({'sourceCommit':commit,'architecture':'arm64','minimumMacOS':'14.0','scannerBundled':False,'signing':'SOCAL candidate; not notarized'},indent=2)+'\n')
    # No probe, alternate identity, or automatic retry. This is actual candidate code.
    run('sign-server-executable.log',['/usr/bin/codesign','--force','--keychain',KEYCHAIN,'--sign',APP_IDENTITY,'--options','runtime','--timestamp',app/'Contents/MacOS/JosiServer'])
    runtime=app/'Contents/Resources/runtime'
    spec=importlib.util.spec_from_file_location('inventory',REPO/'scripts/macos/inventory.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    m.inventory(runtime)
    run('sign-app.log',['/usr/bin/codesign','--force','--keychain',KEYCHAIN,'--sign',APP_IDENTITY,'--options','runtime','--timestamp',app])
    run('verify-app.log',['/usr/bin/codesign','--verify','--deep','--strict',app])
    identity=run('app-authority.log',['/usr/bin/codesign','-d','--verbose=4',app])
    if 'Authority='+APP_IDENTITY not in identity or 'TeamIdentifier=LRH75YR6QW' not in identity or 'Timestamp=' not in identity or '(runtime)' not in identity:raise ValueError('Wrong application identity, timestamp or hardened runtime')
    packages=out/'packages';packages.mkdir()
    for name,identifier,version in [('server','com.heyjosi.ce.server.pkg','0.1.78.3'),('client','com.heyjosi.ce.desktop.pkg','0.6.5')]:
        payload=out/('payload' if name=='server' else 'client-payload')
        run(name+'-pkg.log',['/usr/bin/pkgbuild','--root',payload,'--component-plist',component_plan(out,name),'--install-location','/','--ownership','recommended','--identifier',identifier,'--version',version,'--scripts',out/(name+'-scripts'),packages/(name+'.pkg')])
    pkg=out/'Install Josi.pkg'
    run('productbuild.log',['/usr/bin/productbuild','--distribution',out/'Distribution.xml','--resources',out/'package-resources','--package-path',packages,'--keychain',KEYCHAIN,'--sign',PKG_IDENTITY,'--timestamp',pkg])
    signature=run('pkg-signature.log',['/usr/sbin/pkgutil','--check-signature',pkg])
    if PKG_IDENTITY not in signature:raise ValueError('Wrong package identity')
    run('expanded-pkg.log',['/usr/sbin/pkgutil','--expand-full',pkg,out/'expanded-pkg'])
    run('pkg-gatekeeper.log',['/usr/sbin/spctl','--assess','--type','install','--verbose=4',pkg],accepted=(0,1,3))
    # Public source and license materials are companions, not executable payload.
    sources=out/'corresponding-sources';shutil.copytree(BASE/'stage/corresponding-sources',sources)
    commit=subprocess.check_output(['/usr/bin/git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
    run('source-archive.log',['/usr/bin/git','archive','--format=tar.gz','--prefix=josi-ce-source/','-o',sources/'sources/josi-ce-source.tar.gz',commit])
    client_sources=sources/'sources/desktop-client-0.6.5';client_sources.mkdir()
    for name in ['src','assets','docs','package.json','package-lock.json','README.md']:
        src=CLIENT_ROOT/name
        if src.is_dir():shutil.copytree(src,client_sources/name)
        else:shutil.copyfile(src,client_sources/name)
    shutil.copytree(out/'client-legal',sources/'desktop-client-legal')
    shutil.copytree(out/'client-source-closure',sources/'desktop-engine-sources')
    source_zip=out/'Josi-corresponding-sources.zip'
    run('source-zip.log',['/usr/bin/ditto','--norsrc','--noextattr','-c','-k','--keepParent',sources,source_zip])
    (out/'SOURCE-COMMIT.txt').write_text(commit+'\n')
    # Prepare a branded image; never add an Applications drag target.
    image_root=out/'dmg-root';image_root.mkdir()
    shutil.copyfile(pkg,image_root/pkg.name);shutil.copyfile(out/'TEST-ME.txt',image_root/'TEST-ME.txt')
    legal_root=image_root/'Licenses and Sources';legal_root.mkdir()
    # Apple recursively scans archives inside the submitted image, including
    # upstream source fixtures. Keep the exact source closure beside the DMG.
    (legal_root/'Corresponding-Sources.txt').write_text(
        'Complete corresponding source is distributed beside this disk image as '
        +source_zip.name+'. See SHA256SUMS.txt for its checksum.\n'
        'The source archive contains upstream build and test fixtures; it is '
        'not an installer and should not be executed.\n')
    shutil.copyfile(out/'client-legal/Josi-Desktop-Notices.txt',legal_root/'Josi-Desktop-Notices.txt')
    (image_root/'.background').mkdir();shutil.copyfile(out/'background.png',image_root/'.background/background.png')
    shutil.copyfile(app/'Contents/Resources/Josi.icns',image_root/'.VolumeIcon.icns')
    run('volume-icon.log',['/usr/bin/xcrun','SetFile','-a','C',image_root])
    dmg=out/'Josi-Server-macos-arm64.dmg'
    writable=out/'Josi-Server-layout.dmg'
    run('dmg-build.log',['/usr/bin/hdiutil','create','-srcfolder',image_root,'-volname','Josi Server','-fs','HFS+','-format','UDRW',writable])
    if standard_mount:
        mounted=run('dmg-mount.log',['/usr/bin/hdiutil','attach','-nobrowse','-plist',writable])
        points=[x['mount-point'] for x in plistlib.loads(mounted.encode())['system-entities'] if 'mount-point' in x]
        if len(points)!=1:raise ValueError('Expected one candidate volume')
        mount=Path(points[0])
    else:
        mount=out/'dmg-mount';mount.mkdir()
        run('dmg-mount.log',['/usr/bin/hdiutil','attach','-nobrowse','-mountpoint',mount,writable])
    try:
        run('dmg-layout.log',[BASE/'prefix/python/bin/python3.11','-I','-B',REPO/'scripts/macos/dmg-layout.py',out,mount,*(['--standard-mount'] if standard_mount else [])])
        run('mounted-volume-icon.log',['/usr/bin/xcrun','SetFile','-a','C',mount])
    finally:run('dmg-detach.log',['/usr/bin/hdiutil','detach',mount])
    run('dmg-compress.log',['/usr/bin/hdiutil','convert',writable,'-format','UDZO','-o',dmg])
    run('sign-dmg.log',['/usr/bin/codesign','--keychain',KEYCHAIN,'--sign',APP_IDENTITY,'--timestamp',dmg])
    run('dmg-signature.log',['/usr/bin/codesign','--verify','--verbose=4',dmg])
    run('dmg-verify.log',['/usr/bin/hdiutil','verify',dmg])
    (out/'SHA256SUMS.txt').write_text(''.join(digest(p)+'  '+p.name+'\n' for p in [pkg,dmg,source_zip]))
    print(out,flush=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','sign']);parser.add_argument('--output',required=True);parser.add_argument('--standard-mount',action='store_true',help='Use only after user authorizes a temporary /Volumes mount');args=parser.parse_args()
    out=Path(args.output)
    if out.parent!=RELEASE or not out.name.startswith('pkg-candidate-') or out.is_symlink():raise ValueError('Use a new timestamped candidate directory under the release root')
    if args.mode=='prepare':prepare(out)
    else:sign(out,args.standard_mount)
if __name__=='__main__':main()
