#!/usr/bin/env python3
"""Narrow Docker-socket helper for one Josi NAS backup mount."""
import argparse, json, os, re, shutil, socketserver, subprocess, tempfile, threading, uuid
from http.server import BaseHTTPRequestHandler
from pathlib import Path

SAFE_HOST = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
SAFE_SHARE = re.compile(r"^[A-Za-z0-9._$ -]{1,255}$")
SAFE_EXPORT = re.compile(r"^/[A-Za-z0-9._ /-]{1,254}$")

class Manager:
    def __init__(self, root: Path, state: Path, image: str):
        self.root, self.state, self.image = root.resolve(), state.resolve(), image
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.state, 0o700)
        self.docker = shutil.which('docker')
        if self.docker not in ('/usr/bin/docker', '/usr/local/bin/docker'):
            raise ValueError('Docker CLI is unavailable')
        self.lock = threading.Lock()
        self.volume = 'josi-ce_nas_backup'

    def run(self, args, timeout=600, capture=False):
        return subprocess.run([self.docker, '--host', 'unix:///var/run/docker.sock', *args],
            check=True, timeout=timeout, text=True, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
            env={'PATH':'/usr/bin:/bin','HOME':str(self.state)})

    def compose_files(self, include_storage: bool):
        files = [self.root / 'docker-compose.yml']
        workspace = self.root / 'docker-compose.workspace.yml'
        if workspace.exists():
            files.append(workspace)
        env_path = self.root / '.env'
        if env_path.exists() and any(
            line.strip() == 'JOSI_ACCESS_MODE=proxy'
            for line in env_path.read_text(errors='replace').splitlines()
        ):
            no_proxy = self.root / 'docker-compose.noproxy.yml'
            if no_proxy.exists():
                files.append(no_proxy)
        if include_storage:
            files.append(self.root / 'docker-compose.storage.yml')
        args = ['compose']
        for path in files:
            args += ['-f', str(path)]
        return args + ['--project-directory', str(self.root), '--project-name', 'josi-ce']

    def validate(self, body):
        protocol = 'nfs' if body.get('protocol') == 'nfs' else 'smb'
        host, share = str(body.get('host','')).strip(), str(body.get('share','')).strip()
        folder = str(body.get('folder','')).strip().strip('/')
        valid_share = SAFE_EXPORT.fullmatch(share) if protocol == 'nfs' else SAFE_SHARE.fullmatch(share)
        if not SAFE_HOST.fullmatch(host) or not valid_share or '..' in share or '..' in folder:
            raise ValueError('NAS address, share, or folder is invalid')
        return protocol, host, share, folder

    def mount(self, body, volume=None, credential_path=None):
        protocol, host, share, folder = self.validate(body)
        volume = volume or self.volume
        self.run(['volume','rm','-f',volume], timeout=30)
        args = ['volume','create','--driver','local']
        if protocol == 'smb':
            cred = credential_path or self.state / 'nas.credentials'
            username, password = str(body.get('username','')), str(body.get('password',''))
            if any(ch in username + password for ch in ('\n', '\r', '\x00')):
                raise ValueError('NAS credentials contain unsupported control characters')
            # Always replace this runtime projection from the supplied Vault
            # credential. A file left by an earlier setup is never authority.
            fd, name = tempfile.mkstemp(dir=self.state, prefix='.nas.', text=True)
            with os.fdopen(fd, 'w') as out:
                out.write('username=' + username + '\npassword=' + password + '\n')
                out.flush(); os.fsync(out.fileno())
            os.chmod(name, 0o600); os.replace(name, cred)
            opts = f'credentials={cred},uid=1000,gid=1000,file_mode=0600,dir_mode=0700,noserverino'
            args += ['--opt','type=cifs','--opt',f'device=//{host}/{share}','--opt',f'o={opts}']
        else:
            (credential_path or self.state / 'nas.credentials').unlink(missing_ok=True)
            args += ['--opt','type=nfs','--opt',f'device=:{share if share.startswith("/") else "/"+share}','--opt',f'o=addr={host},rw,nfsvers=4']
        args.append(volume); self.run(args, timeout=60)
        return folder

    def browse(self, body):
        # Browsing must not replace the live backup volume or its credentials.
        with self.lock:
            volume = 'josi-ce_nas_browse_' + uuid.uuid4().hex
            cred = self.state / (volume + '.credentials')
            try:
                self.mount(body, volume, cred)
                result = self.run(['run','--rm','--network','none','-v',f'{volume}:/share:ro',
                    '--entrypoint','python3',self.image,'-c',
                    "import json,os; print(json.dumps(sorted([x for x in os.listdir('/share') if os.path.isdir('/share/'+x)])))"], capture=True)
                return {'folders': json.loads(result.stdout or '[]')[:500]}
            finally:
                cred.unlink(missing_ok=True)
                self.run(['volume','rm','-f',volume], timeout=30)

    def status(self):
        with self.lock:
            return self._status()

    def _status(self):
        marker = self.state / 'nas.mount.json'
        if not marker.exists():
            return None
        return json.loads(marker.read_text())

    def configure(self, body):
        revision = str(body.get('configurationRevision', ''))
        if str(uuid.UUID(revision)) != revision:
            raise ValueError('a valid configuration revision is required')
        with self.lock:
            marker = self.state / 'nas.mount.json'
            marker.unlink(missing_ok=True)
            folder = self.mount(body)
            mount = '/mnt/josi-nas' + (('/' + folder) if folder else '')
            override = self.root / 'docker-compose.storage.yml'
            data = {'services': {'web': {'volumes': [f'{self.volume}:/mnt/josi-nas']},
                                  'worker': {'volumes': [f'{self.volume}:/mnt/josi-nas']}},
                    'volumes': {self.volume: {'external': True}}}
            temp = override.with_suffix('.tmp'); temp.write_text(json.dumps(data)); os.replace(temp, override)
            compose = self.compose_files(True) + ['up','-d','--no-deps','--force-recreate','web','worker']
            self.run(compose)
            status = {'mountedPath': mount, 'configurationRevision': revision}
            temp = marker.with_suffix('.tmp'); temp.write_text(json.dumps(status)); os.chmod(temp, 0o600); os.replace(temp, marker)
            return status

    def remove(self, body=None):
        with self.lock:
            expected = (body or {}).get('expectedRevision')
            current = self._status()
            if expected and current and current.get('configurationRevision') != expected:
                raise ValueError('the NAS configuration changed before removal')
            (self.state/'nas.mount.json').unlink(missing_ok=True)
            (self.root/'docker-compose.storage.yml').unlink(missing_ok=True)
            (self.state/'nas.credentials').unlink(missing_ok=True)
            self.run(self.compose_files(False) + ['up','-d','--no-deps','--force-recreate','web','worker'])
            self.run(['volume','rm','-f',self.volume], timeout=30)
            return {'ok': True}

class Handler(BaseHTTPRequestHandler):
    manager = None
    def do_POST(self):
        try:
            size = int(self.headers.get('content-length','0'))
            if size > 65536: raise ValueError('request is too large')
            body = json.loads(self.rfile.read(size) or b'{}')
            if self.path == '/browse': result = self.manager.browse(body)
            elif self.path == '/configure': result = self.manager.configure(body)
            elif self.path == '/remove': result = self.manager.remove(body)
            elif self.path == '/status': result = self.manager.status()
            else: self.send_error(404); return
            self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(json.dumps(result).encode())
        except Exception as exc:
            self.send_response(400); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(json.dumps({'error':str(exc)}).encode())
    def log_message(self, *_): pass

def main():
    p=argparse.ArgumentParser(); p.add_argument('--root',required=True); p.add_argument('--state',required=True); p.add_argument('--socket',required=True); p.add_argument('--image',required=True); p.add_argument('--socket-gid',type=int,required=True); a=p.parse_args()
    Handler.manager=Manager(Path(a.root),Path(a.state),a.image); path=Path(a.socket); path.unlink(missing_ok=True); path.parent.mkdir(parents=True,exist_ok=True)
    class Server(socketserver.ThreadingUnixStreamServer): daemon_threads=True
    with Server(str(path),Handler) as server:
        os.chmod(path,0o660); os.chown(path,-1,a.socket_gid); server.serve_forever()
if __name__ == '__main__': main()
