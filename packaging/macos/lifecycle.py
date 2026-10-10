"""Native offline lifecycle. Production roots/labels are fixed, never user input.
The isolated adapter runs only child processes in a marked JosiDrive test root.
It cannot call launchctl, create users, or operate on the installed product.
"""
import fcntl
import ctypes
import hashlib
import http.client
import json
import os
from pathlib import Path
import plistlib
import pwd
import grp
import secrets
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time

PRODUCT = Path('/Library/Application Support/Josi CE Server')
LABEL = 'com.heyjosi.ce.'
ROLES = ('database','voice','voice-control','web','worker','proxy')
STOP = ('proxy','voice-control','voice','worker','web','database')
ACCOUNTS = {'database':'_josice_db','web':'_josice_web','worker':'_josice_worker','proxy':'_josice_proxy','voice':'_josice_voice','voice-control':'_josice_control'}
PHASES = ('prepared','verified','quiescing','quiesced','snapshot','provisioned','database-ready','migrating','migrated','activating','activated','healthy','committed')
TRANSITIONS = {a:{b,'recovery-required'} for a,b in zip(PHASES,PHASES[1:])}
TRANSITIONS.update({'recovery-required':{'rolling-back'},'rolling-back':{'rolled-back','recovery-required'}})

def hashed(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def diagnostic(error):
    """Useful failure evidence without command arguments or credential values."""
    def redact(value):
        if isinstance(value, bytes): value=value.decode('utf-8','replace')
        value=str(value or '')
        value=re.sub(r'(?i)(password|token|secret|authorization|master.key)(\s*[=:]\s*)\S+',r'\1\2[redacted]',value)
        value=re.sub(r'(?i)(postgres(?:ql)?://)[^\s]+',r'\1[redacted]',value)
        value=re.sub(r'\b[a-fA-F0-9]{64}\b','[redacted]',value)
        return value[-32768:]
    result={'error':type(error).__name__,'cause':redact(error)}
    if isinstance(error,(subprocess.CalledProcessError,subprocess.TimeoutExpired)):
        # str(CalledProcessError) includes argv, which can contain credentials.
        result['cause']='A required component timed out' if isinstance(error,subprocess.TimeoutExpired) else 'A required component exited unsuccessfully'
        result['component']=Path(str(error.cmd[0])).name if isinstance(error.cmd,(list,tuple)) and error.cmd else 'component'
        result['exitCode']=getattr(error,'returncode',None)
        result['stdout']=redact(error.stdout);result['stderr']=redact(error.stderr)
    return result

def emit(value):
    print(json.dumps(value),flush=True)
    # The privileged installer redirects stdout to its evidence file. Flush
    # each phase and failure before returning or permitting the next mutation.
    if stat.S_ISREG(os.fstat(sys.stdout.fileno()).st_mode):
        os.fsync(sys.stdout.fileno())

def plain(path, owner=None):
    p=Path(path)
    if not p.is_absolute() or '..' in p.parts: raise ValueError('Unsafe path')
    for part in (p,*p.parents):
        if part.is_symlink(): raise ValueError('Linked path')
    if owner is not None and p.exists() and p.stat().st_uid != owner: raise ValueError('Unexpected owner')
    return p

def durable(path, value, replace=False, mode=0o600):
    path=Path(path); plain(path.parent)
    temp=path.with_name(path.name+'.'+secrets.token_hex(12)+'.pending')
    data=json.dumps(value,sort_keys=True,separators=(',',':')).encode()+b'\n' if not isinstance(value,bytes) else value
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    try:
        with os.fdopen(fd,'wb',closefd=False) as f: f.write(data);f.flush()
        os.fsync(fd);fcntl.fcntl(fd,51)
    finally: os.close(fd)
    if replace: os.replace(temp,path)
    else: os.link(temp,path);temp.unlink()
    d=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(d)
    finally: os.close(d)

class Journal:
    def __init__(self, folder, identity=None):
        self.folder=plain(folder);self.folder.mkdir(mode=0o700,exist_ok=True)
        parent=os.open(self.folder.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(parent)
        finally:os.close(parent)
        self.identity=identity;self.records=[];previous='0'*64
        for p in sorted(self.folder.glob('*.json')):
            if p.name!=f'{len(self.records)+1:04}.json' or p.stat().st_size>8192 or p.is_symlink() or p.stat().st_nlink!=1: raise ValueError('Journal sequence')
            r=json.loads(p.read_bytes())
            if set(r)!={'identity','phase','sequence','previous','time'} or r['sequence']!=len(self.records)+1 or r['previous']!=previous: raise ValueError('Journal chain')
            if self.identity is None:self.identity=r['identity']
            if r['identity']!=self.identity:raise ValueError('Journal identity')
            if set(self.identity)!={'from','to','manifest'} or not re.fullmatch('[a-f0-9]{64}',self.identity['manifest']):raise ValueError('Journal payload identity')
            if any(v is not None and not re.fullmatch(r'\d+\.\d+\.\d+-[a-z0-9.]+',v) for v in (self.identity['from'],self.identity['to'])):raise ValueError('Journal version identity')
            if self.records and r['phase'] not in TRANSITIONS.get(self.records[-1]['phase'],set()):raise ValueError('Journal transition')
            if not self.records and r['phase']!='prepared':raise ValueError('Journal start')
            self.records.append(r);previous=hashed(p)
        self.previous=previous
    def phase(self, phase):
        if self.records and phase not in TRANSITIONS.get(self.records[-1]['phase'],set()):raise ValueError('Invalid transition')
        if not self.records and phase!='prepared':raise ValueError('Invalid initial phase')
        r={'identity':self.identity,'sequence':len(self.records)+1,'previous':self.previous,'phase':phase,'time':time.time()}
        p=self.folder/f'{r["sequence"]:04}.json';durable(p,r);self.records.append(r);self.previous=hashed(p)

class Lifecycle:
    def __init__(self, runtime, root=PRODUCT, isolated=False, progress=None):
        self.runtime=plain(runtime);self.root=plain(root);self.isolated=isolated
        self.progress=progress or (lambda phase,service:emit({'phase':phase,'service':service}))
        if isolated:
            if os.getuid()==0 or not str(root).startswith('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests/'):raise ValueError('Invalid isolated root')
        elif os.getuid()!=0 or self.root!=PRODUCT:raise PermissionError('Administrator authorization required')
        self.data=self.root/'data';self.children={};self.version=json.loads((runtime/'app/package.json').read_text())['version']
        if not re.fullmatch(r'\d+\.\d+\.\d+-[a-z0-9.]+',self.version):raise ValueError('Invalid version identity')
        self.installed=self.root/'versions'/self.version
        self.plan=None;self.journal=None
    def run(self,args,role=None,timeout=180,**kw):
        env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','TMPDIR':str(self.data/'temp'/(role or 'migrate')),'LC_ALL':'C','LANG':'C'}
        def demote():
            if role and not self.isolated:
                user=pwd.getpwnam(ACCOUNTS[role]);os.initgroups(user.pw_name,user.pw_gid);os.setgid(user.pw_gid);os.setuid(user.pw_uid)
            os.umask(0o077)
        return subprocess.run([str(a) for a in args],env=env,stdin=subprocess.DEVNULL,capture_output=True,timeout=timeout,check=True,preexec_fn=demote,**kw)
    def verify(self,directory=None):
        directory=directory or self.runtime
        manifest=json.loads((self.runtime.parent/'inventory.json').read_text())
        if manifest['architecture']!='arm64' or manifest['version']!=self.version:raise ValueError('Payload identity')
        expected={x['path']:x for x in manifest['files']}
        if len(expected)!=len(manifest['files']):raise ValueError('Duplicate payload inventory entries')
        actual=set()
        for p in directory.rglob('*'):
            rel=p.relative_to(directory).as_posix()
            if p.is_symlink():
                if not p.resolve().is_relative_to(directory):raise ValueError('Escaping payload link')
                if expected.get(rel,{}).get('link')!=os.readlink(p):raise ValueError('Payload link mismatch')
                actual.add(rel)
            elif p.is_file():
                x=expected.get(rel,{})
                if p.stat().st_nlink!=1 or x.get('size')!=p.stat().st_size or x.get('sha256')!=hashed(p):raise ValueError('Payload hash mismatch: '+rel)
                actual.add(rel)
            elif not p.is_dir():raise ValueError('Special payload file')
        if actual!=set(expected):raise ValueError('Incomplete payload: '+', '.join(sorted(actual.symmetric_difference(expected))[:10]))
        return hashed(self.runtime.parent/'inventory.json')
    def account(self,role):
        if self.isolated:return os.getuid(),os.getgid()
        user=pwd.getpwnam(ACCOUNTS[role]);return user.pw_uid,user.pw_gid
    def identities(self,fresh):
        if self.isolated:return
        for role in ROLES:
            name=ACCOUNTS[role]
            try:existing=pwd.getpwnam(name)
            except KeyError:existing=None
            try:existing_group=grp.getgrnam(name)
            except KeyError:existing_group=None
            if fresh and (existing or existing_group):raise ValueError('Service identity collision')
            if not fresh:
                record=json.loads((self.root/'identities.json').read_text())[role]
                if not existing or not existing_group or existing_group.gr_gid!=existing.pw_gid or existing_group.gr_mem or [existing.pw_uid,existing.pw_gid]!=record or existing.pw_shell!='/usr/bin/false':raise ValueError('Service identity changed')
        if not fresh:return
        used={p.pw_uid for p in pwd.getpwall()}|{g.gr_gid for g in grp.getgrall()}
        available=[n for n in range(400,500) if n not in used]
        if len(available)<len(ROLES):raise ValueError('No isolated service identity range available')
        plan={role:[number,number] for role,number in zip(ROLES,available)}
        durable(self.root/'identities-plan.json',plan)
        records={}
        for role in ROLES:
            number=plan[role][0];name=ACCOUNTS[role]
            for args in [('-create',f'/Groups/{name}'),('-create',f'/Groups/{name}','PrimaryGroupID',str(number)),('-create',f'/Users/{name}'),('-create',f'/Users/{name}','UniqueID',str(number)),('-create',f'/Users/{name}','PrimaryGroupID',str(number)),('-create',f'/Users/{name}','UserShell','/usr/bin/false'),('-create',f'/Users/{name}','NFSHomeDirectory',str(self.data/'profiles'/role)),('-create',f'/Users/{name}','IsHidden','1'),('-create',f'/Users/{name}','Password','*')]:self.run(['/usr/bin/dscl','.',*args])
            records[role]=[number,number]
            durable(self.root/'identities.json',records,replace=(self.root/'identities.json').exists())
    def snapshot_inventory(self, directory):
        libc=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
        libc.acl_get_file.argtypes=[ctypes.c_char_p,ctypes.c_int];libc.acl_get_file.restype=ctypes.c_void_p
        libc.acl_to_text.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ssize_t)];libc.acl_to_text.restype=ctypes.c_void_p
        libc.acl_free.argtypes=[ctypes.c_void_p]
        result={}
        for p in sorted(directory.rglob('*')):
            s=p.lstat(); name=p.relative_to(directory).as_posix()
            if stat.S_ISLNK(s.st_mode) or not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)):
                raise ValueError('Snapshot contains a link or special file')
            acl=libc.acl_get_file(os.fsencode(p),0x100);text=None
            if acl:
                try:
                    length=ctypes.c_ssize_t();text=libc.acl_to_text(acl,ctypes.byref(length))
                    if not text:raise ValueError('Cannot verify snapshot ACL')
                    acl_value=ctypes.string_at(text,length.value).decode()
                finally:
                    if text:libc.acl_free(text)
                    libc.acl_free(acl)
            elif ctypes.get_errno()==2:acl_value=''
            else:raise ValueError('Cannot inspect snapshot ACL')
            result[name]={'mode':stat.S_IMODE(s.st_mode),'uid':s.st_uid,'gid':s.st_gid,'acl':acl_value,'flags':s.st_flags,
                          'hash':hashed(p) if p.is_file() else None}
        return result
    def write(self,path,bytes,role=None,mode=0o600):
        durable(path,bytes,mode=mode)
        if role and not self.isolated:os.chown(path,0,self.account(role)[1])
    def layout(self, ports):
        self.data.mkdir(mode=0o700)
        if self.isolated:durable(self.data/'isolated-test.json',{'purpose':'disposable-native-acceptance'})
        else:os.chmod(self.data,0o711)
        for folder in ('config','secrets','temp','profiles','logs','voice'):(self.data/folder).mkdir(mode=0o711)
        for role in (*ROLES,'migrate','bootstrap'):
            uid,gid=self.account(role) if role in ROLES else (os.getuid(),os.getgid())
            for category in ('temp','profiles','logs','secrets'):
                p=self.data/category/role;p.mkdir(mode=0o750 if category=='secrets' else 0o700)
                if not self.isolated:os.chown(p,0 if category=='secrets' else uid,gid)
        for folder,role in [('database','database'),('chat-attachments','web'),('roots','web'),('versions','web'),('backups','web'),('diagnostics','web'),('codex','web'),('state','worker'),('proxy','proxy'),('voice/gateway','voice-control'),('voice/control','voice-control')]:
            p=self.data/folder;p.mkdir(mode=0o700)
            if not self.isolated:
                os.chown(p,*self.account(role))
                if role in ('web','worker'):
                    for reader in ('web','worker'):
                        self.run(['/bin/chmod','+a',f'user:{ACCOUNTS[reader]} allow read,write,append,execute,delete,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit',p])
        if not self.isolated:
            os.chown(self.data/'voice/gateway',self.account('voice-control')[0],self.account('voice')[1]);os.chmod(self.data/'voice/gateway',0o2750)
        master,password,setup,control,gateway,init=[secrets.token_hex(32) for _ in range(6)]
        for role in ('web','worker','migrate','bootstrap'):
            for name,value in [('master-key',master),('database-password',password)]:self.write(self.data/'secrets'/role/name,value.encode(),role if role in ROLES else None,0o640)
        for role in ('web','voice-control'):self.write(self.data/'secrets'/role/'voice-control-token',control.encode(),role,0o640)
        self.write(self.data/'secrets/database/init-password',init.encode(),'database',0o640)
        self.write(self.data/'secrets/bootstrap/init-password',init.encode(),mode=0o600)
        self.write(self.data/'voice/gateway/token',gateway.encode(),mode=0o640)
        settings={'model':'base.en','voice':'af_heart','threshold':0.5,'silenceMs':700,'speed':1.0,'device':'cpu'}
        durable(self.data/'voice/gateway/settings.json',settings,mode=0o640)
        if not self.isolated:
            for name in ('token','settings.json'):os.chown(self.data/'voice/gateway'/name,self.account('voice-control')[0],self.account('voice')[1])
        cfg={'schemaVersion':1,'version':self.version,'databasePort':ports[0],'apiPort':ports[1],'publicPort':ports[2],'voicePort':ports[3],'controlPort':ports[4],'setupTokenSha256':hashlib.sha256(setup.encode()).hexdigest(),'scannerSocket':''}
        self.write(self.data/'config/runtime.json',cfg,mode=0o644)
        # Only the original interactive user receives this credential later.
        self.write(self.data/'secrets/bootstrap/browser-token',setup.encode())
        return cfg
    def arguments(self,role,program=None):
        p=program or self.installed;cfg=json.loads((self.data/'config/runtime.json').read_text());config=str(self.data/'config/runtime.json');test=['--isolated'] if self.isolated else []
        if role=='database':return [str(p/'postgresql/bin/postgres'),'-D',str(self.data/'database')]
        if role=='proxy':return [str(p/'caddy/caddy'),'run','--config',str(self.data/'config/Caddyfile'),'--adapter','caddyfile']
        if role in ('voice','voice-control'):return [str(p/'python/bin/python3.11'),'-I','-B',str(p/'app/native/PythonRuntime.py'),role,config,*test]
        return [str(p/'node/bin/node'),str(p/'app/native/Runtime.mjs'),role,config,*test]
    def plists(self,program=None):
        return {role:{'Label':LABEL+role,'ProgramArguments':self.arguments(role,program),'UserName':ACCOUNTS[role],'GroupName':ACCOUNTS[role],
            'RunAtLoad':True,'KeepAlive':{'SuccessfulExit':False},'ThrottleInterval':10,'ExitTimeOut':60,'Umask':0o077,
            'WorkingDirectory':str((program or self.installed)/'app'),
            'EnvironmentVariables':{'PATH':'/usr/bin:/bin','TMPDIR':str(self.data/'temp'/role),'XDG_DATA_HOME':str(self.data/'proxy'),'XDG_CONFIG_HOME':str(self.data/'proxy')},
            'StandardOutPath':str(self.data/'logs'/role/'stdout.log'),'StandardErrorPath':str(self.data/'logs'/role/'stderr.log')}
            for role in ROLES}
    def check_owned(self,program):
        if self.isolated:return
        for role,definition in self.plists(program).items():
            p=Path('/Library/LaunchDaemons')/(LABEL+role+'.plist');plain(p,0)
            if not p.exists():
                # Uninstall retains the exact owned definitions for repair or
                # reinstall; an unrelated/missing definition still fails closed.
                record=json.loads((self.root/'disabled-launchd-record.json').read_text())
                name=record.get(role,'')
                if not re.fullmatch(re.escape(LABEL+role)+r'\.[a-f0-9]{32}\.plist',name):raise ValueError('Invalid retained service identity')
                p=self.root/'disabled-launchd'/name;plain(p,0)
                if not p.is_file() or p.stat().st_mode&0o022:raise ValueError('Unprotected retained service definition')
            if plistlib.loads(p.read_bytes())!=definition:raise ValueError('Unowned service definition')
    def stop(self):
        for role in STOP:
            self.progress('Stopping services',role)
            if self.isolated:
                child=self.children.pop(role,None)
                if child and child.poll() is None:child.send_signal(signal.SIGTERM);child.wait(timeout=60)
            else:
                p=Path('/Library/LaunchDaemons')/(LABEL+role+'.plist')
                if p.exists():
                    query=subprocess.run(['/bin/launchctl','print','system/'+LABEL+role],capture_output=True,text=True,timeout=10)
                    pids=[int(line.strip()[6:]) for line in query.stdout.splitlines() if line.strip().startswith('pid = ') and line.strip()[6:].isdecimal()]
                    result=subprocess.run(['/bin/launchctl','bootout','system',str(p)],capture_output=True)
                    if result.returncode and b'No such process' not in result.stderr and b'Could not find' not in result.stderr:raise RuntimeError('Service quiescence failed')
                    for pid in pids:
                        deadline=time.monotonic()+60
                        while True:
                            try:os.kill(pid,0)
                            except ProcessLookupError:break
                            if time.monotonic()>=deadline:raise RuntimeError('Service did not finish stopping; snapshot refused')
                            time.sleep(.2)
        # PostgreSQL may be an installer-owned temporary process, not a loaded job.
        if (self.data/'database/postmaster.pid').exists():self.run([self.installed/'postgresql/bin/pg_ctl','-D',self.data/'database','-m','fast','-w','-t','60','stop'],'database')
    def start(self,role):
        self.progress('Starting services',role)
        if self.isolated:
            log=open(self.data/'logs'/role/'isolated.log','ab')
            env={'PATH':'/usr/bin:/bin','TMPDIR':str(self.data/'temp'/role),'XDG_DATA_HOME':str(self.data/'proxy'),'XDG_CONFIG_HOME':str(self.data/'proxy')}
            self.children[role]=subprocess.Popen(self.arguments(role),env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log);log.close()
        else:
            self.run(['/bin/launchctl','bootstrap','system',Path('/Library/LaunchDaemons')/(LABEL+role+'.plist')])
    def ready(self):
        cfg=json.loads((self.data/'config/runtime.json').read_text());deadline=time.monotonic()+240
        while time.monotonic()<deadline:
            self.progress('Checking readiness','web / worker / speech')
            try:
                self.listeners(cfg)
                for port in (cfg['apiPort'],cfg['publicPort']):
                    c=http.client.HTTPConnection('127.0.0.1',port,timeout=3);c.request('GET','/ready');r=c.getresponse();r.read();c.close()
                    if r.status!=200:raise RuntimeError()
                hb=self.data/'state/worker-heartbeat'
                if not hb.exists() or time.time()-hb.stat().st_mtime>90:raise RuntimeError()
                c=http.client.HTTPConnection('127.0.0.1',cfg['controlPort'],timeout=3)
                token=(self.data/'secrets/voice-control/voice-control-token').read_text()
                c.request('GET','/status',headers={'Authorization':'Bearer '+token});r=c.getresponse();status=json.loads(r.read());c.close()
                if r.status!=200 or not status.get('helperAvailable') or (status.get('enabled') and not status.get('healthy')):raise RuntimeError()
                return
            except (OSError,ValueError,RuntimeError,http.client.HTTPException):time.sleep(2)
        raise RuntimeError('Readiness deadline exceeded')
    def listeners(self,cfg):
        ports={'database':cfg['databasePort'],'web':cfg['apiPort'],'proxy':cfg['publicPort'],'voice':cfg['voicePort'],'voice-control':cfg['controlPort']}
        for role in ROLES:
            if self.isolated:
                child=self.children.get(role)
                if child is None or child.poll() is not None:raise RuntimeError('Packaged service exited')
                pid=child.pid
            else:
                output=self.run(['/bin/launchctl','print','system/'+LABEL+role]).stdout.decode()
                matches=[line.strip()[6:] for line in output.splitlines() if line.strip().startswith('pid = ')]
                if len(matches)!=1 or not matches[0].isdecimal():raise RuntimeError('Service has no running PID')
                pid=int(matches[0])
            if role in ports:
                result=subprocess.run(['/usr/sbin/lsof','-nP','-a','-p',str(pid),'-iTCP','-sTCP:LISTEN','-Fn'],capture_output=True,text=True,timeout=5)
                names=[line[1:] for line in result.stdout.splitlines() if line.startswith('n')]
                if result.returncode or names!=['127.0.0.1:'+str(ports[role])]:raise RuntimeError('Unexpected or unavailable service listener')
    def copy(self,source,target):
        if target.exists():raise ValueError('Copy destination exists')
        self.progress('Copying and flushing protected files','installer')
        self.run(['/usr/bin/ditto','--acl','--extattr',source,target],timeout=600)
        last=None
        for p in target.rglob('*'):
            if p.is_symlink():continue
            fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
            try:os.fsync(fd)
            finally:os.close(fd)
            if p.is_file():last=p
        if last:
            fd=os.open(last,os.O_RDONLY|os.O_NOFOLLOW)
            try:fcntl.fcntl(fd,51)
            finally:os.close(fd)
    def seal_program(self,directory):
        if self.isolated:return
        self.run(['/bin/chmod','-RN',directory])
        for p in [directory,*directory.rglob('*')]:
            os.lchown(p,0,0)
            if not p.is_symlink():os.chmod(p,0o755 if p.is_dir() or p.stat().st_mode&0o111 else 0o644)
    def install(self,ports=(15432,18080,8080,18081,18082),fail_at=None,interactive_uid=None,repair=False):
        if not self.isolated and (interactive_uid is None or interactive_uid<501 or os.stat('/dev/console').st_uid!=interactive_uid):raise ValueError('Logged-in installer user required')
        if fail_at and not self.isolated:raise ValueError('Fault injection is isolated only')
        if self.root.exists() and not (self.root/'installation.json').exists() and any(self.root.iterdir()):
            raise ValueError('Existing directory has no Josi ownership receipt; preserve it')
        self.root.mkdir(mode=0o700 if self.isolated else 0o711,parents=True,exist_ok=True)
        if self.root.stat().st_uid!=os.getuid() or self.root.stat().st_mode&0o022:raise ValueError('Unprotected product directory')
        if not (self.root/'installation.json').exists():self.run(['/bin/chmod','-N',self.root])
        elif len(self.run(['/bin/ls','-lde',self.root]).stdout.splitlines())!=1:raise ValueError('Unexpected product directory ACL')
        plain(self.root,os.getuid());lock_path=self.root/'lifecycle.lock'
        lock=os.open(lock_path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        lock_info=os.fstat(lock)
        if lock_info.st_nlink!=1 or lock_info.st_uid!=os.getuid() or lock_info.st_mode&0o077:os.close(lock);raise ValueError('Unsafe lifecycle lock')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        transactions=self.root/'transactions';transactions.mkdir(mode=0o700,exist_ok=True)
        try:
            maintenance=self.root/'maintenance.json'
            if maintenance.exists() and json.loads(maintenance.read_text()).get('state')!='complete':raise RuntimeError('Earlier settings change requires review')
            for folder in transactions.iterdir():
                prior=Journal(folder)
                if not prior.records or prior.records[-1]['phase'] not in ('committed','rolled-back'):raise RuntimeError('Earlier transaction requires recovery')
            fresh=not self.data.exists();old=None
            if not fresh:
                marker=json.loads((self.root/'installation.json').read_text())
                if marker.get('product')!='Josi CE Server':raise ValueError('Unrelated data')
                if (self.data/'database/PG_VERSION').read_text().strip()!='16':raise ValueError('Database major-version conversion requires a separate reviewed migration')
                old=json.loads((self.data/'config/runtime.json').read_text())['version'];self.check_owned(self.root/'versions'/old)
                if old==self.version and not repair:raise ValueError('This version is already installed; preserve it')
            folder=transactions/secrets.token_hex(16);self.journal=Journal(folder,{'from':old,'to':self.version,'manifest':self.verify()})
            def phase(name):
                self.journal.phase(name);self.progress(name,'installer')
                if fail_at==name:raise RuntimeError('Injected isolated failure')
            phase('prepared');phase('verified')
            if fresh:
                if not self.isolated:
                    for role in ROLES:
                        if (Path('/Library/LaunchDaemons')/(LABEL+role+'.plist')).exists() or subprocess.run(['/bin/launchctl','print','system/'+LABEL+role],capture_output=True).returncode==0:raise ValueError('Existing launchd label must be preserved')
                probes=[]
                try:
                    if len(set(ports))!=5 or any(not isinstance(p,int) or p<1024 or p>65535 for p in ports):raise ValueError('Invalid ports')
                    for port in ports:
                        probe=socket.socket();probes.append(probe);probe.bind(('127.0.0.1',port))
                finally:
                    for probe in probes:probe.close()
            self.identities(fresh)
            self.installed.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
            if self.installed.exists():
                if not self.isolated:
                    for p in [self.installed,*self.installed.rglob('*')]:
                        if p.lstat().st_uid!=0 or (not p.is_symlink() and p.stat().st_mode&0o022):raise ValueError('Unprotected retained program')
                self.verify(self.installed)
            else:
                # No user-owned copied executable becomes reachable through the
                # public versions directory before ownership and hashes pass.
                staged=folder/'program';self.copy(self.runtime,staged);self.seal_program(staged);self.verify(staged)
                os.rename(staged,self.installed)
            phase('quiescing')
            if not fresh:self.stop()
            phase('quiesced')
            if not fresh:
                before=self.snapshot_inventory(self.data)
                self.copy(self.data,folder/'snapshot')
                if self.snapshot_inventory(folder/'snapshot')!=before:raise ValueError('Cold snapshot verification failed')
                durable(folder/'snapshot-inventory',before)
            phase('snapshot')
            if fresh:
                durable(self.root/'installation.json',{'product':'Josi CE Server','id':secrets.token_hex(16)})
                cfg=self.layout(ports)
                self.run([self.installed/'postgresql/bin/initdb','-D',self.data/'database','-U','bootstrap_admin','--pwfile='+str(self.data/'secrets/database/init-password'),'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C'],'database')
                settings=f"listen_addresses='127.0.0.1'\nport={cfg['databasePort']}\nunix_socket_directories=''\npassword_encryption='scram-sha-256'\nlog_statement='none'\nlog_min_error_statement='panic'\nlog_parameter_max_length=0\nlog_parameter_max_length_on_error=0\n"
                durable(self.data/'database/postgresql.auto.conf',settings.encode(),replace=True,mode=0o600)
                if not self.isolated:os.chown(self.data/'database/postgresql.auto.conf',*self.account('database'))
                self.write(self.data/'config/Caddyfile',f"{{\n admin off\n auto_https off\n}}\nhttp://localhost:{cfg['publicPort']} {{\n bind 127.0.0.1\n reverse_proxy 127.0.0.1:{cfg['apiPort']}\n}}\n".encode(),mode=0o644)
            phase('provisioned')
            self.run([self.installed/'postgresql/bin/pg_ctl','-D',self.data/'database','-l',self.data/'logs/database/setup.log','-w','-t','60','start'],'database')
            if fresh:
                self.run(self.arguments('bootstrap'))
                for role in ('bootstrap','database'):(self.data/'secrets'/role/'init-password').unlink()
            phase('database-ready');phase('migrating')
            self.run(self.arguments('migrate'),timeout=300)
            phase('migrated')
            self.run([self.installed/'postgresql/bin/pg_ctl','-D',self.data/'database','-m','fast','-w','-t','60','stop'],'database')
            phase('activating')
            cfg=json.loads((self.data/'config/runtime.json').read_text());cfg['version']=self.version
            durable(self.data/'config/runtime.json',cfg,replace=True,mode=0o644)
            if not self.isolated:
                for role,value in self.plists().items():durable(Path('/Library/LaunchDaemons')/(LABEL+role+'.plist'),plistlib.dumps(value),replace=True,mode=0o644)
            for role in ROLES:self.start(role)
            phase('activated');self.ready();phase('healthy')
            if not self.isolated:
                handoffs=self.root/'handoff';handoffs.mkdir(mode=0o711,exist_ok=True)
                handoff=handoffs/str(interactive_uid)
                if not handoff.exists():
                    handoff.mkdir(mode=0o700)
                    durable(handoff/'bootstrap.json',{'token':(self.data/'secrets/bootstrap/browser-token').read_text(),'port':cfg['publicPort']})
                    os.chown(handoff/'bootstrap.json',interactive_uid,-1);os.chown(handoff,interactive_uid,-1)
            phase('committed')
            durable(self.root/'status.json',{'installed':True,'version':self.version,'publicPort':cfg['publicPort']},replace=True,mode=0o644)
            return folder
        except Exception as error:
            if self.journal:
                durable(self.journal.folder/'failure-diagnostics',diagnostic(error),replace=True)
            if self.journal and self.journal.records[-1]['phase'] not in ('committed','rolled-back','recovery-required'):
                self.journal.phase('recovery-required')
            self.progress('Recovery required; existing data retained','installer')
            raise
        finally:fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)

    def recover(self, folder):
        """Restore only a verified cold snapshot before any candidate writer starts.
        Failed data is renamed and retained, never deleted. After activation a
        lossless operator review is required because users may have made writes.
        """
        folder=plain(folder)
        if folder.parent!=self.root/'transactions':raise ValueError('Foreign transaction')
        if self.root.stat().st_uid!=os.getuid() or self.root.stat().st_mode&0o022 or len(self.run(['/bin/ls','-lde',self.root]).stdout.splitlines())!=1:raise ValueError('Unsafe recovery root')
        lock=os.open(self.root/'lifecycle.lock',os.O_RDWR|os.O_NOFOLLOW)
        try:
            info=os.fstat(lock)
            if info.st_nlink!=1 or info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError('Unsafe recovery lock')
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            journal=Journal(folder);phases=[r['phase'] for r in journal.records]
            if 'activating' in phases:raise RuntimeError('Activation began; preserve current data for lossless manual recovery')
            if not phases or phases[-1]!='recovery-required':raise ValueError('Not a recoverable transaction')
            if not journal.identity['from']:
                raise RuntimeError('No verified previous installation; preserve provisioning evidence for review')
            self.check_owned(self.root/'versions'/journal.identity['from'])
            if 'migrating' not in phases:
                # Before migration starts the original cold database remains
                # authoritative; never replace it with an incomplete copy.
                if json.loads((self.data/'config/runtime.json').read_text())['version']!=journal.identity['from']:raise ValueError('Previous activation identity changed')
                self.stop();journal.phase('rolling-back');self.installed=self.root/'versions'/journal.identity['from']
                for role in ROLES:self.start(role)
                self.ready();journal.phase('rolled-back');return
            if 'snapshot' not in phases:raise ValueError('Migration lacks a verified snapshot')
            expected=json.loads((folder/'snapshot-inventory').read_text())
            if self.snapshot_inventory(folder/'snapshot')!=expected:raise ValueError('Snapshot integrity failed')
            self.stop();journal.phase('rolling-back')
            retained=folder/'failed-data'
            if retained.exists():raise ValueError('Recovery already started; preserve both copies')
            os.rename(self.data,retained)
            self.copy(folder/'snapshot',self.data)
            if self.snapshot_inventory(self.data)!=expected:raise ValueError('Restored data integrity failed')
            self.installed=self.root/'versions'/journal.identity['from']
            for role in ROLES:self.start(role)
            self.ready();journal.phase('rolled-back')
        finally:fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)

if __name__=='__main__':
    try:
        runtime=Path(__file__).resolve().parents[2]
        if sys.argv[1:]==['verify']:
            # No mutation or elevation for unsigned acceptance inspection.
            obj=object.__new__(Lifecycle);obj.runtime=runtime
            obj.version=json.loads((runtime/'app/package.json').read_text())['version']
            emit({'verified':obj.verify(),'architecture':'arm64'})
        elif len(sys.argv)==3 and sys.argv[1]=='install' and sys.argv[2].isascii() and sys.argv[2].isdecimal():
            Lifecycle(runtime).install(interactive_uid=int(sys.argv[2]))
        elif len(sys.argv)==3 and sys.argv[1]=='recover' and re.fullmatch('[a-f0-9]{32}',sys.argv[2]):
            Lifecycle(runtime).recover(PRODUCT/'transactions'/sys.argv[2])
        else:raise ValueError('Unsupported lifecycle command')
    except Exception as error:
        emit({'phase':'Stopped',**diagnostic(error)})
        sys.exit(1)
