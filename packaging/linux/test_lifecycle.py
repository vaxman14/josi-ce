import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
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
    def test_same_version_installed_payload_mutation_is_rejected(self):
        installed=self.root/'installed';shutil.copytree(self.runtime,installed)
        (installed/'app/package.json').write_text('{"version":"0.1.78-linux.test","changed":true}\n')
        with self.assertRaisesRegex(ValueError,'hash mismatch'):self.obj.verify(installed)
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
    def test_plain_release_version_is_accepted(self):
        (self.runtime/'app/package.json').write_text('{"version":"1.0.0"}\n')
        self.assertEqual(lifecycle.Lifecycle(self.runtime,self.installation,isolated=True,progress=lambda *_:None).version,'1.0.0')
        (self.runtime/'app/package.json').write_text('{"version":"1.0"}\n')
        with self.assertRaisesRegex(ValueError,'version'):lifecycle.Lifecycle(self.runtime,self.installation,isolated=True,progress=lambda *_:None)
    def test_key_folder_is_private_on_install_and_restored_on_upgrade(self):
        self.installation.mkdir(mode=0o700);self.obj.layout((15432,18080,8080,18081,18082))
        keys=self.obj.data/'keys'
        self.assertEqual(keys.stat().st_mode&0o777,0o700)
        keys.rmdir();self.obj.repair_layout_permissions()
        self.assertEqual(keys.stat().st_mode&0o777,0o700)
        os.chmod(keys,0o755);self.obj.repair_layout_permissions()
        self.assertEqual(keys.stat().st_mode&0o777,0o700)
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
    def test_program_root_restores_service_traversal_after_restrictive_umask(self):
        folder=self.root/'versions';folder.mkdir(mode=0o700);os.chmod(folder,0o700)
        lifecycle.protect_program_root(folder,False)
        self.assertEqual(folder.stat().st_mode&0o777,0o755)
    def test_durable_applies_requested_mode_despite_restrictive_umask(self):
        folder=self.root/'durable';folder.mkdir()
        previous=os.umask(0o077)
        try:lifecycle.durable(folder/'shared-secret',b'secret',mode=0o640)
        finally:os.umask(previous)
        self.assertEqual((folder/'shared-secret').stat().st_mode&0o777,0o640)
    def test_browser_handoff_parent_is_traversable_and_user_folder_is_private(self):
        previous=os.umask(0o077)
        try:handoff=lifecycle.prepare_browser_handoff(self.root,os.getuid())
        finally:os.umask(previous)
        self.assertEqual((self.root/'handoff').stat().st_mode&0o777,0o711)
        self.assertEqual(handoff.stat().st_mode&0o777,0o700)
        self.assertEqual(handoff.stat().st_uid,os.getuid())
    def test_fresh_install_selects_an_open_public_port_when_preferred_is_taken(self):
        occupied=socket.socket();occupied.bind(('0.0.0.0',0));self.addCleanup(occupied.close)
        public=occupied.getsockname()[1]
        probes=[]
        try:
            for _ in range(4):
                probe=socket.socket();probe.bind(('127.0.0.1',0));probes.append(probe)
            preferred=(probes[0].getsockname()[1],probes[1].getsockname()[1],public,
                probes[2].getsockname()[1],probes[3].getsockname()[1])
        finally:
            for probe in probes:probe.close()
        selected=lifecycle.available_ports(preferred)
        self.assertNotEqual(selected[2],public)
        self.assertEqual(len(set(selected)),5)
    def test_port_selection_rejects_invalid_or_duplicate_ports(self):
        for ports in ((8080,)*5,(80,18080,8080,18081,18082),(True,18080,8080,18081,18082)):
            with self.assertRaisesRegex(ValueError,'Invalid ports'):lifecycle.available_ports(ports)
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

    # ---- the installer's answers
    def test_settings_derive_the_browser_address_for_each_mode(self):
        lan=lifecycle.normalize_settings({'addressMode':'lan','lanAddress':'192.168.50.20','port':8090})
        self.assertEqual(lan['appUrl'],'http://192.168.50.20:8090')
        domain=lifecycle.normalize_settings({'addressMode':'domain','domain':'Josi.Example.COM.','email':'me@example.com','port':8080})
        self.assertEqual((domain['appUrl'],domain['domain'],domain['email']),('https://josi.example.com','josi.example.com','me@example.com'))
        proxy=lifecycle.normalize_settings({'addressMode':'proxy','publicUrl':'https://josi.example.com:443/','email':'me@example.com'})
        self.assertEqual((proxy['appUrl'],proxy['email']),('https://josi.example.com',None))
        self.assertEqual(lifecycle.normalize_settings({'addressMode':'proxy','publicUrl':'https://josi.example.com:8443'})['appUrl'],'https://josi.example.com:8443')
        self.assertEqual(lifecycle.normalize_settings({})['appUrl'],'http://127.0.0.1:8080')
        self.assertEqual(set(lan),lifecycle.SETTINGS_KEYS)
    def test_open_setup_is_off_unless_asked_and_only_for_a_lan_address(self):
        self.assertNotIn('openSetup',lifecycle.normalize_settings({'addressMode':'lan','lanAddress':'192.168.50.20'}))
        self.assertIs(lifecycle.normalize_settings({'addressMode':'lan','lanAddress':'192.168.50.20','openSetup':True})['openSetup'],True)
        for mode,extra in (('proxy',{'publicUrl':'https://josi.example.com'}),('domain',{'domain':'josi.example.com'})):
            self.assertNotIn('openSetup',lifecycle.normalize_settings({'addressMode':mode,'openSetup':True,**extra}))
        with self.assertRaises(ValueError):lifecycle.normalize_settings({'addressMode':'lan','openSetup':'yes'})
        path=self.root/'install-open.json'
        saved=lifecycle.normalize_settings({'addressMode':'lan','lanAddress':'192.168.50.20','openSetup':True})
        path.write_text(json.dumps(saved));os.chmod(path,0o644)
        self.assertEqual(lifecycle.load_settings(path),saved)
    def test_settings_refuse_unsafe_values(self):
        for value in ({'addressMode':'cloud'},{'port':80},{'port':True},{'port':'8080'},
                      {'addressMode':'domain','domain':'10.0.0.5'},{'addressMode':'domain','domain':'josi.example.com\n admin on'},
                      {'addressMode':'domain','domain':'josi.example.com','email':'not an email'},
                      {'addressMode':'proxy','publicUrl':'http://josi.example.com'},{'addressMode':'proxy','publicUrl':'https://josi.example.com/app'},
                      {'addressMode':'proxy','publicUrl':'https://user:pw@josi.example.com'},
                      {'addressMode':'lan','lanAddress':'0.0.0.0'},{'addressMode':'lan','lanAddress':'bad host'},
                      {'pcControlUser':'Root Admin'},{'pcControlUser':'../x'}):
            with self.assertRaises(ValueError,msg=value):lifecycle.normalize_settings(value)
    def test_saved_settings_round_trip_and_must_be_protected(self):
        path=self.root/'install.json'
        self.assertEqual(lifecycle.load_settings(path)['addressMode'],'lan')
        saved=lifecycle.normalize_settings({'addressMode':'domain','domain':'josi.example.com','port':8443,'pcControlUser':'roman'})
        path.write_text(json.dumps(saved));os.chmod(path,0o644)
        self.assertEqual(lifecycle.load_settings(path),saved)
        os.chmod(path,0o666)
        with self.assertRaisesRegex(ValueError,'Unsafe'):lifecycle.load_settings(path)
        os.chmod(path,0o644);path.write_text(json.dumps({**saved,'appUrl':'https://evil.example.com'}))
        with self.assertRaisesRegex(ValueError,'address'):lifecycle.load_settings(path)
        path.write_text(json.dumps({**saved,'extra':1}))
        with self.assertRaises(ValueError):lifecycle.load_settings(path)
        link=self.root/'linked.json';link.symlink_to(path)
        with self.assertRaises(OSError):lifecycle.load_settings(link)
    def test_domain_mode_turns_on_automatic_https_for_that_name(self):
        cfg={'publicPort':8080,'apiPort':18080}
        domain=self.obj.caddyfile(cfg,lifecycle.normalize_settings({'addressMode':'domain','domain':'josi.example.com','email':'me@example.com'})).decode()
        self.assertNotIn('auto_https off',domain)
        self.assertIn('\njosi.example.com {\n reverse_proxy 127.0.0.1:18080\n}\n',domain)
        self.assertIn(' email me@example.com\n',domain)
        self.assertIn('\nhttp://:8080 {\n bind 0.0.0.0\n',domain)
        for mode in ({'addressMode':'lan','lanAddress':'192.168.1.5'},{'addressMode':'proxy','publicUrl':'https://josi.example.com'}):
            text=self.obj.caddyfile(cfg,lifecycle.normalize_settings(mode)).decode()
            self.assertIn('auto_https off',text);self.assertIn('\n:8080 {\n',text)
    def test_web_unit_joins_the_pc_group_and_older_units_stay_recognised(self):
        web=self.obj.unit('web').decode();legacy=self.obj.unit('web',legacy=True).decode()
        self.assertIn('SupplementaryGroups=josi-ce-app josi-pc\n',web)
        self.assertIn('SupplementaryGroups=josi-ce-app\n',legacy)
        proxy=self.obj.unit('proxy').decode()
        self.assertIn('AmbientCapabilities=CAP_NET_BIND_SERVICE\n',proxy)
        self.assertNotIn('AmbientCapabilities',self.obj.unit('proxy',legacy=True).decode())
        self.assertNotIn('AmbientCapabilities',self.obj.unit('web').decode())
        self.assertEqual(self.obj.unit('worker'),self.obj.unit('worker',legacy=True))
    def test_pc_executor_unit_runs_as_the_chosen_user_on_the_current_version(self):
        program=self.installation/'versions/1.2.0'
        unit=self.obj.pc_unit('roman','roman',{'apiPort':18080},program).decode()
        for line in ('User=roman','Group=roman','SupplementaryGroups=josi-pc','StateDirectory=josi-pc','StateDirectoryMode=0700',
                     'Restart=always','RestartSec=5','PartOf=josi.service','After=josi-ce-web.service','WantedBy=josi.service',
                     'Environment=JOSI_PC_API=http://127.0.0.1:18080','Environment=JOSI_PC_STATE=/var/lib/josi-pc',
                     f'Environment=JOSI_PC_SPOOL={self.obj.data}/pc-spool',
                     f'ExecStart={program}/node/bin/node {program}/app/packaging/linux/pc-executor/josi-pc.mjs'):
            self.assertIn(line+'\n',unit)
        self.assertNotIn('ProtectHome',unit);self.assertNotIn('ProtectSystem',unit)
        for user,group in (('root user','root'),('roman','x;y'),('Roman','roman')):
            with self.assertRaises(ValueError):self.obj.pc_unit(user,group,{'apiPort':18080},program)
    @unittest.skipUnless(shutil.which('node') and (HERE/'pc-executor/browser.mjs').is_file(),'node and browser.mjs required')
    def test_browser_host_wrapper_and_manifests_name_the_current_version(self):
        program=self.root/'versions/1.2.0';executor=program/'app/packaging/linux/pc-executor';executor.mkdir(parents=True)
        shutil.copy(HERE/'pc-executor/browser.mjs',executor/'browser.mjs')
        (program/'node/bin').mkdir(parents=True);(program/'node/bin/node').symlink_to(shutil.which('node'))
        self.installation.mkdir(mode=0o700);self.obj.layout((15432,18080,8080,18081,18082))
        wrapper,files=self.obj.browser_host_files(program)
        self.assertIn(f"exec '{program}/node/bin/node' '{program}/app/packaging/linux/pc-executor/josi-browser-host.mjs'",wrapper)
        self.assertIn("JOSI_PC_STATE='/var/lib/josi-pc'",wrapper)
        self.assertEqual(sorted(str(path.parent) for path,_ in files),sorted(lifecycle.BROWSER_DIRS))
        for _,text in files:self.assertEqual(json.loads(text)['path'],str(lifecycle.BROWSER_WRAPPER))
    def test_own_browser_unit_follows_the_version_and_the_pc_account(self):
        program=self.installation/'versions/1.3.0'
        unit=self.obj.browser_unit('roman','roman',program).decode()
        for line in ('PartOf=josi.service','After=josi-pc.service','User=roman','Group=roman','StateDirectory=josi-pc',
                     'StateDirectoryMode=0700','Restart=always','RestartSec=5','Environment=JOSI_PC_STATE=/var/lib/josi-pc',
                     f'Environment=JOSI_BROWSER_EXTENSION={program}/app/browser-extension/chrome',
                     f'ExecStart={program}/node/bin/node {program}/app/packaging/linux/pc-executor/josi-browser.mjs',
                     'WantedBy=josi.service'):
            self.assertIn(line+'\n',unit)
        self.assertNotIn('ProtectHome',unit)
        with self.assertRaises(ValueError):self.obj.browser_unit('roman','x y',program)
    def test_browser_answer_needs_pc_control_and_old_files_still_load(self):
        self.assertFalse(lifecycle.normalize_settings({'browser':True})['browser'])
        self.assertTrue(lifecycle.normalize_settings({'browser':True,'pcControlUser':'roman'})['browser'])
        with self.assertRaises(ValueError):lifecycle.normalize_settings({'browser':'yes','pcControlUser':'roman'})
        old=lifecycle.normalize_settings({'pcControlUser':'roman'});old.pop('browser')
        path=self.root/'old-install.json';path.write_text(json.dumps(old));os.chmod(path,0o644)
        self.assertFalse(lifecycle.load_settings(path)['browser'])
    def test_pc_account_must_be_a_login_user(self):
        with self.assertRaises(ValueError):lifecycle.pc_account('root')
        with self.assertRaises(KeyError):lifecycle.pc_account('josi-no-such-user')
    def test_layout_creates_the_pc_spool(self):
        self.installation.mkdir(mode=0o700);self.obj.layout((15432,18080,8080,18081,18082));self.obj.repair_layout_permissions()
        self.assertEqual((self.obj.data/'pc-spool').stat().st_mode&0o7777,0o2770)
    def test_fresh_install_prefers_the_chosen_port(self):
        calls=[]
        original=lifecycle.available_ports
        def capture(ports):calls.append(ports);raise RuntimeError('stop here')
        lifecycle.available_ports=capture
        self.addCleanup(setattr,lifecycle,'available_ports',original)
        path=self.root/'install.json';path.write_text(json.dumps(lifecycle.normalize_settings({'port':18081})));os.chmod(path,0o644)
        self.obj.settings_path=path
        with self.assertRaisesRegex(RuntimeError,'stop here'):self.obj.install()
        self.assertEqual(calls[0][2],18081);self.assertEqual(len(set(calls[0])),5)

    # ---- interruptions
    def test_interrupted_install_records_recovery_required(self):
        def interrupted(fresh):raise KeyboardInterrupt()
        self.obj.identities=interrupted
        with self.assertRaises(KeyboardInterrupt):self.obj.install()
        folder=next((self.installation/'transactions').iterdir())
        self.assertEqual(lifecycle.Journal(folder).records[-1]['phase'],'recovery-required')
        self.assertEqual(json.loads((folder/'failure-diagnostics').read_text())['error'],'KeyboardInterrupt')
    def test_transaction_left_mid_phase_by_a_dead_process_is_settled(self):
        self.installation.mkdir(mode=0o700);self.obj.data.mkdir()
        transactions=self.installation/'transactions';transactions.mkdir()
        journal=lifecycle.Journal(transactions/'killed',{'from':None,'to':'0.1.78-linux.test','manifest':'a'*64})
        for phase in ('prepared','verified','quiescing'):journal.phase(phase)
        (transactions/'empty').mkdir()
        self.obj.settle_activated_recovery(os.getuid())
        self.assertEqual([r['phase'] for r in lifecycle.Journal(transactions/'killed').records][-3:],['recovery-required','rolling-back','rolled-back'])
        self.assertFalse((transactions/'empty').exists())
    def test_stop_signals_raise_but_an_inherited_hangup_ignore_is_kept(self):
        import signal
        saved={value:signal.getsignal(value) for value in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT)}
        self.addCleanup(lambda:[signal.signal(value,handler) for value,handler in saved.items()])
        signal.signal(signal.SIGHUP,signal.SIG_IGN)
        lifecycle.handle_stop_signals()
        self.assertIs(signal.getsignal(signal.SIGHUP),signal.SIG_IGN)
        self.assertIs(signal.getsignal(signal.SIGTERM),lifecycle.stop_requested)
        signal.signal(signal.SIGHUP,signal.SIG_DFL);lifecycle.handle_stop_signals()
        self.assertIs(signal.getsignal(signal.SIGHUP),lifecycle.stop_requested)
        with self.assertRaises(lifecycle.Stopped):lifecycle.stop_requested(signal.SIGTERM,None)
        self.assertIs(signal.getsignal(signal.SIGTERM),signal.SIG_IGN)
    def test_emit_survives_a_closed_reader(self):
        import io,sys
        class Closed(io.StringIO):
            def write(self,value):raise BrokenPipeError()
        previous=sys.stdout;sys.stdout=Closed()
        try:lifecycle.emit({'phase':'x'})
        finally:sys.stdout=previous

    def test_codex_scratch_links_are_removed_before_a_snapshot(self):
        # The bundled Codex CLI links helper names to its binary on every start.
        # A cold snapshot refuses links, so an update after any Codex use failed.
        obj=object.__new__(lifecycle.Lifecycle);obj.data=self.root/'data'
        program=self.root/'versions/1.1.1/cli/codex';program.mkdir(parents=True);(program/'codex').write_text('binary')
        kept=obj.data/'profiles/web/.codex/sessions';kept.mkdir(parents=True);(kept/'keep.json').write_text('{}')
        for home in (obj.data/'profiles/web/.codex',obj.data/'profiles/worker/.codex',obj.data/'codex'):
            scratch=home/'tmp/arg0/codex-arg0AbCdEf';scratch.mkdir(parents=True)
            (scratch/'apply_patch').symlink_to(program/'codex')
        (obj.data/'codex/auth-like.json').write_text('kept')
        with self.assertRaises(ValueError):lifecycle.Lifecycle.snapshot_inventory(obj,obj.data)
        obj.prune_cli_scratch()
        lifecycle.Lifecycle.snapshot_inventory(obj,obj.data)
        self.assertEqual((program/'codex').read_text(),'binary')
        self.assertTrue((kept/'keep.json').exists());self.assertTrue((obj.data/'codex/auth-like.json').exists())
        self.assertFalse((obj.data/'profiles/web/.codex/tmp/arg0').exists())
    def test_old_versions_are_removed_but_the_running_one_and_the_way_back_stay(self):
        self.installation.mkdir(mode=0o700);versions=self.installation/'versions'
        for name in ('1.2.8-beta.10','1.2.8-beta.11','1.2.8-beta.12','1.2.8-beta.13'):
            (versions/name).mkdir(parents=True);(versions/name/'blob').write_text(name)
        (versions/'not-a-version').mkdir();(versions/'link').symlink_to(versions/'1.2.8-beta.10')
        removed=self.obj.prune_old_versions({'1.2.8-beta.13','1.2.8-beta.12'})
        self.assertEqual(sorted(removed),['1.2.8-beta.10','1.2.8-beta.11'])
        self.assertEqual(sorted(p.name for p in versions.iterdir()),['1.2.8-beta.12','1.2.8-beta.13','link','not-a-version'])
        self.assertTrue((versions/'link').is_symlink())
    def test_a_full_disk_is_named_in_plain_words_before_anything_is_copied(self):
        self.installation.mkdir(mode=0o700)
        real=shutil.disk_usage
        shutil.disk_usage=lambda path:shutil._ntuple_diskusage(10<<30,10<<30,100)
        try:
            with self.assertRaisesRegex(ValueError,'Not enough free disk space.*Nothing was changed'):self.obj.ensure_space(None)
        finally:shutil.disk_usage=real
        self.obj.ensure_space(None)

if __name__=='__main__':unittest.main()
