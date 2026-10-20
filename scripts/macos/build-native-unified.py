"""Build the SwiftUI/AppKit Josi app and standalone uninstaller.

Only --sign --package creates an installer. Signing uses the owner's exact
Socal Receptionist LLC identities. This command never installs or launches
anything, touches server data, or submits a notarization.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[2]
APP_ID = 'com.heyjosi.ce.unified'
APP_IDENTITY = 'Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)'
INSTALLER_IDENTITY = 'Developer ID Installer: Socal Receptionist LLC (LRH75YR6QW)'
KEYCHAIN = '/Users/roman/Library/Keychains/login.keychain-db'
VERSION = '0.7.0-native.6'
PROTECTED_ID = 'com.heyjosi.ce.protected-key'
SIGNING_CERTIFICATE_SHA1 = '0bdc050694b41330db6833e440a4a8e6f466abdb'


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def copy_file(source, target):
    # Byte/mode copy only: Finder metadata and resource forks from an older
    # package are not product inputs. Never mutate the retained source.
    with open(source, 'rb') as reader, open(target, 'xb') as writer:
        shutil.copyfileobj(reader, writer, length=8 * 1024 * 1024)
    shutil.copymode(source, target)
    return target


def tree(source, target, ignore=()):
    shutil.copytree(source, target, symlinks=True, copy_function=copy_file,
                    ignore=shutil.ignore_patterns('.DS_Store', '._*', '__pycache__', *ignore))


def replace(source, target):
    if not source.is_dir():
        raise ValueError('Build current package first: ' + str(source))
    if target.is_symlink():
        raise ValueError('Unexpected package directory link: ' + str(target))
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    tree(source, target)


def package_contents(root):
    """Compare payload bytes, executable modes and links, not machine metadata."""
    entries = {}
    for path in root.rglob('*'):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            entries[name] = {'link': os.readlink(path)}
        elif path.is_file():
            entries[name] = {'sha256': digest(path), 'mode': stat.S_IMODE(path.stat().st_mode)}
        elif not path.is_dir():
            raise ValueError('Unexpected package entry: ' + name)
    return entries


def protected_entitlements(profile):
    """Select only this helper's own Keychain group from an Apple profile."""
    decoded = subprocess.run(['/usr/bin/security', 'cms', '-D', '-i', str(profile)],
                             capture_output=True, check=True)
    value = plistlib.loads(decoded.stdout)
    identifier = 'LRH75YR6QW.' + PROTECTED_ID
    entitlements = value.get('Entitlements', {})
    def allows(pattern):
        return isinstance(pattern, str) and (pattern == identifier
            or pattern.endswith('*') and pattern.count('*') == 1 and identifier.startswith(pattern[:-1]))
    expires = value.get('ExpirationDate')
    certificates = [hashlib.sha1(cert).hexdigest() for cert in value.get('DeveloperCertificates', [])]
    if (value.get('TeamIdentifier') != ['LRH75YR6QW']
        or 'OSX' not in value.get('Platform', [])
        or value.get('ProvisionsAllDevices') is not True
        or not isinstance(expires, datetime.datetime)
        or expires.replace(tzinfo=datetime.timezone.utc) <= datetime.datetime.now(datetime.timezone.utc)
        or not allows(entitlements.get('com.apple.application-identifier'))
        or entitlements.get('com.apple.developer.team-identifier') != 'LRH75YR6QW'
        or not any(allows(group) for group in entitlements.get('keychain-access-groups', []))
        or entitlements.get('get-task-allow') or entitlements.get('com.apple.security.get-task-allow')
        or SIGNING_CERTIFICATE_SHA1 not in certificates):
        raise ValueError('Use an unexpired Socal Developer ID profile for ' + PROTECTED_ID
                         + ', authorizing its own Keychain group and the selected certificate')
    # The signed profile is embedded; macOS validates Apple's authorization
    # when launching the helper. Never substitute another team's entitlement.
    return {'com.apple.application-identifier': identifier,
            'com.apple.developer.team-identifier': 'LRH75YR6QW',
            'keychain-access-groups': [identifier]}


def build(args):
    if sys.platform != 'darwin' or os.uname().machine != 'arm64':
        raise ValueError('Apple Silicon macOS is required')
    if args.package and not args.sign:
        raise ValueError('An installer requires Socal signing; unsigned packages are not produced')
    profile = args.protected_profile.resolve(strict=True) if args.protected_profile else None
    key_entitlements = protected_entitlements(profile) if profile else None
    runtime_input = args.runtime.resolve(strict=True)
    output = args.output.expanduser().resolve()
    if output.exists() or output.is_symlink():
        raise ValueError('Use a fresh build folder; previous candidates are retained')
    size = sum(p.stat().st_size for p in runtime_input.rglob('*') if not p.is_symlink() and p.is_file())
    if shutil.disk_usage(output.parent).free < 3 * size + 3 * 1024**3:
        raise ValueError('Keep space for the candidate, installer intermediates and a 3 GiB reserve')
    output.mkdir(mode=0o700)
    evidence = output / 'evidence'; evidence.mkdir()

    def run(name, command, timeout=300):
        print(name, flush=True)
        with (evidence / (name + '.log')).open('x') as log:
            result = subprocess.run([str(v) for v in command], cwd=REPO,
                                    stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        if result.returncode:
            raise RuntimeError('Build stopped at ' + str(evidence / (name + '.log')))
        return (evidence / (name + '.log')).read_text(errors='replace')

    source = REPO / 'apps/macos-native/Sources'
    app = output / 'payload/Applications/Josi.app'
    resources = app / 'Contents/Resources'; resources.mkdir(parents=True)
    executables = app / 'Contents/MacOS'; executables.mkdir()
    run('compile-native-josi', ['xcrun', 'swiftc', '-swift-version', '6', '-parse-as-library', '-O',
                                '-target', 'arm64-apple-macos14.2', '-module-cache-path', output / 'module-cache',
                                '-o', executables / 'Josi', *sorted(source.glob('*.swift')),
                                REPO / 'packaging/macos/NativeAuthorization.swift',
                                REPO / 'apps/automation-macos/Sources/WorkspaceMachine.swift'])
    (output / 'native-app-entitlements.plist').write_bytes(plistlib.dumps({'com.apple.security.virtualization': True}))
    copy_file(REPO / 'packaging/macos/Josi.png', resources / 'Josi.png')
    icons = output / 'Josi.iconset'; icons.mkdir()
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            name = f'icon_{size}x{size}' + ('@2x' if scale == 2 else '') + '.png'
            run('icon-' + name, ['/usr/bin/sips', '-z', size * scale, size * scale,
                                resources / 'Josi.png', '--out', icons / name])
    run('create-app-icon', ['/usr/bin/iconutil', '-c', 'icns', icons, '-o', resources / 'Josi.icns'])
    info = {
        'CFBundleIdentifier': APP_ID, 'CFBundleName': 'Josi', 'CFBundleDisplayName': 'Josi',
        'CFBundleExecutable': 'Josi', 'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': '0.7.0',
        'CFBundleVersion': '20261020.6', 'CFBundleIconFile': 'Josi.icns', 'LSMinimumSystemVersion': '14.2',
        'NSHighResolutionCapable': True, 'NSPrincipalClass': 'NSApplication',
        'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
        'JosiNativeClientProtocol': 1, 'JosiProtectedHostProtocol': 1,
        'JosiProtectedKeyProvisioned': bool(profile),
        'NSSystemAdministrationUsageDescription': 'Josi manages its local server when you request installation, updates or service changes.',
        'NSHumanReadableCopyright': 'Copyright SOCAL RECEPTIONIST LLC. AGPL-3.0-or-later; bundled notices apply.',
    }
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    for name in ('LICENSE', 'NOTICE'):
        copy_file(REPO / name, resources / name)
    print('Bundling the current offline server runtime', flush=True)
    runtime = resources / 'runtime'; tree(runtime_input, runtime)
    baseline_version = json.loads((runtime / 'app/package.json').read_text())['version']
    for group in ('packages', 'apps'):
        for package in (REPO / group).iterdir():
            if not (package / 'package.json').is_file() or package.name == 'desktop':
                continue
            target = runtime / 'app' / group / package.name; target.mkdir(parents=True, exist_ok=True)
            (target / 'package.json').write_bytes((package / 'package.json').read_bytes())
            if (package / 'tsconfig.json').exists() or (package / 'dist').exists():
                replace(package / 'dist', target / 'dist')
            link = runtime / 'app/node_modules/@josi-ce' / package.name
            link.parent.mkdir(parents=True, exist_ok=True)
            if link.is_symlink():
                link.unlink()
            if not link.exists():
                link.symlink_to(os.path.relpath(target, link.parent), target_is_directory=True)
    replace(REPO / 'packages/db/migrations', runtime / 'app/packages/db/migrations')
    (runtime / 'app/packages/db/migrate.mjs').write_bytes((REPO / 'packages/db/migrate.mjs').read_bytes())
    native = runtime / 'app/native'; native.mkdir(exist_ok=True)
    for name in ('lifecycle.py', 'maintenance.py', 'workspace_access.py', 'pkg-driver.py', 'unified-postinstall.py',
                 'Runtime.mjs', 'SubscriptionEnvironment.mjs', 'PythonRuntime.py',
                 'automation-workspace.py', 'automation-workspace-guardian.py'):
        (native / name).write_bytes((REPO / 'packaging/macos' / name).read_bytes())
    meta = json.loads((runtime / 'app/package.json').read_text()); meta['version'] = VERSION
    (runtime / 'app/package.json').write_text(json.dumps(meta, indent=2) + '\n')
    native_build = output / 'native-helpers'
    run('compile-protected-helpers', [sys.executable, '-B', REPO / 'scripts/macos/build-automation-components.py',
                                     '--protected-host-only', '--output', native_build])
    helpers = app / 'Contents/Helpers'; helpers.mkdir()
    # Data-protection Keychain access requires a provisioned app-like bundle,
    # including for a private command-line helper. The socket consent helper
    # does not use that Keychain and retains its existing fixed executable path.
    key_bundle = helpers / 'JosiProtectedKeyHost.app'
    (key_bundle / 'Contents/MacOS').mkdir(parents=True)
    copy_file(native_build / 'JosiProtectedKeyHost', key_bundle / 'Contents/MacOS/JosiProtectedKeyHost')
    (key_bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': PROTECTED_ID, 'CFBundleName': 'Josi Protected Key Host',
        'CFBundleExecutable': 'JosiProtectedKeyHost', 'CFBundlePackageType': 'APPL',
        'CFBundleShortVersionString': '0.7.0', 'CFBundleVersion': info['CFBundleVersion'],
        'LSMinimumSystemVersion': '14.2', 'LSUIElement': True,
    }))
    if profile:
        copy_file(profile, key_bundle / 'Contents/embedded.provisionprofile')
        (output / 'protected-key-entitlements.plist').write_bytes(plistlib.dumps(key_entitlements))
    copy_file(native_build / 'JosiDeviceConsentHost', helpers / 'JosiDeviceConsentHost')

    uninstaller = output / 'payload/Applications/Uninstall Josi.app'
    ur = uninstaller / 'Contents/Resources'; ur.mkdir(parents=True)
    um = uninstaller / 'Contents/MacOS'; um.mkdir()
    run('compile-uninstaller', ['xcrun', 'swiftc', '-parse-as-library', '-O', '-target', 'arm64-apple-macos14.2',
                                '-module-cache-path', output / 'module-cache', '-o', um / 'JosiUninstall',
                                *[REPO / 'packaging/macos' / name for name in
                                  ('UninstallApp.swift', 'NativeAuthorization.swift', 'JosiArtworkView.swift', 'DiagnosticLog.swift')]])
    up = dict(info)
    up.update(CFBundleIdentifier='com.heyjosi.ce.uninstaller', CFBundleName='Uninstall Josi',
              CFBundleDisplayName='Uninstall Josi', CFBundleExecutable='JosiUninstall',
              NSSystemAdministrationUsageDescription='Remove Josi services and apps using the removal option you choose.',
              NSAppBundlesUsageDescription='Remove the Josi apps you chose to uninstall.',
              NSAppDataUsageDescription='Remove Josi data only when you choose Complete removal.')
    for key in ('JosiNativeClientProtocol', 'JosiProtectedHostProtocol', 'JosiProtectedKeyProvisioned', 'NSAppTransportSecurity'):
        up.pop(key, None)
    (uninstaller / 'Contents/Info.plist').write_bytes(plistlib.dumps(up))
    for name in ('Josi.png', 'Josi.icns', 'LICENSE', 'NOTICE'):
        copy_file(resources / name, ur / name)
    minimal = ur / 'runtime'
    (minimal / 'python/bin').mkdir(parents=True); (minimal / 'python/lib').mkdir()
    copy_file(runtime / 'python/bin/python3.11', minimal / 'python/bin/python3.11')
    tree(runtime / 'python/lib/python3.11', minimal / 'python/lib/python3.11', ignore=('site-packages',))
    (minimal / 'app/native').mkdir(parents=True)
    (minimal / 'app/package.json').write_text(json.dumps({'version': VERSION}) + '\n')
    for name in ('uninstall.py', 'lifecycle.py', 'workspace_access.py'):
        copy_file(REPO / 'packaging/macos' / name, minimal / 'app/native' / name)
    tree(runtime / 'licenses', minimal / 'licenses')

    def sign(name, path, identifier=None, entitlements=None):
        command = ['/usr/bin/codesign', '--force', '--keychain', KEYCHAIN, '--sign', APP_IDENTITY,
                   '--options', 'runtime', '--timestamp']
        if identifier:
            command += ['--identifier', identifier]
        if entitlements:
            command += ['--entitlements', entitlements]
        run(name, command + [path], timeout=180)

    if args.sign:
        sign('sign-JosiProtectedKeyHost', key_bundle, PROTECTED_ID,
             output / 'protected-key-entitlements.plist' if profile else None)
        sign('sign-JosiDeviceConsentHost', helpers / 'JosiDeviceConsentHost', 'com.heyjosi.ce.device-consent')
    run('runtime-inventory', [sys.executable, '-B', REPO / 'scripts/macos/inventory.py', runtime, '--hash-only'])
    run('uninstaller-inventory', [sys.executable, '-B', REPO / 'scripts/macos/inventory.py', minimal, '--hash-only'])
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    provenance = {
        'schemaVersion': 1, 'version': VERSION, 'sourceCommit': revision,
        'workingTreeModified': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO).strip()),
        'client': 'SwiftUI/AppKit', 'electronIncluded': False, 'baselineRuntimeVersion': baseline_version,
        'protectedKeyProvisioned': bool(profile),
        'signed': args.sign, 'signingIdentity': APP_IDENTITY if args.sign else None,
        'installed': False, 'functionalAcceptancePassed': False, 'notarized': False,
        'builtAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    (resources / 'unified-build.json').write_text(json.dumps(provenance, indent=2) + '\n')
    if args.sign:
        sign('sign-native-josi', app, entitlements=output / 'native-app-entitlements.plist')
        sign('sign-native-uninstaller', uninstaller)
        for name, bundle in (('josi', app), ('uninstaller', uninstaller)):
            run('verify-' + name, ['/usr/bin/codesign', '--verify', '--deep', '--strict', bundle])
            identity = run('identity-' + name, ['/usr/bin/codesign', '-d', '--verbose=4', bundle])
            if ('Authority=' + APP_IDENTITY) not in identity or 'TeamIdentifier=LRH75YR6QW' not in identity or 'Timestamp=' not in identity:
                raise ValueError('Unexpected signing authority')
    if args.package:
        components = output / 'components.plist'
        components.write_bytes(plistlib.dumps([
            {'RootRelativeBundlePath': 'Applications/' + name, 'BundleIsRelocatable': False,
             'BundleIsVersionChecked': False, 'BundleHasStrictIdentifier': True, 'BundleOverwriteAction': 'upgrade'}
            for name in ('Josi.app', 'Uninstall Josi.app')]))
        scripts = output / 'installer-scripts'; scripts.mkdir()
        postinstall = scripts / 'postinstall'
        postinstall.write_text('#!/bin/sh\nset -eu\nexec "/Applications/Josi.app/Contents/Resources/runtime/python/bin/python3.11" -I -B "/Applications/Josi.app/Contents/Resources/runtime/app/native/unified-postinstall.py"\n')
        postinstall.chmod(0o755)
        run('build-component', ['/usr/bin/pkgbuild', '--root', output / 'payload', '--component-plist', components,
                                '--identifier', APP_ID + '.pkg', '--version', '0.7.0.7', '--install-location', '/',
                                '--scripts', scripts, output / 'application.pkg'])
        distribution = output / 'Distribution.xml'
        distribution.write_text('''<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
 <title>Josi</title>
 <options customize="never" require-scripts="true" hostArchitectures="arm64" rootVolumeOnly="true"/>
 <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
 <allowed-os-versions><os-version min="14.2"/></allowed-os-versions>
 <choices-outline><line choice="josi"/></choices-outline>
 <choice id="josi" title="Josi" visible="false" start_selected="true" start_enabled="false"><pkg-ref id="com.heyjosi.ce.unified.pkg"/></choice>
 <pkg-ref id="com.heyjosi.ce.unified.pkg" version="0.7.0.7" onConclusion="none">application.pkg</pkg-ref>
</installer-gui-script>
''')
        package = output / 'Install Josi.pkg'
        run('sign-installer', ['/usr/bin/productbuild', '--distribution', distribution, '--package-path', output,
                               '--sign', INSTALLER_IDENTITY, '--keychain', KEYCHAIN, '--timestamp', package])
        verdict = run('verify-installer-signature', ['/usr/sbin/pkgutil', '--check-signature', package])
        if INSTALLER_IDENTITY not in verdict:
            raise ValueError('Unexpected installer signing authority')
        # Verify the deliverable rather than only its staging inputs. Run this
        # under the same signing-capable environment: restricted sandboxes can
        # make codesign report invalid signatures for byte-identical copies.
        expanded = output / 'expanded'
        run('expand-installer', ['/usr/sbin/pkgutil', '--expand-full', package, expanded])
        restored = expanded / 'application.pkg/Payload'
        before = package_contents(output / 'payload')
        after = package_contents(restored)
        if before != after:
            raise ValueError('The installer payload differs from the signed staging files')
        for name, bundle in (('josi', 'Josi.app'), ('uninstaller', 'Uninstall Josi.app')):
            run('verify-packaged-' + name, ['/usr/bin/codesign', '--verify', '--deep', '--strict',
                                            restored / 'Applications' / bundle])
        (evidence / 'package-integrity.json').write_text(json.dumps({
            'matchedEntries': len(before), 'bytesModesAndLinksMatch': True,
            'extractedAppSignaturesVerified': True,
        }, indent=2) + '\n')
        (output / 'SHA256SUMS.txt').write_text(digest(package) + '  Install Josi.pkg\n')
    (output / 'build.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(json.dumps({'app': str(app), 'uninstaller': str(uninstaller), 'signed': args.sign,
                      'installer': str(output / 'Install Josi.pkg') if args.package else None}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sign', action='store_true')
    parser.add_argument('--package', action='store_true')
    parser.add_argument('--protected-profile', type=Path,
                        help='Apple-issued Socal Developer ID provisioning profile for the private biometric key helper')
    build(parser.parse_args())
