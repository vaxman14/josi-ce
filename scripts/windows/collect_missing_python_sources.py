"""Retain official commit-pinned sources absent from installed wheel metadata.

This collects review evidence only. It does not approve redistribution, execute
source code, extract builds or claim the patched wheels' full source closure.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tarfile
import urllib.request

REPO = Path(__file__).resolve().parents[2]
BASE = REPO / 'artifacts/windows-native'
PROJECTS = {
    'flatbuffers': ('google/flatbuffers', 'v25.12.19', '25.12.19'),
    'onnxruntime': ('microsoft/onnxruntime', 'v1.22.1', '1.22.1'),
    'faster-whisper': ('SYSTRAN/faster-whisper', 'v1.2.1', '1.2.1'),
    'ctranslate2': ('OpenNMT/CTranslate2', 'v4.8.2', '4.8.2'),
}


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Josi-source-review/1'}), timeout=40) as response:
        content = response.read(4 * 1024 * 1024 + 1)
    if len(content) > 4 * 1024 * 1024:
        raise ValueError('Source metadata exceeds its bound')
    return json.loads(content)


def main():
    if sys.platform != 'win32':
        raise ValueError('Use the pinned Windows review environment')
    rows = json.loads((BASE / 'evidence/python-source-closure.json').read_text(encoding='utf-8'))['components']
    output = []
    for name, (repository, tag, expected) in PROJECTS.items():
        installed = next(row for row in rows if row['name'] == name)
        if installed['version'].split('+')[0] != expected:
            raise ValueError('Installed dependency does not match this source review')
        root = BASE / 'sources/python' / (name + '-' + installed['version'])
        root.mkdir(exist_ok=True)
        pin_file = root / 'upstream-source.json'
        if pin_file.exists():
            pin = json.loads(pin_file.read_text(encoding='utf-8'))
            if pin['repository'] != repository or pin['tag'] != tag:
                raise ValueError('Existing source pin changed identity')
        else:
            ref = get_json('https://api.github.com/repos/' + repository + '/git/ref/tags/' + tag)['object']
            for _ in range(3):
                if ref['type'] == 'commit':
                    break
                if ref['type'] != 'tag' or not re.fullmatch(r'[a-f0-9]{40}', ref['sha']):
                    raise ValueError('Unexpected source tag object')
                ref = get_json('https://api.github.com/repos/' + repository + '/git/tags/' + ref['sha'])['object']
            if ref['type'] != 'commit' or not re.fullmatch(r'[a-f0-9]{40}', ref['sha']):
                raise ValueError('Source tag did not resolve to a commit')
            pin = {'repository': repository, 'tag': tag, 'commit': ref['sha']}
        url = 'https://codeload.github.com/' + repository + '/tar.gz/' + pin['commit']
        target = root / (name + '-' + pin['commit'] + '.tar.gz')
        if not target.exists():
            with urllib.request.urlopen(url, timeout=90) as response:
                content = response.read(256 * 1024 * 1024 + 1)
            if not 0 < len(content) <= 256 * 1024 * 1024:
                raise ValueError('Source archive exceeds its bound')
            if 'sha256' in pin and hashlib.sha256(content).hexdigest() != pin['sha256']:
                raise ValueError('Pinned source download changed bytes')
            partial = target.with_suffix('.partial')
            partial.write_bytes(content)
            partial.replace(target)
        content = target.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if 'sha256' in pin and (pin['sha256'] != digest or pin['size'] != len(content)):
            raise ValueError('Pinned source archive changed bytes')
        notices = []
        with tarfile.open(fileobj=io.BytesIO(content), mode='r:gz') as archive:
            for member in archive:
                path = Path(member.name)
                if (len(path.parts) != 2 or path.is_absolute() or '..' in path.parts
                        or not re.fullmatch(r'(?:LICENSE|COPYING|NOTICE)(?:\.[A-Za-z0-9_-]+)?', path.name, re.I)):
                    continue
                if not member.isfile() or not 0 < member.size <= 1024 * 1024:
                    raise ValueError('Source notice is invalid')
                notice = archive.extractfile(member).read()
                destination = root / 'upstream-notices' / path.name
                destination.parent.mkdir(exist_ok=True)
                destination.write_bytes(notice)
                notices.append({'path': destination.relative_to(BASE).as_posix(), 'sha256': hashlib.sha256(notice).hexdigest()})
        if not notices:
            raise ValueError('Official source license notice is missing')
        pin.update({'url': url, 'size': len(content), 'sha256': digest, 'path': target.relative_to(BASE).as_posix(),
                    'notices': notices, 'publisherDigest': False, 'redistributionApproved': False})
        pin_file.write_text(json.dumps(pin, indent=2), encoding='utf-8')
        output.append({'name': name, 'installedVersion': installed['version'], **pin})
        print(name + ': exact official source and notices retained; redistribution review remains open.', flush=True)
    tokenizers = next(row for row in rows if row['name'] == 'tokenizers')
    token_source = BASE / tokenizers['source']['path']
    if hashlib.sha256(token_source.read_bytes()).hexdigest() != tokenizers['source']['sha256']:
        raise ValueError('Tokenizers source integrity failed')
    with tarfile.open(token_source, mode='r:gz') as archive:
        licenses = [member for member in archive if member.isfile() and member.name == 'tokenizers-' + tokenizers['version'] + '/tokenizers/LICENSE']
        if len(licenses) != 1 or not 0 < licenses[0].size <= 1024 * 1024:
            raise ValueError('Tokenizers official source license is missing')
        destination = token_source.parent / 'upstream-notices/LICENSE'
        destination.parent.mkdir(exist_ok=True)
        destination.write_bytes(archive.extractfile(licenses[0]).read())
    (BASE / 'evidence/python-missing-source-review.json').write_text(json.dumps({
        'components': output, 'tokenizersSourceLicenseRetained': True,
        'patchedWheelSourceClosureComplete': False, 'redistributionApproved': False}, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
