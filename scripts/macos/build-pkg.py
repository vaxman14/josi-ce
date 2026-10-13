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
import tempfile
import zipfile

REPO=Path(__file__).resolve().parents[2]
BASE=Path('/Users/roman/Documents/Josi Mac Native/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port')
RELEASE=Path('/Users/roman/Documents/Josi Mac Native/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009')
PREVIOUS=RELEASE/'socal-signed-20261010T021606Z/Josi CE Server Setup.app'
CLIENT_ROOT=Path('/Users/roman/Documents/Josi Mac Native/JosiDrive/Projects/worktrees/josi-desktop-macos-0.6.5-e1d28de')
CLIENT=CLIENT_ROOT/'release-public-20261001-2321/mac-arm64/Josi CE.app'
APP_IDENTITY='Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)'
PKG_IDENTITY='Developer ID Installer: Socal Receptionist LLC (LRH75YR6QW)'
KEYCHAIN='/Users/roman/Library/Keychains/login.keychain-db'
VERSION='0.1.78-macos.12'
SDK='/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'
SWIFTC='/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'
ENV={**os.environ,'DEVELOPER_DIR':'/Applications/Xcode.app/Contents/Developer','TMPDIR':str(BASE/'tmp'),'CLANG_MODULE_CACHE_PATH':str(BASE/'clang-cache'),'npm_config_cache':'/Users/roman/Documents/Josi Mac Native/JosiDrive/Caches/codex-macos-native-20261009/npm'}

def digest(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def clean_candidate_metadata(out,app,workspace):
    if not app.is_relative_to(workspace) or app.is_symlink():raise ValueError('Candidate app required')
    for path in app.rglob('.DS_Store'):
        if path.is_symlink() or not path.is_file():raise ValueError('Unexpected Finder metadata entry')
        value={'removedFinderMetadata':str(path.relative_to(workspace)),'sha256':digest(path)}
        path.unlink()
        with (out/'evidence/candidate-metadata.jsonl').open('a') as log:log.write(json.dumps(value)+'\n')
    # This private Python does not expose os.listxattr on macOS. Use the native
    # utility, which ignores missing attributes and preserves file contents.
    for name in ('com.apple.FinderInfo','com.apple.ResourceFork'):
        args=['/usr/bin/xattr','-dr',name,str(app)]
        result=subprocess.run(args,capture_output=True,text=True,env=ENV)
        with (out/'evidence/candidate-metadata.jsonl').open('a') as log:
            log.write(json.dumps({'command':args,'exitCode':result.returncode,'stdout':result.stdout,'stderr':result.stderr})+'\n')
        if result.returncode:raise RuntimeError('Candidate metadata cleanup failed')

def runner(out):
    def run(name,args,accepted=(0,),cwd=REPO):
        print('Checking/building '+name,flush=True)
        path=out/'evidence'/name
        with path.open('x') as log:
            # Machine-readable plist stdout must not include SDK deprecation
            # warnings. Keep those diagnostics in a separate evidence file.
            structured='-plist' in [str(x) for x in args]
            result=subprocess.run([str(x) for x in args],cwd=cwd,env=ENV,stdout=log,stderr=subprocess.PIPE if structured else subprocess.STDOUT)
        if structured:
            with path.with_name(path.name+'.stderr').open('xb') as stderr:stderr.write(result.stderr)
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
        names=['Josi Server.app','Uninstall Josi.app'] if name=='server' else ['Josi CE.app']
        path.write_bytes(plistlib.dumps([{'RootRelativeBundlePath':'Applications/'+app,'BundleIsRelocatable':False,'BundleIsVersionChecked':False,'BundleHasStrictIdentifier':True,'BundleOverwriteAction':'upgrade'} for app in names]))
    return path

def distribution():
    return '''<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
 <title>Josi Server</title>
 <options customize="always" require-scripts="false" hostArchitectures="arm64" rootVolumeOnly="true"/>
 <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
 <allowed-os-versions><os-version min="14.0"/></allowed-os-versions>
 <welcome file="welcome.rtf" mime-type="text/rtf"/>
 <license file="license.txt"/>
 <conclusion file="conclusion.rtf" mime-type="text/rtf"/>
 <choices-outline><line choice="server"/><line choice="client"/></choices-outline>
 <choice id="server" title="Josi Server" description="Required. Installs the local server and Josi Server management app. Your existing server data is retained." start_selected="true" start_enabled="false"><pkg-ref id="com.heyjosi.ce.server.pkg"/></choice>
 <choice id="client" title="Desktop Client (optional)" description="Adds the real Josi CE desktop app. It can be removed separately. Leave unchecked if you already have this client." start_selected="false"><pkg-ref id="com.heyjosi.ce.desktop.pkg"/></choice>
 <pkg-ref id="com.heyjosi.ce.server.pkg" version="0.1.78.12" onConclusion="none">server.pkg</pkg-ref>
 <pkg-ref id="com.heyjosi.ce.desktop.pkg" version="0.6.5" onConclusion="none">client.pkg</pkg-ref>
</installer-gui-script>
'''

def prepare(out):
    out.mkdir();(out/'evidence').mkdir(mode=0o700)
    # File Provider can reattach FinderInfo to signed bundles in Documents.
    # Only app staging is temporary; every deliverable and log remains in out.
    with tempfile.TemporaryDirectory(prefix='josi-pkg-native-',dir='/private/tmp') as folder:
        prepare_native(out,Path(folder))

def prepare_native(out,workspace):
    run=runner(out)
    # Finder may attach unsigned metadata when the handoff is copied. Preserve
    # the immutable input; verify its original signature on a byte-identical
    # candidate copy without resource forks or extended attributes.
    baseline=workspace/'baseline-input/Josi CE Server Setup.app'
    run('baseline-copy.log',['/usr/bin/ditto','--norsrc','--noextattr',PREVIOUS,baseline])
    clean_candidate_metadata(out,baseline,workspace)
    run('baseline-app-signature.log',['/usr/bin/codesign','--verify','--deep','--strict','-R','=anchor apple generic and certificate leaf[subject.OU] = "LRH75YR6QW" and certificate leaf[subject.CN] = "'+APP_IDENTITY+'"',baseline])
    app=workspace/'payload/Applications/Josi Server.app';resources=app/'Contents/Resources';resources.mkdir(parents=True)
    shutil.copytree(baseline/'Contents/Resources/runtime',resources/'runtime',symlinks=True)
    runtime=resources/'runtime'
    for p in REPO.glob('packages/*/dist'):
        destination=runtime/'app'/p.relative_to(REPO)
        if destination.exists():shutil.rmtree(destination)
        shutil.copytree(p,destination)
    for p in REPO.glob('apps/*/dist'):
        destination=runtime/'app'/p.relative_to(REPO)
        if destination.exists():shutil.rmtree(destination)
        shutil.copytree(p,destination)
    for name in ['lifecycle.py','maintenance.py','workspace_access.py','pkg-driver.py','Runtime.mjs','SubscriptionEnvironment.mjs','PythonRuntime.py']:
        shutil.copyfile(REPO/'packaging/macos'/name,runtime/'app/native'/name)
    cli_spec=importlib.util.spec_from_file_location('subscription_cli',REPO/'scripts/macos/bundle-subscription-cli.py');cli=importlib.util.module_from_spec(cli_spec);cli_spec.loader.exec_module(cli)
    cli.bundle(runtime)
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
    compile(run,out,'JosiServer',['ServerApp.swift','NativeAuthorization.swift','JosiArtworkView.swift','InstallerState.swift','DiagnosticLog.swift','ProgressState.swift','BrowserHandoff.swift'])
    shutil.copyfile(out/'JosiServer',macos/'JosiServer');(macos/'JosiServer').chmod(0o755)
    plist={'CFBundleIdentifier':'com.heyjosi.ce.server','CFBundleName':'Josi Server','CFBundleDisplayName':'Josi Server','CFBundleExecutable':'JosiServer','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.1.78','CFBundleVersion':'20261013.12','CFBundleIconFile':'Josi.icns','LSMinimumSystemVersion':'14.0','NSHighResolutionCapable':True,'NSAppTransportSecurity':{'NSAllowsLocalNetworking':True},'NSHumanReadableCopyright':'Copyright SOCAL RECEPTIONIST LLC. AGPL-3.0-or-later; bundled notices and corresponding sources apply.'}
    (app/'Contents/Info.plist').write_bytes(plistlib.dumps(plist))
    uninstaller=workspace/'payload/Applications/Uninstall Josi.app'
    ur=uninstaller/'Contents/Resources';ur.mkdir(parents=True)
    (uninstaller/'Contents/MacOS').mkdir()
    compile(run,out,'JosiUninstall',['UninstallApp.swift','NativeAuthorization.swift','JosiArtworkView.swift','DiagnosticLog.swift'])
    shutil.copyfile(out/'JosiUninstall',uninstaller/'Contents/MacOS/JosiUninstall');(uninstaller/'Contents/MacOS/JosiUninstall').chmod(0o755)
    up=dict(plist);up.update(CFBundleIdentifier='com.heyjosi.ce.uninstaller',CFBundleName='Uninstall Josi',CFBundleDisplayName='Uninstall Josi',CFBundleExecutable='JosiUninstall');up.pop('NSAppTransportSecurity')
    (uninstaller/'Contents/Info.plist').write_bytes(plistlib.dumps(up))
    for name in ['Josi.png','Josi.icns']:shutil.copyfile(resources/name,ur/name)
    minimal=ur/'runtime';(minimal/'python/bin').mkdir(parents=True);(minimal/'python/lib').mkdir()
    shutil.copyfile(runtime/'python/bin/python3.11',minimal/'python/bin/python3.11');(minimal/'python/bin/python3.11').chmod(0o755)
    shutil.copytree(runtime/'python/lib/python3.11',minimal/'python/lib/python3.11',ignore=shutil.ignore_patterns('site-packages','__pycache__'),symlinks=True)
    (minimal/'app/native').mkdir(parents=True)
    (minimal/'app/package.json').write_text(json.dumps({'version':VERSION})+'\n')
    for name in ['uninstall.py','lifecycle.py','workspace_access.py']:shutil.copyfile(REPO/'packaging/macos'/name,minimal/'app/native'/name)
    shutil.copytree(runtime/'licenses',minimal/'licenses')
    shutil.copyfile(REPO/'LICENSE',ur/'LICENSE.txt')
    run('uninstaller-python-smoke.log',[minimal/'python/bin/python3.11','-I','-B','-c','import ctypes,fcntl,grp,json,pathlib,plistlib,pwd,shutil,signal,subprocess; print("PASS standalone uninstaller standard library")'])
    gate=run('maintenance-isolated-import-gate.log',[runtime/'python/bin/python3.11','-I','-B',runtime/'app/native/maintenance.py','uninstall'],accepted=(1,))
    if 'Administrator authorization required' not in gate:raise ValueError('Native maintenance import/privilege gate failed')
    gate=run('uninstaller-isolated-import-gate.log',[minimal/'python/bin/python3.11','-I','-B',minimal/'app/native/uninstall.py'],accepted=(1,))
    if 'administrator authorization' not in gate:raise ValueError('Standalone cleanup import/privilege gate failed')
    compile(run,out,'authorization-tests',['NativeAuthorization.swift','NativeAuthorizationTests.swift'])
    run('authorization-tests.log',[out/'authorization-tests'])
    for executable,sources in [('state-tests',['InstallerState.swift','InstallerStateTests.swift']),('diagnostic-tests',['DiagnosticLog.swift','DiagnosticTests.swift']),('progress-tests',['ProgressState.swift','ProgressTests.swift'])]:
        compile(run,out,executable,sources)
        run(executable+'.log',[out/executable,*([out] if executable=='diagnostic-tests' else [])])
    compile(run,out,'brand-resources',['BrandResources.swift'])
    run('brand.log',[out/'brand-resources',resources/'Josi.png',out/'background.png'])
    dimensions=run('background-pixels.log',['/usr/bin/sips','-g','pixelWidth','-g','pixelHeight','-g','dpiWidth','-g','dpiHeight',out/'background.png'])
    values=dict(line.strip().split(': ',1) for line in dimensions.splitlines()[1:] if ': ' in line)
    if [float(values[k]) for k in ['pixelWidth','pixelHeight','dpiWidth','dpiHeight']]!=[1440,880,144,144]:raise ValueError('Background must render at 720 by 440 points on every build host')
    run('dmg-build-tools.log',[BASE/'prefix/python/bin/python3.11','-I','-B',REPO/'scripts/macos/acquire-dmg-tools.py',out])
    # The client is reused unchanged, with its original signature and identity.
    client=workspace/'client-payload/Applications/Josi CE.app'
    shutil.copytree(CLIENT,client,symlinks=True)
    clean_candidate_metadata(out,client,workspace)
    run('baseline-client-signature.log',['/usr/bin/codesign','--verify','--deep','--strict','-R','=anchor apple generic and certificate leaf[subject.OU] = "LRH75YR6QW" and certificate leaf[subject.CN] = "'+APP_IDENTITY+'"',client])
    legal=out/'client-legal';legal.mkdir()
    electron_archive=Path('/Users/roman/Documents/Josi Mac Native/JosiDrive/Caches/electron/electron-v43.2.0-darwin-arm64.zip')
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
    def installer_rtf(title, paragraphs):
        def escape(value):
            return value.replace('\\', '\\\\').replace('{', '\\{').replace('}', '\\}')
        return '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs26 ' + '\\b\\fs36 ' + escape(title) + '\\b0\\fs26\\par\\par ' + '\\par\\par '.join(escape(text) for text in paragraphs) + '}'
    (resources_pkg/'welcome.rtf').write_text(installer_rtf('Welcome to Josi Server', [
        'Your private server runs on this Mac. Requires Apple Silicon, macOS 14 or later and at least 6 GB free space on the startup disk.',
        'Use Customize to add the optional desktop client. If Josi CE is already installed, leave Desktop Client unchecked to preserve it.',
        'Installation verifies files and automatically recovers supported interrupted installations before upgrading. Existing data and recovery evidence are retained. A resizable Josi window shows progress. Startup checks can take up to four minutes.',
        'After installation, choose a local folder for read-only workspace access or continue without access, then open Josi in your browser.',
        'Document indexing requires a separately configured supported scanner.'
    ]))
    (resources_pkg/'conclusion.rtf').write_text(installer_rtf('Finish setting up Josi', [
        'Open Josi Server in Applications. Choose a workspace folder or continue without access, then click Open Josi in Browser.',
        'Connect the optional desktop client to http://localhost:8080 after owner setup.',
        'For failures, choose Copy Diagnostics in Josi Server. Installation logs are in /Library/Logs/Josi CE Server.',
        'To uninstall, open Uninstall Josi in Applications or from this disk image. Choose Keep my data or Complete removal. Connected workspace files are retained.'
    ]))
    (out/'Distribution.xml').write_text(distribution())
    clean_candidate_metadata(out,app,workspace)
    spec=importlib.util.spec_from_file_location('inventory',REPO/'scripts/macos/inventory.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    m.inventory(runtime)
    m.inventory(minimal)
    run('unsigned-runtime-integrity.log',[runtime/'python/bin/python3.11','-I','-B',runtime/'app/native/lifecycle.py','verify'])
    packages=out/'unsigned-packages';packages.mkdir()
    for name,identifier,version in [('server','com.heyjosi.ce.server.pkg','0.1.78.12'),('client','com.heyjosi.ce.desktop.pkg','0.6.5')]:
        root=workspace/('payload' if name=='server' else 'client-payload')
        run('unsigned-'+name+'-pkg.log',['/usr/bin/pkgbuild','--root',root,'--component-plist',component_plan(out,name),'--install-location','/','--ownership','recommended','--identifier',identifier,'--version',version,'--scripts',out/(name+'-scripts'),packages/(name+'.pkg')])
    run('unsigned-productbuild.log',['/usr/bin/productbuild','--distribution',out/'Distribution.xml','--resources',out/'package-resources','--package-path',packages,out/'Install Josi-unsigned.pkg'])
    run('unsigned-package-expand.log',['/usr/sbin/pkgutil','--expand-full',out/'Install Josi-unsigned.pkg',out/'expanded-unsigned-pkg'])
    for name in ['payload','client-payload']:
        shutil.copytree(workspace/name,out/name,symlinks=True)
    shutil.copyfile(REPO/'packaging/macos/PKG-TEST-ME.txt',out/'TEST-ME.txt')
    (out/'prepared.json').write_text(json.dumps({'version':VERSION,'candidate':False,'notarized':False,'installed':False},indent=2)+'\n')
    print(out,flush=True)

def sign(out,standard_mount=False):
    if not (out/'prepared.json').is_file():raise ValueError('Prepare first')
    with tempfile.TemporaryDirectory(prefix='josi-pkg-native-',dir='/private/tmp') as folder:
        workspace=Path(folder)
        for name in ['payload','client-payload']:
            subprocess.run(['/usr/bin/ditto','--norsrc','--noextattr',str(out/name),str(workspace/name)],check=True)
        sign_native(out,standard_mount,workspace)

def sign_native(out,standard_mount,workspace):
    run=runner(out);app=workspace/'payload/Applications/Josi Server.app'
    subprocess.run(['/usr/bin/git','diff','--exit-code','--quiet'],cwd=REPO,check=True)
    subprocess.run(['/usr/bin/git','diff','--cached','--exit-code','--quiet'],cwd=REPO,check=True)
    if subprocess.check_output(['/usr/bin/git','ls-files','--others','--exclude-standard','--exclude=.native-acceptance-evidence/'],cwd=REPO):raise ValueError('Commit intended source before signing')
    commit=subprocess.check_output(['/usr/bin/git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
    clean_candidate_metadata(out,workspace/'payload',workspace)
    clean_candidate_metadata(out,workspace/'client-payload',workspace)
    prepared_runtime=app/'Contents/Resources/runtime'
    run('signing-prepared-runtime-integrity.log',[prepared_runtime/'python/bin/python3.11','-I','-B',prepared_runtime/'app/native/lifecycle.py','verify'])
    (app/'Contents/Resources/runtime/licenses/build.json').write_text(json.dumps({'sourceCommit':commit,'architecture':'arm64','minimumMacOS':'14.0','scannerBundled':False,'signing':'SOCAL candidate; not notarized'},indent=2)+'\n')
    clean_candidate_metadata(out,app,workspace)
    client=workspace/'client-payload/Applications/Josi CE.app'
    clean_candidate_metadata(out,client,workspace)
    run('signing-client-input-verify.log',['/usr/bin/codesign','--verify','--deep','--strict',client])
    # No probe, alternate identity, or automatic retry. This is actual candidate code.
    run('sign-server-executable.log',['/usr/bin/codesign','--force','--keychain',KEYCHAIN,'--sign',APP_IDENTITY,'--options','runtime','--timestamp',app/'Contents/MacOS/JosiServer'])
    uninstaller=workspace/'payload/Applications/Uninstall Josi.app'
    minimal=uninstaller/'Contents/Resources/runtime'
    (minimal/'licenses/build.json').write_text(json.dumps({'sourceCommit':commit,'architecture':'arm64','minimumMacOS':'14.0','component':'native uninstaller'},indent=2)+'\n')
    spec=importlib.util.spec_from_file_location('uninstall_inventory',REPO/'scripts/macos/inventory.py');ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui);ui.inventory(minimal)
    run('sign-uninstaller-executable.log',['/usr/bin/codesign','--force','--keychain',KEYCHAIN,'--sign',APP_IDENTITY,'--options','runtime','--timestamp',uninstaller/'Contents/MacOS/JosiUninstall'])
    run('sign-uninstaller-app.log',['/usr/bin/codesign','--force','--keychain',KEYCHAIN,'--sign',APP_IDENTITY,'--options','runtime','--timestamp',uninstaller])
    run('verify-uninstaller-app.log',['/usr/bin/codesign','--verify','--deep','--strict',uninstaller])
    runtime=app/'Contents/Resources/runtime'
    spec=importlib.util.spec_from_file_location('inventory',REPO/'scripts/macos/inventory.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    m.inventory(runtime)
    run('sign-app.log',['/usr/bin/codesign','--force','--keychain',KEYCHAIN,'--sign',APP_IDENTITY,'--options','runtime','--timestamp',app])
    run('verify-app.log',['/usr/bin/codesign','--verify','--deep','--strict',app])
    identity=run('app-authority.log',['/usr/bin/codesign','-d','--verbose=4',app])
    if 'Authority='+APP_IDENTITY not in identity or 'TeamIdentifier=LRH75YR6QW' not in identity or 'Timestamp=' not in identity or '(runtime)' not in identity:raise ValueError('Wrong application identity, timestamp or hardened runtime')
    packages=out/'packages';packages.mkdir()
    for name,identifier,version in [('server','com.heyjosi.ce.server.pkg','0.1.78.12'),('client','com.heyjosi.ce.desktop.pkg','0.6.5')]:
        payload=workspace/('payload' if name=='server' else 'client-payload')
        run(name+'-pkg.log',['/usr/bin/pkgbuild','--root',payload,'--component-plist',component_plan(out,name),'--install-location','/','--ownership','recommended','--identifier',identifier,'--version',version,'--scripts',out/(name+'-scripts'),packages/(name+'.pkg')])
    pkg=out/'Install Josi.pkg'
    run('productbuild.log',['/usr/bin/productbuild','--distribution',out/'Distribution.xml','--resources',out/'package-resources','--package-path',packages,'--keychain',KEYCHAIN,'--sign',PKG_IDENTITY,'--timestamp',pkg])
    signature=run('pkg-signature.log',['/usr/sbin/pkgutil','--check-signature',pkg])
    if PKG_IDENTITY not in signature:raise ValueError('Wrong package identity')
    # Preserve signed inspection copies separately. Deleting or replacing an
    # inspection tree in Documents races File Provider's Finder metadata.
    # The package was built from the clean local staging tree above.
    for name in ['payload','client-payload']:
        shutil.copytree(workspace/name,out/('signed-'+name),symlinks=True)
    run('expanded-pkg.log',['/usr/sbin/pkgutil','--expand-full',pkg,out/'expanded-pkg'])
    run('pkg-gatekeeper.log',['/usr/sbin/spctl','--assess','--type','install','--verbose=4',pkg],accepted=(0,1,3))
    # Public source and license materials are companions, not executable payload.
    sources=out/'corresponding-sources';shutil.copytree(BASE/'stage/corresponding-sources',sources)
    cli_spec=importlib.util.spec_from_file_location('subscription_cli',REPO/'scripts/macos/bundle-subscription-cli.py');cli=importlib.util.module_from_spec(cli_spec);cli_spec.loader.exec_module(cli);cli.sources(sources/'sources/subscription-cli')
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
    # DiskImages also uses File Provider copy callbacks. Build from a local
    # source tree, then preserve complete inspection/image files in Documents.
    image_root=workspace/'dmg-root';image_root.mkdir()
    shutil.copyfile(pkg,image_root/pkg.name);shutil.copyfile(out/'TEST-ME.txt',image_root/'TEST-ME.txt')
    shutil.copytree(uninstaller,image_root/'Uninstall Josi.app',symlinks=True)
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
    local_writable=workspace/writable.name
    run('dmg-build.log',['/usr/bin/hdiutil','create','-srcfolder',image_root,'-volname','Josi Server','-fs','HFS+','-format','UDRW',local_writable])
    shutil.copyfile(local_writable,writable)
    shutil.copytree(image_root,out/'dmg-root')
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
