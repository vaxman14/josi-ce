"""Narrow signed companion helper. Never deletes Josi data or user folders."""
import fcntl
import errno
import json
import os
from pathlib import Path
import pwd
import stat
import sys
import secrets
import subprocess
sys.path.insert(0,str(Path(__file__).resolve().parent))
from lifecycle import Lifecycle, PRODUCT, LABEL, ROLES, TERMINAL, durable, plain, diagnostic, emit
import workspace_access

class WorkspaceServiceAccessError(PermissionError):pass

def failure(error,operation):
    value={'result':'failure',**diagnostic(error)}
    if operation=='workspace':
        if isinstance(error,WorkspaceServiceAccessError):value['recovery']='workspace-service-access'
        elif isinstance(error,PermissionError) and error.errno==errno.EPERM:value['recovery']='full-disk-access'
    return value

def probe_workspace(obj,selection):
    # Preserve the service-user errno without exposing file contents or an
    # arbitrary traceback. The parent can then offer the correct privacy UI.
    probe="""import os,sys,json
try:
    f=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        s=os.fstat(f)
        assert (s.st_dev,s.st_ino)==(int(sys.argv[2]),int(sys.argv[3]))
        os.listdir(f)
    finally:os.close(f)
except OSError as error:
    print(json.dumps({'workspaceAccessErrno':error.errno}),file=sys.stderr)
    sys.exit(77)
"""
    for role in ('web','worker'):
        try:obj.run([obj.installed/'python/bin/python3.11','-I','-B','-c',probe,selection['path'],str(selection['dev']),str(selection['ino'])],role)
        except subprocess.CalledProcessError as error:
            try:code=json.loads(error.stderr)['workspaceAccessErrno'] if error.returncode==77 else None
            except (ValueError,TypeError,KeyError):code=None
            if code in (errno.EPERM,errno.EACCES):raise WorkspaceServiceAccessError(code,'Josi '+role+' service cannot read this folder',selection['path']) from error
            raise

def selected_folder(path,uid):
    p=plain(Path(path))
    home=Path(pwd.getpwuid(uid).pw_dir)
    if p==home or not (str(p).startswith('/Users/') or str(p).startswith('/Volumes/')) or any(x.startswith('.') for x in p.parts):
        raise ValueError('Choose a documents or project folder, rather than your entire home or a hidden folder')
    # A folder selected in NSOpenPanel does not imply consent to read all of
    # Documents. Ancestors need traversal, not directory-listing access.
    fd=os.open('/',os.O_SEARCH|os.O_NOFOLLOW)
    try:
        for index,part in enumerate(p.parts[1:],start=1):
            mode=os.O_RDONLY|os.O_DIRECTORY if index==len(p.parts)-1 else os.O_SEARCH
            next_fd=os.open(part,mode|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=next_fd
        info=os.fstat(fd)
        if info.st_uid!=uid:raise PermissionError('Choose a folder you own')
        return {'path':str(p),'dev':info.st_dev,'ino':info.st_ino,'uid':uid}
    finally:os.close(fd)

def owned_lock(obj):
    plain(obj.root,os.getuid())
    if obj.root.stat().st_mode&0o022:raise PermissionError('Unprotected installation')
    fd=os.open(obj.root/'lifecycle.lock',os.O_RDWR|os.O_NOFOLLOW)
    info=os.fstat(fd)
    if info.st_uid!=os.getuid() or info.st_mode&0o077 or info.st_nlink!=1:os.close(fd);raise PermissionError('Unsafe maintenance lock')
    fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    return fd

def clean_transactions(obj,allow_uninstall=False):
    from lifecycle import Journal
    for folder in (obj.root/'transactions').iterdir():
        j=Journal(folder)
        if not j.records or j.records[-1]['phase'] not in TERMINAL:raise RuntimeError('Installation needs repair before settings can change')
    status=obj.root/'maintenance.json'
    if status.exists():
        saved=json.loads(status.read_text())
        if saved.get('state')!='complete' and not (allow_uninstall and saved.get('operation')=='uninstall'):raise RuntimeError('An earlier settings change needs repair first')

def workspace(obj,path,uid):
    selection=selected_folder(path,uid) if path else None
    lock=owned_lock(obj)
    try:
        clean_transactions(obj)
        cfg_path=obj.data/'config/runtime.json';plain(cfg_path,os.getuid())
        cfg=json.loads(cfg_path.read_text())
        previous=dict(cfg)
        previous_access=workspace_access.read(obj.root)
        if selection:cfg['workspace']=selection
        else:cfg.pop('workspace',None)
        # Durable intent precedes stopping or changing configuration. Data is
        # retained even on an interruption; repair never restores SQL here.
        intent=obj.root/'maintenance.json'
        durable(intent,{'operation':'workspace','state':'pending','previous':previous,'next':cfg,'previousAccess':previous_access},replace=True)
        try:
            obj.stop()
            workspace_access.revoke(obj.root)
            if selection:
                users=[pwd.getpwuid(obj.account(role)[0]).pw_name for role in ('web','worker')]
                workspace_access.grant(obj.root,selection,users,Path(selection['path']) if obj.isolated else Path('/'))
                probe_workspace(obj,selection)
            durable(cfg_path,cfg,replace=True,mode=0o644)
            for role in ROLES:obj.start(role)
            obj.ready()
        except Exception:
            # Only settings are reverted. Database/user writes are retained.
            obj.stop();workspace_access.revoke(obj.root);workspace_access.restore(obj.root,previous_access);durable(cfg_path,previous,replace=True,mode=0o644)
            for role in ROLES:obj.start(role)
            obj.ready()
            durable(intent,{'operation':'workspace','state':'complete','settingsRestored':True},replace=True)
            raise
        durable(intent,{'operation':'workspace','state':'complete'},replace=True)
        return {'workspace':selection,'logicalPath':'/workspace' if selection else None}
    finally:fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)

def uninstall(obj):
    """Disable owned jobs, retaining accounts, all versions, data and evidence."""
    lock=owned_lock(obj)
    try:
        clean_transactions(obj,allow_uninstall=True)
        cfg=json.loads((obj.data/'config/runtime.json').read_text())
        obj.check_owned(obj.root/'versions'/cfg['version'])
        durable(obj.root/'maintenance.json',{'operation':'uninstall','state':'pending'},replace=True)
        obj.stop()
        workspace_access.revoke(obj.root)
        if not obj.isolated:
            # Retain validated definitions rather than deleting them.
            retained=obj.root/'disabled-launchd';retained.mkdir(mode=0o700,exist_ok=True)
            prior=obj.root/'disabled-launchd-record.json'
            record=json.loads(prior.read_text()) if prior.exists() else {}
            generation=secrets.token_hex(16)
            for role in ROLES:
                if (Path('/Library/LaunchDaemons')/(LABEL+role+'.plist')).exists():record[role]=LABEL+role+'.'+generation+'.plist'
            durable(prior,record,replace=True)
            for role in ROLES:
                source=Path('/Library/LaunchDaemons')/(LABEL+role+'.plist')
                if source.exists():
                    target=retained/record[role]
                    if target.exists():raise ValueError('Uninstall evidence collision; preserve both definitions')
                    os.rename(source,target)
        durable(obj.root/'status.json',{'installed':False,'version':cfg['version'],'dataRetained':True},replace=True,mode=0o644)
        durable(obj.root/'maintenance.json',{'operation':'uninstall','state':'complete'},replace=True)
        return {'result':'removed','dataRetained':True}
    finally:fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)

def main():
    runtime=Path(__file__).resolve().parents[2]
    obj=Lifecycle(runtime)
    cfg=json.loads((obj.data/'config/runtime.json').read_text())
    obj.installed=obj.root/'versions'/cfg['version']
    obj.check_owned(obj.installed)
    uid=os.stat('/dev/console').st_uid
    if uid<501:raise PermissionError('Sign in to your Mac first')
    if sys.argv[1:]==['uninstall']:result=uninstall(obj)
    elif len(sys.argv)==3 and sys.argv[1]=='workspace':result=workspace(obj,sys.argv[2],uid)
    elif sys.argv[1:]==['recover-latest']:
        settings=obj.root/'maintenance.json'
        if settings.exists():
            saved=json.loads(settings.read_text())
            if saved.get('state')=='pending' and saved.get('operation')=='workspace':
                lock=owned_lock(obj)
                try:
                    obj.stop();workspace_access.revoke(obj.root);workspace_access.restore(obj.root,saved.get('previousAccess',[]));durable(obj.data/'config/runtime.json',saved['previous'],replace=True,mode=0o644)
                    for role in ROLES:obj.start(role)
                    obj.ready();durable(settings,{'operation':'workspace','state':'complete','settingsRestored':True},replace=True)
                finally:fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)
                emit({'recovered':True,'settingsRestored':True});return
        from lifecycle import Journal
        pending=[f for f in (obj.root/'transactions').iterdir() if Journal(f).records[-1]['phase']=='recovery-required']
        if len(pending)!=1:raise ValueError('No single safe repair is available')
        obj.recover(pending[0]);result={'recovered':True}
    else:raise ValueError('Unsupported maintenance operation')
    emit(result)

if __name__=='__main__':
    try:main()
    except Exception as error:emit(failure(error,sys.argv[1] if len(sys.argv)>1 else ''));sys.exit(1)
