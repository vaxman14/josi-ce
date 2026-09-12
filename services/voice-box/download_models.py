"""Build-time downloads from the reviewed lockfile, verified before use."""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request


def download(root, lock):
    root.mkdir(parents=True, exist_ok=True)
    for entry in lock['files']:
        target = root / entry['path']
        if not target.resolve().is_relative_to(root.resolve()):
            raise ValueError('Invalid model path')
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(entry['url'], timeout=60) as source, target.with_suffix('.download').open('wb') as out:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > entry['size']:
                    raise ValueError('Model exceeds pinned size')
                digest.update(chunk)
                out.write(chunk)
        if size != entry['size'] or digest.hexdigest() != entry['sha256']:
            raise ValueError('Model checksum mismatch: ' + entry['path'])
        target.with_suffix('.download').replace(target)


if __name__ == '__main__':
    download(Path(sys.argv[1]), json.loads(Path(__file__).with_name('models.lock.json').read_text()))
