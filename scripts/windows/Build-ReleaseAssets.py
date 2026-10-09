"""Package accepted bytes once; local staging does not authorize publication."""
import hashlib
import json
from pathlib import Path
import re
import uuid
import zipfile
import argparse
import shutil

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'artifacts/windows-native'


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def record(path, name):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Linked or missing release input')
    return {'path': name, 'size': path.stat().st_size, 'sha256': sha(path)}


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--local-acceptance', action='store_true')
    args.add_argument('--reuse-runtime-assets-report', type=Path)
    options = args.parse_args()
    local = options.local_acceptance
    reusable = {}
    reuse_root = None
    if options.reuse_runtime_assets_report:
        prior = read(options.reuse_runtime_assets_report)
        reuse_root = Path(prior['output'])
        if not prior['archivesVerified'] or sha(reuse_root / 'release-manifest.json') != prior['manifestSha256']:
            raise ValueError('Retained runtime archive identity failed')
        reusable = {row['id']: row for row in read(reuse_root / 'release-manifest.json')['components'] if row['id'] != 'josi'}
    app = read(BASE / 'evidence/application-build.json')
    runtime = read(BASE / 'evidence/runtime-build.json')
    metadata = read(BASE / 'evidence/release-metadata.json')
    accepted = read(BASE / 'evidence/native-candidate-acceptance.json')
    sbom = read(BASE / 'evidence/release-sbom-validation.json')
    if local:
        accepted = read(BASE / 'evidence/onboarding-build-validation.json')
    if not accepted['passed'] or accepted['candidate'] != app['version'] or not sbom['passed'] or not sbom['formatAnnotationsValidated'] or metadata['candidate'] != app['version']:
        raise ValueError('Accepted payload and complete SBOM validation required')
    inventories = [Path(app['build']) / 'reports/payload-inventory.json', Path(runtime['reports']) / 'file-inventory.json']
    expected = [accepted['sourceInventorySha256'] if local else '5a82dd3f048dbfb67c72daddf093373ff100e64690522b9a7c28fd171842783b', runtime['inventorySha256']]
    # The application source inventory and payload inventory have separate hashes.
    if app['sourceInventorySha256'] != expected[0] or sha(inventories[1]) != expected[1]:
        raise ValueError('Accepted inventory identity changed')
    groups = {name: [] for name in ('josi', 'node', 'python', 'postgresql', 'caddy', 'voice-models')}
    for root, inventory in zip((Path(app['payload']), Path(runtime['payload'])), inventories):
        rows = read(inventory)
        if len(rows) != (app['files'] if root == Path(app['payload']) else runtime['files']):
            raise ValueError('Accepted payload count changed')
        for row in rows:
            name = row['path']
            if re.search(r'(^|/)(?:clamav|clamd|clamscan|freshclam)(?:\.exe|/|$)|\.(?:cvd|cld)$', name, re.I):
                raise ValueError('Native antivirus bundle is forbidden')
            path = root / name
            if record(path, name) != row:
                raise ValueError('Accepted payload bytes changed: ' + name)
            component = 'josi' if root == Path(app['payload']) else name.split('/')[0]
            groups[component].append((path, row))
    legal = Path(metadata['output'])
    for path in sorted(legal.rglob('*')):
        if path.is_file():
            name = 'licenses/' + path.relative_to(legal).as_posix()
            groups['josi'].append((path, record(path, name)))
    output = BASE / 'staging' / ('release-assets-' + uuid.uuid4().hex)
    output.mkdir()
    versions = {'josi': app['version'], 'node': '24.21.0', 'python': '3.12.15', 'postgresql': '16.15', 'caddy': '2.11.7', 'voice-models': '1.0.0'}
    licenses = {'josi': 'AGPL-3.0-or-later and retained dependencies', 'node': 'MIT and upstream third-party notices', 'python': 'Python-2.0 and retained dependencies',
                'postgresql': 'PostgreSQL and native dependency notices', 'caddy': 'Apache-2.0 and Go dependency notices', 'voice-models': 'Per-file retained model licenses'}
    upstream = {'josi': 'https://github.com/vaxman14/josi-ce/blob/main/LICENSE', 'node': 'https://github.com/nodejs/node/blob/v24.21.0/LICENSE',
                'python': 'https://docs.python.org/3.12/license.html', 'postgresql': 'https://www.postgresql.org/about/licence/',
                'caddy': 'https://github.com/caddyserver/caddy/blob/v2.11.7/LICENSE', 'voice-models': 'https://github.com/vaxman14/josi-ce/blob/main/services/voice-box/models.lock.json'}
    components = []
    for name, files in groups.items():
        asset = f'josi-windows-{name}-{app["version"]}-x64.zip'
        path = output / asset
        if name in reusable:
            retained = reusable[name]
            original = reuse_root / retained['asset']
            if sha(original) != retained['sha256'] or original.stat().st_size != retained['size']:
                raise ValueError('Retained runtime archive bytes changed')
            with zipfile.ZipFile(original) as archive:
                if json.loads(archive.read('inventories/' + name + '.json')) != [row for _, row in files]:
                    raise ValueError('Runtime inputs changed; reuse refused')
            shutil.copyfile(original, path)
        else:
            with zipfile.ZipFile(path, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
                for source, row in files:
                    archive.write(source, row['path'])
                archive.writestr('inventories/' + name + '.json', json.dumps([row for _, row in files], separators=(',', ':')))
        # Read back every member and CRC after compression; no payload rebuild.
        with zipfile.ZipFile(path) as archive:
            if archive.testzip() is not None or len(archive.infolist()) != len(files) + 1:
                raise ValueError('Archive verification failed')
        components.append({'id': name, 'version': versions[name], 'architecture': 'x64', 'asset': asset, 'size': path.stat().st_size, 'sha256': sha(path),
                           'url': f'https://github.com/vaxman14/josi-ce/releases/download/windows-v{app["version"]}/{asset}',
                           'license': licenses[name], 'licenseSource': upstream[name], 'redistributionEvidence': 'licenses/THIRD_PARTY_NOTICES.txt'})
        print(json.dumps({'component': name, 'files': len(files), 'archiveVerified': True}), flush=True)
    manifest = {'schemaVersion': 1, 'product': 'Josi CE Server', 'version': app['version'], 'architecture': 'x64', 'releaseTag': 'windows-v' + app['version'],
                'components': components, 'installable': local, 'localUnsignedAcceptance': local, 'licenseGatePassed': False, 'unsignedAcceptancePassed': False,
                'payloadAcceptancePassed': True, 'published': False, 'openLicenseGates': metadata['gaps'],
                'acceptanceScope': 'private offline unsigned physical acceptance; no redistribution approval' if local else 'accepted .5 payload; full thin-EXE installation acceptance is unfinished'}
    manifest_path = output / 'release-manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    report = {'packaged': True, 'archivesVerified': True, 'components': len(components), 'acceptedFilesVerified': app['files'] + runtime['files'],
              'nativeClamavExcluded': True, 'output': str(output), 'manifestSha256': sha(manifest_path), 'candidate': app['version'],
              'licenseGatePassed': False, 'installable': local, 'localUnsignedAcceptance': local, 'published': False, 'signed': False, 'releaseApproved': False}
    (BASE / 'evidence/release-assets.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
