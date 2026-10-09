"""Focused fault/ownership tests. All roots are disposable external fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('lifecycle',Path(__file__).with_name('lifecycle.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
BASE=Path('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests')

class Tests(unittest.TestCase):
    def setUp(self):
        BASE.mkdir(exist_ok=True);self.root=Path(tempfile.mkdtemp(prefix='unit-',dir=BASE))
        self.runtime=self.root/'payload';(self.runtime/'app').mkdir(parents=True)
        (self.runtime/'app/package.json').write_text(json.dumps({'version':'1.0.1-macos.1'}))
        self.obj=m.Lifecycle(self.runtime,self.root,isolated=True,progress=lambda *a:None)
    def journal(self,end='migrated'):
        folder=self.root/'transactions'/'abc';folder.parent.mkdir()
        j=m.Journal(folder,{'from':'1.0.0-macos.1','to':'1.0.1-macos.1','manifest':'0'*64})
        for phase in m.PHASES:
            j.phase(phase)
            if phase==end:break
        j.phase('recovery-required');return j
    def test_journal_chains_and_rejects_mutation(self):
        j=self.journal();self.assertEqual(m.Journal(j.folder).records,j.records)
        path=j.folder/'0003.json';r=json.loads(path.read_text());r['phase']='committed';path.write_text(json.dumps(r))
        with self.assertRaises(ValueError):m.Journal(j.folder)
    def test_journal_rejects_missing_record(self):
        j=self.journal();(j.folder/'0002.json').unlink()
        with self.assertRaises(ValueError):m.Journal(j.folder)
    def test_journal_rejects_link(self):
        j=self.journal();p=j.folder/'0002.json';p.rename(j.folder/'saved');p.symlink_to(j.folder/'saved')
        with self.assertRaises(ValueError):m.Journal(j.folder)
    def test_post_activation_recovery_is_not_lossy(self):
        j=self.journal('activated');(self.root/'lifecycle.lock').touch(mode=0o600)
        with self.assertRaisesRegex(RuntimeError,'Activation began'):self.obj.recover(j.folder)
        self.assertEqual(m.Journal(j.folder).records[-1]['phase'],'recovery-required')
    def prepare_snapshot(self):
        j=self.journal();(self.root/'lifecycle.lock').touch(mode=0o600)
        self.obj.data.mkdir();(self.obj.data/'row').write_text('new schema retained')
        snap=j.folder/'snapshot';snap.mkdir();(snap/'row').write_text('old schema')
        m.durable(j.folder/'snapshot-inventory',self.obj.snapshot_inventory(snap))
        self.obj.stop=lambda:None;self.obj.start=lambda role:None;self.obj.ready=lambda:None
        return j
    def test_verified_pre_activation_restore_retains_failed_data(self):
        j=self.prepare_snapshot();self.obj.recover(j.folder)
        self.assertEqual((self.obj.data/'row').read_text(),'old schema')
        self.assertEqual((j.folder/'failed-data/row').read_text(),'new schema retained')
        self.assertEqual(m.Journal(j.folder).records[-1]['phase'],'rolled-back')
    def test_tampered_snapshot_never_replaces_current_data(self):
        j=self.prepare_snapshot();(j.folder/'snapshot/row').write_text('tampered')
        with self.assertRaisesRegex(ValueError,'integrity'):self.obj.recover(j.folder)
        self.assertEqual((self.obj.data/'row').read_text(),'new schema retained')
    def test_snapshot_rejects_links(self):
        self.obj.data.mkdir();(self.obj.data/'link').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):self.obj.snapshot_inventory(self.obj.data)
    def test_isolated_adapter_refuses_live_root(self):
        with self.assertRaises(ValueError):m.Lifecycle(self.runtime,m.PRODUCT,isolated=True)
    def test_definitions_use_six_distinct_nonroot_identities(self):
        self.obj.data.mkdir();(self.obj.data/'config').mkdir()
        (self.obj.data/'config/runtime.json').write_text(json.dumps(dict(databasePort=15432,apiPort=18080,publicPort=8080,voicePort=18081,controlPort=18082)))
        definitions=self.obj.plists()
        self.assertEqual(len(definitions),6)
        self.assertEqual(len({p['UserName'] for p in definitions.values()}),6)
        for role,p in definitions.items():
            self.assertEqual(p['Label'],m.LABEL+role);self.assertTrue(p['RunAtLoad'])
            self.assertTrue(p['ProgramArguments'][0].startswith(str(self.root)))
            self.assertNotIn('root',p['UserName']);self.assertNotIn('PGPASSWORD',p['EnvironmentVariables'])

if __name__=='__main__':unittest.main()
