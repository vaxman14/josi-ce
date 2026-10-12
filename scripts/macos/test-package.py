"""Disposable packaged-runtime integration; never operates on launchd/live data."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import time
import sys

BASE=Path('/Users/roman/Documents/Josi Mac Native/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port')
RUNTIME=BASE/'stage/runtime'
if len(sys.argv)==3 and sys.argv[1]=='--runtime':
    RUNTIME=Path(sys.argv[2])
    if not str(RUNTIME).startswith('/Users/roman/Documents/Josi Mac Native/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009/pkg-candidate-') or RUNTIME.name!='runtime':raise ValueError('Candidate runtime required')
elif sys.argv[1:]:raise ValueError('Unsupported test arguments')
spec=importlib.util.spec_from_file_location('lifecycle',RUNTIME/'app/native/lifecycle.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
test_base=mod.LOCAL_TESTS
mod.plain(test_base,os.getuid())
test_base.mkdir(mode=0o700,exist_ok=True)
if test_base.stat().st_uid!=os.getuid() or test_base.stat().st_mode&0o777!=0o700:raise ValueError('Unprotected isolated test base')
# Darwin inherits a new directory's group from its parent; /private/tmp is
# wheel-owned. Disposable service secrets must use this user's primary group.
os.chown(test_base,-1,os.getgid())
root=test_base/('acceptance-'+str(time.time_ns()))
ports=[]
while len(ports)<5:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        if port not in ports:ports.append(port)
instance=mod.Lifecycle(RUNTIME,root,isolated=True)
try:
    transaction=instance.install(tuple(ports))
    print(json.dumps({'isolatedInstall':'passed','root':str(root),'ports':ports,'transaction':str(transaction)}),flush=True)
    env={'PATH':'/usr/bin:/bin','TMPDIR':str(root/'data/temp/voice'),'JOSI_VOICE_MODELS_DIR':str(instance.installed/'voice-models'),'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1'}
    subprocess.run([str(instance.installed/'python/bin/python3.11'),'-B',str(instance.installed/'app/services/voice-box/model_smoke.py')],env=env,check=True,timeout=180)
    print('PASS isolated offline CPU speech roundtrip',flush=True)
    repo=Path(__file__).resolve().parents[2]
    subscription_proof=repo/'scripts/macos/test-subscription-cli.mjs'
    subprocess.run([str(instance.installed/'node/bin/node'),str(subscription_proof),str(root),'seed'],env=env,check=True,timeout=60)
    subprocess.run([str(instance.installed/'node/bin/node'),str(repo/'scripts/macos/test-engines.mjs'),str(root)],env=env,check=True,timeout=90)
    subprocess.run([str(BASE/'handoff-tests'),str(root)],env=env,check=True,timeout=30)
    subprocess.run([str(BASE.parent.parent/'node-v24.15.0-darwin-arm64/bin/node'),str(repo/'scripts/macos/test-browser.mjs'),str(root)],cwd=repo,env=env,check=True,timeout=90)
    proof=repo/'scripts/macos/test-database.mjs'
    subprocess.run([str(instance.installed/'node/bin/node'),str(proof),str(root),'seed'],env=env,check=True,timeout=30)
    if (RUNTIME/'app/native/maintenance.py').exists():
        mspec=importlib.util.spec_from_file_location('maintenance',RUNTIME/'app/native/maintenance.py');maintenance=importlib.util.module_from_spec(mspec);mspec.loader.exec_module(maintenance)
        workspace_proof=repo/'scripts/macos/test-native-workspace.mjs'
        subprocess.run([str(instance.installed/'node/bin/node'),str(workspace_proof),str(root),'seed'],env=env,check=True,timeout=30)
        # Exercise the production chooser policy on a disposable user-owned
        # documents folder; system temp directories are intentionally refused.
        chosen=BASE/'tests'/('selected-folder-'+str(time.time_ns()));chosen.mkdir(mode=0o700);(chosen/'chosen.txt').write_text('selected native folder')
        maintenance.workspace(instance,str(chosen),__import__('os').getuid())
        subprocess.run([str(instance.installed/'node/bin/node'),str(workspace_proof),str(root),'verify'],env=env,check=True,timeout=30)
        maintenance.workspace(instance,'',__import__('os').getuid())
        subprocess.run([str(instance.installed/'node/bin/node'),str(workspace_proof),str(root),'declined'],env=env,check=True,timeout=30)
    instance.stop()
    # Reproduce the physical snapshot failure: an inherited-only file ACL
    # must survive both a cold backup and the automatic restore below.
    import pwd
    acl_user=pwd.getpwuid(os.getuid()).pw_name
    instance.run(['/bin/chmod','+a','user:'+acl_user+' allow read,write,append,execute,delete,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit',instance.data/'state'])
    permission_marker=instance.data/'state/snapshot-inherited-permission'
    permission_marker.write_text('retained inherited-permission sentinel')
    inherited_acl=instance.snapshot_inventory(instance.data)['state/snapshot-inherited-permission']['acl']
    assert 'inherited' in inherited_acl
    # The candidate differs only in release metadata; real SQL/data, cold copy,
    # version activation and child processes exercise the production algorithm.
    candidate=root/'upgrade-payload';shutil.copytree(RUNTIME,candidate/'runtime',symlinks=True)
    meta=candidate/'runtime/app/package.json';value=json.loads(meta.read_text());value['version']=value['version']+'.upgrade';meta.write_text(json.dumps(value))
    invspec=importlib.util.spec_from_file_location('inventory',repo/'scripts/macos/inventory.py');inv=importlib.util.module_from_spec(invspec);invspec.loader.exec_module(inv)
    inv.inventory(candidate/'runtime',False)
    instance=mod.Lifecycle(candidate/'runtime',root,isolated=True)
    try:instance.install(tuple(ports),fail_at='migrated')
    except RuntimeError as error:
        if str(error)!='Injected isolated failure':raise
    else:raise AssertionError('Migration fault did not fire')
    interrupted=instance.journal.folder
    instance.stop();instance=mod.Lifecycle(candidate/'runtime',root,isolated=True)
    instance.install(tuple(ports))
    assert mod.Journal(interrupted).records[-1]['phase']=='rolled-back'
    assert (interrupted/'failed-data/database/PG_VERSION').exists()
    assert (instance.data/'state/snapshot-inherited-permission').read_text()=='retained inherited-permission sentinel'
    assert instance.snapshot_inventory(instance.data)['state/snapshot-inherited-permission']['acl']==inherited_acl
    print('PASS exact inherited ACL retention across cold backup and automatic snapshot restoration',flush=True)
    subprocess.run([str(instance.installed/'node/bin/node'),str(proof),str(root),'verify'],env=env,check=True,timeout=30)
    print('PASS automatic migration failure recovery, retained failed data, and continuing upgrade activation',flush=True)
    subprocess.run([str(instance.installed/'node/bin/node'),str(subscription_proof),str(root),'retained'],env=env,check=True,timeout=60)
    if (RUNTIME/'app/native/maintenance.py').exists():
        maintenance.uninstall(instance)
        assert not instance.children and (instance.data/'database/PG_VERSION').exists()
        instance.install(tuple(ports),repair=True)
        subprocess.run([str(instance.installed/'node/bin/node'),str(proof),str(root),'verify'],env=env,check=True,timeout=30)
        print('PASS isolated retained-data uninstall and same-version repair reinstall',flush=True)
    instance.stop()
    # Reproduce the actual blocked Mac: a fresh install activated, then failed
    # before health/commit. A subsequent package must preserve that database
    # and finish a repair without asking the user to erase its journal.
    failed_root=test_base/('activated-fresh-'+str(time.time_ns()))
    fresh_ports=[]
    while len(fresh_ports)<5:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            if port not in fresh_ports:fresh_ports.append(port)
    instance=mod.Lifecycle(RUNTIME,failed_root,isolated=True)
    try:instance.install(tuple(fresh_ports),fail_at='activated')
    except RuntimeError as error:
        if str(error)!='Injected isolated failure':raise
    else:raise AssertionError('Activation fault did not fire')
    interrupted=instance.journal.folder
    # Save a database sentinel after activation, proving that even later writes
    # survive automatic recovery. Start the temporary DB only for this proof.
    instance.stop()
    instance.run([instance.installed/'postgresql/bin/pg_ctl','-D',instance.data/'database','-l',instance.data/'logs/database/setup.log','-w','-t','60','start'],'database')
    subprocess.run([str(instance.installed/'node/bin/node'),str(proof),str(failed_root),'seed'],env=env,check=True,timeout=30)
    instance.stop();instance=mod.Lifecycle(RUNTIME,failed_root,isolated=True)
    instance.install(tuple(fresh_ports),repair=True)
    assert mod.Journal(interrupted).records[-1]['phase']=='preserved'
    subprocess.run([str(instance.installed/'node/bin/node'),str(proof),str(failed_root),'verify'],env=env,check=True,timeout=30)
    print('PASS automatic repair of an activated fresh-install failure, retaining post-activation database writes',flush=True)
except Exception as error:
    if isinstance(error,subprocess.CalledProcessError):
        private=root/'private-failure.txt'
        with private.open('xb') as stream:
            os.chmod(private,0o600);stream.write(error.stdout or b'');stream.write(error.stderr or b'')
        print('Private subprocess diagnostics retained in '+str(private),flush=True)
    raise
finally:
    instance.stop()
