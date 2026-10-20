"""Standalone signed cleanup helper. Fixed paths; no dependency on server health.

Production entry is administrator-authorized by Uninstall Josi.app. Fixture
adapters are import-only and never accepted as privileged command arguments.
"""
import fcntl
import ctypes
import grp
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parent))
from lifecycle import Lifecycle,PRODUCT,ACCOUNTS,ROLES,LABEL,durable,plain,diagnostic
import workspace_access

ENV={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'}
APP_IDS={'Josi.app':'com.heyjosi.ce.unified','Josi Server.app':'com.heyjosi.ce.server','Josi CE.app':'com.romanvaxman.josi.desktop','Uninstall Josi.app':'com.heyjosi.ce.uninstaller'}
RECEIPTS=('com.heyjosi.ce.unified.pkg','com.heyjosi.ce.server.pkg','com.heyjosi.ce.desktop.pkg')
APPLE_SUPPORT_PATHS={'/usr/sbin/distnoted','/usr/libexec/containermanagerd'}

class AccountRemovalPermissionError(PermissionError):pass

def failure(error):
    value={'result':'failure',**diagnostic(error)}
    if isinstance(error,AccountRemovalPermissionError):value['recovery']='full-disk-access'
    return value

def process_path(pid):
    # ps names/argv can be changed by a process. Use the kernel's executable
    # path before deciding that a service-UID process is an Apple helper.
    lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
    lib.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
    lib.proc_pidpath.restype=ctypes.c_int
    buffer=ctypes.create_string_buffer(4096)
    if lib.proc_pidpath(pid,buffer,len(buffer))<=0:
        if ctypes.get_errno()==3:return None # Process exited during inspection.
        raise RuntimeError('Cannot inspect service-account process: '+str(pid))
    return os.fsdecode(buffer.value)

def verify_apple_support(path):
    if path not in APPLE_SUPPORT_PATHS:raise ValueError('Unexpected Apple support path')
    run(['/usr/bin/codesign','--verify','--strict','-R','=anchor apple',path])

def run(args):return subprocess.run([str(x) for x in args],env=ENV,capture_output=True,text=True,check=True)

def local_identity_present(database,name):
    # libc's passwd/group lookups can briefly retain a deleted account. Ask
    # the local directory node directly, and never treat a failed query as
    # absence unless Directory Service explicitly reports record-not-found.
    if database not in ('Users','Groups') or name not in ACCOUNTS.values():raise ValueError('Invalid service identity query')
    args=['/usr/bin/dscl','-plist','/Local/Default','-read','/'+database+'/'+name,'RecordName']
    result=subprocess.run(args,env=ENV,capture_output=True,text=True)
    if result.returncode:
        if result.returncode==56 and 'eDSRecordNotFound' in result.stdout+result.stderr:return False
        raise subprocess.CalledProcessError(result.returncode,args,result.stdout,result.stderr)
    value=plistlib.loads(result.stdout.encode())
    if value.get('dsAttrTypeStandard:RecordName')!=[name]:raise ValueError('Unexpected service identity response')
    return True

def remove(path):
    path=Path(path)
    if not path.is_absolute() or path==Path('/'):raise ValueError('Invalid removal target')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in path.parent.parts[1:]:
            try:next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            except FileNotFoundError:return
            os.close(fd);fd=next_fd
        try:info=os.stat(path.name,dir_fd=fd,follow_symlinks=False)
        except FileNotFoundError:return
        if stat.S_ISDIR(info.st_mode):
            if not shutil.rmtree.avoids_symlink_attacks:raise RuntimeError('Unsafe recursive deletion refused')
            shutil.rmtree(path.name,dir_fd=fd)
        else:os.unlink(path.name,dir_fd=fd)
    finally:os.close(fd)

def profile_paths(home):
    base=home/'Library';names=('josi-desktop','Josi CE','com.heyjosi.ce.unified','com.heyjosi.ce.server','com.romanvaxman.josi.desktop')
    paths=[base/section/name for section in ('Application Support','Caches','HTTPStorages','WebKit','Logs') for name in names]
    paths += [base/'Preferences'/(name+'.plist') for name in ('com.heyjosi.ce.server','com.romanvaxman.josi.desktop')]
    paths += [base/'Saved Application State'/(name+'.savedState') for name in ('com.heyjosi.ce.server','com.romanvaxman.josi.desktop')]
    # The native management app's own diagnostics are also installed state.
    paths.append(base/'Logs/Josi CE Server')
    return paths

class NativeSystem:
    def __init__(self,uid):
        self.uid=uid;self.home=Path(pwd.getpwuid(uid).pw_dir)
        if uid<501 or not str(self.home).startswith('/Users/'):raise ValueError('Invalid interactive user')
        self.apps=Path('/Applications');self.logs=Path('/Library/Logs/Josi CE Server')
        self.daemons=Path('/Library/LaunchDaemons');self.journal=Path('/Library/Application Support/Josi Uninstall')
    def identity(self,role,record,missing=False):
        name=ACCOUNTS[role]
        try:user=pwd.getpwnam(name)
        except KeyError:user=None
        try:group=grp.getgrnam(name)
        except KeyError:group=None
        if not missing and (not user or not group):raise ValueError('Incomplete service identity: '+name)
        if not user:
            try:replacement=pwd.getpwuid(record[0])
            except KeyError:replacement=None
            if replacement:raise ValueError('Service UID now belongs to another account')
        if not group:
            try:replacement=grp.getgrgid(record[1])
            except KeyError:replacement=None
            if replacement:raise ValueError('Service GID now belongs to another group')
        if user and ([user.pw_uid,user.pw_gid]!=record or user.pw_shell!='/usr/bin/false' or user.pw_dir!=str(PRODUCT/'data/profiles'/role)):raise ValueError('Unowned service identity: '+name)
        if group and (group.gr_gid!=record[1] or group.gr_mem):raise ValueError('Unowned service group: '+name)
        if not 400<=record[0]<500:raise ValueError('Service ID is outside the reserved range')
    def absent_jobs(self):
        for role in ROLES:
            label=LABEL+role;q=subprocess.run(['/bin/launchctl','print','system/'+label],env=ENV,capture_output=True,text=True)
            if q.returncode!=113 or 'Could not find service "'+label+'" in domain for system' not in q.stderr:raise RuntimeError('Cannot confirm service stopped: '+role)
    def finish_processes(self,records):
        uids={x[0] for x in records.values()}
        verified=set()
        def processes():
            result=[]
            for line in run(['/bin/ps','-axo','uid=,pid=,state=']).stdout.splitlines():
                parts=line.split()
                if len(parts)!=3 or int(parts[0]) not in uids:continue
                pid=int(parts[1]);state=parts[2]
                if state.startswith('Z'):continue # Already exited; no live files.
                path=process_path(pid)
                if path is None:continue
                # macOS can keep per-UID support agents alive after all Josi
                # jobs exit. Do not signal or wait for these OS-owned agents.
                # Exact kernel paths plus Apple's signature are required.
                if path in APPLE_SUPPORT_PATHS:
                    if path not in verified:verify_apple_support(path);verified.add(path)
                    continue
                result.append((pid,path))
            return result
        for pid,path in processes():
            try:os.kill(pid,signal.SIGTERM)
            except ProcessLookupError:pass
        deadline=time.monotonic()+60
        while remaining:=processes():
            if time.monotonic()>deadline:
                detail=', '.join(str(pid)+' ('+path+')' for pid,path in remaining[:5])
                raise RuntimeError('A Josi process has not stopped; files retained: '+detail)
            time.sleep(.2)
    def delete_identities(self,records):
        for role,record in records.items():
            self.identity(role,record,missing=True)
            name=ACCOUNTS[role]
            for database in ('Users','Groups'):
                if not local_identity_present(database,name):continue
                try:run(['/usr/bin/dscl','/Local/Default', '-delete','/'+database+'/'+name])
                except subprocess.CalledProcessError as error:
                    if error.returncode==40 and 'eDSPermissionError' in (error.stderr or ''):
                        raise AccountRemovalPermissionError('macOS blocked removal of '+name+'. Enable Uninstall Josi in System Settings > Privacy & Security > Full Disk Access, then quit and reopen it to retry. Josi data is retained.') from error
                    raise
    def forget_receipts(self):
        existing=set(run(['/usr/sbin/pkgutil','--pkgs']).stdout.splitlines())
        for receipt in RECEIPTS:
            if receipt in existing:run(['/usr/sbin/pkgutil','--forget',receipt])
    def verify_erased(self,records):
        self.absent_jobs()
        for role in ROLES:
            for database in ('Users','Groups'):
                if local_identity_present(database,ACCOUNTS[role]):raise RuntimeError('Service identity remains: '+role+' ('+database.lower()+')')
        if set(run(['/usr/sbin/pkgutil','--pkgs']).stdout.splitlines()) & set(RECEIPTS):raise RuntimeError('Installer receipts remain')

def uninstall(obj,mode,system,operation):
    if mode not in ('keep','erase'):raise ValueError('Invalid removal choice')
    uuid.UUID(operation)
    if obj.isolated and os.getuid()==0:raise ValueError('Isolated cleanup must never be privileged')
    journal=system.journal;plain(journal,os.getuid());journal.mkdir(mode=0o711,parents=True,exist_ok=True)
    if journal.stat().st_mode&0o022:raise ValueError('Unprotected cleanup journal')
    lock=os.open(journal/'lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    info=os.fstat(lock)
    if info.st_uid!=os.getuid() or info.st_mode&0o077 or info.st_nlink!=1:raise ValueError('Unprotected cleanup lock')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    product_lock=None
    def progress(phase):
        durable(journal/'status.json',{'operation':operation,'phase':phase},replace=True,mode=0o644)
        print(json.dumps({'phase':phase}),flush=True)
    try:
        saved=journal/'intent.json';plain(saved,os.getuid())
        if saved.exists():
            if saved.stat().st_mode&0o077:raise ValueError('Unprotected cleanup intent')
            intent=json.loads(saved.read_text())
            if intent['mode']!=mode or intent['uid']!=system.uid:raise RuntimeError('Retry the earlier removal choice with the same Mac user')
        else:
            plain(obj.root,os.getuid())
            if obj.root.stat().st_mode&0o022:raise ValueError('Unprotected installation')
            for filename in ['installation.json','identities.json','data/config/runtime.json']:
                file=plain(obj.root/filename,os.getuid());info=file.stat()
                if info.st_mode&0o022 or info.st_nlink!=1:raise ValueError('Unprotected installation metadata')
            marker=json.loads((obj.root/'installation.json').read_text())
            if marker.get('product')!='Josi CE Server':raise ValueError('Josi ownership receipt is missing')
            cfg=json.loads((obj.data/'config/runtime.json').read_text());records=json.loads((obj.root/'identities.json').read_text())
            if set(records)!=set(ROLES):raise ValueError('Incomplete service identity receipt')
            for role,record in records.items():system.identity(role,record)
            intent={'mode':mode,'uid':system.uid,'installation':marker,'cfg':cfg,'identities':records,'phase':'planned'}
            durable(saved,intent)
        records=intent['identities'];cfg=intent['cfg']
        for role,record in records.items():system.identity(role,record,missing=intent['phase']=='removing')
        if obj.root.exists():
            plain(obj.root,os.getuid())
            if json.loads((obj.root/'installation.json').read_text())!=intent['installation']:raise RuntimeError('A different Josi installation now occupies this folder')
            product_lock=os.open(obj.root/'lifecycle.lock',os.O_RDWR|os.O_NOFOLLOW)
            info=os.fstat(product_lock)
            if info.st_uid!=os.getuid() or info.st_mode&0o077 or info.st_nlink!=1:raise ValueError('Unprotected installation lock')
            fcntl.flock(product_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        elif intent['phase']!='removing':raise ValueError('Product folder disappeared before cleanup')
        if intent['phase']=='planned':
            progress('Stopping Josi')
            obj.installed=obj.root/'versions'/cfg['version']
            if not re.fullmatch(r'\d+\.\d+\.\d+-[a-z0-9.]+',cfg['version']):raise ValueError('Invalid active version')
            if not obj.isolated:
                alternatives=[p for p in (obj.root/'versions').iterdir() if p!=obj.installed and re.fullmatch(r'\d+\.\d+\.\d+-[a-z0-9.]+',p.name)]
                obj.check_owned(obj.installed,alternatives,configuration=cfg)
            obj.stop();system.absent_jobs();system.finish_processes(records)
            progress('Disconnecting folder access');workspace_access.revoke(obj.root)
            # A failed settings change can retain grants from the previous choice.
            settings=obj.root/'maintenance.json'
            if settings.exists():
                previous=json.loads(settings.read_text()).get('previousAccess',[])
                workspace_access.save(obj.root,previous);workspace_access.revoke(obj.root)
            if not obj.isolated:
                retained=obj.root/'disabled-launchd';retained.mkdir(mode=0o700,exist_ok=True)
                record_path=obj.root/'disabled-launchd-record.json'
                record=json.loads(record_path.read_text()) if record_path.exists() else {}
                for role in ROLES:
                    source=system.daemons/(LABEL+role+'.plist')
                    if source.exists():
                        target=LABEL+role+'.'+uuid.uuid4().hex+'.plist';record[role]=target
                        durable(record_path,record,replace=True);os.rename(source,retained/target)
            cfg=dict(cfg);cfg.pop('workspace',None)
            durable(obj.data/'config/runtime.json',cfg,replace=True,mode=0o644)
            durable(obj.root/'status.json',{'installed':False,'version':cfg['version'],'dataRetained':mode=='keep'},replace=True,mode=0o644)
            durable(obj.root/'maintenance.json',{'operation':'uninstall','state':'complete'},replace=True)
            intent['phase']='removing';durable(saved,intent,replace=True)
        system.absent_jobs();system.finish_processes(records)
        # Validate every app first. A foreign app must refuse cleanup before
        # any account is deleted. Permission failures then leave apps available
        # for retry instead of deleting the UI before Directory Service access.
        targets=[]
        for name,identifier in APP_IDS.items():
            path=system.apps/name
            if not path.exists() and not path.is_symlink():continue
            plain(path)
            if plistlib.loads((path/'Contents/Info.plist').read_bytes()).get('CFBundleIdentifier')!=identifier:raise ValueError('Unrelated app at '+str(path))
            targets.append((path,identifier))
        if mode=='erase':
            progress('Removing Josi service accounts')
            system.delete_identities(records);system.forget_receipts()
        progress('Removing Josi apps')
        for path,identifier in targets:
            plain(path)
            if plistlib.loads((path/'Contents/Info.plist').read_bytes()).get('CFBundleIdentifier')!=identifier:raise ValueError('Application changed during removal')
            remove(path)
        if mode=='erase':
            progress('Deleting Josi data and saved connections')
            remove(obj.root);remove(system.logs)
            for path in profile_paths(system.home):remove(path)
        progress('Verifying removal')
        system.absent_jobs()
        if any((system.apps/name).exists() for name in APP_IDS):raise RuntimeError('A Josi app remains')
        if mode=='erase':
            system.verify_erased(records)
            if obj.root.exists() or system.logs.exists() or any(p.exists() or p.is_symlink() for p in profile_paths(system.home)):raise RuntimeError('Josi data remains')
        else:
            if not obj.data.is_dir():raise RuntimeError('Retained data folder missing')
        result={'result':'removed','mode':mode,'dataRetained':mode=='keep','verified':True,'browserData':'Clear Josi website data in your browser before a fresh-install test.'}
        remove(journal)
        print(json.dumps(result),flush=True);return result
    finally:
        if product_lock is not None:os.close(product_lock)
        os.close(lock)

def main():
    if os.getuid()!=0 or sys.platform!='darwin' or len(sys.argv)!=4:raise PermissionError('Use the signed Uninstall Josi app and administrator authorization')
    mode,uid,operation=sys.argv[1:];uid=int(uid)
    if uid!=os.stat('/dev/console').st_uid:raise PermissionError('The requesting Mac user is not signed in')
    runtime=Path(__file__).resolve().parents[2]
    obj=Lifecycle(runtime);uninstall(obj,mode,NativeSystem(uid),operation)

if __name__=='__main__':
    try:main()
    except Exception as error:print(json.dumps(failure(error)),flush=True);sys.exit(1)
