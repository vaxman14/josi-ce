"""Focused fault/ownership tests. All roots are disposable external fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('lifecycle',Path(__file__).with_name('lifecycle.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
BASE=Path('/Users/roman/Documents/Josi Mac Native/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests')

class Tests(unittest.TestCase):
    def test_stopping_already_unloaded_services_is_idempotent(self):
        from unittest.mock import patch
        import subprocess
        self.obj.isolated=False
        def query(args, **kwargs):
            self.assertEqual(args[:2],['/bin/launchctl','print'])
            label=args[2].split('/',1)[1]
            return subprocess.CompletedProcess(args,113,'','Bad request.\nCould not find service "'+label+'" in domain for system\n')
        with patch.object(Path,'exists',lambda p: p.parent==Path('/Library/LaunchDaemons')), patch.object(m.subprocess,'run',side_effect=query) as run:
            self.obj.stop()
        self.assertEqual(run.call_count,len(m.ROLES))
    def test_service_inspection_errors_are_not_treated_as_stopped(self):
        from unittest.mock import patch
        import subprocess
        self.obj.isolated=False
        with patch.object(Path,'exists',lambda p: p.parent==Path('/Library/LaunchDaemons')), patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','Permission denied')):
            with self.assertRaisesRegex(RuntimeError,'Cannot inspect service'):self.obj.stop()
    def test_missing_service_requires_exact_label_domain_and_exit_code(self):
        from unittest.mock import patch
        import subprocess
        self.obj.isolated=False
        label=m.LABEL+m.STOP[0]
        for code,message in [
            (1,'Could not find service "'+label+'" in domain for system'),
            (113,'Could not find service "'+label+'-other" in domain for system'),
            (113,'Could not find service "'+label+'" in domain for gui/501'),
            (113,'Permission denied'),
        ]:
            with self.subTest(code=code,message=message), patch.object(Path,'exists',lambda p: p.parent==Path('/Library/LaunchDaemons')), patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],code,'',message)) as run:
                with self.assertRaisesRegex(RuntimeError,'Cannot inspect service'):self.obj.stop()
                self.assertEqual(run.call_count,1)
    def test_subprocess_diagnostics_preserve_cause_without_argv_secrets(self):
        import subprocess
        uri=b'postgres://'+b'user:unsafe'+b'@host/db'
        error=subprocess.CalledProcessError(9,['/private/runtime/initdb','--password=unsafe'],output=b'failed component',stderr=b'permission denied password=unsafe token=unsafe '+uri)
        result=m.diagnostic(error)
        self.assertEqual(result['component'],'initdb');self.assertEqual(result['exitCode'],9)
        self.assertIn('permission denied',result['stderr']);self.assertNotIn('unsafe',json.dumps(result))
    def test_timeout_and_hash_failure_diagnostics(self):
        import subprocess
        result=m.diagnostic(subprocess.TimeoutExpired(['/runtime/pg_ctl'],60,stderr=b'waiting for startup'))
        self.assertIn('timed out',result['cause']);self.assertEqual(result['stderr'],'waiting for startup')
        self.assertIn('app/file.js',m.diagnostic(ValueError('Payload hash mismatch: app/file.js'))['cause'])
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
    def test_automatic_pre_activation_restore_does_not_start_old_writers(self):
        j=self.prepare_snapshot();self.obj.start=lambda role:self.fail('Old writers must stay stopped during automatic recovery')
        self.obj.automatic_recovery(self.root/'transactions')
        self.assertEqual((self.obj.data/'row').read_text(),'old schema')
        self.assertEqual((j.folder/'failed-data/row').read_text(),'new schema retained')
        self.assertEqual(m.Journal(j.folder).records[-1]['phase'],'rolled-back')
    def test_automatic_post_activation_keeps_data_and_resolves_previous_failure(self):
        j=self.journal('activated')
        (self.obj.data/'config').mkdir(parents=True)
        (self.obj.data/'config/runtime.json').write_text(json.dumps({'version':j.identity['to']}))
        (self.obj.data/'row').write_text('user writes after activation')
        (self.root/'versions'/j.identity['to']).mkdir(parents=True)
        self.obj.stop=lambda:None
        self.obj.automatic_recovery(self.root/'transactions')
        self.assertEqual((self.obj.data/'row').read_text(),'user writes after activation')
        self.assertEqual(m.Journal(j.folder).records[-1]['phase'],'preserved')
        self.obj.automatic_recovery(self.root/'transactions')
        self.assertEqual((self.obj.data/'row').read_text(),'user writes after activation')
    def test_automatic_repair_of_activated_fresh_install(self):
        j=self.journal('activated')
        for path in j.folder.glob('*.json'):path.unlink()
        j=m.Journal(j.folder,{'from':None,'to':'1.0.0-macos.1','manifest':'0'*64})
        for phase in m.PHASES[:11]:j.phase(phase)
        j.phase('recovery-required')
        (self.obj.data/'config').mkdir(parents=True)
        (self.obj.data/'config/runtime.json').write_text(json.dumps({'version':j.identity['to']}))
        (self.obj.data/'row').write_text('retained fresh data')
        (self.root/'versions'/j.identity['to']).mkdir(parents=True)
        self.obj.stop=lambda:None
        self.obj.automatic_recovery(self.root/'transactions')
        self.assertEqual((self.obj.data/'row').read_text(),'retained fresh data')
        self.assertEqual(m.Journal(j.folder).records[-1]['phase'],'preserved')
    def test_changed_activation_identity_is_never_overwritten(self):
        j=self.journal('activated')
        (self.obj.data/'config').mkdir(parents=True)
        path=self.obj.data/'config/runtime.json';path.write_text('{"version":"9.0.0-macos.1"}')
        with self.assertRaisesRegex(ValueError,'identity changed'):self.obj.automatic_recovery(self.root/'transactions')
        self.assertEqual(json.loads(path.read_text())['version'],'9.0.0-macos.1')
        self.assertEqual(m.Journal(j.folder).records[-1]['phase'],'recovery-required')
    def test_fresh_pre_activation_retry_retains_incomplete_data(self):
        folder=self.root/'transactions'/'fresh';folder.parent.mkdir()
        j=m.Journal(folder,{'from':None,'to':self.obj.version,'manifest':'0'*64})
        for phase in m.PHASES[:7]:j.phase(phase)
        # An abrupt termination has no explicit failure record.
        self.obj.data.mkdir();(self.obj.data/'row').write_text('partial provisioning')
        self.obj.stop=lambda:None
        self.obj.automatic_recovery(folder.parent)
        self.assertFalse(self.obj.data.exists())
        self.assertEqual((folder/'incomplete-data/row').read_text(),'partial provisioning')
        self.assertEqual(m.Journal(folder).records[-1]['phase'],'preserved')
    def test_interrupted_restore_continues_from_retained_failed_data(self):
        j=self.prepare_snapshot();j.phase('rolling-back')
        os.rename(self.obj.data,j.folder/'failed-data')
        self.obj.automatic_recovery(self.root/'transactions')
        self.assertEqual((self.obj.data/'row').read_text(),'old schema')
        self.assertEqual((j.folder/'failed-data/row').read_text(),'new schema retained')
    def test_interrupted_restore_with_changed_data_refuses_to_discard_it(self):
        j=self.prepare_snapshot();j.phase('rolling-back')
        (j.folder/'failed-data').mkdir();(j.folder/'failed-data/row').write_text('failed retained')
        with self.assertRaisesRegex(ValueError,'changed data'):self.obj.automatic_recovery(self.root/'transactions')
        self.assertEqual((self.obj.data/'row').read_text(),'new schema retained')
    def test_empty_owned_transaction_directory_is_cleared(self):
        folder=self.root/'transactions'/'empty';folder.mkdir(parents=True,mode=0o700)
        self.obj.automatic_recovery(folder.parent);self.assertFalse(folder.exists())
    def test_multiple_pending_transactions_are_not_guessed(self):
        j=self.journal()
        other=m.Journal(j.folder.parent/'other',{'from':None,'to':self.obj.version,'manifest':'0'*64});other.phase('prepared')
        with self.assertRaisesRegex(RuntimeError,'Multiple interrupted'):self.obj.automatic_recovery(j.folder.parent)
        self.assertEqual(m.Journal(j.folder).records[-1]['phase'],'recovery-required')
    def test_snapshot_rejects_links(self):
        self.obj.data.mkdir();(self.obj.data/'link').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):self.obj.snapshot_inventory(self.obj.data)
    def test_isolated_adapter_refuses_live_root(self):
        with self.assertRaises(ValueError):m.Lifecycle(self.runtime,m.PRODUCT,isolated=True)
    def test_isolated_adapter_refuses_arbitrary_temporary_root(self):
        with self.assertRaisesRegex(ValueError,'Invalid isolated root'):m.Lifecycle(self.runtime,Path('/private/tmp/arbitrary-josi-test'),isolated=True)
    def test_local_isolated_adapter_requires_private_base(self):
        from unittest.mock import patch
        base=self.root/'local-tests';base.mkdir(mode=0o700)
        with patch.object(m,'LOCAL_TESTS',base):
            obj=m.Lifecycle(self.runtime,base/'acceptance-test',isolated=True)
            self.assertEqual(obj.root,base/'acceptance-test')
            base.chmod(0o755)
            with self.assertRaisesRegex(ValueError,'Unprotected isolated test base'):m.Lifecycle(self.runtime,base/'acceptance-test',isolated=True)
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
