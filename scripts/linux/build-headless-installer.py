"""Fill the one-command installer with the hashes of the packages just built.

The template is packaging/linux/install-josi-ce-server.sh. The result goes to
the artifacts folder beside the packages and into SHA256SUMS.txt, and is
uploaded to the same GitHub release as the packages it names.
"""
import json
import re

from package_common import OUT, RELEASE_BASE_URL, REPO, VERSION, digest, package_names, record_checksum

TEMPLATE = REPO / 'packaging/linux/install-josi-ce-server.sh'
NAME = 'install-josi-ce-server.sh'


def render(version: str, base_url: str, packages: dict) -> str:
    """packages maps 'arch', 'debian' and 'rpm' to (file name, sha256)."""
    text = TEMPLATE.read_text()
    values = {'VERSION': version, 'BASE_URL': base_url.rstrip('/')}
    for family in ('arch', 'debian', 'rpm'):
        name, sha256 = packages[family]
        if not re.fullmatch(r'[A-Za-z0-9._+-]+', name) or not re.fullmatch(r'[a-f0-9]{64}', sha256):
            raise ValueError('Unexpected package name or hash for ' + family)
        values[family.upper() + '_PACKAGE'] = name
        values[family.upper() + '_SHA256'] = sha256
    for key, value in values.items():
        text = text.replace('@' + key + '@', value)
    left = re.search(r'@[A-Z_]+@', text)
    if left:
        raise ValueError('Template placeholder not filled: ' + left.group(0))
    return text


def main() -> None:
    packages = {}
    for family, name in package_names().items():
        path = OUT / name
        if not path.is_file():
            raise SystemExit('Missing native package: ' + str(path))
        packages[family] = (name, digest(path))
    target = OUT / NAME
    target.write_text(render(VERSION, RELEASE_BASE_URL, packages))
    target.chmod(0o755)
    print(json.dumps({'installer': str(target), 'version': VERSION, 'baseUrl': RELEASE_BASE_URL,
        'sha256': record_checksum(target), 'packages': {k: v[1] for k, v in packages.items()}}))


if __name__ == '__main__':
    main()
