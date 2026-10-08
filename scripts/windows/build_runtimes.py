"""Stage native runtimes locally; redistribution remains a separate release gate.

Run with the prepared private CPython. No network, pip, compilation or mutable
package resolution occurs here. Installed Python files must match wheel RECORD.
"""
import base64
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import uuid
import zipfile

REPO = Path(__file__).resolve().parents[2]
BASE = REPO / 'artifacts/windows-native'
TOOLS = BASE / 'tools/python-3.12.15/python'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verified(name, size, sha):
    path = BASE / 'cache' / name
    if path.is_symlink() or path.stat().st_size != size or digest(path) != sha:
        raise ValueError('Runtime archive does not match its reviewed pin: ' + name)
    return path


def relative(name):
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in ('.', '..') or re.search(r'[<>:"\\|?*\x00-\x1f]', part)
            or part.endswith(('.', ' ')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I) for part in path.parts):
        raise ValueError('Unsafe archive path')
    return path


def unzip(source, destination, select=lambda path: path):
    with zipfile.ZipFile(source) as archive:
        for info in archive.infolist():
            path = relative(info.filename)
            chosen = select(path)
            if chosen is None:
                continue
            if info.external_attr >> 16 & 0o170000 == 0o120000:
                raise ValueError('Runtime archives may not contain links')
            output = destination.joinpath(*chosen.parts)
            if info.is_dir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as src, output.open('xb') as dst:
                    shutil.copyfileobj(src, dst)


def main():
    if sys.platform != 'win32' or Path(sys.executable).resolve() != TOOLS / 'python.exe':
        raise ValueError('Use the pinned private Windows Python runtime')
    build = BASE / 'staging' / ('runtimes-' + uuid.uuid4().hex)
    payload = build / 'payload'
    reports = build / 'reports'
    payload.mkdir(parents=True)
    reports.mkdir()
    python = payload / 'python'
    archive = verified('cpython-3.12.15-20261003-windows-x64.tar.gz', 46509797,
                       '4b6f0beebbb695a0f3ea237b8c3eaa5bd424f47a7bc25b2fbe3a43390c770f08')
    # Extract the original interpreter/stdlib, never the build tool installation.
    with tarfile.open(archive) as tar:
        for item in tar:
            path = relative(item.name)
            if path.parts[0] != 'python' or not (item.isfile() or item.isdir()):
                raise ValueError('Unexpected Python archive member')
            if len(path.parts) > 1 and path.parts[1] in ('include', 'libs', 'Scripts'):
                continue
            if path.parts[1:3] in (('Lib', 'site-packages'), ('Lib', 'ensurepip'), ('Lib', 'test'), ('Lib', 'idlelib')):
                continue
            output = payload.joinpath(*path.parts)
            if item.isdir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(item) as src, output.open('xb') as dst:
                    shutil.copyfileobj(src, dst)
    normalize = lambda name: re.sub(r'[-_.]+', '-', name).lower()
    expected = {}
    for lock in ('requirements.lock', 'requirements-windows.lock'):
        text = (REPO / 'services/voice-box' / lock).read_text(encoding='utf-8')
        for name, version in re.findall(r'^([A-Za-z0-9_-]+)==([^\s]+)', text, re.M):
            expected[normalize(name)] = version
    expected.update({'en-core-web-sm': '3.8.0', 'faster-whisper': '1.2.1+josi.pcm1', 'ctranslate2': '4.8.2+josi.windows2'})
    site = TOOLS / 'Lib/site-packages'
    installed = {}
    for dist in metadata.distributions(path=[str(site)]):
        # Ignore pip's rejected upstream-wheel uninstall backup, never ship it.
        if Path(dist._path).name.startswith('~'):
            continue
        name = normalize(dist.metadata['Name'])
        if name in expected:
            if name in installed:
                raise ValueError('Duplicate Python dependency metadata')
            installed[name] = dist
    if set(installed) != set(expected):
        raise ValueError('Missing pinned Python dependency')
    components = []
    for name, version in sorted(expected.items()):
        dist = installed[name]
        if dist.version != version or not dist.files:
            raise ValueError('Python dependency version/RECORD mismatch: ' + name)
        count = 0
        for item in dist.files:
            # Entry-point CLI launchers and bytecode are unnecessary to the service.
            if str(item).startswith('../') or '__pycache__' in item.parts or item.suffix == '.pyc':
                continue
            if item.name in ('direct_url.json', 'REQUESTED', 'INSTALLER'):
                continue
            path = relative(str(item))
            source = Path(dist.locate_file(item))
            if not source.resolve().is_relative_to(site) or source.is_symlink() or source.stat().st_nlink != 1:
                raise ValueError('Python dependency file is not private: ' + name)
            content = source.read_bytes()
            if item.hash:
                actual = base64.urlsafe_b64encode(hashlib.new(item.hash.mode, content).digest()).decode().rstrip('=')
                if actual != item.hash.value or len(content) != item.size:
                    raise ValueError('Installed wheel integrity mismatch: ' + name + '/' + str(item))
            elif item.name != 'RECORD':
                raise ValueError('Unhashed Python dependency file: ' + name + '/' + str(item))
            output = python / 'Lib/site-packages' / Path(*path.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            if output.exists():
                if output.read_bytes() != content:
                    raise ValueError('Conflicting Python namespace file')
            else:
                output.write_bytes(content)
            count += 1
        license_text = dist.metadata.get('License-Expression') or dist.metadata.get('License') or 'NOASSERTION'
        components.append({'type': 'library', 'name': name, 'version': version,
                           'purl': 'pkg:pypi/' + name + '@' + version,
                           'licenses': [{'license': {'name': license_text}}],
                           'properties': [{'name': 'josi:verified-record-files', 'value': str(count)}]})
    print('Python dependency RECORD verification passed.', flush=True)
    node = verified('node-v24.21.0-win-x64.zip', 37618919, '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541')
    def select_node(path):
        if len(path.parts) == 2 and path.parts[1] in ('node.exe', 'LICENSE'):
            return PurePosixPath('JosiRuntime.exe' if path.name == 'node.exe' else 'LICENSE')
    unzip(node, payload / 'node', select_node)
    postgres = verified('postgresql-16.15-5-windows-x64-binaries.zip', 373254386,
                        '43bb45f173a6f08cf1d29a97a6d8deb119e8e8093a24c00d2d1001a0ccaa8281')
    unzip(postgres, payload / 'postgresql', lambda p: PurePosixPath(*p.parts[1:]) if len(p.parts) >= 2 and p.parts[0] == 'pgsql' and p.parts[1] in ('bin', 'lib', 'share', 'doc') else None)
    unzip(verified('caddy_2.11.7_windows_amd64.zip', 18479498, '0a1edc0b799512051c57071ce0e798d3f2cf67dc98171366f1d2b326072e3b06'), payload / 'caddy')
    shell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    clean = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR', 'ProgramData', 'ProgramFiles', 'TEMP', 'TMP') if key in os.environ}
    for destination in (python, payload / 'node', payload / 'postgresql/bin'):
        subprocess.run([str(shell), '-NoProfile', '-NonInteractive', '-File', str(REPO / 'scripts/windows/Copy-MsvcRuntime.ps1'),
                        '-Destination', str(destination)], check=True, env=clean, creationflags=subprocess.CREATE_NO_WINDOW)
    model_lock = json.loads((REPO / 'services/voice-box/models.lock.json').read_text(encoding='utf-8'))
    for entry in model_lock['files']:
        path = relative(entry['path'])
        source = BASE / 'cache/voice-models' / Path(*path.parts)
        if source.stat().st_size != entry['size'] or digest(source) != entry['sha256']:
            raise ValueError('Approved model integrity mismatch')
        output = payload / 'voice-models' / Path(*path.parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, output)
    for name in ('node/JosiRuntime.exe', 'python/python.exe', 'postgresql/bin/postgres.exe', 'caddy/caddy.exe'):
        if not (payload / name).is_file():
            raise ValueError('Runtime layout incomplete: ' + name)
    inventory = []
    for path in sorted(payload.rglob('*')):
        if path.is_file():
            inventory.append({'path': path.relative_to(payload).as_posix(), 'size': path.stat().st_size, 'sha256': digest(path)})
    (reports / 'python-sbom.cdx.json').write_text(json.dumps({'bomFormat': 'CycloneDX', 'specVersion': '1.6', 'version': 1, 'components': components}, indent=2), encoding='utf-8')
    (reports / 'file-inventory.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
    evidence = {'staged': True, 'payload': str(payload), 'reports': str(reports), 'pythonComponents': len(components),
                'files': len(inventory), 'bytes': sum(item['size'] for item in inventory), 'redistributionApproved': False,
                'installedOrAccepted': False, 'inventorySha256': digest(reports / 'file-inventory.json')}
    (BASE / 'evidence/runtime-build.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
