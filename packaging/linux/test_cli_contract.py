import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class LinuxCliContract(unittest.TestCase):
    def test_production_runtime_uses_the_data_directory(self):
        javascript = Path(__file__).with_name('Runtime.mjs').read_text()
        python = Path(__file__).with_name('PythonRuntime.py').read_text()
        self.assertIn("data !== '/var/lib/josi/data'", javascript)
        self.assertNotIn("data !== '/var/lib/josi'", javascript)
        self.assertIn("str(data) != '/var/lib/josi/data'", python)
        self.assertNotIn("str(data) != '/var/lib/josi'", python)

    def test_cli_surfaces_redacted_failure_cause(self):
        source = Path(__file__).with_name('install_cli.py').read_text()
        self.assertIn("event.get('cause')", source)

    def test_cli_does_not_print_internal_lifecycle_phases(self):
        source = Path(__file__).with_name('install_cli.py').read_text()
        self.assertNotIn("event.get('phase')", source)
        self.assertNotIn("event['phase']", source)

    def test_runtime_surfaces_redacted_startup_error(self):
        source = Path(__file__).with_name('Runtime.mjs').read_text()
        self.assertIn('Josi native Linux runtime failed:', source)
        self.assertIn('[redacted database URL]', source)
        self.assertIn('[redacted secret]', source)

    def test_browser_handoff_rejects_non_json_without_a_traceback(self):
        source = Path(__file__).with_name('install_cli.py').read_text()
        self.assertIn('except (UnicodeDecodeError, json.JSONDecodeError)', source)

    def test_normal_linux_path_is_cli_only(self):
        repo = Path(__file__).resolve().parents[2]
        source = repo.joinpath('scripts/linux/package_common.py').read_text()
        self.assertIn('install_cli.py', source)
        self.assertNotIn("packaging/linux/setup.py', root", source)
        installer = repo.joinpath('packaging/linux/install-josi-ce-server.sh').read_text()
        self.assertIn('/usr/bin/josi-ce-server-install 2>&3', installer)

    def test_portable_voice_runtime_bundles_openblas_compiler_libraries(self):
        source = Path(__file__).resolve().parents[2].joinpath('scripts/linux/build-voice.py').read_text()
        for library in ('libgfortran.so.5', 'libquadmath.so.0', 'libgomp.so.1'):
            self.assertIn(library, source)

    def test_staging_regenerates_payload_inventory(self):
        source = Path(__file__).resolve().parents[2].joinpath('scripts/linux/stage.py').read_text()
        self.assertIn("REPO/'scripts/linux/inventory.py'", source)

    def test_staging_puts_the_pc_executor_under_the_app_folder(self):
        source = REPO.joinpath('scripts/linux/stage.py').read_text()
        self.assertIn("executor=REPO/'packaging/linux/pc-executor'", source)
        self.assertIn("app/'packaging/linux/pc-executor'", source)
        lifecycle = module('lifecycle_for_stage', HERE / 'lifecycle.py')
        self.assertEqual(lifecycle.PC_EXECUTOR, 'app/packaging/linux/pc-executor/josi-pc.mjs')

    def test_runtime_is_the_linux_server_with_the_chosen_address(self):
        source = HERE.joinpath('Runtime.mjs').read_text()
        self.assertIn("JOSI_LINUX_SERVER: '1'", source)
        self.assertIn("JOSI_NATIVE_RUNTIME: '1'", source)
        self.assertIn('APP_URL: address.appUrl, JOSI_ACCESS_MODE: address.addressMode', source)
        self.assertIn("readFileSync('/etc/josi/install.json')", source)
        self.assertIn("st.uid !== 0 || (st.mode & 0o022)", source)
        self.assertIn("role === 'web' ? { JOSI_PC_SPOOL: join(data, 'pc-spool') }", source)
        self.assertNotIn('APP_URL: `http://localhost:${cfg.publicPort}`', source)

    @unittest.skipUnless(shutil.which('node'), 'node required')
    def test_runtime_parses(self):
        subprocess.run(['node', '--check', str(HERE / 'Runtime.mjs')], check=True)

    def test_setup_keeps_the_linux_address_instead_of_localhost(self):
        source = REPO.joinpath('apps/api/src/setup/setupRoutes.ts').read_text()
        linux = source.index("if (process.env.JOSI_LINUX_SERVER === '1') {")
        self.assertLess(linux, source.index("process.env.APP_URL === 'http://localhost:8080'"))
        self.assertIn('installerAddress: await linuxInstallerAddress(db)', source)

    def test_deb_removal_disables_josi(self):
        source = REPO.joinpath('scripts/linux/build-deb.py').read_text()
        self.assertIn("postrm = control / 'postrm'", source)
        self.assertIn('systemctl disable --now {units}', source)
        self.assertIn('josi-pc.service', source)
        self.assertIn('Version: {debian_version()}', source)

    def test_uninstall_removes_pc_control(self):
        source = HERE.joinpath('josi-uninstall.sh').read_text()
        self.assertIn('systemctl disable --now josi-pc.service', source)
        self.assertIn('rm -f /etc/systemd/system/josi-pc.service', source)
        self.assertIn('groupdel josi-pc', source)
        lifecycle = module('lifecycle_for_uninstall', HERE / 'lifecycle.py')
        for folder in lifecycle.BROWSER_DIRS:
            self.assertIn(f'{folder}/{lifecycle.BROWSER_HOST_NAME}.json', source)
        self.assertIn(str(lifecycle.BROWSER_WRAPPER), source)

    @unittest.skipUnless(Path('/bin/bash').exists(), 'bash required')
    def test_shell_scripts_parse(self):
        for name in ('install-josi-ce-server.sh', 'josi-uninstall.sh', 'universal_root_install.sh'):
            subprocess.run(['/bin/bash', '-n', str(HERE / name)], check=True)


class PackageVersionTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(REPO / 'scripts/linux'))
        self.addCleanup(sys.path.remove, str(REPO / 'scripts/linux'))
        self.common = module('package_common_for_test', REPO / 'scripts/linux/package_common.py')

    def test_prerelease_sorts_before_the_release_in_dpkg(self):
        self.assertEqual(self.common.debian_version('1.2.8-beta.1'), '1.2.8~beta.1')
        self.assertEqual(self.common.debian_version('1.2.8'), '1.2.8')
        if shutil.which('dpkg'):
            for left, right in (('1.2.8-beta.1', '1.2.8'), ('1.2.8-beta.2', '1.2.8-beta.10'), ('1.2.7', '1.2.8-beta.1')):
                subprocess.run(['dpkg', '--compare-versions', self.common.debian_version(left), 'lt',
                    self.common.debian_version(right)], check=True)

    def test_build_accepts_only_the_version_shape_the_runtime_accepts(self):
        sys.modules['package_common'] = self.common
        generator = module('build_headless_for_version', REPO / 'scripts/linux/build-headless-installer.py')
        sample = {'debian-x86_64': ('josi_1.1.0_amd64.deb', 'b' * 64)}
        generator.render('1.1.0-beta.1', 'https://example.invalid', sample)
        with self.assertRaises(ValueError):
            generator.render('1.1.0-Beta.1', 'https://example.invalid', sample)
        lifecycle = module('lifecycle_for_version', HERE / 'lifecycle.py')
        self.assertEqual(self.common.VERSION_PATTERN, lifecycle.VERSION_PATTERN)
        updater = module('josi_update_for_version', HERE / 'josi_update.py')
        self.assertEqual(updater.VERSION.pattern, '^' + lifecycle.VERSION_PATTERN + '$')


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.updater = module('josi_update_for_test', HERE / 'josi_update.py')
        self.folder = Path(tempfile.mkdtemp(prefix='josi-update-'))
        self.addCleanup(shutil.rmtree, self.folder, True)
        self.updater.STATUS = self.folder / 'update-status.json'
        self.updater.LOCK = self.folder / 'update.lock'

    def test_version_order_is_semantic(self):
        newer = self.updater.newer
        self.assertTrue(newer('1.2.8', '1.2.8-beta.1'))
        self.assertTrue(newer('1.2.8-beta.10', '1.2.8-beta.2'))
        self.assertTrue(newer('1.2.8-beta.1', '1.2.8-alpha.3'))
        self.assertTrue(newer('1.2.8-beta.1', '1.2.7'))
        self.assertFalse(newer('1.2.8-beta.1', '1.2.8'))
        self.assertFalse(newer('1.2.8', '1.2.8'))

    def test_status_is_read_without_following_links_or_blocking(self):
        self.updater.STATUS.write_text('{"state":"idle"}')
        self.assertEqual(self.updater.read_status(), {'state': 'idle'})
        secret = self.folder / 'secret'; secret.write_text('{"shadow":"root:x"}')
        self.updater.STATUS.unlink(); self.updater.STATUS.symlink_to(secret)
        self.assertEqual(self.updater.read_status(), {})
        self.updater.STATUS.unlink(); os.mkfifo(self.updater.STATUS)
        self.assertEqual(self.updater.read_status(), {})
        self.updater.STATUS.unlink(); self.updater.STATUS.write_text('{"x":"' + 'a' * 70000 + '"}')
        self.assertEqual(self.updater.read_status(), {})

    def test_check_and_update_share_one_lock(self):
        held = self.updater.update_lock(wait=True)
        self.assertIsNotNone(held)
        try:
            self.assertIsNone(self.updater.update_lock(wait=False))
        finally:
            os.close(held)
        again = self.updater.update_lock(wait=False)
        self.assertIsNotNone(again); os.close(again)

    def test_apt_waits_for_its_lock_and_finishes_dpkg_first(self):
        source = HERE.joinpath('josi_update.py').read_text()
        self.assertIn("APT_LOCK = ['-o', 'DPkg::Lock::Timeout=600']", source)
        self.assertEqual(source.count("'/usr/bin/apt-get', *APT_LOCK"), 2)
        self.assertLess(source.index("'/usr/bin/dpkg', '--configure', '-a'"), source.index("'/usr/bin/apt-get', *APT_LOCK, 'update'"))

    def test_failed_update_rolls_back_before_restarting(self):
        source = HERE.joinpath('josi_update.py').read_text()
        self.assertLess(source.index("'/usr/bin/josi-ce-server-install', '--recover'"),
            source.index("['/usr/bin/systemctl', 'start', 'josi.service']"))


class InstallCliTests(unittest.TestCase):
    def setUp(self):
        self.cli = module('install_cli_for_test', HERE / 'install_cli.py')
        self.folder = Path(tempfile.mkdtemp(prefix='josi-cli-'))
        self.addCleanup(shutil.rmtree, self.folder, True)
        self.cli.SETTINGS = self.folder / 'install.json'
        self.cli.CONFIG = self.folder
        self.cli.LIB = self.folder / 'no-lib'
        # Never the lifecycle of a Josi installed on the test machine.
        self.cli.LIFECYCLE = self.folder / 'no-lib/lifecycle.py'
        self.cli.ROOT = self.folder / 'root'
        self.cli.primary_ip = lambda: '192.168.7.9'

    def test_flags_are_parsed(self):
        mode, uid, answers = self.cli.parse(['x', '--address-mode', 'proxy', '--public-url=https://josi.example.com',
            '--port', '9000', '--pc-control-user', 'roman', '--yes'])
        self.assertEqual(mode, 'install')
        self.assertEqual(answers, {'addressMode': 'proxy', 'publicUrl': 'https://josi.example.com', 'port': 9000, 'pcControlUser': 'roman'})
        self.assertEqual(self.cli.parse(['x', '--no-pc-control'])[2], {'pcControlUser': None})
        self.assertEqual(self.cli.parse(['x', '--upgrade'])[:2], ('upgrade', 0))
        self.assertEqual(self.cli.parse(['x', '--recover'])[:2], ('recover', 0))
        for bad in (['x', '--bogus'], ['x', '--port', 'eighty'], ['x', '--domain']):
            with self.assertRaises(SystemExit):
                self.cli.parse(bad)

    def test_answers_resolve_over_saved_over_defaults(self):
        settings = self.cli.resolve_settings({}, {})
        self.assertEqual((settings['addressMode'], settings['appUrl']), ('lan', f"http://192.168.7.9:{settings['port']}"))
        self.cli.save_settings({**settings, 'port': settings['port']})
        self.assertEqual(json.loads(self.cli.SETTINGS.read_text())['appUrl'], settings['appUrl'])
        again = self.cli.resolve_settings({'addressMode': 'proxy', 'publicUrl': 'https://josi.example.com/'},
            {'installed': True, 'publicPort': settings['port']})
        self.assertEqual((again['appUrl'], again['port']), ('https://josi.example.com', settings['port']))
        with self.assertRaises(SystemExit):
            self.cli.resolve_settings({'addressMode': 'domain', 'domain': 'not a domain'}, {})
        with self.assertRaises(SystemExit):
            self.cli.resolve_settings({'pcControlUser': 'josi-no-such-user'}, {})
        with self.assertRaises(SystemExit):
            self.cli.resolve_settings({'pcControlUser': 'root'}, {})

    def test_an_explicit_busy_port_is_refused_and_a_default_one_moves(self):
        import socket
        listener = socket.socket(); listener.bind(('0.0.0.0', 0)); listener.listen(1)
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        with self.assertRaises(SystemExit):
            self.cli.resolve_settings({'port': port}, {})
        self.cli.save_settings(self.cli.resolve_settings({}, {}) | {'port': port} | {'appUrl': f'http://192.168.7.9:{port}'})
        self.assertNotEqual(self.cli.resolve_settings({}, {})['port'], port)
        self.assertEqual(self.cli.resolve_settings({}, {'installed': True, 'publicPort': port})['port'], port)

    def test_recoverable_transactions_are_found(self):
        folder = self.cli.ROOT / 'transactions' / ('a' * 32); folder.mkdir(parents=True)
        identity = {'from': '1.0.0', 'to': '1.1.0', 'manifest': 'b' * 64}
        for number, phase in enumerate(('prepared', 'verified', 'migrating', 'recovery-required'), 1):
            (folder / f'{number:04}.json').write_text(json.dumps({'phase': phase, 'identity': identity}))
        (self.cli.ROOT / 'transactions' / 'not-a-transaction').mkdir()
        self.assertEqual(self.cli.transactions(), [('a' * 32, ['prepared', 'verified', 'migrating', 'recovery-required'], identity)])
        self.assertFalse(self.cli.lifecycle_busy())

    def test_cli_recovers_before_installing_and_reconfigures_after(self):
        source = HERE.joinpath('install_cli.py').read_text()
        main = source[source.index('def main():'):]
        self.assertLess(main.index('recover_upgrades()\n    current = status()'), main.index("run_lifecycle('install', uid)"))
        self.assertLess(main.index("run_lifecycle('install', uid)"), main.index("run_lifecycle('configure')"))
        self.assertIn('fail(LEGACY_MESSAGE)', main)


if __name__ == '__main__':
    unittest.main()
