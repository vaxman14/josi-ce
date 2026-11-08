"""Fill the one-command installer and the update feed for the packages just built.

The template is packaging/linux/install-josi-ce-server.sh. Two files go to the
artifacts folder beside the packages:

  linux              the installer, served as https://<install host>/linux
  linux-latest.json  the feed the web updater reads (attach it to the latest release)
"""
import json
import re
import time

from package_common import OUT, RELEASE_BASE_URL, REPO, VERSION, digest, package_names, record_checksum

TEMPLATE = REPO / 'packaging/linux/install-josi-ce-server.sh'
NAME = 'linux'
FEED = 'linux-latest.json'


def render(version: str, base_url: str, packages: dict) -> str:
    """packages maps 'family-processor' (debian-x86_64, arch-aarch64, ...) to (file name, sha256)."""
    text = TEMPLATE.read_text()
    rows = []
    for key, (name, sha256) in sorted(packages.items()):
        family, _, processor = key.partition('-')
        if family not in ('arch', 'debian') or processor not in ('x86_64', 'aarch64'):
            raise ValueError('Unexpected package family ' + key)
        if not re.fullmatch(r'[A-Za-z0-9._+-]+', name) or not re.fullmatch(r'[a-f0-9]{64}', sha256):
            raise ValueError('Unexpected package name or hash for ' + key)
        rows.append(f'{family} {processor} {name} {sha256}')
    if not rows:
        raise ValueError('No packages to install')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?', version) or not re.fullmatch(r'https?://[^\s\'"]+', base_url):
        raise ValueError('Unexpected version or address')
    values = {'VERSION': version, 'BASE_URL': base_url.rstrip('/'), 'PACKAGES': '\n'.join(rows)}
    for key, value in values.items():
        text = text.replace('@' + key + '@', value)
    left = re.search(r'@[A-Z_]+@', text)
    if left:
        raise ValueError('Template placeholder not filled: ' + left.group(0))
    return text


def main() -> None:
    packages = {}
    for key, name in package_names().items():
        path = OUT / name
        if path.is_file():
            packages[key] = (name, digest(path))
    if not packages:
        raise SystemExit('No native packages in ' + str(OUT))
    target = OUT / NAME
    target.write_text(render(VERSION, RELEASE_BASE_URL, packages))
    target.chmod(0o755)
    feed = {'version': VERSION, 'name': f'Josi {VERSION}',
            'publishedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'packages': {key: {'file': name, 'sha256': sha} for key, (name, sha) in packages.items()}}
    (OUT / FEED).write_text(json.dumps(feed, indent=2) + '\n')
    print(json.dumps({'installer': str(target), 'feed': str(OUT / FEED), 'version': VERSION,
        'baseUrl': RELEASE_BASE_URL, 'sha256': record_checksum(target), 'packages': sorted(packages)}))


if __name__ == '__main__':
    main()
