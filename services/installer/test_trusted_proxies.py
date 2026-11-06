"""The existing-proxy address: checked before install, kept across updates."""
import importlib.util, os, pathlib, tempfile, unittest
from unittest.mock import patch


class TrustedProxies(unittest.TestCase):
    def controller(self, directory):
        here = pathlib.Path(__file__)
        environment = {'JOSI_INSTALL_ROOT': directory, 'JOSI_INSTALLER_HTML': str(here.with_name('index.html')),
                       'JOSI_INSTALL_UID': str(os.getuid()), 'JOSI_INSTALL_GID': str(os.getgid())}
        patcher = patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        spec = importlib.util.spec_from_file_location('controller', here.with_name('controller.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def plan(self, **extra):
        return {'mode': 'proxy', 'domain': 'josi.example.test', 'appUrl': 'https://josi.example.test',
                'httpPort': 80, 'httpsPort': 443, 'webPort': 8081, **extra}

    def test_accepts_addresses_and_ranges_and_refuses_anything_else(self):
        with tempfile.TemporaryDirectory() as directory:
            m = self.controller(directory)
            self.assertEqual(m.trusted_proxies(' 10.0.0.5 , fd00::/8,'), '10.0.0.5,fd00::/8')
            self.assertEqual(m.trusted_proxies(''), '')
            for bad in ('caddy', '10.0.0.5/33', '10.0.0.5 10.0.0.6'):
                with self.assertRaises(ValueError):
                    m.trusted_proxies(bad)

    def test_only_the_proxy_mode_asks_for_it(self):
        with tempfile.TemporaryDirectory() as directory:
            m = self.controller(directory)
            m.occupied_ports = lambda: {}
            request = {'httpPort': 80, 'httpsPort': 443, 'webPort': 8081, 'trustedProxies': '10.0.0.5'}
            self.assertEqual(m.validate({**request, 'mode': 'proxy', 'publicUrl': 'https://josi.example.test'})['trustedProxies'], '10.0.0.5')
            self.assertEqual(m.validate({**request, 'mode': 'domain', 'domain': 'josi.example.test'})['trustedProxies'], '')

    def test_an_update_that_leaves_it_empty_keeps_what_was_set(self):
        with tempfile.TemporaryDirectory() as directory:
            m = self.controller(directory)
            env = pathlib.Path(directory) / '.env'
            m.write_env(self.plan(trustedProxies='10.0.0.5'))
            self.assertIn('JOSI_TRUSTED_PROXIES=10.0.0.5\n', env.read_text())
            m.write_env(self.plan(trustedProxies=''))
            self.assertIn('JOSI_TRUSTED_PROXIES=10.0.0.5\n', env.read_text())


if __name__ == '__main__':
    unittest.main()
