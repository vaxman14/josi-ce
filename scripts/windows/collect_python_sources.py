"""Retain exact upstream source archives and installed license evidence.

This is build-time compliance work. It never installs or executes downloaded
code, and does not declare redistribution approval from package metadata.
"""
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[2]
BASE = REPO / 'artifacts' / 'windows-native'


def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        while data := stream.read(1024 * 1024):
            value.update(data)
    return value.hexdigest()


def main():
    expected_python = BASE / 'tools/python-3.12.15/python/python.exe'
    if sys.platform != 'win32' or Path(sys.executable).resolve() != expected_python.resolve():
        raise ValueError('Use the pinned private Windows Python')
    build = json.loads((BASE / 'evidence/runtime-build.json').read_text(encoding='utf-8-sig'))
    site = Path(build['payload']) / 'python/Lib/site-packages'
    output = BASE / 'sources/python'
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    for dist in sorted(metadata.distributions(path=[str(site)]), key=lambda value: value.metadata['Name'].lower()):
        name = re.sub(r'[-_.]+', '-', dist.metadata['Name']).lower()
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name):
            raise ValueError('Unexpected dependency identity')
        version = dist.version
        if not re.fullmatch(r'[0-9][a-zA-Z0-9.+-]{0,100}', version):
            raise ValueError('Unexpected dependency version')
        root = output / (name + '-' + version)
        root.mkdir(exist_ok=True)
        row = {'name': name, 'version': version, 'licenseExpression': dist.metadata.get('License-Expression'),
               'metadataLicense': dist.metadata.get('License'), 'licenseFiles': [],
               'source': None, 'sourceStatus': 'unresolved', 'redistributionApproved': False}
        for item in dist.files or []:
            # Some native wheels put legally required notices in their package
            # directory instead of dist-info (notably ONNX Runtime).
            if not re.search(r'(license|copying|notice|authors)', str(item), re.I):
                continue
            source = Path(dist.locate_file(item))
            if not source.resolve().is_relative_to(site) or source.is_symlink() or source.stat().st_nlink != 1:
                raise ValueError('License evidence is not a private regular file')
            relative = Path(*item.parts)
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Unsafe license evidence path')
            target = root / 'licenses' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            content = source.read_bytes()
            target.write_bytes(content)
            row['licenseFiles'].append({'path': target.relative_to(BASE).as_posix(), 'size': len(content), 'sha256': sha(target)})
        # Local patches need their complete build source and change notices too;
        # the original distribution alone is never called corresponding source.
        upstream = version.split('+', 1)[0]
        if name == 'en-core-web-sm':
            row['sourceStatus'] = 'model-wheel-is-data; training/provenance-review-pending'
        else:
            try:
                request = urllib.request.Request('https://pypi.org/pypi/' + name + '/' + upstream + '/json',
                                                 headers={'User-Agent': 'Josi-native-source-review/1'})
                with urllib.request.urlopen(request, timeout=30) as response:
                    raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise ValueError('Source metadata exceeds its bound')
                data = json.loads(raw)
                choices = [item for item in data['urls'] if item['packagetype'] == 'sdist']
                if len(choices) != 1:
                    row['sourceStatus'] = 'no-unique-pypi-sdist; upstream-source-review-pending'
                else:
                    item = choices[0]
                    url, digest, size, filename = item['url'], item['digests']['sha256'], item['size'], item['filename']
                    if (not url.startswith('https://files.pythonhosted.org/') or not re.fullmatch(r'[a-f0-9]{64}', digest)
                            or not 0 < size <= 256 * 1024 * 1024 or Path(filename).name != filename or '\\' in filename):
                        raise ValueError('Source archive identity is invalid')
                    target = root / filename
                    if not target.exists():
                        partial = target.with_name(target.name + '.partial')
                        with urllib.request.urlopen(url, timeout=60) as response, partial.open('wb') as stream:
                            count = 0
                            while block := response.read(1024 * 1024):
                                count += len(block)
                                if count > size:
                                    raise ValueError('Source archive exceeds its pinned size')
                                stream.write(block)
                        if partial.stat().st_size != size or sha(partial) != digest:
                            raise ValueError('Source archive integrity failed')
                        partial.replace(target)
                    if target.stat().st_size != size or sha(target) != digest:
                        raise ValueError('Cached source archive integrity failed')
                    row['source'] = {'url': url, 'size': size, 'sha256': digest,
                                     'path': target.relative_to(BASE).as_posix(), 'upstreamVersion': upstream}
                    row['sourceStatus'] = 'upstream-sdist-retained; license-and-native-dependency-review-pending'
                    if '+' in version:
                        row['sourceStatus'] = 'upstream-sdist-retained; local-patches-and-build-source-required'
            except (urllib.error.URLError, TimeoutError):
                row['sourceStatus'] = 'source-download-interrupted; retry-required'
        rows.append(row)
        (BASE / 'evidence/python-source-closure.json').write_text(json.dumps({
            'schemaVersion': 1, 'components': rows, 'reviewComplete': False,
            'correspondingSourceComplete': False, 'redistributionApproved': False}, indent=2), encoding='utf-8')
        print(name + ' ' + version + ': ' + row['sourceStatus'], flush=True)
    print('Retained exact source and license evidence for ' + str(len(rows)) + ' dependencies; review remains required.', flush=True)


if __name__ == '__main__':
    main()
