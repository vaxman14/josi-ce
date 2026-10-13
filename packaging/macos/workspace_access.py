"""Explicit, reversible read grants. Never changes modes or follows links.

Only the selected directory gets read access. Private parents get search only;
existing descendants are not recursively rewritten. Native macOS privacy
restrictions remain enforced, and access is probed as the web service.
"""
from collections import Counter
import ctypes
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import pwd
import uuid
from lifecycle import durable, plain

def entries(fd):
    lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
    lib.acl_get_fd_np.argtypes=[ctypes.c_int,ctypes.c_int];lib.acl_get_fd_np.restype=ctypes.c_void_p
    lib.acl_to_text.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ssize_t)];lib.acl_to_text.restype=ctypes.c_void_p
    lib.acl_free.argtypes=[ctypes.c_void_p]
    acl=lib.acl_get_fd_np(fd,0x100)
    if not acl:
        if ctypes.get_errno()==2:return []
        raise ValueError('Cannot read selected-folder permissions')
    text=None
    try:
        size=ctypes.c_ssize_t();text=lib.acl_to_text(acl,ctypes.byref(size))
        if not text:raise ValueError('Cannot decode selected-folder permissions')
        result=[]
        for line in ctypes.string_at(text,size.value).decode().splitlines()[1:]:
            kind,identifier,name,number,tags,rights=line.split(':')
            flags=tags.split(',');result.append(kind+':'+identifier+' '+flags[0]+' '+','.join([rights,*flags[1:]]))
        return result
    finally:
        if text:lib.acl_free(text)
        lib.acl_free(acl)

def identifier(user):
    lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib');value=(ctypes.c_ubyte*16)()
    lib.mbr_uid_to_uuid.argtypes=[ctypes.c_uint,ctypes.POINTER(ctypes.c_ubyte)]
    if lib.mbr_uid_to_uuid(pwd.getpwnam(user).pw_uid,value):raise ValueError('Cannot resolve service identity')
    return str(uuid.UUID(bytes=bytes(value))).upper()

def descriptor(record):
    path=plain(Path(record['path']))
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    info=os.fstat(fd)
    if (info.st_dev,info.st_ino,info.st_uid)!=(record['dev'],record['ino'],record['uid']):
        os.close(fd);raise ValueError('Folder identity changed; permissions were not modified: '+str(path))
    return fd

def edit(fd,operation,entry):
    if operation=='+a':
        subprocess.run(['/bin/chmod',operation,entry,f'/dev/fd/{fd}'],pass_fds=(fd,),capture_output=True,check=True)
        return
    current=entries(fd)
    if entry not in current:return
    index=current.index(entry)
    lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
    lib.acl_get_fd_np.argtypes=[ctypes.c_int,ctypes.c_int];lib.acl_get_fd_np.restype=ctypes.c_void_p
    lib.acl_get_entry.argtypes=[ctypes.c_void_p,ctypes.c_int,ctypes.POINTER(ctypes.c_void_p)]
    lib.acl_delete_entry.argtypes=[ctypes.c_void_p,ctypes.c_void_p]
    lib.acl_set_fd_np.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_int]
    lib.acl_free.argtypes=[ctypes.c_void_p]
    acl=lib.acl_get_fd_np(fd,0x100);pointer=ctypes.c_void_p()
    if not acl:raise ValueError('Cannot revoke selected-folder permission')
    try:
        for n in range(index+1):
            if lib.acl_get_entry(acl,0 if n==0 else 1,ctypes.byref(pointer)):raise ValueError('Folder permission changed during revocation')
        if lib.acl_delete_entry(acl,pointer) or lib.acl_set_fd_np(fd,acl,0x100):raise ValueError('Cannot revoke selected-folder permission')
        if entries(fd)!=current[:index]+current[index+1:]:raise ValueError('Unexpected folder permission change')
    finally:lib.acl_free(acl)

def read(root):
    path=root/'workspace-access.json'
    if not path.exists():return []
    plain(path,os.getuid())
    info=path.stat()
    if info.st_mode&0o077 or info.st_nlink!=1:raise ValueError('Unprotected folder-access receipt')
    value=json.loads(path.read_text())
    if not isinstance(value,list):raise ValueError('Invalid folder-access receipt')
    return value

def save(root,records):durable(root/'workspace-access.json',records,replace=True)

def revoke(root):
    records=read(root)
    for record in reversed(records):
        if not Path(record['path']).exists() and not Path(record['path']).is_symlink():raise ValueError('Connected folder moved or was deleted; access receipt retained for review: '+record['path'])
        fd=descriptor(record)
        try:
            if record['entry'] in entries(fd):edit(fd,'-a',record['entry'])
        finally:os.close(fd)
    save(root,[])

def restore(root,records):
    save(root,records)
    for record in records:
        fd=descriptor(record)
        try:
            if record['entry'] not in entries(fd):edit(fd,'+a',record['request'])
        finally:os.close(fd)

def grant(root,selection,users,boundary=Path('/')):
    if read(root):raise ValueError('Earlier folder grants need revocation first')
    selected=Path(selection['path']);records=[]
    if not selected.is_relative_to(boundary):raise ValueError('Folder lies outside the grant boundary')
    paths=[p for p in [*reversed(selected.parents),selected] if p.is_relative_to(boundary)]
    for path in paths:
        plain(path)
        info=path.stat()
        if path!=selected and info.st_mode&0o001:continue
        if info.st_uid!=selection['uid']:raise PermissionError('A private parent is not owned by the selected-folder owner')
        permissions='read,execute,readattr,readextattr,readsecurity' if path==selected else 'execute'
        for user in sorted(set(users)):
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',user):raise ValueError('Invalid service identity')
            record={'path':str(path),'dev':info.st_dev,'ino':info.st_ino,'uid':info.st_uid,'entry':'user:'+identifier(user)+' allow '+permissions,'request':'user:'+user+' allow '+permissions}
            fd=descriptor(record)
            try:
                before=entries(fd)
                if record['entry'] in before:continue
                records.append(record);save(root,records) # Durable intent before adding access.
                edit(fd,'+a',record['request'])
                added=list((Counter(entries(fd))-Counter(before)).elements())
                if len(added)!=1:raise ValueError('Could not identify the added folder permission')
                record['entry']=added[0];save(root,records)
            finally:os.close(fd)
