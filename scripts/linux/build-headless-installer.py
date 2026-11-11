"""Fill the one-command installer with the hashes of the packages just built.

The template is packaging/linux/install-josi-ce-server.sh. The result goes to
the artifacts folder beside the packages and into SHA256SUMS.txt, and is
uploaded to the same GitHub release as the packages it names. It names the
packages of every architecture built for this version; an architecture that
was not built is left empty and the installer says so on such a machine.
"""
import json
import re

import target
from package_common import ARCH, OUT, RELEASE_BASE_URL, REPO, VERSION, digest, package_names, record_checksum

TEMPLATE = REPO / 'packaging/linux/install-josi-ce-server.sh'
NAME = 'install-josi-ce-server.sh'
FAMILIES = ('arch', 'debian', 'rpm')


def render(version: str, base_url: str, packages: dict) -> str:
    """packages maps an architecture to {'arch'|'debian'|'rpm': (file name, sha256)}."""
    text = TEMPLATE.read_text()
    values = {'VERSION': version, 'BASE_URL': base_url.rstrip('/')}
    if not packages or set(packages) - set(target.ARCHITECTURES):
        raise ValueError('Unexpected architectures: ' + ', '.join(sorted(packages)))
    for arch in target.ARCHITECTURES:
        built = packages.get(arch)
        for family in FAMILIES:
            name, sha256 = built[family] if built else ('', '')
            if built and (not re.fullmatch(r'[A-Za-z0-9._+-]+', name) or not re.fullmatch(r'[a-f0-9]{64}', sha256)):
                raise ValueError('Unexpected package name or hash for ' + family + ' ' + arch)
            values[f'{family}_{arch}_PACKAGE'.upper()] = name
            values[f'{family}_{arch}_SHA256'.upper()] = sha256
    for key, value in values.items():
        text = text.replace('@' + key + '@', value)
    left = re.search(r'@[A-Z0-9_]+@', text)
    if left:
        raise ValueError('Template placeholder not filled: ' + left.group(0))
    return text


def main() -> None:
    packages = {}
    for arch in target.ARCHITECTURES:
        paths = {family: OUT / name for family, name in package_names(arch=arch).items()}
        if all(path.is_file() for path in paths.values()):
            packages[arch] = {family: (path.name, digest(path)) for family, path in paths.items()}
        elif arch == ARCH:
            raise SystemExit('Missing native package: ' + ', '.join(str(p) for p in paths.values() if not p.is_file()))
    target_file = OUT / NAME
    target_file.write_text(render(VERSION, RELEASE_BASE_URL, packages))
    target_file.chmod(0o755)
    print(json.dumps({'installer': str(target_file), 'version': VERSION, 'baseUrl': RELEASE_BASE_URL,
        'sha256': record_checksum(target_file),
        'packages': {arch: {k: v[1] for k, v in built.items()} for arch, built in packages.items()}}))


if __name__ == '__main__':
    main()
