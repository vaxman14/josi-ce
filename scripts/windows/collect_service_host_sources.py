"""Retain the complete reviewed service-host source/build and runtime notices.

Build-only tool. Archive contents are inspected as data, never executed.
The upstream sources plus a complete patch and locked build recipe cover the
merged WinSW, log4net and YamlDotNet runtime components.
"""
import difflib
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

REPO = Path(__file__).resolve().parents[2]
BASE = REPO / 'artifacts/windows-native'
SOURCES = BASE / 'sources/winsw'
COMMIT = 'eef5bade59fca0254e387ac73ed7625ba6aa7147'
ARCHIVES = [
    ('WinSW', '2.12.0', 'MIT', 'winsw-' + COMMIT + '.zip',
     '15581a065018d6828041dfd764876b1bf9087a8fe0cc26506e1e9f5a81951c43',
     'https://codeload.github.com/winsw/winsw/zip/' + COMMIT),
    ('log4net', '3.5.0', 'Apache-2.0', 'apache-log4net-source-3.5.0.zip',
     '77800103bca75ef521115704c6dcbd0f12d94b5e614a990b7a6b8b8a8492c553',
     'https://downloads.apache.org/logging/log4net/3.5.0/apache-log4net-source-3.5.0.zip'),
    ('YamlDotNet', '8.1.2', 'MIT', 'yamldotnet-60139851a1fcf9e252b9336a4fe69235137694de.zip',
     'b1a6bd00d92a9a577ba5ded2d8197d69ddf4f6cee3b6fbe099bc761755706444',
     'https://codeload.github.com/aaubry/YamlDotNet/zip/60139851a1fcf9e252b9336a4fe69235137694de'),
]


def digest(path, algorithm='sha256'):
    value = hashlib.new(algorithm)
    with path.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            value.update(block)
    return value.digest()


def main():
    if sys.platform != 'win32' or Path(sys.executable).resolve() != (BASE / 'tools/python-3.12.15/python/python.exe').resolve():
        raise ValueError('Use the pinned private Windows Python')
    build = json.loads((BASE / 'evidence/service-host-build-pinned1.json').read_text(encoding='utf-8-sig'))
    binary = Path(build['binary'])
    if digest(binary).hex() != build['sha256']:
        raise ValueError('Reviewed service host has changed')
    root = SOURCES / 'josi-windows1'
    root.mkdir(exist_ok=True)
    components = []
    for name, version, license_id, filename, expected, url in ARCHIVES:
        archive = SOURCES / filename
        if archive.is_symlink() or digest(archive).hex() != expected:
            raise ValueError('Reviewed source archive has changed')
        notices = []
        with zipfile.ZipFile(archive) as source:
            for item in source.infolist():
                if PurePosixPath(item.filename).name.lower() not in ('license', 'license.txt', 'notice', 'notice.txt'):
                    continue
                if item.file_size > 128 * 1024:
                    raise ValueError('Source notice exceeds its bound')
                target = root / 'notices' / name / PurePosixPath(item.filename).name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read(item))
                notices.append({'path': target.relative_to(BASE).as_posix(), 'sha256': digest(target).hex()})
        if not notices:
            raise ValueError('A merged runtime component lacks license evidence')
        components.append({'name': name, 'version': version, 'license': license_id, 'sourceUrl': url,
                           'sourceArchive': archive.relative_to(BASE).as_posix(), 'sourceSha256': expected,
                           'notices': notices})

    # Compare every upstream tracked file, not only the one-line SCM change.
    # This includes framework/dependency retargeting and rejects unrecorded edits.
    changes = []
    with zipfile.ZipFile(SOURCES / ARCHIVES[0][3]) as upstream:
        prefix = 'winsw-' + COMMIT + '/'
        for entry in upstream.infolist():
            if entry.is_dir():
                continue
            relative = entry.filename.removeprefix(prefix)
            if entry.filename == relative or '..' in PurePosixPath(relative).parts:
                raise ValueError('Unsafe upstream source path')
            actual = Path(build['source']) / relative
            before = upstream.read(entry)
            after = actual.read_bytes()
            if before != after:
                changes.extend(difflib.unified_diff(before.decode('utf-8-sig').splitlines(keepends=True),
                    after.decode('utf-8-sig').splitlines(keepends=True), fromfile='a/' + relative, tofile='b/' + relative))
    (root / 'josi-windows1.patch').write_text(''.join(changes), encoding='utf-8', newline='\n')
    (root / 'CHANGES.txt').write_text(
        'Josi CE service host 2.12.0+josi.windows1\n'
        'Based on WinSW v2.12.0, commit ' + COMMIT + '.\n'
        'Changes: request SCM Connect for child completion; target net462; use\n'
        'log4net 3.5.0; pin build-only reference assemblies and analyzer versions.\n'
        'The complete patch, upstream sources and locked build recipe accompany\n'
        'the binary. No upstream endorsement is implied.\n', encoding='utf-8')

    build_inputs = []
    locks = REPO / 'packaging/windows/service-host-dependencies'
    verified = json.loads((BASE / 'evidence/service-host-build-inputs.json').read_text(encoding='utf-8-sig'))
    if verified.get('passed') is not True:
        raise ValueError('SDK verification of locked build inputs is required')
    verified = {(item['name'].lower(), item['version']): item for item in verified['packages']}
    for lock in sorted(locks.glob('*.lock.json')):
        data = json.loads(lock.read_text())
        for framework, packages in data['dependencies'].items():
            if framework != '.NETFramework,Version=v4.6.2' and packages:
                raise ValueError('Unexpected service-host target framework')
            for name, item in packages.items():
                if item['type'] == 'Project':
                    continue
                package = BASE / 'cache/nuget' / name.lower() / item['resolved'] / (name.lower() + '.' + item['resolved'] + '.nupkg')
                review = verified[(name.lower(), item['resolved'])]
                if (review['contentHash'] != item['contentHash'] or review['sha256'] != digest(package).hex()
                        or review['upstreamSignatureVerified'] is not True):
                    raise ValueError('Locked NuGet package integrity failed')
                build_inputs.append({'name': name, 'version': item['resolved'], 'sha256': digest(package).hex(),
                                     'runtimeMerged': name.lower() in ('log4net', 'yamldotnet')})
        target = root / 'build' / lock.relative_to(REPO)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(lock.read_bytes())
    for relative in ('scripts/windows/Build-ServiceHost.ps1', 'scripts/windows/Verify-ServiceHostInputs.ps1', 'packaging/windows/winsw-least-privilege.patch'):
        target = root / 'build' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((REPO / relative).read_bytes())
    report = {'schemaVersion': 1, 'variant': build['variant'], 'binarySha256': build['sha256'],
              'runtimeComponents': components, 'lockedBuildInputs': build_inputs,
              'runtimeLicenseConditions': 'Retain MIT copyright/license files; retain Apache LICENSE/NOTICE and mark local modifications.',
              'completeReleaseNoticesAttached': False, 'redistributionApproved': False,
              'sourcePatch': (root / 'josi-windows1.patch').relative_to(BASE).as_posix(),
              'sourcePatchSha256': digest(root / 'josi-windows1.patch').hex(),
              'serviceAcceptancePassed': False, 'bitIdenticalRebuildProven': False}
    (BASE / 'evidence/service-host-source-closure.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('Retained all three merged runtime sources, notices, complete patch and verified locked build inputs.')


if __name__ == '__main__':
    main()
