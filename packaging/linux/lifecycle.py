"""Crash-persistent native Linux lifecycle.

Production roots, service names and executable paths are fixed. The isolated
adapter may only run child processes in a marked JosiDrive fixture and cannot
create users, write systemd units or touch an installed Josi instance.
"""
import fcntl
import hashlib
import http.client
import ipaddress
import itertools
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

PRODUCT = Path('/var/lib/josi')
# josi.service is the one unit an administrator starts, stops or enables. The
# six isolated services below are PartOf it, so they follow it.
PARENT_UNIT = 'josi.service'
UNIT_DIR = Path('/etc/systemd/system')
UNIT_PREFIX = 'josi-ce-'
ROLES = ('database', 'voice', 'voice-control', 'web', 'worker', 'proxy')
STOP = ('proxy', 'voice-control', 'voice', 'worker', 'web', 'database')
DEFAULT_PORTS = (15432, 18080, 8080, 18081, 18082)
ACCOUNTS = {role: 'josi-ce-' + ({'voice-control':'control'}.get(role, role)) for role in ROLES}
SHARED_GROUPS = {'josi-ce-app':('web','worker'), 'josi-ce-voice-shared':('voice','voice-control')}
PHASES = ('prepared','verified','quiescing','quiesced','snapshot','provisioned',
          'database-ready','migrating','migrated','activating','activated','healthy','committed')
TRANSITIONS = {left:{right,'recovery-required'} for left,right in zip(PHASES,PHASES[1:])}
TRANSITIONS.update({'recovery-required':{'activated','rolling-back'}, 'rolling-back':{'rolled-back','recovery-required'}})
TERMINAL = ('committed','rolled-back')
VERSION_PATTERN = r'\d+\.\d+\.\d+(?:-[a-z0-9.]+)?'

# The installer's answers: how people reach Josi, its port and PC control.
# Written by josi-ce-server-install (root), read here and by Runtime.mjs.
SETTINGS = Path('/etc/josi/install.json')
SETTINGS_KEYS = {'schemaVersion','addressMode','appUrl','lanAddress','domain','email','publicUrl','port','pcControlUser','browser'}
# Keys that older files do not have, and that are only written when set.
OPTIONAL_SETTINGS_KEYS = {'browser','openSetup'}
# Josi's own browser (josi-browser.service): Chrome for Testing on a hidden
# Xvfb screen, run by the launcher as the PC control account.
BROWSER_UNIT = 'josi-browser.service'
BROWSER_LAUNCHER = 'app/packaging/linux/pc-executor/josi-browser.mjs'
BROWSER_EXTENSION = 'app/browser-extension/chrome'
# PC control: josi-pc.service runs the executor as the chosen human account.
# The web service and the executor meet only in data/pc-spool (root:josi-pc 2770).
PC_UNIT = 'josi-pc.service'
PC_GROUP = 'josi-pc'
PC_EXECUTOR = 'app/packaging/linux/pc-executor/josi-pc.mjs'
# The browser native-messaging host (browser.mjs makes the wrapper and the
# manifests); the wrapper names the current version's node and host script.
BROWSER_MODULE = 'app/packaging/linux/pc-executor/browser.mjs'
BROWSER_SCRIPT = 'app/packaging/linux/pc-executor/josi-browser-host.mjs'
BROWSER_WRAPPER = Path('/usr/lib/josi/josi-browser-host')
BROWSER_HOST_NAME = 'com.heyjosi.browser'
BROWSER_DIRS = ('/etc/opt/chrome/native-messaging-hosts', '/etc/chromium/native-messaging-hosts',
                '/etc/opt/edge/native-messaging-hosts', '/usr/lib/mozilla/native-messaging-hosts')
HOSTNAME = re.compile(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')
DOMAIN = re.compile(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]')
EMAIL = re.compile(r'[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}')
USERNAME = re.compile(r'[a-z_][a-z0-9_-]{0,31}')

class Stopped(BaseException):
    """SIGTERM or SIGHUP reached the lifecycle; recorded like any failure."""

def _host(value):
    value = str(value or '').strip().lower()
    try:
        address = ipaddress.ip_address(value)
        if address.version != 4 or address.is_unspecified or address.is_multicast: raise ValueError('Invalid address')
        return value
    except ValueError:
        if not HOSTNAME.fullmatch(value) or value.replace('.','').isdigit(): raise ValueError('Invalid host name: '+value[:80])
        return value

def normalize_settings(value):
    """Validate the installer's answers and derive the browser address (appUrl).

    lan     http://<lanAddress>:<port>        Caddy serves plain HTTP on the port
    domain  https://<domain>                  Caddy gets a certificate (80 and 443)
    proxy   <publicUrl> (https)               the administrator's own reverse proxy
    """
    if not isinstance(value, dict): raise ValueError('Invalid install settings')
    mode = value.get('addressMode', 'lan')
    port = value.get('port', 8080)
    if mode not in ('lan','domain','proxy'): raise ValueError('Invalid address mode')
    if not isinstance(port, int) or isinstance(port, bool) or not 1024 <= port <= 65535: raise ValueError('Invalid port')
    result = {'schemaVersion':1,'addressMode':mode,'lanAddress':None,'domain':None,'email':None,'publicUrl':None,'port':port,
              'pcControlUser':None,'browser':False}
    browser = value.get('browser', False)
    if not isinstance(browser, bool): raise ValueError('Invalid browser answer')
    open_setup = value.get('openSetup', False)
    if not isinstance(open_setup, bool): raise ValueError('Invalid open setup answer')
    # The first visitor may start setup without the one-use link: plain-HTTP LAN installs only
    # (the Docker image turns it on); never behind a tunnel or a public address.
    if open_setup and mode == 'lan': result['openSetup'] = True
    if mode == 'lan':
        result['lanAddress'] = _host(value.get('lanAddress') or '127.0.0.1')
        result['appUrl'] = f"http://{result['lanAddress']}:{port}"
    elif mode == 'domain':
        domain = str(value.get('domain') or '').strip().lower().rstrip('.')
        if not DOMAIN.fullmatch(domain): raise ValueError('Invalid domain name')
        result['domain'], result['appUrl'] = domain, 'https://' + domain
    else:
        from urllib.parse import urlsplit
        url = urlsplit(str(value.get('publicUrl') or '').strip())
        try: url_port = url.port
        except ValueError as error: raise ValueError('Invalid public address port') from error
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ('','/') or url.query or url.fragment:
            raise ValueError('The public address must be https://<host> with no path')
        origin = 'https://' + _host(url.hostname) + (f':{url_port}' if url_port and url_port != 443 else '')
        result['publicUrl'] = result['appUrl'] = origin
    email = value.get('email')
    if email:
        email = str(email).strip()
        if len(email) > 254 or not EMAIL.fullmatch(email): raise ValueError('Invalid certificate email')
        if mode == 'domain': result['email'] = email
    user = value.get('pcControlUser')
    if user:
        if not isinstance(user, str) or not USERNAME.fullmatch(user): raise ValueError('Invalid PC control user')
        result['pcControlUser'] = user
        result['browser'] = browser  # only with PC control
    return result

def load_settings(path=SETTINGS):
    """The saved answers, or the defaults when the installer saved none."""
    if path is None or not Path(path).exists(): return normalize_settings({})
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 4096 or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError('Unsafe install settings file')
        value = json.loads(os.read(descriptor, 4097))
    finally: os.close(descriptor)
    # A file saved before the browser answer existed has no 'browser' key.
    if not isinstance(value, dict) or not SETTINGS_KEYS - OPTIONAL_SETTINGS_KEYS <= set(value) <= SETTINGS_KEYS | OPTIONAL_SETTINGS_KEYS:
        raise ValueError('Invalid install settings')
    normal = normalize_settings(value)
    if normal['appUrl'] != value['appUrl']: raise ValueError('Invalid install settings address')
    return normal

def pc_account(name):
    """The human account PC control runs as: a real login account."""
    user = pwd.getpwnam(name)
    if user.pw_uid < 1000 or user.pw_uid == 65534 or user.pw_shell.endswith(('/nologin','/false')):
        raise ValueError('PC control needs a normal login account: '+name)
    return user, grp.getgrgid(user.pw_gid).gr_name

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
    # The installer that reads this may be gone (Ctrl-C, a dropped SSH
    # session); the lifecycle still finishes its work or records recovery.
    try: print(json.dumps(value), flush=True)
    except (BrokenPipeError, OSError, ValueError): return
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
        os.fchmod(descriptor, mode)
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

def protect_product_root(path, isolated=False):
    """Validate ownership first, then restore the service traversal boundary."""
    path = Path(path)
    path.mkdir(mode=0o700 if isolated else 0o711, parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('Unprotected product directory')
    if not isolated:
        os.chmod(path, 0o711)

def protect_program_root(path, isolated=False):
    """Keep immutable runtimes traversable despite a restrictive root umask."""
    path = Path(path)
    path.mkdir(mode=0o755, parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('Unprotected program directory')
    if not isolated:
        os.chmod(path, 0o755)

def prepare_browser_handoff(root, interactive_uid):
    """Keep the shared boundary traversable and each user's handoff private."""
    parent = plain(Path(root) / 'handoff')
    parent.mkdir(mode=0o711, exist_ok=True)
    info = parent.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('Unprotected browser handoff directory')
    os.chmod(parent, 0o711)
    handoff = plain(parent / str(interactive_uid))
    handoff.mkdir(mode=0o700, exist_ok=True)
    info = handoff.stat()
    if info.st_uid not in (os.getuid(), interactive_uid) or info.st_mode & 0o077:
        raise ValueError('Unprotected user browser handoff directory')
    os.chmod(handoff, 0o700)
    os.chown(handoff, interactive_uid, -1)
    return handoff

def available_ports(preferred=DEFAULT_PORTS):
    """Choose collision-free fresh-install ports, preferring stable defaults.

    Internal services bind loopback. The public proxy binds every IPv4
    interface, so its availability probe must do the same or a Docker-published
    port can slip past the preflight and fail only after provisioning.
    """
    if len(preferred) != 5 or len(set(preferred)) != 5 or any(
        not isinstance(port, int) or isinstance(port, bool) or port < 1024 or port > 65535
        for port in preferred
    ):
        raise ValueError('Invalid ports')
    selected, reservations = [], []
    try:
        for index, first in enumerate(preferred):
            address = '0.0.0.0' if index == 2 else '127.0.0.1'
            candidates = itertools.chain(range(first, 65536), range(1024, first))
            for port in candidates:
                if port in selected:
                    continue
                probe = socket.socket()
                # As the services themselves bind: a port with only closed
                # connections in TIME_WAIT is free, a listening one is not.
                # Without this a reinstall right after an uninstall moved
                # every port up by one.
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    probe.bind((address, port))
                    probe.listen(1)
                except OSError:
                    probe.close()
                    continue
                reservations.append(probe)
                selected.append(port)
                break
            else:
                raise RuntimeError('No available service port')
        return tuple(selected)
    finally:
        for probe in reservations:
            probe.close()

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
            if any(value is not None and not re.fullmatch(VERSION_PATTERN, value) for value in (self.identity['from'], self.identity['to'])):
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

def stop_requested(signum, frame):
    ignore_stop_signals()
    raise Stopped(signal.Signals(signum).name)

def handle_stop_signals():
    """SIGTERM and SIGHUP become an exception the lifecycle records as
    recovery-required. A SIGHUP the parent already ignores (the one-command
    installer ignores it so a dropped SSH session does not stop an install)
    stays ignored."""
    signal.signal(signal.SIGTERM, stop_requested)
    if signal.getsignal(signal.SIGHUP) is not signal.SIG_IGN:
        signal.signal(signal.SIGHUP, stop_requested)

def ignore_stop_signals():
    """While a failure is being recorded, nothing interrupts the record."""
    try:
        for value in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT): signal.signal(value, signal.SIG_IGN)
    except ValueError:
        pass  # not the main thread

def lock_lifecycle(root):
    descriptor = os.open(Path(root)/'lifecycle.lock', os.O_RDWR | os.O_NOFOLLOW)
    info = os.fstat(descriptor)
    if info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(descriptor); raise ValueError('Unsafe lifecycle lock')
    try: fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError: os.close(descriptor); raise
    return descriptor

def port_is_free(port, address='0.0.0.0'):
    probe = socket.socket()
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try: probe.bind((address, port)); probe.listen(1); return True
    except OSError: return False
    finally: probe.close()

def mark_interrupted(journal):
    """A transaction left mid-phase by a process that died (power loss, kill -9).

    Only called with the lifecycle lock held, so its writer is gone; record it
    as needing recovery so the ordinary recovery paths can close it.
    """
    if journal.records and journal.records[-1]['phase'] not in (*TERMINAL, 'recovery-required'):
        journal.phase('recovery-required')

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
        if not re.fullmatch(VERSION_PATTERN, self.version): raise ValueError('Invalid version identity')
        self.installed, self.journal = self.root/'versions'/self.version, None
        self.settings_path = None if isolated else SETTINGS

    def settings(self):
        return load_settings(self.settings_path)

    def ensure_pc_group(self):
        """The group the web service and the PC executor share for the spool."""
        if self.isolated: return
        try: grp.getgrnam(PC_GROUP)
        except KeyError: self.run(['/usr/sbin/groupadd','--system',PC_GROUP])

    def repair_pc_spool(self):
        path = plain(self.data/'pc-spool')
        path.mkdir(mode=0o2770, exist_ok=True)
        if path.is_symlink() or not path.is_dir(): raise ValueError('Unsafe PC spool')
        if not self.isolated:
            self.ensure_pc_group()
            os.chown(path, 0, grp.getgrnam(PC_GROUP).gr_gid)
        os.chmod(path, 0o2770)

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
        recorded = None
        if fresh and (self.root/'identities.json').exists():
            recorded = json.loads((self.root/'identities.json').read_text())
        for role,name in ACCOUNTS.items():
            try: user = pwd.getpwnam(name)
            except KeyError: user = None
            try: group = grp.getgrnam(name)
            except KeyError: group = None
            if fresh and recorded is not None:
                record = recorded.get(role)
                if not user or not group or user.pw_gid != group.gr_gid or [user.pw_uid,user.pw_gid] != record or user.pw_shell not in ('/usr/sbin/nologin','/sbin/nologin'):
                    raise ValueError('Recovered service identity changed')
            elif fresh and (user or group): raise ValueError('Service identity collision')
            if not fresh:
                record = json.loads((self.root/'identities.json').read_text())[role]
                if not user or not group or user.pw_gid != group.gr_gid or [user.pw_uid,user.pw_gid] != record or user.pw_shell not in ('/usr/sbin/nologin','/sbin/nologin'):
                    raise ValueError('Service identity changed')
        if not fresh: return
        if recorded is not None:
            for group_name,members in SHARED_GROUPS.items():
                group = grp.getgrnam(group_name)
                if any(ACCOUNTS[role] not in group.gr_mem for role in members):
                    raise ValueError('Recovered shared service identity changed')
            return
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

    def write(self, path, value, role=None, mode=0o600, replace=False):
        durable(path, value, mode=mode, replace=replace)
        if role and not self.isolated: os.chown(path, 0, self.account(role)[1])

    def layout(self, ports):
        self.data.mkdir(mode=0o700)
        if self.isolated: durable(self.data/'isolated-test.json', {'purpose':'disposable-native-acceptance'})
        else: os.chmod(self.data, 0o711)
        for folder in ('config','secrets','temp','profiles','logs','voice'):
            path = self.data/folder
            path.mkdir(mode=0o711)
            os.chmod(path, 0o711)
        for role in (*ROLES,'migrate','bootstrap'):
            uid,gid = self.account(role) if role in ROLES else (os.getuid(),os.getgid())
            for category in ('temp','profiles','logs','secrets'):
                path = self.data/category/role
                path.mkdir(mode=0o750 if category == 'secrets' else 0o700)
                os.chmod(path, 0o750 if category == 'secrets' else 0o700)
                if not self.isolated: os.chown(path, 0 if category == 'secrets' else uid, gid)
        shared_gid = os.getgid() if self.isolated else grp.getgrnam('josi-ce-app').gr_gid
        for folder in ('chat-attachments','roots','versions','backups','diagnostics','codex','state'):
            path = self.data/folder
            path.mkdir(mode=0o2770)
            os.chmod(path, 0o2770)
            if not self.isolated: os.chown(path, 0, shared_gid)
        for folder,role in [('database','database'),('proxy','proxy'),('keys','web'),('voice/gateway','voice-control'),('voice/control','voice-control')]:
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

    def repair_key_folder(self):
        """The web service's relay keys, when no Secret Service works for it.

        The service can't create this itself: the data root isn't writable by
        it. An upgrade from before this folder existed gets it here.
        """
        path = plain(self.data/'keys')
        path.mkdir(mode=0o700, exist_ok=True)
        os.chmod(path, 0o700)
        if not self.isolated: os.chown(path, *self.account('web'))

    def repair_layout_permissions(self):
        """Reassert the fixed service-write boundary after older installs.

        mkdir modes are filtered by the invoking user's umask. Explicit chmod
        keeps shared application directories group-writable on physical hosts,
        including upgrades from candidates created before this repair.
        """
        self.repair_key_folder()
        self.repair_pc_spool()
        if self.isolated: return
        shared_gid = grp.getgrnam('josi-ce-app').gr_gid
        for folder in ('chat-attachments','roots','versions','backups','diagnostics','codex','state'):
            path = self.data/folder; plain(path, 0)
            os.chown(path, 0, shared_gid); os.chmod(path, 0o2770)

    def prune_cli_scratch(self):
        """Remove the bundled Codex CLI's per-run trampolines before a snapshot.

        Codex links helper names (apply_patch, codex-linux-sandbox, ...) to its
        own binary in <home>/tmp/arg0/codex-arg0XXXX on every start. They are
        scratch it recreates, they point into versions/, and the cold snapshot
        refuses links. Only folders exactly at .../tmp/arg0 under the services'
        homes and the shared Codex home are removed, and only with the services
        stopped; nothing they contain is followed.
        """
        for home in [self.data/'codex', *(self.data/'profiles').glob('*/.codex'), *(self.data/'codex').glob('*/.codex')]:
            scratch = home/'tmp'/'arg0'
            if scratch.is_dir() and not scratch.is_symlink():
                plain(scratch)
                shutil.rmtree(scratch)

    def seal_traversal_permissions(self):
        if self.isolated: return
        for path in (self.root, self.data, self.data/'secrets'):
            plain(path, 0); os.chmod(path, 0o711)

    def settle_activated_recovery(self, interactive_uid):
        """Close a retained transaction without discarding reachable data."""
        for folder in sorted((self.root/'transactions').iterdir()):
            prior = Journal(folder)
            if not prior.records and not any(folder.iterdir()):
                folder.rmdir(); continue  # stopped before its first record
            if not prior.records or prior.records[-1]['phase'] in TERMINAL: continue
            mark_interrupted(prior)
            phases = [record['phase'] for record in prior.records]
            if prior.records[-1]['phase'] != 'recovery-required':
                raise RuntimeError('Earlier transaction requires recovery')
            if prior.identity['from'] is None and 'activating' not in phases:
                retained = folder/'failed-data'
                if retained.exists():
                    raise RuntimeError('Fresh-install recovery evidence already exists')
                if self.data.exists():
                    os.rename(self.data, retained)
                    sync_directory(folder); sync_directory(self.root)
                prior.phase('rolling-back'); prior.phase('rolled-back')
                continue
            configured = json.loads((self.data/'config/runtime.json').read_text())['version']
            if 'activating' not in phases:
                if 'migrating' in phases or prior.identity['from'] != configured:
                    raise RuntimeError('Earlier transaction requires snapshot recovery')
                self.installed = self.root/'versions'/configured
                self.check_owned(self.installed)
                self.repair_layout_permissions()
                self.stop(); prior.phase('rolling-back')
                try:
                    for role in ROLES: self.start(role)
                    self.ready()
                except Exception:
                    prior.phase('recovery-required')
                    raise
                prior.phase('rolled-back')
                continue
            if prior.identity['to'] != configured:
                raise RuntimeError('Earlier activated transaction identity changed')
            self.installed = self.root/'versions'/configured
            self.check_owned(self.installed)
            self.repair_layout_permissions()
            self.stop()
            for role in ROLES: self.start(role)
            prior.phase('activated')
            try: self.ready()
            except Exception:
                prior.phase('recovery-required')
                raise
            prior.phase('healthy')
            cfg = json.loads((self.data/'config/runtime.json').read_text())
            handoff=prepare_browser_handoff(self.root,interactive_uid)
            durable(handoff/'bootstrap.json',{'token':(self.data/'secrets/bootstrap/browser-token').read_text(),'port':cfg['publicPort']},replace=(handoff/'bootstrap.json').exists())
            os.chown(handoff/'bootstrap.json',interactive_uid,-1)
            prior.phase('committed')
            durable(self.root/'status.json',{'installed':True,'version':configured,'publicPort':cfg['publicPort']},replace=(self.root/'status.json').exists(),mode=0o644)

    def arguments(self, role, program=None):
        program = program or self.installed
        config = str(self.data/'config/runtime.json')
        test = ['--isolated'] if self.isolated else []
        if role == 'database': return [program/'postgresql/bin/postgres','-D',self.data/'database']
        if role == 'proxy': return [program/'caddy/caddy','run','--config',self.data/'config/Caddyfile','--adapter','caddyfile']
        if role in ('voice','voice-control'):
            return [program/'python/bin/python3.12','-I','-B',program/'app/native/PythonRuntime.py',role,config,*test]
        return [program/'node/bin/node',program/'app/native/Runtime.mjs',role,config,*test]

    def caddyfile(self, cfg, settings=None):
        """LAN and own-proxy: plain HTTP on the public port. Domain: Caddy's
        automatic HTTPS for that name on 80 and 443, plus the same plain HTTP
        port for this network and the installer's readiness check."""
        settings = settings or self.settings()
        proxy = f" reverse_proxy 127.0.0.1:{cfg['apiPort']}\n"
        if settings['addressMode'] == 'domain':
            email = f" email {settings['email']}\n" if settings.get('email') else ''
            return (f"{{\n admin off\n{email}}}\n{settings['domain']} {{\n{proxy}}}\n"
                f"http://:{cfg['publicPort']} {{\n bind 0.0.0.0\n{proxy}}}\n").encode()
        return (f"{{\n admin off\n auto_https off\n}}\n:{cfg['publicPort']} {{\n"
            f" bind 0.0.0.0\n{proxy}}}\n").encode()

    def unit(self, role, program=None, legacy=False):
        """legacy is the unit as written before PC control and domain HTTPS,
        accepted by check_owned so an older install can still be upgraded."""
        program = program or self.installed
        supplemental = {'web':'josi-ce-app' if legacy else 'josi-ce-app '+PC_GROUP,'worker':'josi-ce-app',
                        'voice':'josi-ce-voice-shared','voice-control':'josi-ce-voice-shared'}.get(role)
        if any(re.search(r'[\s"\'\\]', str(value)) for value in self.arguments(role, program)):
            raise ValueError('Unsafe systemd argument')
        command = ' '.join(str(value) for value in self.arguments(role, program))
        lines = ['[Unit]','Description=Josi CE Server '+role,'After=network.target','PartOf='+PARENT_UNIT,
                 *(['After=josi-ce-database.service','Requires=josi-ce-database.service'] if role in ('web','worker') else []),
                 '[Service]','Type=simple','User='+ACCOUNTS[role],'Group='+ACCOUNTS[role],
                 *(['SupplementaryGroups='+supplemental] if supplemental else []),
                 # Caddy binds 80 and 443 for a public domain's certificate.
                 *(['AmbientCapabilities=CAP_NET_BIND_SERVICE','CapabilityBoundingSet=CAP_NET_BIND_SERVICE']
                   if role == 'proxy' and not legacy else []),
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

    def pc_unit(self, user, group, cfg, program=None):
        """The PC control executor, as the chosen human account. No
        ProtectHome or ProtectSystem: it works on that person's own files."""
        program = program or self.installed
        if not USERNAME.fullmatch(user) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,31}', group):
            raise ValueError('Unsafe PC control account')
        command = [program/'node/bin/node', program/PC_EXECUTOR]
        if any(re.search(r'[\s"\'\\]', str(value)) for value in command): raise ValueError('Unsafe systemd argument')
        lines = ['[Unit]','Description=Josi PC control for '+user,'PartOf='+PARENT_UNIT,
                 'After='+UNIT_PREFIX+'web.service','[Service]','Type=simple','User='+user,'Group='+group,
                 'SupplementaryGroups='+PC_GROUP,'StateDirectory=josi-pc','StateDirectoryMode=0700',
                 f"Environment=JOSI_PC_API=http://127.0.0.1:{cfg['apiPort']}",
                 'Environment=JOSI_PC_SPOOL='+str(self.data/'pc-spool'),'Environment=JOSI_PC_STATE=/var/lib/josi-pc',
                 'ExecStart='+' '.join(str(value) for value in command),'Restart=always','RestartSec=5',
                 '[Install]','WantedBy='+PARENT_UNIT,'']
        return '\n'.join(lines).encode()

    def apply_pc_control(self, cfg, settings=None):
        """Write, follow the version of, or remove josi-pc.service. Returns
        True when the executor is configured."""
        if self.isolated: return False
        settings = settings or self.settings()
        path = UNIT_DIR/PC_UNIT
        if path.is_symlink(): raise ValueError('Linked PC control unit')
        if not settings['pcControlUser']:
            if path.exists():
                subprocess.run(['/usr/bin/systemctl','disable','--now',PC_UNIT], capture_output=True, timeout=70)
                path.unlink()
                subprocess.run(['/usr/bin/systemctl','daemon-reload'], check=True, timeout=60)
            self.apply_browser_host(False)
            self.apply_own_browser(None, None, settings)
            return False
        if not (self.installed/PC_EXECUTOR).is_file(): raise ValueError('This Josi version has no PC control executor')
        user, group = pc_account(settings['pcControlUser'])
        self.ensure_pc_group()
        text = self.pc_unit(user.pw_name, group, cfg)
        if not path.exists() or path.read_bytes() != text:
            durable(path, text, replace=path.exists(), mode=0o644)
            subprocess.run(['/usr/bin/systemctl','daemon-reload'], check=True, timeout=60)
        subprocess.run(['/usr/bin/systemctl','enable',PC_UNIT], check=True, capture_output=True, timeout=60)
        try: self.apply_own_browser(user.pw_name, group, settings)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            self.progress("Josi's own browser was not set up: "+str(error)[:200], 'pc-control')
        # Browser control is a part of PC control, never a reason to fail it.
        try: self.apply_browser_host(True)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            self.progress('Browser control was not set up: '+str(error)[:200], 'pc-control')
        return True

    def browser_host_files(self, program=None):
        """(wrapper text, [(manifest path, json text)]) from browser.mjs of
        this version, with every path checked against the known folders."""
        program = program or self.installed
        code = ("const b=await import(process.argv[1]);process.stdout.write(JSON.stringify({wrapper:"
                "b.nativeHostWrapper(process.argv[2],process.argv[3],'/var/lib/josi-pc'),"
                "manifests:b.nativeHostManifests(process.argv[4])}))")
        from urllib.parse import quote
        result = self.run([program/'node/bin/node','--input-type=module','-e',code,
            'file://'+quote(str(program/BROWSER_MODULE)), program/'node/bin/node', program/BROWSER_SCRIPT, BROWSER_WRAPPER], timeout=30)
        value = json.loads(result.stdout)
        wrapper, manifests = value['wrapper'], value['manifests']
        if not isinstance(wrapper, str) or not wrapper.startswith('#!/bin/sh\n') or len(wrapper) > 4096: raise ValueError('Invalid browser host wrapper')
        allowed = {folder+'/'+BROWSER_HOST_NAME+'.json' for folder in BROWSER_DIRS}
        files = []
        for item in manifests:
            if item.get('path') not in allowed or not isinstance(item.get('json'), str) or len(item['json']) > 8192:
                raise ValueError('Unexpected browser host manifest')
            if json.loads(item['json']).get('path') != str(BROWSER_WRAPPER): raise ValueError('Browser host manifest names another program')
            files.append((Path(item['path']), item['json']))
        return wrapper, files

    def apply_browser_host(self, enabled):
        """Install (root-owned wrapper 0755, manifests 0644) or remove the
        browser native-messaging host. Rewritten on every install and upgrade."""
        if self.isolated: return
        targets = [Path(folder)/(BROWSER_HOST_NAME+'.json') for folder in BROWSER_DIRS]
        if not enabled:
            for path in [*targets, BROWSER_WRAPPER]:
                if path.is_symlink() or path.is_file(): path.unlink()
            return
        if not (self.installed/BROWSER_MODULE).is_file() or not (self.installed/BROWSER_SCRIPT).is_file():
            raise ValueError('This Josi version has no browser control host')
        wrapper, files = self.browser_host_files()
        def put(path, text, mode):
            path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            plain(path.parent)
            if path.is_symlink(): path.unlink()
            if path.is_file() and path.read_text() == text and stat.S_IMODE(path.stat().st_mode) == mode: return
            durable(path, text.encode(), replace=path.exists(), mode=mode)
            os.chown(path, 0, 0)
        put(BROWSER_WRAPPER, wrapper, 0o755)
        for path, text in files: put(path, text, 0o644)

    def browser_unit(self, user, group, program=None):
        """Josi's own browser, as the PC control account, from this version."""
        program = program or self.installed
        if not USERNAME.fullmatch(user) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,31}', group):
            raise ValueError('Unsafe PC control account')
        command = [program/'node/bin/node', program/BROWSER_LAUNCHER]
        if any(re.search(r'[\s"\'\\]', str(value)) for value in [*command, program/BROWSER_EXTENSION]):
            raise ValueError('Unsafe systemd argument')
        lines = ['[Unit]',"Description=Josi's own browser for "+user,'PartOf='+PARENT_UNIT,'After='+PC_UNIT,
                 '[Service]','Type=simple','User='+user,'Group='+group,'StateDirectory=josi-pc','StateDirectoryMode=0700',
                 'Environment=JOSI_PC_STATE=/var/lib/josi-pc','Environment=JOSI_BROWSER_EXTENSION='+str(program/BROWSER_EXTENSION),
                 'ExecStart='+' '.join(str(value) for value in command),'Restart=always','RestartSec=5',
                 '[Install]','WantedBy='+PARENT_UNIT,'']
        return '\n'.join(lines).encode()

    def apply_own_browser(self, user, group, settings):
        """Write josi-browser.service for the current version, or remove it
        when the browser or PC control is off."""
        if self.isolated: return False
        path = UNIT_DIR/BROWSER_UNIT
        if path.is_symlink(): raise ValueError('Linked browser unit')
        if not user or not settings.get('browser'):
            if path.exists():
                subprocess.run(['/usr/bin/systemctl','disable','--now',BROWSER_UNIT], capture_output=True, timeout=70)
                path.unlink()
                subprocess.run(['/usr/bin/systemctl','daemon-reload'], check=True, timeout=60)
            return False
        if not (self.installed/BROWSER_LAUNCHER).is_file() or not (self.installed/BROWSER_EXTENSION/'manifest.json').is_file():
            raise ValueError("This Josi version has no browser launcher or extension")
        text = self.browser_unit(user, group)
        if not path.exists() or path.read_bytes() != text:
            durable(path, text, replace=path.exists(), mode=0o644)
            subprocess.run(['/usr/bin/systemctl','daemon-reload'], check=True, timeout=60)
        subprocess.run(['/usr/bin/systemctl','enable',BROWSER_UNIT], check=True, capture_output=True, timeout=60)
        return True

    def start_pc_control(self):
        """Restart the executor (and Josi's browser) on the current version.
        Never fatal: Josi itself runs without them and systemd keeps retrying."""
        if self.isolated: return
        for unit in (PC_UNIT, BROWSER_UNIT):
            if (UNIT_DIR/unit).exists():
                self.progress('Starting services', unit.removesuffix('.service'))
                subprocess.run(['/usr/bin/systemctl','restart',unit], capture_output=True, timeout=70)

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
            if not path.is_file() or path.stat().st_mode & 0o022 or path.read_bytes() not in (self.unit(role, program), self.unit(role, program, legacy=True)):
                raise ValueError('Unowned service definition')

    def stop(self):
        for unit in (BROWSER_UNIT, PC_UNIT):
            if not self.isolated and (UNIT_DIR/unit).exists():
                self.progress('Stopping services', unit.removesuffix('.service'))
                subprocess.run(['/usr/bin/systemctl','stop',unit], capture_output=True, timeout=70)
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
                if child is None or child.poll() is not None: raise RuntimeError(role+' service exited')
            elif subprocess.run(['/usr/bin/systemctl','is-active','--quiet',UNIT_PREFIX+role+'.service']).returncode:
                raise RuntimeError(role+' service is not active')
            if role in ports:
                probe = socket.socket()
                probe.settimeout(2)
                try: probe.connect(('127.0.0.1', ports[role]))
                except OSError as error: raise RuntimeError(role+' service is not listening') from error
                finally: probe.close()

    def ready(self):
        cfg = json.loads((self.data/'config/runtime.json').read_text())
        deadline = time.monotonic() + 240
        last_error = RuntimeError('readiness did not start')
        while time.monotonic() < deadline:
            self.progress('Checking readiness', 'web / worker / speech')
            try:
                self.listeners(cfg)
                for name,port in (('web',cfg['apiPort']),('proxy',cfg['publicPort'])):
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                    connection.request('GET','/ready')
                    response = connection.getresponse(); response.read(); connection.close()
                    if response.status != 200: raise RuntimeError(name+' readiness returned HTTP '+str(response.status))
                heartbeat = self.data/'state/worker-heartbeat'
                if not heartbeat.exists(): raise RuntimeError('worker heartbeat is missing')
                if time.time()-heartbeat.stat().st_mtime > 90: raise RuntimeError('worker heartbeat is stale')
                connection = http.client.HTTPConnection('127.0.0.1',cfg['controlPort'],timeout=3)
                token = (self.data/'secrets/voice-control/voice-control-token').read_text()
                connection.request('GET','/status',headers={'Authorization':'Bearer '+token})
                response = connection.getresponse(); status_value = json.loads(response.read()); connection.close()
                if response.status != 200: raise RuntimeError('speech control returned HTTP '+str(response.status))
                if not status_value.get('helperAvailable'): raise RuntimeError('speech helper is unavailable')
                if status_value.get('enabled') and not status_value.get('healthy'):
                    raise RuntimeError('speech runtime is unhealthy')
                return
            except (OSError,ValueError,RuntimeError,http.client.HTTPException) as error:
                last_error = error
                time.sleep(2)
        raise RuntimeError('Readiness deadline exceeded: '+str(last_error))

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

    VERSION_NAME = re.compile(r'[0-9][0-9A-Za-z.~+-]{0,63}')

    def program_size(self, path):
        """Bytes in a folder tree, counting each file once and following no links."""
        total = 0
        for base, _dirs, names in os.walk(path, followlinks=False):
            for name in names:
                try: total += os.lstat(os.path.join(base, name)).st_size
                except OSError: pass
        return total

    def prune_old_versions(self, keep):
        """Remove program copies nobody needs: everything in versions/ except
        the names in `keep` (the running version and the one to roll back to).

        Every upgrade leaves the previous program behind (about 2 GB each), and
        after a day of betas a small disk fills. Only plain folders whose name
        looks like a version are touched, nothing is followed, and a folder
        that cannot be removed is left alone: this never fails an install.
        Returns the names removed.
        """
        folder = self.root/'versions'
        if not folder.is_dir() or folder.is_symlink(): return []
        removed = []
        for child in sorted(folder.iterdir()):
            if child.name in keep or not self.VERSION_NAME.fullmatch(child.name): continue
            if child.is_symlink() or not child.is_dir(): continue
            try:
                shutil.rmtree(child)
                removed.append(child.name)
            except OSError as error:
                self.progress('Could not remove the old version '+child.name+': '+str(error)[:120], 'installer')
        if removed: self.progress('Removed '+str(len(removed))+' old version'+('s' if len(removed) != 1 else '')+' to free disk space', 'installer')
        return removed

    def ensure_space(self, old):
        """Say so in plain words, before anything is copied, if the disk is too full.

        The new program is copied beside the old one, and an upgrade also takes
        a cold copy of the data first. Old versions are removed first when that
        is what makes room.
        """
        program = self.program_size(self.runtime)
        need = program + (self.program_size(self.data) if old else 0) + (512 << 20)
        probe = self.root if self.root.exists() else self.root.parent
        if shutil.disk_usage(probe).free >= need: return
        if old: self.prune_old_versions({old})
        free = shutil.disk_usage(probe).free
        if free < need:
            gb = lambda n: '%.1f GB' % (n / (1 << 30))
            raise ValueError('Not enough free disk space on %s: Josi needs about %s free for this %s and only %s is free. Nothing was changed. Free some space (for example old files under %s) and run the installer again.'
                % (probe, gb(need), 'upgrade' if old else 'install', gb(free), probe))

    def install(self, ports=None, fail_at=None, interactive_uid=None, repair=False):
        # 0 is root itself: the one-command installer run from a root shell,
        # or the web updater. Any other account must be a real login account.
        if not self.isolated and (interactive_uid is None or (interactive_uid != 0 and interactive_uid < 1000) or not pwd.getpwuid(interactive_uid).pw_dir):
            raise ValueError('Logged-in installer user required')
        if fail_at and not self.isolated: raise ValueError('Fault injection is isolated only')
        # A first install that stopped before its receipt leaves only the lock
        # and its own transaction records; running the command again starts over.
        leftovers = {'lifecycle.lock','transactions'}
        if self.root.exists() and not (self.root/'installation.json').exists() and any(p.name not in leftovers for p in self.root.iterdir()):
            raise ValueError('Existing directory has no Josi ownership receipt; preserve it')
        protect_product_root(self.root, self.isolated)
        lock_path = self.root/'lifecycle.lock'
        lock = os.open(lock_path, os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600)
        info = os.fstat(lock)
        if info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
            os.close(lock); raise ValueError('Unsafe lifecycle lock')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        transactions = self.root/'transactions'; transactions.mkdir(mode=0o700,exist_ok=True)
        try:
            self.settle_activated_recovery(interactive_uid)
            self.installed = self.root/'versions'/self.version
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
            if not self.isolated or os.environ.get('JOSI_LIFECYCLE_CHECK_SPACE') == '1': self.ensure_space(old)
            if fresh:
                if not self.isolated:
                    for role in ROLES:
                        if (UNIT_DIR/(UNIT_PREFIX+role+'.service')).exists(): raise ValueError('Existing systemd unit must be preserved')
                if ports is None:
                    ports = list(DEFAULT_PORTS); ports[2] = self.settings()['port']
                    for index in (0,1,3,4):
                        if ports[index] == ports[2]: ports[index] = 18083
                ports = available_ports(tuple(ports))
            self.identities(fresh)
            protect_program_root(self.installed.parent, self.isolated)
            if self.installed.exists(): self.verify(self.installed)
            else:
                staged=folder/'program'; self.copy(self.runtime,staged); self.seal_program(staged); self.verify(staged); os.rename(staged,self.installed)
            phase('quiescing')
            if not fresh: self.stop()
            phase('quiesced')
            if not fresh:
                self.prune_cli_scratch()
                before=self.snapshot_inventory(self.data); self.copy(self.data,folder/'snapshot')
                if self.snapshot_inventory(folder/'snapshot') != before: raise ValueError('Cold snapshot verification failed')
                durable(folder/'snapshot-inventory',before)
            phase('snapshot')
            if fresh:
                receipt = self.root/'installation.json'
                if receipt.exists() and json.loads(receipt.read_text()).get('product') != 'Josi CE Server':
                    raise ValueError('Unrelated installation receipt')
                durable(receipt,{'product':'Josi CE Server','id':secrets.token_hex(16)},replace=receipt.exists())
                cfg=self.layout(ports)
                self.run([self.installed/'postgresql/bin/initdb','-D',self.data/'database','-U','bootstrap_admin',
                    '--pwfile='+str(self.data/'secrets/database/init-password'),'--auth-host=scram-sha-256',
                    '--auth-local=scram-sha-256','--encoding=UTF8','--locale=C'],'database')
                settings=("listen_addresses='127.0.0.1'\nport=%d\nunix_socket_directories=''\npassword_encryption='scram-sha-256'\n"
                    "log_statement='none'\nlog_min_error_statement='panic'\nlog_parameter_max_length=0\nlog_parameter_max_length_on_error=0\n") % cfg['databasePort']
                durable(self.data/'database/postgresql.auto.conf',settings.encode(),replace=True,mode=0o600)
                if not self.isolated: os.chown(self.data/'database/postgresql.auto.conf',*self.account('database'))
            cfg=json.loads((self.data/'config/runtime.json').read_text())
            self.repair_layout_permissions()
            self.write(self.data/'config/Caddyfile',self.caddyfile(cfg),
                mode=0o644, replace=(self.data/'config/Caddyfile').exists())
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
            self.seal_traversal_permissions()
            if not self.isolated:
                for role in ROLES: durable(UNIT_DIR/(UNIT_PREFIX+role+'.service'),self.unit(role),replace=True,mode=0o644)
                subprocess.run(['/usr/bin/systemctl','daemon-reload'],check=True)
                for role in ROLES: subprocess.run(['/usr/bin/systemctl','enable',UNIT_PREFIX+role+'.service'],check=True)
                # josi-pc.service moves to this version's program with the
                # others. PC control never fails the install itself;
                # josi-ce-server-install checked the account beforehand.
                try: self.apply_pc_control(cfg)
                except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                    self.progress('PC control was not set up: '+str(error)[:200], 'pc-control')
            for role in ROLES: self.start(role)
            phase('activated'); self.ready(); phase('healthy')
            self.start_pc_control()
            if not self.isolated: self.record_applied(cfg)
            if not self.isolated:
                handoff=prepare_browser_handoff(self.root,interactive_uid)
                durable(handoff/'bootstrap.json',{'token':(self.data/'secrets/bootstrap/browser-token').read_text(),'port':cfg['publicPort']},replace=True)
                os.chown(handoff/'bootstrap.json',interactive_uid,-1)
            phase('committed')
            durable(self.root/'status.json',{'installed':True,'version':self.version,'publicPort':cfg['publicPort']},replace=True,mode=0o644)
            # Only after a good start: keep this version and the one just
            # replaced (the way back), drop the rest.
            self.prune_old_versions({self.version, *([old] if old else [])})
            return folder
        except BaseException as error:
            # Ctrl-C, SIGTERM and SIGHUP too: a transaction left mid-phase
            # would block every later install until someone repaired it.
            if not self.isolated: ignore_stop_signals()
            if self.journal: durable(self.journal.folder/'failure-diagnostics',diagnostic(error),replace=True)
            if self.journal and self.journal.records and self.journal.records[-1]['phase'] not in (*TERMINAL,'recovery-required'):
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
            journal=Journal(folder); mark_interrupted(journal); phases=[record['phase'] for record in journal.records]
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

    def applied_view(self, cfg, settings):
        return {'appUrl':settings['appUrl'],'addressMode':settings['addressMode'],'email':settings['email'],
                'publicPort':cfg['publicPort']}

    def record_applied(self, cfg, settings=None):
        path = self.root/'applied-settings.json'
        durable(path, self.applied_view(cfg, settings or self.settings()), replace=path.exists())

    def reconfigure(self):
        """Apply the installer's answers to the installed version: the public
        port, the Caddyfile (LAN, own proxy or domain HTTPS), the browser
        address the web service is started with, and PC control. Only what
        changed is restarted; a failed restart puts the old files back."""
        if self.isolated: raise ValueError('Reconfiguration is for installed servers')
        lock = lock_lifecycle(self.root)
        try:
            for folder in (self.root/'transactions').iterdir():
                prior = Journal(folder)
                if not prior.records or prior.records[-1]['phase'] not in TERMINAL:
                    raise RuntimeError('Earlier transaction requires recovery')
            settings = self.settings()
            config_path = plain(self.data/'config/runtime.json', 0)
            cfg = json.loads(config_path.read_text()); previous = dict(cfg)
            self.installed = self.root/'versions'/cfg['version']; self.check_owned(self.installed)
            self.repair_layout_permissions()
            if settings['port'] != cfg['publicPort']:
                if settings['port'] in {cfg[key] for key in ('databasePort','apiPort','voicePort','controlPort')}:
                    raise ValueError(f"Port {settings['port']} is used by Josi's own services")
                if not port_is_free(settings['port']): raise ValueError(f"Port {settings['port']} is in use")
                cfg['publicPort'] = settings['port']
            caddy_path = plain(self.data/'config/Caddyfile')
            caddy_before = caddy_path.read_bytes() if caddy_path.exists() else None
            caddy = self.caddyfile(cfg, settings)
            applied_path = self.root/'applied-settings.json'
            applied = json.loads(applied_path.read_text()) if applied_path.exists() else None
            restart = (['proxy'] if caddy != caddy_before else []) + \
                (['web','worker'] if applied != self.applied_view(cfg, settings) else [])
            try:
                if cfg != previous: durable(config_path, cfg, replace=True, mode=0o644)
                if caddy != caddy_before: durable(caddy_path, caddy, replace=caddy_before is not None, mode=0o644)
                for role in restart:
                    self.progress('Starting services', role)
                    subprocess.run(['/usr/bin/systemctl','restart',UNIT_PREFIX+role+'.service'], check=True, timeout=70)
                if restart: self.ready()
            except BaseException:
                ignore_stop_signals()
                durable(config_path, previous, replace=True, mode=0o644)
                if caddy_before is not None: durable(caddy_path, caddy_before, replace=True, mode=0o644)
                for role in restart:
                    subprocess.run(['/usr/bin/systemctl','restart',UNIT_PREFIX+role+'.service'], capture_output=True, timeout=70)
                raise
            units = lambda: [(UNIT_DIR/unit).read_bytes() if (UNIT_DIR/unit).exists() else None for unit in (PC_UNIT, BROWSER_UNIT)]
            pc_before = units()
            if self.apply_pc_control(cfg, settings):
                if units() != pc_before: self.start_pc_control()
                else:
                    for unit in (PC_UNIT, BROWSER_UNIT):
                        if (UNIT_DIR/unit).exists(): subprocess.run(['/usr/bin/systemctl','start',unit], capture_output=True, timeout=70)
            self.record_applied(cfg, settings)
            durable(self.root/'status.json',{'installed':True,'version':cfg['version'],'publicPort':cfg['publicPort']},replace=True,mode=0o644)
            return restart
        finally:
            fcntl.flock(lock,fcntl.LOCK_UN); os.close(lock)

if __name__ == '__main__':
    try:
        handle_stop_signals()
        runtime=Path(__file__).resolve().parents[2]
        if sys.argv[1:]==['verify']:
            obj=object.__new__(Lifecycle); obj.runtime=runtime
            obj.version=json.loads((runtime/'app/package.json').read_text())['version']
            emit({'verified':obj.verify(),'architecture':os.uname().machine})
        elif len(sys.argv)==3 and sys.argv[1] in ('install','repair') and sys.argv[2].isascii() and sys.argv[2].isdecimal():
            # repair puts the same version back over data an uninstall kept.
            Lifecycle(runtime).install(interactive_uid=int(sys.argv[2]), repair=sys.argv[1]=='repair')
        elif sys.argv[1:]==['configure']:
            emit({'restarted':Lifecycle(runtime).reconfigure()})
        else: raise ValueError('Unsupported lifecycle command')
    except BaseException as error:
        emit({'phase':'Stopped',**diagnostic(error)})
        sys.exit(1)
