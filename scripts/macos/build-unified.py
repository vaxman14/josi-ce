"""Build an unsigned, single-app candidate from explicit local runtime inputs.

No installation, service changes, downloads, Keychain access or publishing.
The optional --package creates one installer choice; local hosting is chosen
inside Josi after install, so remote-only use does not create a second server.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parents[2]
VERSION = '0.7.0-unified.1'
IDENTIFIER = 'com.heyjosi.ce.unified'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def clone_file(source, destination):
    # APFS clones keep a candidate from duplicating a multi-GB runtime. Refuse
    # instead of silently copying it onto a nearly full build volume.
    library = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    library.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    library.clonefile.restype = ctypes.c_int
    if library.clonefile(os.fsencode(source), os.fsencode(destination), 0):
        raise OSError(ctypes.get_errno(), 'APFS clone required; use an output folder on the input volume', str(source))
    return destination


def copy_tree(source, destination):
    shutil.copytree(source, destination, symlinks=True, copy_function=clone_file,
                    ignore=shutil.ignore_patterns('.DS_Store', '__pycache__'))


def replace_tree(source, destination):
    if not source.is_dir():
        raise ValueError('Build this source package first: ' + str(source))
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    copy_tree(source, destination)


def prepare(args):
    if sys.platform != 'darwin' or os.uname().machine != 'arm64':
        raise ValueError('Build the macOS candidate on Apple Silicon')
    output = args.output.expanduser().resolve()
    if output.exists() or output.is_symlink():
        raise ValueError('Use a new output directory; existing builds are retained')
    electron = args.electron.resolve(strict=True)
    runtime_input = args.runtime.resolve(strict=True) if args.runtime else None
    lock = json.loads((REPO / 'packaging/macos/desktop-sources.lock.json').read_text())
    framework = electron / 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist'
    electron_version = plistlib.loads(framework.read_bytes()).get('CFBundleVersion')
    if electron_version != lock['electron']:
        raise ValueError('Electron version does not match the pinned desktop runtime')
    if args.package and runtime_input is None:
        raise ValueError('A unified installer must include the server runtime')
    if shutil.disk_usage(output.parent).free < 2 * 1024**3:
        raise ValueError('Keep at least 2 GiB available for source overlays and packaging')
    output.mkdir(mode=0o700)
    app = output / 'payload/Applications/Josi.app'
    app.parent.mkdir(parents=True)
    copy_tree(electron, app)
    resources = app / 'Contents/Resources'
    default = resources / 'default_app.asar'
    if default.exists():
        default.unlink()
    # Only this fresh candidate loses stale input signatures. Re-signing the
    # complete product and updating its inventory is a later release step.
    for signature in sorted(app.rglob('_CodeSignature'), reverse=True):
        if signature.is_dir() and not signature.is_symlink():
            shutil.rmtree(signature)
    source = resources / 'app'
    source.mkdir()
    copy_tree(REPO / 'apps/desktop/src', source / 'src')
    meta = json.loads((REPO / 'apps/desktop/package.json').read_text())
    meta.update(name='josi', productName='Josi', version=VERSION)
    (source / 'package.json').write_text(json.dumps(meta, indent=2) + '\n')
    protocol = source / 'node_modules/@josi-ce/protocol'
    protocol.mkdir(parents=True)
    shutil.copyfile(REPO / 'packages/protocol/package.json', protocol / 'package.json')
    copy_tree(REPO / 'packages/protocol/dist', protocol / 'dist')
    for name in ('LICENSE', 'NOTICE'):
        if (REPO / name).is_file():
            shutil.copyfile(REPO / name, resources / name)
    shutil.copyfile(REPO / 'packaging/macos/Josi.png', resources / 'Josi.png')
    executable = app / 'Contents/MacOS/Electron'
    executable.rename(executable.with_name('Josi'))
    info_path = app / 'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    info.update(CFBundleIdentifier=IDENTIFIER, CFBundleName='Josi', CFBundleDisplayName='Josi',
                CFBundleExecutable='Josi', CFBundleShortVersionString='0.7.0', CFBundleVersion='20261019.1',
                LSMinimumSystemVersion='14.2', NSHighResolutionCapable=True,
                NSSystemAdministrationUsageDescription='Josi manages the local server when you choose Run on this Mac.',
                NSDocumentsFolderUsageDescription='Josi accesses only local folders you choose.',
                NSDesktopFolderUsageDescription='Josi accesses only local folders you choose.',
                NSDownloadsFolderUsageDescription='Josi accesses only local folders you choose.')
    info.pop('CFBundleURLTypes', None)
    info_path.write_bytes(plistlib.dumps(info))
    sealed = subprocess.run([str(args.node.resolve(strict=True)), str(REPO / 'scripts/macos/seal-desktop-code.mjs'), str(app)],
                            check=True, capture_output=True, text=True, timeout=180)
    integrity = json.loads(sealed.stdout)
    if integrity.get('algorithm') != 'SHA256' or len(integrity.get('hash', '')) != 64:
        raise ValueError('The desktop integrity record is unavailable')
    info['ElectronAsarIntegrity'] = {'Resources/app.asar': {'algorithm': 'SHA256', 'hash': integrity['hash']}}
    info['JosiProtectedHostProtocol'] = 1
    info_path.write_bytes(plistlib.dumps(info))
    (resources / 'desktop-integrity.json').write_text(json.dumps(integrity, indent=2) + '\n')
    native_build = output / 'native-components'
    subprocess.run([sys.executable, '-B', str(REPO / 'scripts/macos/build-automation-components.py'),
                    '--protected-host-only', '--output', str(native_build)], check=True, timeout=240)
    helpers = app / 'Contents/Helpers'
    helpers.mkdir(exist_ok=True)
    protected_host = helpers / 'JosiProtectedKeyHost'
    shutil.copyfile(native_build / 'JosiProtectedKeyHost', protected_host)
    protected_host.chmod(0o755)
    if runtime_input:
        runtime = resources / 'runtime'
        copy_tree(runtime_input, runtime)
        # Refresh every server package, web build, migration and native helper.
        # An old runtime supplies offline native engines/dependencies, not old
        # application code or an old database schema.
        for group in ('packages', 'apps'):
            for package in (REPO / group).iterdir():
                if not (package / 'package.json').exists() or package.name == 'desktop':
                    continue
                target = runtime / 'app' / group / package.name
                target.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(package / 'package.json', target / 'package.json')
                if (package / 'tsconfig.json').exists() or (package / 'dist').exists():
                    replace_tree(package / 'dist', target / 'dist')
                link = runtime / 'app/node_modules/@josi-ce' / package.name
                link.parent.mkdir(parents=True, exist_ok=True)
                if link.is_symlink():
                    link.unlink()
                if not link.exists():
                    link.symlink_to(os.path.relpath(target, link.parent), target_is_directory=True)
        replace_tree(REPO / 'packages/db/migrations', runtime / 'app/packages/db/migrations')
        shutil.copyfile(REPO / 'packages/db/migrate.mjs', runtime / 'app/packages/db/migrate.mjs')
        native = runtime / 'app/native'
        native.mkdir(exist_ok=True)
        for name in ('lifecycle.py', 'maintenance.py', 'workspace_access.py', 'pkg-driver.py',
                     'Runtime.mjs', 'SubscriptionEnvironment.mjs', 'PythonRuntime.py'):
            shutil.copyfile(REPO / 'packaging/macos' / name, native / name)
        runtime_meta = json.loads((runtime / 'app/package.json').read_text())
        runtime_meta['version'] = VERSION
        (runtime / 'app/package.json').write_text(json.dumps(runtime_meta, indent=2) + '\n')
        subprocess.run([sys.executable, '-B', str(REPO / 'scripts/macos/inventory.py'),
                        str(runtime), '--hash-only'], check=True)
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO, text=True).strip())
    provenance = {'schemaVersion': 1, 'version': VERSION, 'sourceCommit': revision, 'workingTreeModified': dirty,
                  'electronVersion': electron_version, 'electronExecutableSha256': digest(electron / 'Contents/MacOS/Electron'),
                  'serverIncluded': runtime_input is not None, 'signed': False, 'validated': False,
                  'desktopAsarHeaderSha256': integrity['hash'], 'desktopFuses': integrity['fuses'],
                  'protectedHostSha256': digest(protected_host),
                  'builtAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    (resources / 'unified-build.json').write_text(json.dumps(provenance, indent=2) + '\n')
    if args.package:
        components = output / 'components.plist'
        components.write_bytes(plistlib.dumps([{'RootRelativeBundlePath': 'Applications/Josi.app',
            'BundleIsRelocatable': False, 'BundleIsVersionChecked': False,
            'BundleHasStrictIdentifier': True, 'BundleOverwriteAction': 'upgrade'}]))
        subprocess.run(['/usr/bin/pkgbuild', '--root', str(output / 'payload'), '--component-plist', str(components),
                        '--identifier', IDENTIFIER + '.pkg', '--version', '0.7.0.1', '--install-location', '/',
                        str(output / 'application.pkg')], check=True)
        distribution = output / 'Distribution.xml'
        distribution.write_text('''<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
 <title>Josi</title>
 <options customize="never" require-scripts="false" hostArchitectures="arm64" rootVolumeOnly="true"/>
 <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
 <allowed-os-versions><os-version min="14.2"/></allowed-os-versions>
 <choices-outline><line choice="josi"/></choices-outline>
 <choice id="josi" title="Josi" visible="false" start_selected="true" start_enabled="false"><pkg-ref id="com.heyjosi.ce.unified.pkg"/></choice>
 <pkg-ref id="com.heyjosi.ce.unified.pkg" version="0.7.0.1" onConclusion="none">application.pkg</pkg-ref>
</installer-gui-script>
''')
        subprocess.run(['/usr/bin/productbuild', '--distribution', str(distribution), '--package-path', str(output),
                        str(output / 'Josi-unsigned.pkg')], check=True)
    print(json.dumps({'app': str(app), 'package': str(output / 'Josi-unsigned.pkg') if args.package else None,
                      'serverIncluded': runtime_input is not None, 'signed': False, 'validated': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--electron', type=Path, required=True, help='Pinned Electron.app from the existing verified cache')
    parser.add_argument('--node', type=Path, required=True, help='Node 22.12+ used for pinned ASAR and fuse build tools')
    parser.add_argument('--runtime', type=Path, help='Existing staged native server runtime; required for installer builds')
    parser.add_argument('--output', type=Path, required=True, help='New candidate folder on the same APFS volume')
    parser.add_argument('--package', action='store_true', help='Also build the unsigned, one-choice installer')
    prepare(parser.parse_args())
