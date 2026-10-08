"""Reconstruct the pinned CPU CTranslate2 source tree without network or git."""
import json
import argparse
from pathlib import Path
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path('/native-build'))
parser.add_argument('--sources', type=Path, default=Path('/redistribution/sources'))
parser.add_argument('--lock', type=Path, default=Path('/build/sources.lock.json'))
parser.add_argument('--variant', choices=('4.8.2+josi.cpu1', '4.8.2+josi.windows1', '4.8.2+josi.windows2'), default='4.8.2+josi.cpu1')
args = parser.parse_args()
root = args.root
for entry in json.loads(args.lock.read_text(encoding='utf-8'))['files']:
    if entry.get('kind') != 'native-source':
        continue
    target = root / entry['destination']
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(args.sources / entry['path']) as archive:
        members = []
        for member in archive.getmembers():
            parts = member.name.split('/', 1)
            if len(parts) == 2 and parts[1]:
                member.name = parts[1]
                members.append(member)
        archive.extractall(target, members=members, filter='data')
# Mark the variant honestly; do not claim the upstream CUDA/MKL wheel build.
p = root / 'ctranslate2/python/ctranslate2/version.py'
p.write_text(p.read_text(encoding='utf-8').replace('4.8.2', args.variant), encoding='utf-8')
p = root / 'ctranslate2/python/setup.py'
p.write_text('\n'.join(line for line in p.read_text(encoding='utf-8').split('\n') if 'Environment :: GPU' not in line), encoding='utf-8')
(root / 'ctranslate2/python/LICENSE').write_bytes((root / 'ctranslate2/LICENSE').read_bytes())
