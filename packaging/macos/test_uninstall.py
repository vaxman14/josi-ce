import importlib.util
import json
import os
from pathlib import Path
import plistlib
import tempfile
import shutil
import socket
import unittest
import uuid
from unittest.mock import patch
from lifecycle import Lifecycle,ACCOUNTS,bind_probe
import uninstall as cleanup
import workspace_access
import pwd

class FixtureSystem:
    def __init__(self,root):
        self.uid=os.getuid();self.apps=root/'fixture-apps';self.home=root/'fixture-home';self.logs=root/'fixture-logs';self.daemons=root/'fixture-daemons';self.journal=root.parent/(root.name+'-cleanup')
        self.accounts={role:[os.getuid(),os.getgid()] for role in ACCOUNTS};self.receipts=set(cleanup.RECEIPTS);self.fail=False
        for path in [self.apps,self.home,self.logs,self.daemons]:path.mkdir()
        for name,identifier in cleanup.APP_IDS.items():
            path=self.apps/name/'Contents';path.mkdir(parents=True);(path/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':identifier}))
    def identity(self,role,record,missing=False):
        if role not in self.accounts and missing:return
        if self.accounts.get(role)!=record:raise ValueError('Identity collision')
    def absent_jobs(self):pass
    def finish_processes(self,records):pass
    def delete_identities(self,records):
        for role,record in records.items():
            self.identity(role,record,missing=True);self.accounts.pop(role,None)
            if self.fail:self.fail=False;raise RuntimeError('Injected account cleanup interruption')
    def forget_receipts(self):self.receipts.clear()
    def verify_erased(self,records):assert not self.accounts and not self.receipts

class UninstallTests(unittest.TestCase):
    def setUp(self):
        base=Path('/private/tmp/josi-ce-native-tests-'+str(os.getuid()));base.mkdir(mode=0o700,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(prefix='uninstall-unit-',dir=base);self.root=Path(self.temp.name)
        self.other=tempfile.TemporaryDirectory(prefix='josi-workspace-unit-',dir='/private/tmp')
        runtime=self.root/'runtime';(runtime/'app').mkdir(parents=True);(runtime/'app/package.json').write_text('{"version":"1.0.0-macos.1"}')
        self.obj=Lifecycle(runtime,self.root,isolated=True,progress=lambda *args:None)
        self.system=FixtureSystem(self.root)
        (self.root/'installation.json').write_text('{"product":"Josi CE Server","id":"fixture"}')
        (self.root/'identities.json').write_text(json.dumps(self.system.accounts))
        (self.root/'lifecycle.lock').touch(mode=0o600)
        (self.obj.data/'config').mkdir(parents=True);(self.obj.data/'config/runtime.json').write_text('{"version":"1.0.0-macos.1"}')
        (self.obj.data/'sentinel').write_text('private data')
        self.obj.stop=lambda:None
    def tearDown(self):
        if self.system.journal.exists():shutil.rmtree(self.system.journal)
        self.temp.cleanup();self.other.cleanup()
    def call(self,mode):return cleanup.uninstall(self.obj,mode,self.system,str(uuid.uuid4()))
    def test_keep_preserves_data_and_identities_and_removes_apps(self):
        self.assertTrue(self.call('keep')['verified'])
        self.assertEqual((self.obj.data/'sentinel').read_text(),'private data')
        self.assertEqual(len(self.system.accounts),6)
        self.assertFalse(any(self.system.apps.iterdir()))
        self.assertFalse(self.system.journal.exists())
    def test_complete_removal_preserves_external_workspace_through_cache_links(self):
        workspace=Path(self.other.name)/'workspace';workspace.mkdir();(workspace/'keep.txt').write_text('keep')
        cache=self.system.home/'Library/Application Support/josi-desktop';cache.mkdir(parents=True);(cache/'linked-workspace').symlink_to(workspace)
        self.assertTrue(self.call('erase')['verified'])
        self.assertFalse(self.root.exists());self.assertFalse(cache.exists())
        self.assertEqual((workspace/'keep.txt').read_text(),'keep')
        self.assertFalse(self.system.accounts);self.assertFalse(self.system.receipts)
    def test_partial_account_deletion_can_resume_from_owned_journal(self):
        self.system.fail=True
        with self.assertRaisesRegex(RuntimeError,'Injected'):self.call('erase')
        self.assertTrue(self.root.exists());self.assertTrue(self.system.journal.exists())
        self.assertTrue(self.call('erase')['verified']);self.assertFalse(self.root.exists())
    def test_retry_refuses_replaced_installation(self):
        self.system.fail=True
        with self.assertRaises(RuntimeError):self.call('erase')
        (self.root/'installation.json').write_text('{"product":"Josi CE Server","id":"other"}')
        with self.assertRaisesRegex(RuntimeError,'different Josi'):self.call('erase')
        self.assertTrue((self.obj.data/'sentinel').exists())
    def test_foreign_app_is_not_deleted(self):
        path=self.system.apps/'Josi CE.app/Contents/Info.plist';path.write_bytes(plistlib.dumps({'CFBundleIdentifier':'other.app'}))
        with self.assertRaisesRegex(ValueError,'Unrelated app'):self.call('erase')
        self.assertTrue(path.exists());self.assertTrue((self.obj.data/'sentinel').exists());self.assertEqual(len(self.system.accounts),6)
    def test_invalid_choice_cannot_mutate(self):
        with self.assertRaises(ValueError):self.call('unexpected')
        self.assertTrue((self.obj.data/'sentinel').exists());self.assertFalse(self.system.journal.exists())
    def test_real_folder_grants_are_read_only_and_reversible(self):
        parent=Path(self.other.name)/'private';parent.mkdir(mode=0o700);folder=parent/'RV';folder.mkdir(mode=0o700)
        fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY);original=workspace_access.entries(fd);os.close(fd)
        selection={'path':str(folder),'uid':os.getuid()}
        workspace_access.grant(self.root,selection,[pwd.getpwuid(os.getuid()).pw_name],parent)
        records=workspace_access.read(self.root)
        self.assertEqual(len(records),2)
        self.assertTrue(all('write' not in x['entry'] and 'delete' not in x['entry'] for x in records))
        self.assertEqual(folder.stat().st_mode&0o777,0o700)
        workspace_access.revoke(self.root)
        fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY);self.assertEqual(workspace_access.entries(fd),original);os.close(fd)
        workspace_access.restore(self.root,records);workspace_access.revoke(self.root)
    def test_replaced_folder_is_not_modified_on_revocation(self):
        folder=Path(self.other.name)/'RV';folder.mkdir()
        workspace_access.grant(self.root,{'path':str(folder),'uid':os.getuid()},[pwd.getpwuid(os.getuid()).pw_name],folder)
        folder.rename(folder.with_name('original'));folder.mkdir()
        with self.assertRaisesRegex(ValueError,'identity changed'):workspace_access.revoke(self.root)
    def test_missing_identity_cannot_target_a_reused_uid(self):
        system=cleanup.NativeSystem.__new__(cleanup.NativeSystem)
        with patch.object(cleanup.pwd,'getpwnam',side_effect=KeyError),patch.object(cleanup.grp,'getgrnam',side_effect=KeyError),patch.object(cleanup.pwd,'getpwuid',return_value=object()):
            with self.assertRaisesRegex(ValueError,'another account'):system.identity('web',[404,404],missing=True)
    def test_fresh_port_probe_rejects_live_listener_and_accepts_closed_connections(self):
        server=socket.socket();server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);server.bind(('127.0.0.1',0));server.listen(1)
        port=server.getsockname()[1]
        with self.assertRaises(OSError):bind_probe(port)
        client=socket.create_connection(('127.0.0.1',port));connection,_=server.accept();connection.close();client.recv(1);client.close();server.close()
        probe=bind_probe(port);probe.close()

if __name__=='__main__':unittest.main()
