"""Bundle pinned, unmodified Apple Silicon CLIs; no global install."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

REPO=Path(__file__).resolve().parents[2]
CACHE=REPO.parents[2]/'Caches/codex-macos-native-20261009/subscription-cli'
LOCK=REPO/'packaging/macos/subscription-cli.lock.json'

def verified(row):
    path=CACHE/row['filename']
    with path.open('rb') as stream:
        if hashlib.file_digest(stream,'sha256').hexdigest()!=row['sha256']:raise ValueError('CLI artifact pin mismatch: '+row['id'])
    if 'integrity' in row:
        with path.open('rb') as stream:
            integrity='sha512-'+base64.b64encode(hashlib.file_digest(stream,'sha512').digest()).decode()
        if integrity!=row['integrity']:raise ValueError('CLI npm integrity mismatch')
    return path

def bundle(runtime):
    rows=json.loads(LOCK.read_text());inputs={row['id']:verified(row) for row in rows}
    target=runtime/'subscription-cli'
    if target.exists():raise ValueError('New subscription CLI staging required')
    (target/'bin').mkdir(parents=True)
    for name,artifact in [('codex','codex-arm64'),('claude','claude-arm64')]:
        destination=target/name;destination.mkdir()
        with tarfile.open(inputs[artifact]) as archive:
            for entry in archive:
                path=Path(entry.name)
                if not path.parts or path.parts[0]!='package' or '..' in path.parts or path.is_absolute() or not (entry.isfile() or entry.isdir()):raise ValueError('Unsafe vendor artifact entry')
                # This optional bundled shell requires macOS 15. Codex supports
                # an absent bundled shell; Josi uses the core CLI on macOS 14.
                # Preserve the entire original distribution in the companion.
                if artifact=='codex-arm64' and path.as_posix()=='package/vendor/aarch64-apple-darwin/codex-resources/zsh/bin/zsh':continue
                output=destination.joinpath(*path.parts[1:])
                if entry.isdir():output.mkdir(parents=True,exist_ok=True);continue
                output.parent.mkdir(parents=True,exist_ok=True)
                with archive.extractfile(entry) as source,output.open('xb') as stream:shutil.copyfileobj(source,stream)
                output.chmod(entry.mode&0o755)
    (target/'bin/codex').symlink_to('../codex/vendor/aarch64-apple-darwin/bin/codex')
    (target/'bin/claude').symlink_to('../claude/claude')
    shutil.copyfile(LOCK,target/'inputs.lock.json')
    notices=[]
    with tarfile.open(inputs['codex-source']) as archive:
        for name in ('LICENSE','NOTICE'):
            data=archive.extractfile('codex-rust-v0.152.0/'+name).read()
            (target/'codex'/name).write_bytes(data);notices.append(data.decode())
    for name in ('LICENSE.md','README.md'):notices.append((target/'claude'/name).read_text())
    (runtime/'licenses/subscription-cli-notices.txt').write_text('\n\n'.join(notices))
    shutil.copyfile(LOCK,runtime/'licenses/subscription-cli.lock.json')
    bom=runtime/'licenses/runtime.cdx.json';value=json.loads(bom.read_text())
    for row in rows:
        value['components'].append({'type':'application' if row['id'].endswith('arm64') else 'library','name':row['name'],'version':row['version'],'hashes':[{'alg':'SHA-256','content':row['sha256']}],'properties':[{'name':'josi:vendor-artifact','value':row['filename']}]})
    bom.write_text(json.dumps(value,indent=2)+'\n')
    # Preserve vendor signatures; do not replace them with Josi's identity.
    for path in [target/'claude/claude',*(target/'codex/vendor').rglob('*')]:
        if not path.is_file():continue
        with path.open('rb') as stream:magic=stream.read(4)
        if magic==b'\xcf\xfa\xed\xfe':subprocess.run(['/usr/bin/codesign','--verify','--strict',str(path)],check=True)
    print(json.dumps({'bundledCodex':'0.152.0','bundledClaudeCode':'2.1.258','vendorBytesAndSignaturesPreserved':True}),flush=True)

def sources(destination):
    destination.mkdir()
    for row in json.loads(LOCK.read_text()):shutil.copyfile(verified(row),destination/row['filename'])
    shutil.copyfile(LOCK,destination/'inputs.lock.json')
