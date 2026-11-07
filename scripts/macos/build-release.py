"""Build the Josi CE release for Mac and, if asked, attach it to the GitHub
release the Windows and Linux installers share.

  python3 scripts/macos/build-release.py --version 1.0.0 --runtime <staged runtime> \
      --protected-profile <Apple profile> [--notarize-profile josi-notary] [--publish] [--skip-code]

Runs on the Apple Silicon Mac that holds the Socal Receptionist LLC signing
identities. It orders the existing scripts: the server and web build, the
signed native app and installer (build-native-unified.py), Apple notarization
and stapling, then a release folder with the public file name, SHA256SUMS.txt
and RELEASE-NOTES.md. Nothing here installs, launches or changes server data.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
REPOSITORY = 'vaxman14/josi-ce'


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def run(command, **kwargs):
    print('+ ' + ' '.join(str(part) for part in command), flush=True)
    return subprocess.run([str(part) for part in command], check=True, **kwargs)


def step(title):
    print('\n== ' + title, flush=True)


def notarize(package, profile, evidence):
    """Submit the signed installer to Apple and staple the ticket; refuse anything but Accepted."""
    step('Apple notarization (this waits for Apple, usually a few minutes)')
    submission = run(['xcrun', 'notarytool', 'submit', package, '--keychain-profile', profile,
                      '--wait', '--output-format', 'json'], capture_output=True, text=True)
    (evidence / 'notarization.json').write_text(submission.stdout)
    result = json.loads(submission.stdout)
    if result.get('status') != 'Accepted':
        log = subprocess.run(['xcrun', 'notarytool', 'log', str(result.get('id', '')), '--keychain-profile', profile],
                             capture_output=True, text=True)
        (evidence / 'notarization-log.json').write_text(log.stdout)
        raise SystemExit('Apple did not accept the installer: ' + str(result.get('status'))
                         + '. The log is in ' + str(evidence / 'notarization-log.json'))
    run(['xcrun', 'stapler', 'staple', package])
    run(['xcrun', 'stapler', 'validate', package])
    assessment = run(['spctl', '--assess', '--verbose=4', '--type', 'install', package],
                     capture_output=True, text=True)
    (evidence / 'gatekeeper.txt').write_text(assessment.stdout + assessment.stderr)
    if 'accepted' not in (assessment.stdout + assessment.stderr):
        raise SystemExit('Gatekeeper did not accept the stapled installer')
    return result['id']


def publish(version, release, package_name):
    """Create the draft release, or attach to the one another platform created,
    merging our checksum line into the shared SHA256SUMS.txt."""
    tag = 'v' + version
    step('GitHub release ' + tag)
    exists = subprocess.run(['gh', 'release', 'view', tag, '--repo', REPOSITORY],
                            capture_output=True).returncode == 0
    if not exists:
        run(['gh', 'release', 'create', tag, '--repo', REPOSITORY, '--draft', '--title', 'Josi CE ' + version,
             '--notes-file', release / 'RELEASE-NOTES.md', release / package_name, release / 'SHA256SUMS.txt'])
        print('Draft release ' + tag + ' created. Attach the Windows and Linux files, then press Publish on GitHub.')
        return
    merged = Path(tempfile.mkdtemp(prefix='josi-sums-'))
    subprocess.run(['gh', 'release', 'download', tag, '--repo', REPOSITORY, '--pattern', 'SHA256SUMS.txt',
                    '--dir', str(merged)], capture_output=True)
    lines = {}
    for source in (release / 'SHA256SUMS.txt', merged / 'SHA256SUMS.txt'):
        if source.exists():
            for line in source.read_text().splitlines():
                parts = line.split('  ', 1)
                if len(parts) == 2 and parts[1] not in lines:
                    lines[parts[1]] = line
    (merged / 'SHA256SUMS.txt').write_text('\n'.join(lines[name] for name in sorted(lines)) + '\n')
    run(['gh', 'release', 'upload', tag, '--repo', REPOSITORY, '--clobber', release / package_name,
         merged / 'SHA256SUMS.txt'])
    print('Attached to the existing release ' + tag + ' (still a draft if it was one).')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--version', required=True, help='Release version, like 1.0.0')
    parser.add_argument('--runtime', type=Path, required=True,
                        help='The staged offline server runtime (scripts/macos/stage.py)')
    parser.add_argument('--protected-profile', type=Path,
                        help='Apple-issued Socal Developer ID profile for the biometric key helper')
    parser.add_argument('--notarize-profile',
                        help='notarytool keychain profile name saved with "xcrun notarytool store-credentials"')
    parser.add_argument('--output-root', type=Path,
                        default=Path('~/Documents/Josi Mac Native/JosiDrive/Artifacts').expanduser(),
                        help='Where the build folder and the releases folder go')
    parser.add_argument('--publish', action='store_true', help='Attach the result to the GitHub release v<version>')
    parser.add_argument('--skip-code', action='store_true', help='Skip npm ci, tsc and the web build')
    parser.add_argument('--skip-notarize', action='store_true',
                        help='Sign only; a public download needs notarization')
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?', args.version):
        raise SystemExit('Use --version like 1.0.0')
    if sys.platform != 'darwin' or os.uname().machine != 'arm64':
        raise SystemExit('The Apple Silicon Mac with the Socal signing identities is required')
    if args.publish and shutil.which('gh') is None:
        raise SystemExit('gh (GitHub CLI, signed in) is required for --publish')
    if not args.skip_notarize and not args.notarize_profile:
        raise SystemExit('Give --notarize-profile <name> (saved once with "xcrun notarytool store-credentials <name>"), '
                         'or --skip-notarize for a local test build')
    runtime = args.runtime.expanduser().resolve(strict=True)
    stamp = time.strftime('%Y%m%d-%H%M%S', time.gmtime())
    output = args.output_root.expanduser().resolve() / ('josi-ce-' + args.version + '-macos-' + stamp)
    if not args.skip_code:
        step('Server and web build')
        run(['npm', 'ci', '--no-audit', '--no-fund'], cwd=REPO)
        run(['npx', 'tsc', '-b'], cwd=REPO)
        run(['npm', '--prefix', 'apps/web', 'run', 'build'], cwd=REPO)
    step('Signed native app and installer (' + args.version + ')')
    command = [sys.executable, '-B', REPO / 'scripts/macos/build-native-unified.py', '--version', args.version,
               '--runtime', runtime, '--output', output, '--sign', '--package']
    if args.protected_profile:
        command += ['--protected-profile', args.protected_profile.expanduser().resolve(strict=True)]
    else:
        print('No --protected-profile: the Touch ID key helper is not provisioned in this build.', flush=True)
    run(command, cwd=REPO)
    package = output / 'Install Josi.pkg'
    evidence = output / 'evidence'
    if not args.skip_notarize:
        notarize(package, args.notarize_profile, evidence)
    step('Release folder')
    release = args.output_root.expanduser().resolve() / 'releases' / args.version
    if release.exists():
        shutil.rmtree(release)
    release.mkdir(parents=True)
    package_name = 'Josi-' + args.version + '-macOS-arm64.pkg'
    shutil.copyfile(package, release / package_name)
    sha256 = digest(release / package_name)
    (release / 'SHA256SUMS.txt').write_text(sha256 + '  ' + package_name + '\n')
    notes = ['Josi ' + args.version + ' for Mac (Apple Silicon, macOS 14.2 or newer).', '',
             'Download ' + package_name + ', open it, and Josi opens when the installer is done. About 6 GB of disk.', '',
             'Check the file: its SHA-256 is in SHA256SUMS.txt, and the installer is signed by Socal Receptionist LLC'
             + (' and notarized by Apple.' if not args.skip_notarize else '. (This build is NOT notarized.)'), '',
             'Source and help: https://github.com/vaxman14/josi-ce and https://get.heyjosi.com']
    (release / 'RELEASE-NOTES.md').write_text('\n'.join(notes) + '\n')
    (release / 'build.json').write_text(json.dumps({
        'version': args.version, 'installer': package_name, 'sha256': sha256,
        'bytes': (release / package_name).stat().st_size, 'buildFolder': str(output),
        'notarized': not args.skip_notarize, 'builtAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }, indent=2) + '\n')
    print('Installer: ' + str(release / package_name) + ' (' + str((release / package_name).stat().st_size // 1048576)
          + ' MB, sha256 ' + sha256 + ')')
    if args.publish:
        publish(args.version, release, package_name)


if __name__ == '__main__':
    main()
