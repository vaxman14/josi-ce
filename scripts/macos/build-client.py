"""Build Josi Client for Mac: the Josi app without the server.

  python3 scripts/macos/build-client.py --version 1.2.10 [--notarize-profile josi-notary] [--node <node>]

It connects to a Josi server somewhere else and does everything the signed-in
person may do there; it is also a node, so that server can work on this Mac
(docs/WINDOWS_CLIENT_NODE_SPEC.md). The same Swift sources as Josi, compiled
without JOSI_SERVER_APP, as "Josi Client.app" (com.heyjosi.ce.client), with its
own browser helpers and Safari extension (JosiEdition "client"). No server
runtime, database, Vault or models are inside it.

Runs on the Apple Silicon Mac that holds the Socal Receptionist LLC signing
identities. The result is a signed, notarized and stapled installer in
~/JosiBuild/Artifacts/releases/<version>/. Nothing is installed or published.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[2]
CLIENT_ID = 'com.heyjosi.ce.client'
NAME = 'Josi Client'
APP_IDENTITY = 'Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)'
INSTALLER_IDENTITY = 'Developer ID Installer: Socal Receptionist LLC (LRH75YR6QW)'
KEYCHAIN = '/Users/roman/Library/Keychains/login.keychain-db'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--notarize-profile', default=None, help='notarytool keychain profile; without it the installer is signed but not notarized')
    parser.add_argument('--node', type=Path, default=Path(shutil.which('node') or '/opt/homebrew/bin/node'))
    parser.add_argument('--output-root', type=Path, default=Path('~/JosiBuild/Artifacts'))
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+\.\d+(-[a-z0-9.]+)?', args.version):
        raise SystemExit('Use --version like 1.2.10')
    version = args.version
    short = version.split('-')[0]
    output = args.output_root.expanduser().resolve() / ('josi-client-' + version + '-macos-' + time.strftime('%Y%m%d-%H%M%S'))
    output.mkdir(parents=True)
    evidence = output / 'evidence'; evidence.mkdir()

    def run(name, command, timeout=900, env=None):
        print(name, flush=True)
        with (evidence / (name + '.log')).open('x') as log:
            result = subprocess.run([str(v) for v in command], cwd=REPO, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, env=env)
        if result.returncode:
            raise SystemExit('Build stopped at ' + str(evidence / (name + '.log')))
        return (evidence / (name + '.log')).read_text(errors='replace')

    def tree(source, target):
        shutil.copytree(source, target, symlinks=True, ignore=shutil.ignore_patterns('.DS_Store', '._*', '__pycache__'))

    # ---------------------------------------------------------------- the app
    native = REPO / 'apps/macos-native'
    run('compile-josi-client', ['xcrun', 'xcodebuild', '-project', native / 'Josi.xcodeproj', '-scheme', 'Josi', '-configuration', 'Release',
                                '-derivedDataPath', output / 'xcode', 'CODE_SIGNING_ALLOWED=NO',
                                'SWIFT_ACTIVE_COMPILATION_CONDITIONS=JOSI_CLIENT_APP', 'build'], timeout=1800)
    built = output / 'xcode/Build/Products/Release/Josi.app/Contents'
    app = output / 'payload/Applications' / (NAME + '.app')
    resources = app / 'Contents/Resources'; resources.mkdir(parents=True)
    (app / 'Contents/MacOS').mkdir()
    shutil.copy2(built / 'MacOS/Josi', app / 'Contents/MacOS' / NAME)
    for item in (built / 'Resources').iterdir():
        if item.name in ('Fonts', 'Mascot') or item.suffix == '.bundle':
            tree(item, resources / item.name)
    shutil.copy2(native / 'Resources/JosiMark.png', resources / 'JosiMark.png')
    masko = output / 'xcode/SourcePackages/checkouts/masko-player'
    (resources / 'third-party').mkdir()
    shutil.copy2(masko / 'LICENSE', resources / 'third-party/masko-player-LICENSE')
    shutil.copy2(masko / 'THIRD_PARTY_NOTICES.md', resources / 'third-party/masko-player-THIRD_PARTY_NOTICES.md')
    for name in ('LICENSE', 'NOTICE'):
        shutil.copy2(REPO / name, resources / name)
    shutil.copy2(native / 'Resources/JosiIcon.png', resources / 'Josi.png')
    icons = output / 'Josi.iconset'; icons.mkdir()
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            file = f'icon_{size}x{size}' + ('@2x' if scale == 2 else '') + '.png'
            run('icon-' + file, ['/usr/bin/sips', '-z', size * scale, size * scale, resources / 'Josi.png', '--out', icons / file])
    run('create-app-icon', ['/usr/bin/iconutil', '-c', 'icns', icons, '-o', resources / 'Josi.icns'])
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': CLIENT_ID, 'CFBundleName': NAME, 'CFBundleDisplayName': NAME, 'CFBundleExecutable': NAME,
        'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': short, 'CFBundleVersion': version,
        'CFBundleIconFile': 'Josi.icns', 'LSMinimumSystemVersion': '14.2', 'NSHighResolutionCapable': True,
        'NSPrincipalClass': 'NSApplication', 'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
        'NSMicrophoneUsageDescription': 'Josi uses your microphone only when you start dictation or voice chat. Audio is processed by Voice Box on your Josi server.',
        'NSLocalNetworkUsageDescription': 'Josi Client connects straight to your Josi server when both are on the same network.',
        'NSAccessibilityUsageDescription': 'Josi uses windows on this Mac only when you ask her to and allow it in PC Control.',
        'NSScreenCaptureUsageDescription': 'Josi takes a picture of a window on this Mac only when you ask her to and allow it in PC Control.',
        'JosiNativeClientProtocol': 1, 'JosiEdition': 'client',
        'NSHumanReadableCopyright': 'Copyright SOCAL RECEPTIONIST LLC. AGPL-3.0-or-later; bundled notices apply.',
    }))

    # ------------------------------------------------- browser helpers (client edition)
    browser = output / 'browser-components'
    run('browser-components', [sys.executable, '-B', REPO / 'scripts/macos/build-guest-browser-components.py',
                               '--output', browser, '--node', args.node, '--edition', 'client'], timeout=1200)
    tree(browser / 'BrowserExtensions', resources / 'BrowserExtensions')
    shutil.copy2(browser / 'BrowserExtensions/BrowserDistribution.json', resources / 'BrowserDistribution.json')
    tree(browser / 'NativeMessagingHosts', resources / 'NativeMessagingHosts')
    helpers = app / 'Contents/Helpers'; helpers.mkdir()
    for name in ('JosiBrowserHost', 'JosiBrowserBroker'):
        shutil.copy2(browser / name, helpers / name)
    (app / 'Contents/PlugIns').mkdir()
    appex = app / 'Contents/PlugIns/Josi Workspace.appex'
    tree(browser / 'Josi Workspace.appex', appex)
    agents = app / 'Contents/Library/LaunchAgents'; agents.mkdir(parents=True)
    shutil.copy2(browser / 'com.heyjosi.ce.client.browser.plist', agents / 'com.heyjosi.ce.client.browser.plist')
    if 'Josi Client.app/Contents/Helpers/JosiBrowserHost' not in (resources / 'NativeMessagingHosts/chrome.json').read_text():
        raise SystemExit('The native host manifest does not point inside Josi Client')

    # ------------------------------------------------------------------ signing
    (output / 'app.entitlements').write_bytes(plistlib.dumps({'com.apple.security.device.audio-input': True}))

    def sign(name, path, identifier=None, entitlements=None):
        command = ['/usr/bin/codesign', '--force', '--keychain', KEYCHAIN, '--sign', APP_IDENTITY, '--options', 'runtime', '--timestamp']
        if identifier: command += ['--identifier', identifier]
        if entitlements: command += ['--entitlements', entitlements]
        run(name, command + [path], timeout=300)

    sign('sign-browser-host', helpers / 'JosiBrowserHost', 'com.heyjosi.ce.browser-host')
    sign('sign-browser-broker', helpers / 'JosiBrowserBroker', 'com.heyjosi.ce.browser-broker')
    sign('sign-safari-extension', appex, CLIENT_ID + '.workspace-safari', browser / 'Safari.entitlements')
    sign('sign-josi-client', app, CLIENT_ID, output / 'app.entitlements')
    run('verify-josi-client', ['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
    identity = run('identity-josi-client', ['/usr/bin/codesign', '-d', '--verbose=4', app])
    if 'Authority=' + APP_IDENTITY not in identity or 'Identifier=' + CLIENT_ID not in identity or 'Timestamp=' not in identity:
        raise SystemExit('Unexpected signing identity on Josi Client')

    # ---------------------------------------------------------------- installer
    components = output / 'components.plist'
    components.write_bytes(plistlib.dumps([{'RootRelativeBundlePath': 'Applications/' + NAME + '.app', 'BundleIsRelocatable': False,
                                            'BundleIsVersionChecked': False, 'BundleHasStrictIdentifier': True, 'BundleOverwriteAction': 'upgrade'}]))
    run('build-component', ['/usr/bin/pkgbuild', '--root', output / 'payload', '--component-plist', components, '--identifier', CLIENT_ID + '.pkg',
                            '--version', short, '--install-location', '/', output / 'client.pkg'])
    distribution = output / 'Distribution.xml'
    distribution.write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
 <title>{NAME}</title>
 <options customize="never" require-scripts="false" hostArchitectures="arm64" rootVolumeOnly="true"/>
 <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
 <allowed-os-versions><os-version min="14.2"/></allowed-os-versions>
 <choices-outline><line choice="client"/></choices-outline>
 <choice id="client" title="{NAME}" visible="false" start_selected="true" start_enabled="false"><pkg-ref id="{CLIENT_ID}.pkg"/></choice>
 <pkg-ref id="{CLIENT_ID}.pkg" version="{short}" onConclusion="none">client.pkg</pkg-ref>
</installer-gui-script>
''')
    package_name = f'Josi-Client-{version}-macOS-arm64.pkg'
    package = output / package_name
    run('sign-installer', ['/usr/bin/productbuild', '--distribution', distribution, '--package-path', output,
                           '--sign', INSTALLER_IDENTITY, '--keychain', KEYCHAIN, '--timestamp', package])
    if INSTALLER_IDENTITY not in run('verify-installer-signature', ['/usr/sbin/pkgutil', '--check-signature', package]):
        raise SystemExit('Unexpected installer signing identity')
    expanded = output / 'expanded'
    run('expand-installer', ['/usr/sbin/pkgutil', '--expand-full', package, expanded])
    run('verify-packaged-client', ['/usr/bin/codesign', '--verify', '--deep', '--strict', expanded / 'client.pkg/Payload/Applications' / (NAME + '.app')])

    notarized = False
    if args.notarize_profile:
        spec = importlib.util.spec_from_file_location('josi_release', REPO / 'scripts/macos/build-release.py')
        release_module = importlib.util.module_from_spec(spec); spec.loader.exec_module(release_module)
        release_module.notarize(package, args.notarize_profile, evidence)
        notarized = True

    release = args.output_root.expanduser().resolve() / 'releases' / version
    release.mkdir(parents=True, exist_ok=True)
    final = release / package_name
    if final.exists():
        raise SystemExit('A client installer for this version already exists: ' + str(final))
    shutil.copy2(package, final)
    with final.open('rb') as source:
        sha = hashlib.file_digest(source, 'sha256').hexdigest()
    sums = release / 'SHA256SUMS.txt'
    lines = [line for line in (sums.read_text().splitlines() if sums.exists() else []) if not line.endswith('  ' + package_name)]
    sums.write_text('\n'.join(lines + [f'{sha}  {package_name}']) + '\n')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    (output / 'build.json').write_text(json.dumps({'edition': 'client', 'version': version, 'sourceCommit': revision, 'signed': True,
                                                   'notarized': notarized, 'installer': str(final), 'sha256': sha}, indent=2) + '\n')
    print(f'Installer: {final} ({final.stat().st_size // 1_000_000} MB, sha256 {sha})')


if __name__ == '__main__':
    main()
