"""Narrow native Linux maintenance helper. User folders and Josi data survive."""
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import subprocess
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from lifecycle import Lifecycle, PRODUCT, UNIT_DIR, UNIT_PREFIX, ROLES, durable, plain, diagnostic, emit

def selected_folder(path,uid):
    selected=plain(Path(path)); home=Path(pwd.getpwuid(uid).pw_dir)
    allowed=('/home/','/mnt/','/media/','/srv/')
    if selected==home or not str(selected).startswith(allowed) or any(part.startswith('.') for part in selected.parts):
        raise ValueError('Choose a documents or project folder, rather than your entire home or a hidden folder')
    descriptor=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in selected.parts[1:]:
            next_descriptor=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=descriptor)
            os.close(descriptor);descriptor=next_descriptor
        info=os.fstat(descriptor)
        if info.st_uid!=uid:raise PermissionError('Choose a folder you own')
        return {'path':str(selected),'dev':info.st_dev,'ino':info.st_ino,'uid':uid}
    finally:os.close(descriptor)

def owned_lock(obj):
    plain(obj.root,os.getuid())
    if obj.root.stat().st_mode&0o022:raise PermissionError('Unprotected installation')
    descriptor=os.open(obj.root/'lifecycle.lock',os.O_RDWR|os.O_NOFOLLOW)
    info=os.fstat(descriptor)
    if info.st_uid!=os.getuid() or info.st_mode&0o077 or info.st_nlink!=1:
        os.close(descriptor);raise PermissionError('Unsafe maintenance lock')
    fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB);return descriptor

def clean_transactions(obj,allow_uninstall=False):
    from lifecycle import Journal
    for folder in (obj.root/'transactions').iterdir():
        journal=Journal(folder)
        if not journal.records or journal.records[-1]['phase'] not in ('committed','rolled-back'):
            raise RuntimeError('Installation needs repair before settings can change')
    status=obj.root/'maintenance.json'
    if status.exists():
        saved=json.loads(status.read_text())
        if saved.get('state')!='complete' and not (allow_uninstall and saved.get('operation')=='uninstall'):
            raise RuntimeError('An earlier settings change needs repair first')

def workspace(obj,path,uid):
    selection=selected_folder(path,uid) if path else None;lock=owned_lock(obj)
    try:
        clean_transactions(obj);config_path=obj.data/'config/runtime.json';plain(config_path,os.getuid())
        config=json.loads(config_path.read_text());previous=dict(config)
        if selection:
            probe="import os,sys;p=sys.argv[1];f=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);s=os.fstat(f);assert(s.st_dev,s.st_ino)==(int(sys.argv[2]),int(sys.argv[3]));os.listdir(f);os.close(f)"
            obj.run([obj.installed/'python/bin/python3.12','-I','-B','-c',probe,selection['path'],str(selection['dev']),str(selection['ino'])],'web')
            config['workspace']=selection
        else:config.pop('workspace',None)
        intent=obj.root/'maintenance.json';durable(intent,{'operation':'workspace','state':'pending','previous':previous,'next':config},replace=True)
        try:
            obj.stop();durable(config_path,config,replace=True,mode=0o644)
            for role in ROLES:obj.start(role)
            obj.ready()
        except Exception:
            obj.stop();durable(config_path,previous,replace=True,mode=0o644)
            for role in ROLES:obj.start(role)
            obj.ready();durable(intent,{'operation':'workspace','state':'complete','settingsRestored':True},replace=True);raise
        durable(intent,{'operation':'workspace','state':'complete'},replace=True)
        return {'workspace':selection,'logicalPath':'/workspace' if selection else None}
    finally:fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)

def uninstall(obj):
    lock=owned_lock(obj)
    try:
        clean_transactions(obj,allow_uninstall=True);config=json.loads((obj.data/'config/runtime.json').read_text())
        obj.check_owned(obj.root/'versions'/config['version'])
        durable(obj.root/'maintenance.json',{'operation':'uninstall','state':'pending'},replace=True);obj.stop()
        if not obj.isolated:
            retained=obj.root/'disabled-systemd';retained.mkdir(mode=0o700,exist_ok=True)
            record_path=obj.root/'disabled-systemd-record.json';record=json.loads(record_path.read_text()) if record_path.exists() else {}
            generation=secrets.token_hex(16)
            for role in ROLES:
                source=UNIT_DIR/(UNIT_PREFIX+role+'.service')
                if source.exists():
                    target=retained/(UNIT_PREFIX+role+'.'+generation+'.service')
                    if target.exists():raise ValueError('Uninstall evidence collision')
                    os.rename(source,target);record[role]=target.name
            durable(record_path,record,replace=record_path.exists())
            subprocess.run(['/usr/bin/systemctl','daemon-reload'],check=True,timeout=30)
        durable(obj.root/'status.json',{'installed':False,'version':config['version'],'dataRetained':True},replace=True,mode=0o644)
        durable(obj.root/'maintenance.json',{'operation':'uninstall','state':'complete'},replace=True)
        return {'result':'removed','dataRetained':True}
    finally:fcntl.flock(lock,fcntl.LOCK_UN);os.close(lock)

def main():
    runtime=Path(__file__).resolve().parents[2];obj=Lifecycle(runtime)
    config=json.loads((obj.data/'config/runtime.json').read_text());obj.installed=obj.root/'versions'/config['version'];obj.check_owned(obj.installed)
    if sys.argv[1:]==['uninstall']:result=uninstall(obj)
    elif len(sys.argv)==4 and sys.argv[1]=='workspace' and sys.argv[3].isdecimal():result=workspace(obj,sys.argv[2],int(sys.argv[3]))
    elif len(sys.argv)==3 and sys.argv[1]=='recover' and re.fullmatch('[a-f0-9]{32}',sys.argv[2]):
        obj.recover(PRODUCT/'transactions'/sys.argv[2]);result={'recovered':True}
    else:raise ValueError('Unsupported maintenance operation')
    emit(result)

if __name__=='__main__':
    try:main()
    except Exception as error:emit(diagnostic(error));sys.exit(1)
