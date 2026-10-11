import unittest
from pathlib import Path


class LinuxCliContract(unittest.TestCase):
    def test_production_runtime_uses_the_data_directory(self):
        javascript = Path(__file__).with_name('Runtime.mjs').read_text()
        python = Path(__file__).with_name('PythonRuntime.py').read_text()
        self.assertIn("data !== '/var/lib/josi-ce-server/data'", javascript)
        self.assertNotIn("data !== '/var/lib/josi-ce-server'", javascript)
        self.assertIn("str(data) != '/var/lib/josi-ce-server/data'", python)
        self.assertNotIn("str(data) != '/var/lib/josi-ce-server'", python)

    def test_cli_surfaces_redacted_failure_cause(self):
        source = Path(__file__).with_name('install_cli.py').read_text()
        self.assertIn("event.get('cause')", source)

    def test_normal_linux_path_is_cli_only(self):
        repo = Path(__file__).resolve().parents[2]
        source = repo.joinpath('scripts/linux/package_common.py').read_text()
        self.assertIn('install_cli.py', source)
        self.assertNotIn("packaging/linux/setup.py', root", source)
        installer = next(repo.glob('get.*josi.com/server-install.sh')).read_text()
        self.assertIn('josi-ce-server-install --interactive-uid', installer)


if __name__ == '__main__':
    unittest.main()
