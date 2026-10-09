"""Inventory the accepted bytes and retain notices without approving redistribution.

Unknown licenses and missing corresponding-source evidence are release blockers,
never silently inferred from a package name or a successful runtime test.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import uuid
import argparse

REPO = Path(__file__).resolve().parents[2]
BASE = REPO / 'artifacts/windows-native'


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--local-acceptance', action='store_true')
    local = args.parse_args().local_acceptance
    app = read(BASE / 'evidence/application-build.json')
    runtime = read(BASE / 'evidence/runtime-build.json')
    accepted = read(BASE / 'evidence/native-candidate-acceptance.json')
    if local:
        proof = read(BASE / 'evidence/onboarding-build-validation.json')
        if not proof['passed'] or proof['candidate'] != app['version'] or proof['sourceInventorySha256'] != app['sourceInventorySha256']:
            raise ValueError('Verified new candidate inputs required')
    elif not accepted['passed'] or app['version'] != accepted['candidate']:
        raise ValueError('Only the accepted candidate can enter release metadata')
    output = BASE / 'staging' / ('release-metadata-' + uuid.uuid4().hex)
    output.mkdir()
    licenses = output / 'licenses'
    licenses.mkdir()
    notices = []
    for label, root in [('josi', Path(app['payload'])), ('runtime', Path(runtime['payload']))]:
        for path in root.rglob('*'):
            if not path.is_file() or not re.fullmatch(r'(?:LICENSE|LICENCE|COPYING|NOTICE|THIRD[-_]PARTY[-_]NOTICES)(?:[._-].*)?', path.name, re.I):
                continue
            if path.is_symlink() or path.stat().st_nlink != 1 or path.stat().st_size > 4 * 1024 * 1024:
                raise ValueError('Unsafe notice file')
            relative = Path(label) / path.relative_to(root)
            target = licenses / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            notices.append({'path': relative.as_posix(), 'size': target.stat().st_size, 'sha256': sha(target)})
    python = read(BASE / 'evidence/python-source-closure.json')
    missing = read(BASE / 'evidence/python-missing-source-review.json')
    source_overrides = {row['name']: row for row in missing['components']}
    components = []
    gaps = []
    sources = []
    if local:
        launcher = read(BASE / 'evidence/onboarding-launcher.json')
        if not launcher['passed'] or not launcher['testsPassed'] or sha(launcher['binary']) != launcher['sha256']:
            raise ValueError('Verified launcher identity required')
        components.append({'type': 'application', 'bom-ref': 'josi:launcher:' + app['version'],
                           'name': 'Josi Windows onboarding launcher', 'version': app['version'],
                           'hashes': [{'alg': 'SHA-256', 'content': launcher['sha256']}],
                           'licenses': [{'license': {'id': 'AGPL-3.0-or-later'}}],
                           'properties': [{'name': 'josi:system-runtime', 'value': 'Windows .NET Framework 4.6.2 or newer; not bundled'}]})
        for name in ('JosiLauncher.cs', 'JosiLauncher.csproj', 'packages.lock.json'):
            original = REPO / 'packaging/windows/launcher' / name
            if name == 'JosiLauncher.cs' and sha(original) != launcher['sourceSha256']:
                raise ValueError('Tested launcher source changed')
            target = licenses / 'josi-launcher-source' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            notices.append({'path': target.relative_to(licenses).as_posix(), 'size': target.stat().st_size, 'sha256': sha(target)})
    for row in python['components']:
        name, version = row['name'], row['version']
        notice_files = list(row['licenseFiles'])
        override = source_overrides.get(name)
        if override:
            notice_files += override['notices']
        if name == 'tokenizers':
            source_license = BASE / row['source']['path']
            source_license = source_license.parent / 'upstream-notices/LICENSE'
            if source_license.is_file():
                notice_files.append({'path': source_license.relative_to(BASE).as_posix(), 'sha256': sha(source_license)})
        for item in notice_files:
            path = BASE / item['path']
            if sha(path) != item['sha256']:
                raise ValueError('Retained Python notice changed')
            target = licenses / 'python-source' / name / path.name
            target.parent.mkdir(parents=True, exist_ok=True)
            # Dist-info and upstream sometimes use the same filename. Preserve
            # distinct bytes by including their digest rather than replacing.
            if target.exists() and sha(target) != item['sha256']:
                target = target.with_name(item['sha256'][:12] + '-' + target.name)
            if not target.exists():
                shutil.copyfile(path, target)
                notices.append({'path': target.relative_to(licenses).as_posix(), 'size': target.stat().st_size, 'sha256': sha(target)})
        source = override or row.get('source')
        if source:
            path = BASE / source['path']
            if path.stat().st_size != source['size'] or sha(path) != source['sha256']:
                raise ValueError('Retained Python source changed')
            sources.append({'component': name, 'version': version, 'path': source['path'], 'url': source['url'], 'size': source['size'], 'sha256': source['sha256']})
        elif name != 'en-core-web-sm':
            gaps.append({'component': name, 'gate': 'source-provenance', 'detail': 'Exact source archive not retained'})
        if not notice_files:
            gaps.append({'component': name, 'gate': 'license', 'detail': 'No retained license notice'})
        raw = row.get('licenseExpression') or row.get('metadataLicense')
        license_name = raw if raw and len(raw) < 120 and raw not in ('UNKNOWN', 'NOASSERTION') else 'See retained component notices'
        components.append({'type': 'library', 'bom-ref': f'pkg:pypi/{name}@{version}', 'name': name, 'version': version,
                           'purl': f'pkg:pypi/{name}@{version}', 'licenses': [{'license': {'name': license_name}}]})
    npm = read(Path(app['build']) / 'reports/npm-sbom.log')
    for row in npm['components']:
        item = dict(row)
        # npm repository metadata prefixes transports with git+. Retain the
        # publisher's value while exposing the underlying IRI to schema tools.
        item['externalReferences'] = [dict(ref) for ref in item.get('externalReferences', [])]
        for ref in item['externalReferences']:
            original = ref['url']
            if original.startswith(('git+https://', 'git+http://')):
                ref['url'] = original[4:]
            elif original.startswith('git+ssh://git@github.com/'):
                ref['url'] = 'https://github.com/' + original.split('git@github.com/', 1)[1]
            elif original.startswith('git@github.com:'):
                ref['url'] = 'https://github.com/' + original.split(':', 1)[1]
            if ref['url'] != original:
                item.setdefault('properties', []).append({'name': 'josi:original-vcs-url', 'value': original})
        if not item.get('licenses'):
            private = any(prop.get('name') == 'cdx:npm:package:private' and prop.get('value') == 'true' for prop in item.get('properties', []))
            if private or item.get('purl', '').startswith('pkg:npm/%40josi-ce/'):
                item['licenses'] = [{'license': {'id': 'AGPL-3.0-or-later'}}]
            elif item['name'] == 'traverse':
                notice = Path(app['payload']) / 'app/node_modules/traverse/LICENSE'
                text = notice.read_text(encoding='utf-8')
                if 'Copyright 2010 James Halliday' not in text or 'Permission is hereby granted' not in text or 'THE SOFTWARE IS PROVIDED' not in text:
                    raise ValueError('Exact traverse notice is incomplete')
                item['licenses'] = [{'license': {'id': 'MIT'}}]
            elif item['name'] == 'chainsaw':
                # Exact installed metadata says MIT/X11; preserve that statement
                # without inventing a publisher's missing attribution document.
                item['licenses'] = [{'license': {'name': 'MIT/X11 (installed package metadata)'}}]
                gaps.append({'component': item['name'], 'gate': 'notice', 'detail': 'Confirm complete publisher copyright/license notice'})
            elif item['name'] == 'duck':
                item['licenses'] = [{'license': {'id': 'BSD-2-Clause'}}]
            else:
                item['licenses'] = [{'license': {'name': 'NOASSERTION'}}]
                gaps.append({'component': item['name'], 'gate': 'license', 'detail': 'No license in exact npm metadata; upstream evidence required'})
        components.append(item)
    for name, version, license_name in [('node', '24.21.0', 'MIT and retained upstream third-party notices'),
                                        ('python', '3.12.15', 'Python-2.0 and retained upstream notices'),
                                        ('postgresql', '16.15', 'PostgreSQL and retained native dependency notices'),
                                        ('caddy', '2.11.7', 'Apache-2.0 and Go dependency notices'),
                                        ('Microsoft Visual C++ runtime', '14.50.35719.0', 'LicenseRef-Microsoft-Visual-Studio-2026-Redistributable')]:
        components.append({'type': 'application' if name != 'Microsoft Visual C++ runtime' else 'library',
                           'bom-ref': 'josi:runtime:' + name, 'name': name, 'version': version,
                           'licenses': [{'license': {'name': license_name}}]})
    host = read(BASE / 'evidence/service-host-source-closure.json')
    for row in host['runtimeComponents']:
        source = BASE / row['sourceArchive']
        if sha(source) != row['sourceSha256']:
            raise ValueError('Service host source changed')
        sources.append({'component': row['name'], 'version': row['version'], 'path': row['sourceArchive'], 'url': row['sourceUrl'], 'sha256': row['sourceSha256'], 'size': source.stat().st_size})
        components.append({'type': 'library', 'bom-ref': 'josi:service-host:' + row['name'], 'name': row['name'], 'version': row['version'], 'licenses': [{'license': {'name': row['license']}}]})
        for item in row['notices']:
            path = BASE / item['path']
            if sha(path) != item['sha256']:
                raise ValueError('Service host notice changed')
            target = licenses / 'service-host' / row['name'] / path.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            notices.append({'path': target.relative_to(licenses).as_posix(), 'size': target.stat().st_size, 'sha256': sha(target)})
    for row in read(REPO / 'services/voice-box/models.lock.json')['files']:
        revision = row['url'].split('/resolve/')[1].split('/')[0] if '/resolve/' in row['url'] else 'sha256:' + row['sha256']
        components.append({'type': 'data', 'bom-ref': 'josi:model:' + row['path'], 'name': row['path'], 'version': revision,
                           'hashes': [{'alg': 'SHA-256', 'content': row['sha256']}], 'licenses': [{'license': {'name': row['license']}}],
                           'externalReferences': [{'type': 'distribution', 'url': row['url']} ]})
    gaps += [
        {'component': 'libheif-js@1.23.2', 'gate': 'corresponding-source', 'detail': 'LGPL WASM/asm.js rebuild sources, native decoder dependencies and replacement/relink instructions still need exact closure'},
        {'component': 'Windows native libraries', 'gate': 'native-license-review', 'detail': 'Python/Torch/ONNX, PostgreSQL/OpenSSL/ICU and Caddy embedded dependencies require final artifact-specific review; notices alone are insufficient'},
        {'component': 'patched Python wheels', 'gate': 'reconstruction', 'detail': 'Retained source/patch/build inputs must be attached to final source asset with native submodule/compiler provenance'},
    ]
    root_ref = 'josi:windows:' + app['version']
    npm_root = npm['metadata']['component']['bom-ref']
    graph = []
    for dependency in npm.get('dependencies', []):
        graph.append({**dependency, 'ref': root_ref if dependency['ref'] == npm_root else dependency['ref'],
                      'dependsOn': [root_ref if ref == npm_root else ref for ref in dependency.get('dependsOn', [])]})
    root_dependency = next((item for item in graph if item['ref'] == root_ref), None)
    if root_dependency is None:
        root_dependency = {'ref': root_ref, 'dependsOn': []}
        graph.append(root_dependency)
    npm_refs = {item['bom-ref'] for item in npm['components']}
    root_dependency['dependsOn'] = sorted(set(root_dependency['dependsOn']) | {item['bom-ref'] for item in components if item['bom-ref'] not in npm_refs})
    bom = {'bomFormat': 'CycloneDX', 'specVersion': '1.6', 'version': 1, 'serialNumber': 'urn:uuid:' + str(uuid.uuid4()),
           'metadata': {'component': {'type': 'application', 'bom-ref': 'josi:windows:' + app['version'], 'name': 'Josi CE Server', 'version': app['version'], 'licenses': [{'license': {'id': 'AGPL-3.0-or-later'}}]}},
           'components': components, 'dependencies': graph}
    refs = [item['bom-ref'] for item in components]
    if len(refs) != len(set(refs)) or len(python['components']) != runtime['pythonComponents']:
        raise ValueError('SBOM component identity/coverage failed')
    for item in notices:
        target = licenses / item['path']
        if sha(target) != item['sha256'] or target.stat().st_size != item['size']:
            raise ValueError('Exported notice changed')
    for name, value in [('windows.cdx.json', bom), ('notice-inventory.json', notices), ('source-inventory.json', sources), ('release-license-gaps.json', gaps)]:
        (output / name).write_text(json.dumps(value, indent=2), encoding='utf-8')
    (output / 'THIRD_PARTY_NOTICES.txt').write_text('Josi CE Server ' + app['version'] + '\nOriginal third-party copyright, license and notice files are retained in licenses/.\n'
        'Review notice-inventory.json and windows.cdx.json for exact identities and hashes.\n'
        'This local engineering staging has open license/source gates listed in release-license-gaps.json; it is not approved for redistribution.\n'
        'Microsoft runtime files are separately licensed. No antivirus engine/signature database is bundled; Windows AMSI requests use the locally installed provider.\n', encoding='utf-8')
    report = {'generated': True, 'passed': False, 'sbomComponentIdentitiesValidated': True, 'pythonComponents': len(python['components']), 'npmComponents': len(npm['components']),
              'totalComponents': len(components), 'noticesVerified': len(notices), 'sourcesVerified': len(sources), 'licenseGatePassed': False, 'gaps': gaps,
              'output': str(output), 'candidate': app['version'], 'sbomSha256': sha(output / 'windows.cdx.json'), 'redistributionApproved': False}
    (BASE / 'evidence/release-metadata.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'gaps'}, indent=2))


if __name__ == '__main__':
    main()
