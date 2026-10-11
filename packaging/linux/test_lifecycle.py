import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

HERE=Path(__file__).parent
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
lifecycle=module('lifecycle',Path('lifecycle.py'));maintenance=module('maintenance',Path('maintenance.py'))
BASE=Path('/home/roman/JosiDrive/BuildTemp/josi-ce-native-linux-20261010/tests')

class LinuxLifecycleTests(unittest.TestCase):
    def setUp(self):
        BASE.mkdir(parents=True,exist_ok=True)
        self.root=Path(tempfile.mkdtemp(prefix='lifecycle-',dir=BASE));self.addCleanup(shutil.rmtree,self.root,True)
        self.runtime=self.root/'payload/runtime';(self.runtime/'app').mkdir(parents=True)
        package=self.runtime/'app/package.json';package.write_text('{"version":"0.1.78-linux.test"}\n')
        digest=hashlib.sha256(package.read_bytes()).hexdigest()
        (self.runtime.parent/'inventory.json').write_text(json.dumps({'architecture':'x86_64','version':'0.1.78-linux.test',
            'files':[{'path':'app/package.json','size':package.stat().st_size,'sha256':digest}]})+'\n')
        self.installation=self.root/'installation';self.obj=lifecycle.Lifecycle(self.runtime,self.installation,isolated=True,progress=lambda *_:None)
    def test_payload_verification_detects_tampering(self):
        self.assertRegex(self.obj.verify(),r'^[a-f0-9]{64}$')
        (self.runtime/'app/package.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'hash mismatch'):self.obj.verify()
    def test_journal_is_hash_chained_and_transition_bounded(self):
        journal=lifecycle.Journal(self.root/'journal',{'from':None,'to':'0.1.78-linux.test','manifest':'a'*64})
        journal.phase('prepared');journal.phase('verified')
        loaded=lifecycle.Journal(self.root/'journal');self.assertEqual([r['phase'] for r in loaded.records],['prepared','verified'])
        with self.assertRaises(ValueError):loaded.phase('healthy')
    def test_layout_separates_secrets_and_systemd_units(self):
        self.installation.mkdir(mode=0o700);self.obj.layout((15432,18080,8080,18081,18082))
        self.assertEqual((self.obj.data/'secrets/web/master-key').stat().st_mode&0o777,0o640)
        unit=self.obj.unit('web').decode();self.assertIn('User=josi-ce-web',unit);self.assertIn('NoNewPrivileges=yes',unit)
        self.assertNotIn((self.obj.data/'secrets/web/master-key').read_text(),unit)
        self.assertEqual((self.obj.data/'state').stat().st_mode&0o7777,0o2770)
        proxy = self.obj.caddyfile({'publicPort':8080,'apiPort':18080}).decode()
        self.assertIn('\n:8080 {\n', proxy)
        self.assertNotIn('localhost:8080', proxy)
    def test_shared_groups_do_not_collide_with_service_accounts(self):
        self.assertTrue(set(lifecycle.SHARED_GROUPS).isdisjoint(lifecycle.ACCOUNTS.values()))
        self.assertIn('SupplementaryGroups=josi-ce-voice-shared',self.obj.unit('voice').decode())
    def test_diagnostics_redact_credential_shapes(self):
        value=lifecycle.diagnostic(ValueError('token=abc postgresql://josi:pw@host/db '+('a'*64)))['cause']
        self.assertNotIn('abc',value);self.assertNotIn('josi:pw',value);self.assertNotIn('a'*64,value)
    def test_listener_failure_names_the_service(self):
        self.installation.mkdir(mode=0o700);self.obj.layout((15432,18080,8080,18081,18082))
        with self.assertRaisesRegex(RuntimeError,'database service exited'):
            self.obj.listeners(json.loads((self.obj.data/'config/runtime.json').read_text()))
    def test_workspace_selection_refuses_home_and_links(self):
        with self.assertRaises(ValueError):maintenance.selected_folder(str(Path.home()),os.getuid())
        folder=self.root/'owned';folder.mkdir();link=self.root/'linked';link.symlink_to(folder)
        with self.assertRaises(ValueError):maintenance.selected_folder(str(link),os.getuid())
    def test_product_root_restores_service_traversal_after_validation(self):
        folder=self.root/'protected';folder.mkdir(mode=0o700);os.chmod(folder,0o700)
        lifecycle.protect_product_root(folder,False)
        self.assertEqual(folder.stat().st_mode&0o777,0o711)
    def test_failed_fresh_install_is_retained_before_clean_retry(self):
        self.installation.mkdir(mode=0o700);self.obj.data.mkdir()
        (self.obj.data/'partial').write_text('preserve me')
        transactions=self.installation/'transactions';transactions.mkdir()
        journal=lifecycle.Journal(transactions/'fresh',{'from':None,'to':'0.1.78-linux.test','manifest':'a'*64})
        for phase in ('prepared','verified','quiescing','quiesced','snapshot','provisioned','recovery-required'):journal.phase(phase)
        self.obj.settle_activated_recovery(os.getuid())
        self.assertFalse(self.obj.data.exists())
        self.assertEqual((transactions/'fresh'/'failed-data'/'partial').read_text(),'preserve me')
        self.assertEqual(lifecycle.Journal(transactions/'fresh').records[-1]['phase'],'rolled-back')

if __name__=='__main__':unittest.main()
