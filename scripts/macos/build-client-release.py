"""Build Josi Client for Mac: the connect-only app, signed, notarized and packaged.

  python3 scripts/macos/build-client-release.py --version 1.2.0 [--notarize-profile josi-notary]

Runs on the Mac that holds the Socal Receptionist LLC identities. Nothing here
installs, launches or publishes anything.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import time

REPO = Path(__file__).resolve().parents[2]
APP_IDENTITY = 'Developer ID Application: Socal Receptionist LLC (LRH75YR6QW)'
INSTALLER_IDENTITY = 'Developer ID Installer: Socal Receptionist LLC (LRH75YR6QW)'
spec = importlib.util.spec_from_file_location('release', REPO / 'scripts/macos/build-release.py')
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--version', required=True)
    parser.add_argument('--notarize-profile', default='josi-notary')
    parser.add_argument('--output-root', type=Path, default=Path.home() / 'JosiBuild/Artifacts')
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?', args.version):
        raise SystemExit('Use --version like 1.2.0')
    short = args.version.split('-', 1)[0]
    build_number = time.strftime('%Y%m%d.%H%M', time.gmtime())
    root = args.output_root.expanduser().resolve()
    output = root / ('josi-client-' + args.version + '-macos-' + time.strftime('%Y%m%d-%H%M%S', time.gmtime()))
    evidence = output / 'evidence'; evidence.mkdir(parents=True)

    release.step('Signed Josi Client app')
    release.run(['xcrun', 'xcodebuild', '-project', REPO / 'apps/macos-native/Josi.xcodeproj', '-scheme', 'Josi Client',
                 '-configuration', 'Release', '-derivedDataPath', output / 'xcode', 'CODE_SIGN_STYLE=Manual',
                 'CODE_SIGN_IDENTITY=' + APP_IDENTITY, 'DEVELOPMENT_TEAM=LRH75YR6QW', 'OTHER_CODE_SIGN_FLAGS=--timestamp',
                 'MARKETING_VERSION=' + short, 'CURRENT_PROJECT_VERSION=' + build_number, 'build'],
                stdout=(evidence / 'xcodebuild.log').open('w'), stderr=subprocess.STDOUT)
    app = output / 'xcode/Build/Products/Release/Josi Client.app'
    resources = app / 'Contents/Resources'
    masko = output / 'xcode/SourcePackages/checkouts/masko-player'
    (resources / 'third-party').mkdir()
    for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
        shutil.copyfile(masko / name, resources / 'third-party' / ('masko-player-' + name))
    for name in ('LICENSE', 'NOTICE'):
        shutil.copyfile(REPO / name, resources / name)
    release.run(['codesign', '--force', '--options', 'runtime', '--timestamp', '--sign', APP_IDENTITY,
                 '--entitlements', REPO / 'apps/macos-native/Xcode/Josi.entitlements', app])
    release.run(['codesign', '--verify', '--deep', '--strict', '--verbose=2', app])

    release.step('Signed installer')
    component = output / 'component.pkg'
    package = output / 'Install Josi Client.pkg'
    release.run(['pkgbuild', '--component', app, '--install-location', '/Applications', '--identifier', 'com.heyjosi.client.pkg',
                 '--version', short, component])
    release.run(['productbuild', '--package', component, '--sign', INSTALLER_IDENTITY, '--timestamp', package])
    release.run(['pkgutil', '--check-signature', package])
    release.notarize(package, args.notarize_profile, evidence)

    folder = root / 'releases' / args.version; folder.mkdir(parents=True, exist_ok=True)
    name = 'Josi-Client-' + args.version + '-macOS-arm64.pkg'
    shutil.copyfile(package, folder / name)
    sha256 = release.digest(folder / name)
    with (folder / 'SHA256SUMS.txt').open('a') as sums:
        sums.write(sha256 + '  ' + name + '\n')
    (evidence / 'build.json').write_text(json.dumps({'version': args.version, 'installer': name, 'sha256': sha256,
                                                     'bytes': (folder / name).stat().st_size, 'notarized': True}, indent=2) + '\n')
    print('Installer: ' + str(folder / name) + ' (sha256 ' + sha256 + ')')


if __name__ == '__main__':
    main()
