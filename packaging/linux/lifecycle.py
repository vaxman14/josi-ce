"""Crash-persistent native Linux lifecycle.

Production roots, service names and executable paths are fixed. The isolated
adapter may only run child processes in a marked JosiDrive fixture and cannot
create users, write systemd units or touch an installed Josi instance.
"""
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import grp
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time

PRODUCT = Path('/var/lib/josi-ce-server')
UNIT_DIR = Path('/etc/systemd/system')
UNIT_PREFIX = 'josi-ce-'
ROLES = ('database', 'voice', 'voice-control', 'web', 'worker', 'proxy')
STOP = ('proxy', 'voice-control', 'voice', 'worker', 'web', 'database')
ACCOUNTS = {role: 'josi-ce-' + ({'voice-control':'control'}.get(role, role)) for role in ROLES}
SHARED_GROUPS = {'josi-ce-app':('web','worker'), 'josi-ce-voice-shared':('voice','voice-control')}
PHASES = ('prepared','verified','quiescing','quiesced','snapshot','provisioned',
          'database-ready','migrating','migrated','activating','activated','healthy','committed')
TRANSITIONS = {left:{right,'recovery-required'} for left,right in zip(PHASES,PHASES[1:])}
TRANSITIONS.update({'recovery-required':{'rolling-back'}, 'rolling-back':{'rolled-back','recovery-required'}})

def hashed(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def diagnostic(error):
    def redact(value):
        if isinstance(value, bytes): value = value.decode('utf-8', 'replace')
        value = str(value or '')
        value = re.sub(r'(?i)(password|token|secret|authorization|master.key)(\s*[=:]\s*)\S+', r'\1\2[redacted]', value)
        value = re.sub(r'(?i)(postgres(?:ql)?://)[^\s]+', r'\1[redacted]', value)
        value = re.sub(r'\b[a-fA-F0-9]{64}\b', '[redacted]', value)
        return value[-32768:]
    result = {'error':type(error).__name__, 'cause':redact(error)}
    if isinstance(error, (subprocess.CalledProcessError, subprocess.TimeoutExpired)):
        result['cause'] = 'A required component timed out' if isinstance(error, subprocess.TimeoutExpired) else 'A required component exited unsuccessfully'
        result['component'] = Path(str(error.cmd[0])).name if isinstance(error.cmd, (list,tuple)) and error.cmd else 'component'
        result['exitCode'] = getattr(error, 'returncode', None)
        result['stdout'] = redact(error.stdout)
        result['stderr'] = redact(error.stderr)
    return result

def emit(value):
    print(json.dumps(value), flush=True)
    try:
        if stat.S_ISREG(os.fstat(sys.stdout.fileno()).st_mode): os.fsync(sys.stdout.fileno())
    except OSError:
        pass

def plain(path, owner=None):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts: raise ValueError('Unsafe path')
    for part in (path, *path.parents):
        if part.is_symlink(): raise ValueError('Linked path')
    if owner is not None and path.exists() and path.stat().st_uid != owner: raise ValueError('Unexpected owner')
    return path

def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)

def durable(path, value, replace=False, mode=0o600):
    path = Path(path)
    plain(path.parent)
    temporary = path.with_name(path.name + '.' + secrets.token_hex(12) + '.pending')
    data = json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n' if not isinstance(value, bytes) else value
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(descriptor, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
        os.fsync(descriptor)
    finally: os.close(descriptor)
    if replace: os.replace(temporary, path)
    else:
        os.link(temporary, path)
        temporary.unlink()
    sync_directory(path.parent)

class Journal:
    def __init__(self, folder, identity=None):
        self.folder = plain(folder)
        self.folder.mkdir(mode=0o700, exist_ok=True)
        sync_directory(self.folder.parent)
        self.identity, self.records, previous = identity, [], '0' * 64
        for path in sorted(self.folder.glob('*.json')):
            if path.name != f'{len(self.records)+1:04}.json' or path.stat().st_size > 8192 or path.is_symlink() or path.stat().st_nlink != 1:
                raise ValueError('Journal sequence')
            record = json.loads(path.read_bytes())
            if set(record) != {'identity','phase','sequence','previous','time'} or record['sequence'] != len(self.records)+1 or record['previous'] != previous:
                raise ValueError('Journal chain')
            if self.identity is None: self.identity = record['identity']
            if record['identity'] != self.identity: raise ValueError('Journal identity')
            if set(self.identity) != {'from','to','manifest'} or not re.fullmatch('[a-f0-9]{64}', self.identity['manifest']): raise ValueError('Journal payload identity')
            if any(value is not None and not re.fullmatch(r'\d+\.\d+\.\d+-[a-z0-9.]+', value) for value in (self.identity['from'], self.identity['to'])):
                raise ValueError('Journal version identity')
            if self.records and record['phase'] not in TRANSITIONS.get(self.records[-1]['phase'], set()): raise ValueError('Journal transition')
            if not self.records and record['phase'] != 'prepared': raise ValueError('Journal start')
            self.records.append(record)
            previous = hashed(path)
        self.previous = previous
    def phase(self, phase):
        if self.records and phase not in TRANSITIONS.get(self.records[-1]['phase'], set()): raise ValueError('Invalid transition')
        if not self.records and phase != 'prepared': raise ValueError('Invalid initial phase')
        record = {'identity':self.identity, 'sequence':len(self.records)+1, 'previous':self.previous,
                  'phase':phase, 'time':time.time()}
        path = self.folder / f'{record["sequence"]:04}.json'
        durable(path, record)
        self.records.append(record)
        self.previous = hashed(path)

class Lifecycle:
    def __init__(self, runtime, root=PRODUCT, isolated=False, progress=None):
        self.runtime, self.root, self.isolated = plain(runtime), plain(root), isolated
        self.progress = progress or (lambda phase,service: emit({'phase':phase,'service':service}))
        if isolated:
            if os.getuid() == 0 or not str(root).startswith('/home/roman/JosiDrive/'):
                raise ValueError('Invalid isolated root')
        elif os.getuid() != 0 or self.root != PRODUCT:
            raise PermissionError('Administrator authorization required')
        self.data, self.children = self.root/'data', {}
        self.version = json.loads((runtime/'app/package.json').read_text())['version']
        if not re.fullmatch(r'\d+\.\d+\.\d+-linux\.[a-z0-9.]+', self.version): raise ValueError('Invalid version identity')
        self.installed, self.journal = self.root/'versions'/self.version, None

    def run(self, args, role=None, timeout=180, **kwargs):
        env = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin', 'TMPDIR':str(self.data/'temp'/(role or 'migrate')),
               'LD_LIBRARY_PATH':str(self.installed/'postgresql/lib'), 'LC_ALL':'C', 'LANG':'C'}
        def demote():
            if role and not self.isolated:
                user = pwd.getpwnam(ACCOUNTS[role])
                groups = [group.gr_gid for group in grp.getgrall() if user.pw_name in group.gr_mem]
                os.setgroups(groups)
                os.setgid(user.pw_gid)
                os.setuid(user.pw_uid)
            os.umask(0o077)
        return subprocess.run([str(value) for value in args], env=env, stdin=subprocess.DEVNULL,
            capture_output=True, timeout=timeout, check=True, preexec_fn=demote, **kwargs)

    def verify(self, directory=None):
        directory = directory or self.runtime
        manifest = json.loads((self.runtime.parent/'inventory.json').read_text())
        expected_arch = {'x86_64':'x86_64', 'aarch64':'aarch64'}[os.uname().machine]
        if manifest['architecture'] != expected_arch or manifest['version'] != self.version: raise ValueError('Payload identity')
        expected = {item['path']:item for item in manifest['files']}
        if len(expected) != len(manifest['files']): raise ValueError('Duplicate payload inventory entries')
        actual = set()
        for path in directory.rglob('*'):
            relative = path.relative_to(directory).as_posix()
            if path.is_symlink():
                if not path.resolve().is_relative_to(directory) or expected.get(relative,{}).get('link') != os.readlink(path):
                    raise ValueError('Payload link mismatch')
                actual.add(relative)
            elif path.is_file():
                item = expected.get(relative,{})
                if path.stat().st_nlink != 1 or item.get('size') != path.stat().st_size or item.get('sha256') != hashed(path):
                    raise ValueError('Payload hash mismatch: ' + relative)
                actual.add(relative)
            elif not path.is_dir(): raise ValueError('Special payload file')
        if actual != set(expected): raise ValueError('Incomplete payload: ' + ', '.join(sorted(actual.symmetric_difference(expected))[:10]))
        return hashed(self.runtime.parent/'inventory.json')

    def account(self, role):
        if self.isolated: return os.getuid(), os.getgid()
        user = pwd.getpwnam(ACCOUNTS[role])
        return user.pw_uid, user.pw_gid

    def identities(self, fresh):
        if self.isolated: return
        for role,name in ACCOUNTS.items():
            try: user = pwd.getpwnam(name)
            except KeyError: user = None
            try: group = grp.getgrnam(name)
            except KeyError: group = None
            if fresh and (user or group): raise ValueError('Service identity collision')
            if not fresh:
                record = json.loads((self.root/'identities.json').read_text())[role]
                if not user or not group or user.pw_gid != group.gr_gid or [user.pw_uid,user.pw_gid] != record or user.pw_shell not in ('/usr/sbin/nologin','/sbin/nologin'):
                    raise ValueError('Service identity changed')
        if not fresh: return
        records = {}
        for role,name in ACCOUNTS.items():
            self.run(['/usr/sbin/groupadd','--system',name])
            self.run(['/usr/sbin/useradd','--system','--gid',name,'--home-dir',str(self.data/'profiles'/role),
                      '--no-create-home','--shell','/usr/sbin/nologin',name])
            user = pwd.getpwnam(name)
            records[role] = [user.pw_uid,user.pw_gid]
            durable(self.root/'identities.json', records, replace=(self.root/'identities.json').exists())
        for group_name,members in SHARED_GROUPS.items():
            self.run(['/usr/sbin/groupadd','--system',group_name])
            for role in members: self.run(['/usr/sbin/usermod','-a','-G',group_name,ACCOUNTS[role]])

    def snapshot_inventory(self, directory):
        result = {}
        for path in sorted(directory.rglob('*')):
            info = path.lstat()
            name = path.relative_to(directory).as_posix()
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise ValueError('Snapshot contains a link or special file')
            xattrs = {key:os.getxattr(path,key).hex() for key in sorted(os.listxattr(path))}
            result[name] = {'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid,
                            'xattrs':xattrs,'hash':hashed(path) if path.is_file() else None}
        return result

    def write(self, path, value, role=None, mode=0o600):
        durable(path, value, mode=mode)
        if role and not self.isolated: os.chown(path, 0, self.account(role)[1])

    def layout(self, ports):
        self.data.mkdir(mode=0o700)
        if self.isolated: durable(self.data/'isolated-test.json', {'purpose':'disposable-native-acceptance'})
        else: os.chmod(self.data, 0o711)
        for folder in ('config','secrets','temp','profiles','logs','voice'):
            (self.data/folder).mkdir(mode=0o711)
        for role in (*ROLES,'migrate','bootstrap'):
            uid,gid = self.account(role) if role in ROLES else (os.getuid(),os.getgid())
            for category in ('temp','profiles','logs','secrets'):
                path = self.data/category/role
                path.mkdir(mode=0o750 if category == 'secrets' else 0o700)
                if not self.isolated: os.chown(path, 0 if category == 'secrets' else uid, gid)
        shared_gid = os.getgid() if self.isolated else grp.getgrnam('josi-ce-app').gr_gid
        for folder in ('chat-attachments','roots','versions','backups','diagnostics','codex','state'):
            path = self.data/folder
            path.mkdir(mode=0o2770)
            if not self.isolated: os.chown(path, 0, shared_gid)
        for folder,role in [('database','database'),('proxy','proxy'),('voice/gateway','voice-control'),('voice/control','voice-control')]:
            path = self.data/folder
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
            if not self.isolated: os.chown(path, *self.account(role))
        if not self.isolated:
            os.chown(self.data/'voice/gateway', self.account('voice-control')[0], grp.getgrnam('josi-ce-voice-shared').gr_gid)
            os.chmod(self.data/'voice/gateway', 0o2750)
        master,password,setup,control,gateway,initial = [secrets.token_hex(32) for _ in range(6)]
        for role in ('web','worker','migrate','bootstrap'):
            for name,value in [('master-key',master),('database-password',password)]:
                self.write(self.data/'secrets'/role/name, value.encode(), role if role in ROLES else None, 0o640)
        for role in ('web','voice-control'):
            self.write(self.data/'secrets'/role/'voice-control-token', control.encode(), role, 0o640)
        self.write(self.data/'secrets/database/init-password', initial.encode(), 'database', 0o640)
        self.write(self.data/'secrets/bootstrap/init-password', initial.encode())
        self.write(self.data/'voice/gateway/token', gateway.encode(), mode=0o640)
        durable(self.data/'voice/gateway/settings.json', {'model':'base.en','voice':'af_heart','threshold':0.5,
            'silenceMs':700,'speed':1.0,'device':'cpu'}, mode=0o640)
        if not self.isolated:
            for name in ('token','settings.json'):
                os.chown(self.data/'voice/gateway'/name, self.account('voice-control')[0], grp.getgrnam('josi-ce-voice-shared').gr_gid)
        cfg = {'schemaVersion':1,'version':self.version,'databasePort':ports[0],'apiPort':ports[1],
               'publicPort':ports[2],'voicePort':ports[3],'controlPort':ports[4],
               'setupTokenSha256':hashlib.sha256(setup.encode()).hexdigest(),'scannerSocket':''}
        self.write(self.data/'config/runtime.json', cfg, mode=0o644)
        self.write(self.data/'secrets/bootstrap/browser-token', setup.encode())
        return cfg

    def arguments(self, role, program=None):
        program = program or self.installed
        config = str(self.data/'config/runtime.json')
        test = ['--isolated'] if self.isolated else []
        if role == 'database': return [program/'postgresql/bin/postgres','-D',self.data/'database']
        if role == 'proxy': return [program/'caddy/caddy','run','--config',self.data/'config/Caddyfile','--adapter','caddyfile']
        if role in ('voice','voice-control'):
            return [program/'python/bin/python3.12','-I','-B',program/'app/native/PythonRuntime.py',role,config,*test]
        return [program/'node/bin/node',program/'app/native/Runtime.mjs',role,config,*test]

    def unit(self, role, program=None):
        program = program or self.installed
        supplemental = {'web':'josi-ce-app','worker':'josi-ce-app','voice':'josi-ce-voice-shared','voice-control':'josi-ce-voice-shared'}.get(role)
        if any(re.search(r'[\s"\'\\]', str(value)) for value in self.arguments(role, program)):
            raise ValueError('Unsafe systemd argument')
        command = ' '.join(str(value) for value in self.arguments(role, program))
        lines = ['[Unit]','Description=Josi CE Server '+role,'After=network.target',
                 *(['After=josi-ce-database.service','Requires=josi-ce-database.service'] if role in ('web','worker') else []),
                 '[Service]','Type=simple','User='+ACCOUNTS[role],'Group='+ACCOUNTS[role],
                 *(['SupplementaryGroups='+supplemental] if supplemental else []),
                 'ExecStart='+command,'Restart=on-failure','RestartSec=10','TimeoutStopSec=60','UMask=0077',
                 'WorkingDirectory='+str(program/'app'),'Environment=PATH=/usr/bin:/bin',
                 'Environment=LD_LIBRARY_PATH='+str(program/'python/lib')+':'+str(program/'postgresql/lib'),
                 *(['Environment=HOME='+str(self.data/'proxy'),
                    'Environment=XDG_DATA_HOME='+str(self.data/'proxy')] if role == 'proxy' else []),
                 'Environment=TMPDIR='+str(self.data/'temp'/role),'NoNewPrivileges=yes','PrivateTmp=yes',
                 'ProtectSystem=strict','ProtectHome=read-only','ProtectKernelTunables=yes','ProtectKernelModules=yes',
                 'ProtectControlGroups=yes','RestrictSUIDSGID=yes','LockPersonality=yes',
                 'ReadWritePaths='+str(self.data),'[Install]','WantedBy=multi-user.target','']
        return '\n'.join(lines).encode()

    def check_owned(self, program):
        if self.isolated: return
        for role in ROLES:
            path = UNIT_DIR/(UNIT_PREFIX+role+'.service')
            plain(path, 0)
            if not path.exists():
                record=json.loads((self.root/'disabled-systemd-record.json').read_text())
                name=record.get(role,'')
                if not re.fullmatch(re.escape(UNIT_PREFIX+role)+r'\.[a-f0-9]{32}\.service',name):
                    raise ValueError('Invalid retained service identity')
                path=self.root/'disabled-systemd'/name;plain(path,0)
            if not path.is_file() or path.stat().st_mode & 0o022 or path.read_bytes() != self.unit(role, program):
                raise ValueError('Unowned service definition')

    def stop(self):
        for role in STOP:
            self.progress('Stopping services', role)
            if self.isolated:
                child = self.children.pop(role, None)
                if child and child.poll() is None:
                    child.send_signal(signal.SIGTERM)
                    child.wait(timeout=60)
            else:
                result = subprocess.run(['/usr/bin/systemctl','stop',UNIT_PREFIX+role+'.service'], capture_output=True, timeout=70)
                if result.returncode and b'not loaded' not in result.stderr: raise RuntimeError('Service quiescence failed')
        if (self.data/'database/postmaster.pid').exists():
            self.run([self.installed/'postgresql/bin/pg_ctl','-D',self.data/'database','-m','fast','-w','-t','60','stop'], 'database')

    def start(self, role):
        self.progress('Starting services', role)
        if self.isolated:
            log = open(self.data/'logs'/role/'isolated.log', 'ab')
            env = {'PATH':'/usr/bin:/bin','TMPDIR':str(self.data/'temp'/role),
                   'LD_LIBRARY_PATH':str(self.installed/'python/lib')+':'+str(self.installed/'postgresql/lib')}
            if role == 'proxy': env.update(HOME=str(self.data/'proxy'), XDG_DATA_HOME=str(self.data/'proxy'))
            self.children[role] = subprocess.Popen([str(value) for value in self.arguments(role)], env=env,
                stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            log.close()
        else:
            subprocess.run(['/usr/bin/systemctl','start',UNIT_PREFIX+role+'.service'], check=True, timeout=70)

    def listeners(self, cfg):
        ports = {'database':cfg['databasePort'],'web':cfg['apiPort'],'proxy':cfg['publicPort'],
                 'voice':cfg['voicePort'],'voice-control':cfg['controlPort']}
        for role in ROLES:
            if self.isolated:
                child = self.children.get(role)
                if child is None or child.poll() is not None: raise RuntimeError('Packaged service exited')
            elif subprocess.run(['/usr/bin/systemctl','is-active','--quiet',UNIT_PREFIX+role+'.service']).returncode:
                raise RuntimeError('Service is not active')
            if role in ports:
                probe = socket.socket()
                probe.settimeout(2)
                try: probe.connect(('127.0.0.1', ports[role]))
                finally: probe.close()

    def ready(self):
        cfg = json.loads((self.data/'config/runtime.json').read_text())
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            self.progress('Checking readiness', 'web / worker / speech')
            try:
                self.listeners(cfg)
                for port in (cfg['apiPort'], cfg['publicPort']):
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                    connection.request('GET','/ready')
                    response = connection.getresponse(); response.read(); connection.close()
                    if response.status != 200: raise RuntimeError()
                heartbeat = self.data/'state/worker-heartbeat'
                if not heartbeat.exists() or time.time()-heartbeat.stat().st_mtime > 90: raise RuntimeError()
                connection = http.client.HTTPConnection('127.0.0.1',cfg['controlPort'],timeout=3)
                token = (self.data/'secrets/voice-control/voice-control-token').read_text()
                connection.request('GET','/status',headers={'Authorization':'Bearer '+token})
                response = connection.getresponse(); status_value = json.loads(response.read()); connection.close()
                if response.status != 200 or not status_value.get('helperAvailable') or (status_value.get('enabled') and not status_value.get('healthy')):
                    raise RuntimeError()
                return
            except (OSError,ValueError,RuntimeError,http.client.HTTPException): time.sleep(2)
        raise RuntimeError('Readiness deadline exceeded')

    def copy(self, source, target):
        if target.exists(): raise ValueError('Copy destination exists')
        self.progress('Copying and flushing protected files','installer')
        self.run(['/usr/bin/rsync','-aHAX','--numeric-ids',str(source)+'/',str(target)+'/'], timeout=1200)
        for path in [*target.rglob('*'), target]:
            if path.is_symlink(): continue
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try: os.fsync(descriptor)
            finally: os.close(descriptor)

    def seal_program(self, directory):
        if self.isolated: return
        for path in [directory,*directory.rglob('*')]:
            os.lchown(path,0,0)
            if not path.is_symlink(): os.chmod(path,0o755 if path.is_dir() or path.stat().st_mode&0o111 else 0o644)

    def install(self, ports=(15432,18080,8080,18081,18082), fail_at=None, interactive_uid=None, repair=False):
        if not self.isolated and (interactive_uid is None or interactive_uid < 1000 or not pwd.getpwuid(interactive_uid).pw_dir):
            raise ValueError('Logged-in installer user required')
        if fail_at and not self.isolated: raise ValueError('Fault injection is isolated only')
        if self.root.exists() and not (self.root/'installation.json').exists() and any(self.root.iterdir()):
            raise ValueError('Existing directory has no Josi ownership receipt; preserve it')
        self.root.mkdir(mode=0o700 if self.isolated else 0o711, parents=True, exist_ok=True)
        if self.root.stat().st_uid != os.getuid() or self.root.stat().st_mode & 0o022: raise ValueError('Unprotected product directory')
        lock_path = self.root/'lifecycle.lock'
        lock = os.open(lock_path, os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600)
        info = os.fstat(lock)
        if info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
            os.close(lock); raise ValueError('Unsafe lifecycle lock')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        transactions = self.root/'transactions'; transactions.mkdir(mode=0o700,exist_ok=True)
        try:
            for folder in transactions.iterdir():
                prior = Journal(folder)
                if not prior.records or prior.records[-1]['phase'] not in ('committed','rolled-back'):
                    raise RuntimeError('Earlier transaction requires recovery')
            fresh, old = not self.data.exists(), None
            if not fresh:
                marker = json.loads((self.root/'installation.json').read_text())
                if marker.get('product') != 'Josi CE Server': raise ValueError('Unrelated data')
                if (self.data/'database/PG_VERSION').read_text().strip() != '16': raise ValueError('Database major-version conversion requires review')
                old = json.loads((self.data/'config/runtime.json').read_text())['version']
                self.check_owned(self.root/'versions'/old)
                if old == self.version and not repair: raise ValueError('This version is already installed; preserve it')
            folder = transactions/secrets.token_hex(16)
            self.journal = Journal(folder, {'from':old,'to':self.version,'manifest':self.verify()})
            def phase(name):
                self.journal.phase(name); self.progress(name,'installer')
                if fail_at == name: raise RuntimeError('Injected isolated failure')
            phase('prepared'); phase('verified')
            if fresh:
                if not self.isolated:
                    for role in ROLES:
                        if (UNIT_DIR/(UNIT_PREFIX+role+'.service')).exists(): raise ValueError('Existing systemd unit must be preserved')
                probes=[]
                try:
                    if len(set(ports)) != 5 or any(not isinstance(port,int) or port<1024 or port>65535 for port in ports): raise ValueError('Invalid ports')
                    for port in ports:
                        probe=socket.socket(); probes.append(probe)
                        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                        probe.bind(('127.0.0.1',port))
                finally:
                    for probe in probes: probe.close()
            self.identities(fresh)
            self.installed.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
            if self.installed.exists(): self.verify(self.installed)
            else:
                staged=folder/'program'; self.copy(self.runtime,staged); self.seal_program(staged); self.verify(staged); os.rename(staged,self.installed)
            phase('quiescing')
            if not fresh: self.stop()
            phase('quiesced')
            if not fresh:
                before=self.snapshot_inventory(self.data); self.copy(self.data,folder/'snapshot')
                if self.snapshot_inventory(folder/'snapshot') != before: raise ValueError('Cold snapshot verification failed')
                durable(folder/'snapshot-inventory',before)
            phase('snapshot')
            if fresh:
                durable(self.root/'installation.json',{'product':'Josi CE Server','id':secrets.token_hex(16)})
                cfg=self.layout(ports)
                self.run([self.installed/'postgresql/bin/initdb','-D',self.data/'database','-U','bootstrap_admin',
                    '--pwfile='+str(self.data/'secrets/database/init-password'),'--auth-host=scram-sha-256',
                    '--auth-local=scram-sha-256','--encoding=UTF8','--locale=C'],'database')
                settings=("listen_addresses='127.0.0.1'\nport=%d\nunix_socket_directories=''\npassword_encryption='scram-sha-256'\n"
                    "log_statement='none'\nlog_min_error_statement='panic'\nlog_parameter_max_length=0\nlog_parameter_max_length_on_error=0\n") % cfg['databasePort']
                durable(self.data/'database/postgresql.auto.conf',settings.encode(),replace=True,mode=0o600)
                if not self.isolated: os.chown(self.data/'database/postgresql.auto.conf',*self.account('database'))
                self.write(self.data/'config/Caddyfile',(f"{{\n admin off\n auto_https off\n}}\nhttp://localhost:{cfg['publicPort']} {{\n"
                    f" bind 127.0.0.1\n reverse_proxy 127.0.0.1:{cfg['apiPort']}\n}}\n").encode(),mode=0o644)
            phase('provisioned')
            self.run([self.installed/'postgresql/bin/pg_ctl','-D',self.data/'database','-l',self.data/'logs/database/setup.log','-w','-t','60','start'],'database')
            if fresh:
                self.run(self.arguments('bootstrap'))
                for role in ('bootstrap','database'): (self.data/'secrets'/role/'init-password').unlink()
            phase('database-ready'); phase('migrating'); self.run(self.arguments('migrate'),timeout=300); phase('migrated')
            self.run([self.installed/'postgresql/bin/pg_ctl','-D',self.data/'database','-m','fast','-w','-t','60','stop'],'database')
            phase('activating')
            cfg=json.loads((self.data/'config/runtime.json').read_text()); cfg['version']=self.version
            durable(self.data/'config/runtime.json',cfg,replace=True,mode=0o644)
            if not self.isolated:
                for role in ROLES: durable(UNIT_DIR/(UNIT_PREFIX+role+'.service'),self.unit(role),replace=True,mode=0o644)
                subprocess.run(['/usr/bin/systemctl','daemon-reload'],check=True)
                for role in ROLES: subprocess.run(['/usr/bin/systemctl','enable',UNIT_PREFIX+role+'.service'],check=True)
            for role in ROLES: self.start(role)
            phase('activated'); self.ready(); phase('healthy')
            if not self.isolated:
                handoff=self.root/'handoff'/str(interactive_uid); handoff.mkdir(mode=0o700,parents=True,exist_ok=True)
                durable(handoff/'bootstrap.json',{'token':(self.data/'secrets/bootstrap/browser-token').read_text(),'port':cfg['publicPort']},replace=True)
                os.chown(handoff/'bootstrap.json',interactive_uid,-1); os.chown(handoff,interactive_uid,-1)
            phase('committed')
            durable(self.root/'status.json',{'installed':True,'version':self.version,'publicPort':cfg['publicPort']},replace=True,mode=0o644)
            return folder
        except Exception as error:
            if self.journal: durable(self.journal.folder/'failure-diagnostics',diagnostic(error),replace=True)
            if self.journal and self.journal.records[-1]['phase'] not in ('committed','rolled-back','recovery-required'):
                self.journal.phase('recovery-required')
            self.progress('Recovery required; existing data retained','installer')
            raise
        finally:
            fcntl.flock(lock,fcntl.LOCK_UN); os.close(lock)

    def recover(self, folder):
        """Restore a verified cold snapshot only before candidate activation.

        Failed data is retained beside the transaction. Once activation starts,
        automatic rollback is refused because newer user writes may exist.
        """
        folder=plain(folder)
        if folder.parent != self.root/'transactions': raise ValueError('Foreign transaction')
        lock=os.open(self.root/'lifecycle.lock',os.O_RDWR|os.O_NOFOLLOW)
        try:
            info=os.fstat(lock)
            if info.st_nlink!=1 or info.st_uid!=os.getuid() or info.st_mode&0o077: raise ValueError('Unsafe recovery lock')
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            journal=Journal(folder); phases=[record['phase'] for record in journal.records]
            if 'activating' in phases: raise RuntimeError('Activation began; preserve current data for lossless manual recovery')
            if not phases or phases[-1]!='recovery-required': raise ValueError('Not a recoverable transaction')
            if not journal.identity['from']: raise RuntimeError('No verified previous installation; preserve provisioning evidence for review')
            self.check_owned(self.root/'versions'/journal.identity['from'])
            if 'migrating' not in phases:
                if json.loads((self.data/'config/runtime.json').read_text())['version']!=journal.identity['from']:
                    raise ValueError('Previous activation identity changed')
                self.stop(); journal.phase('rolling-back'); self.installed=self.root/'versions'/journal.identity['from']
                for role in ROLES:self.start(role)
                self.ready(); journal.phase('rolled-back'); return
            if 'snapshot' not in phases: raise ValueError('Migration lacks a verified snapshot')
            expected=json.loads((folder/'snapshot-inventory').read_text())
            if self.snapshot_inventory(folder/'snapshot')!=expected: raise ValueError('Snapshot integrity failed')
            self.stop(); journal.phase('rolling-back')
            retained=folder/'failed-data'
            if retained.exists(): raise ValueError('Recovery already started; preserve both copies')
            os.rename(self.data,retained); self.copy(folder/'snapshot',self.data)
            if self.snapshot_inventory(self.data)!=expected: raise ValueError('Restored data integrity failed')
            self.installed=self.root/'versions'/journal.identity['from']
            for role in ROLES:self.start(role)
            self.ready(); journal.phase('rolled-back')
        finally:
            fcntl.flock(lock,fcntl.LOCK_UN); os.close(lock)

if __name__ == '__main__':
    try:
        runtime=Path(__file__).resolve().parents[2]
        if sys.argv[1:]==['verify']:
            obj=object.__new__(Lifecycle); obj.runtime=runtime
            obj.version=json.loads((runtime/'app/package.json').read_text())['version']
            emit({'verified':obj.verify(),'architecture':os.uname().machine})
        elif len(sys.argv)==3 and sys.argv[1]=='install' and sys.argv[2].isascii() and sys.argv[2].isdecimal():
            Lifecycle(runtime).install(interactive_uid=int(sys.argv[2]))
        else: raise ValueError('Unsupported lifecycle command')
    except Exception as error:
        emit({'phase':'Stopped',**diagnostic(error)})
        sys.exit(1)
