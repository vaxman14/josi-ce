import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import errno
import subprocess
from unittest.mock import patch

HERE=Path(__file__).parent
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
driver=module('pkg_driver','pkg-driver.py');maintenance=module('maintenance','maintenance.py')
BASE=Path('/Users/roman/Documents/Josi Mac Native/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests')

class PackageFlow(unittest.TestCase):
    def test_verification_precedes_install_and_failure_prevents_mutation(self):
        class Fixture:
            def verify(self):raise ValueError('Payload hash mismatch: file.js')
            def install(self,**kwargs):raise AssertionError('Install must not start')
        events=[]
        with self.assertRaisesRegex(ValueError,'file.js'):driver.run_install(Fixture(),501,events.append)
        self.assertEqual(events,[{'phase':'verifying'}])
    def test_success_requires_install_commit(self):
        class Fixture:
            def verify(self):pass
            def install(self,**kwargs):
                assert kwargs['repair'] is True;return Path('committed-fixture')
        events=[];driver.run_install(Fixture(),501,events.append)
        self.assertEqual(events[-1]['result'],'success')
    def test_failed_install_recovery_is_only_pre_activation(self):
        for activated in [False,True]:
            class Fixture:
                class Journal:
                    identity={'from':'1.0.0-macos.1'};folder=Path('fixture')
                    records=[{'phase':'activating' if activated else 'migrated'}]
                journal=Journal();recovered=False
                def verify(self):pass
                def install(self,**kwargs):raise RuntimeError('fixture failure')
                def recover(self,folder):self.recovered=True
            obj=Fixture();events=[]
            with self.assertRaises(RuntimeError):driver.run_install(obj,501,events.append)
            self.assertEqual(obj.recovered,not activated)
    def test_event_is_readable_before_writer_closes(self):
        BASE.mkdir(exist_ok=True)
        path=Path(tempfile.mkdtemp(dir=BASE))/'progress.jsonl'
        with path.open('x') as stream:
            driver.write_event(stream,{'phase':'verifying'})
            self.assertEqual(json.loads(path.read_text()),{'phase':'verifying'})
    def fixture(self):
        root=Path(tempfile.mkdtemp(prefix='package-unit-',dir=BASE))
        runtime=root/'runtime';(runtime/'app').mkdir(parents=True)
        (runtime/'app/package.json').write_text('{"version":"1.0.0-macos.1"}')
        obj=maintenance.Lifecycle(runtime,root,isolated=True,progress=lambda *a:None)
        (root/'transactions').mkdir();(root/'lifecycle.lock').touch(mode=0o600)
        (obj.data/'config').mkdir(parents=True)
        (obj.data/'config/runtime.json').write_text('{"version":"1.0.0-macos.1"}')
        (obj.data/'sentinel').write_text('preserve')
        obj.stop=lambda:None;obj.start=lambda role:None;obj.ready=lambda:None
        obj.run=lambda *args,**kwargs:None
        return obj
    def test_workspace_mapping_persists_identity_and_decline_removes_it(self):
        obj=self.fixture();folder=obj.root/'chosen';folder.mkdir()
        result=maintenance.workspace(obj,str(folder),os.getuid())
        self.assertEqual(result['logicalPath'],'/workspace')
        saved=json.loads((obj.data/'config/runtime.json').read_text())['workspace']
        self.assertEqual(saved['path'],str(folder));self.assertEqual(saved['ino'],folder.stat().st_ino)
        maintenance.workspace(obj,'',os.getuid())
        self.assertNotIn('workspace',json.loads((obj.data/'config/runtime.json').read_text()))
        self.assertEqual((obj.data/'sentinel').read_text(),'preserve')
    def test_folder_links_and_broad_home_are_refused(self):
        obj=self.fixture();link=obj.root/'chosen';link.symlink_to(obj.root)
        with self.assertRaises(ValueError):maintenance.selected_folder(str(link),os.getuid())
        import pwd
        with self.assertRaises(ValueError):maintenance.selected_folder(pwd.getpwuid(os.getuid()).pw_dir,os.getuid())
    def test_selected_folder_traverses_a_parent_without_listing_permission(self):
        obj=self.fixture();parent=obj.root/'search-only';parent.mkdir();folder=parent/'RV';folder.mkdir()
        parent.chmod(0o100)
        try:
            with self.assertRaises(PermissionError):os.close(os.open(parent,os.O_RDONLY|os.O_DIRECTORY))
            selection=maintenance.selected_folder(str(folder),os.getuid())
            self.assertEqual(selection['ino'],folder.stat().st_ino)
            # ACL operations on that same parent must not require a listing
            # descriptor either; no unrelated child names are read.
            fd=maintenance.workspace_access.descriptor({'path':str(parent),'dev':parent.stat().st_dev,'ino':parent.stat().st_ino,'uid':os.getuid()})
            try:self.assertIsInstance(maintenance.workspace_access.entries(fd),list)
            finally:os.close(fd)
        finally:parent.chmod(0o700)
    def test_workspace_privacy_failure_is_distinct_from_service_and_ownership_errors(self):
        self.assertEqual(maintenance.failure(PermissionError(errno.EPERM,'Documents'),'workspace')['recovery'],'full-disk-access')
        self.assertNotIn('recovery',maintenance.failure(PermissionError('Choose a folder you own'),'workspace'))
        self.assertNotIn('recovery',maintenance.failure(PermissionError(errno.EACCES,'File permission'),'workspace'))
        self.assertNotIn('recovery',maintenance.failure(PermissionError(errno.EPERM,'Other operation'),'recover-latest'))
        service=maintenance.WorkspaceServiceAccessError(errno.EACCES,'Service cannot read')
        self.assertEqual(maintenance.failure(service,'workspace')['recovery'],'workspace-service-access')
    def test_service_probe_preserves_errno_and_rolls_back_the_folder_connection(self):
        obj=self.fixture();folder=obj.root/'chosen';folder.mkdir()
        obj.run=lambda *a,**kw:(_ for _ in ()).throw(subprocess.CalledProcessError(77,['python3.11'],stderr=b'{"workspaceAccessErrno":13}'))
        with self.assertRaises(maintenance.WorkspaceServiceAccessError) as caught:maintenance.workspace(obj,str(folder),os.getuid())
        self.assertEqual(caught.exception.errno,errno.EACCES)
        self.assertNotIn('workspace',json.loads((obj.data/'config/runtime.json').read_text()))
        self.assertEqual(maintenance.workspace_access.read(obj.root),[])
        self.assertEqual(json.loads((obj.root/'maintenance.json').read_text())['state'],'complete')
        self.assertEqual((obj.data/'sentinel').read_text(),'preserve')
    def test_unrelated_probe_failures_are_not_mislabeled_as_privacy_denials(self):
        obj=self.fixture();selection={'path':str(obj.root),'dev':1,'ino':2}
        for failure in [subprocess.CalledProcessError(1,['python3.11'],stderr=b'other failure'),subprocess.CalledProcessError(77,['python3.11'],stderr=b'{"workspaceAccessErrno":2}')]:
            with self.subTest(failure=failure),patch.object(obj,'run',side_effect=failure):
                with self.assertRaises(subprocess.CalledProcessError):maintenance.probe_workspace(obj,selection)
    def test_workspace_requires_both_web_and_worker_read_access_before_commit(self):
        for failing in (None,'worker'):
            with self.subTest(failing=failing):
                obj=self.fixture();folder=obj.root/'chosen';folder.mkdir();calls=[]
                def run(args,role):
                    calls.append(role)
                    if role==failing:raise subprocess.CalledProcessError(77,['python3.11'],stderr=b'{"workspaceAccessErrno":13}')
                obj.run=run
                if failing:
                    with self.assertRaisesRegex(maintenance.WorkspaceServiceAccessError,'worker'):maintenance.workspace(obj,str(folder),os.getuid())
                    self.assertNotIn('workspace',json.loads((obj.data/'config/runtime.json').read_text()))
                    self.assertEqual(maintenance.workspace_access.read(obj.root),[])
                else:
                    maintenance.workspace(obj,str(folder),os.getuid())
                    self.assertIn('workspace',json.loads((obj.data/'config/runtime.json').read_text()))
                self.assertEqual(calls,['web','worker'])
    def test_uninstall_preserves_data_and_records_disabled_state(self):
        obj=self.fixture();maintenance.uninstall(obj)
        self.assertEqual((obj.data/'sentinel').read_text(),'preserve')
        self.assertFalse(json.loads((obj.root/'status.json').read_text())['installed'])
    def test_pending_transaction_refuses_settings_and_uninstall(self):
        obj=self.fixture()
        from lifecycle import Journal
        j=Journal(obj.root/'transactions'/'pending',{'from':None,'to':'1.0.0-macos.1','manifest':'0'*64});j.phase('prepared')
        with self.assertRaises(RuntimeError):maintenance.workspace(obj,'',os.getuid())
        with self.assertRaises(RuntimeError):maintenance.uninstall(obj)
    def test_settings_failure_restores_configuration_without_restoring_data(self):
        obj=self.fixture();folder=obj.root/'chosen';folder.mkdir();calls=[]
        def ready():
            calls.append(1)
            if len(calls)==1:raise RuntimeError('new settings unavailable')
        obj.ready=ready
        with self.assertRaises(RuntimeError):maintenance.workspace(obj,str(folder),os.getuid())
        self.assertNotIn('workspace',json.loads((obj.data/'config/runtime.json').read_text()))
        self.assertEqual(json.loads((obj.root/'maintenance.json').read_text())['state'],'complete')
        self.assertEqual((obj.data/'sentinel').read_text(),'preserve')
    def test_literal_signature_requirement_and_separate_component_scripts(self):
        self.assertTrue(driver.REQUIREMENT.startswith('=anchor'))
        for name in ['preinstall','postinstall']:
            self.assertIn("'=anchor",(HERE/'pkg'/name).read_text())
        self.assertIn('Deselect Desktop Client',(HERE/'pkg/client-preinstall').read_text())

if __name__=='__main__':unittest.main()
