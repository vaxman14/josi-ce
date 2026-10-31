import importlib.util
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = Path(__file__).with_name('install-josi-ce-server.sh')
SAMPLE = {
    'arch': ('josi-ce-server-setup-1.0.0-1-x86_64.pkg.tar.zst', 'a' * 64),
    'debian': ('josi-ce-server-setup_1.0.0_amd64.deb', 'b' * 64),
    'rpm': ('josi-ce-server-setup-1.0.0.x86_64.rpm', 'c' * 64),
}


def load_generator():
    sys.path.insert(0, str(REPO / 'scripts/linux'))
    spec = importlib.util.spec_from_file_location('build_headless_installer', REPO / 'scripts/linux/build-headless-installer.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TEXT = load_generator().render('1.0.0', 'https://github.com/vaxman14/josi-ce/releases/download/v1.0.0', SAMPLE)


class HeadlessInstallerTests(unittest.TestCase):
    @unittest.skipUnless(Path('/bin/sh').exists(), 'POSIX shell required')
    def test_posix_shell_syntax(self):
        with tempfile.NamedTemporaryFile('w', suffix='.sh', delete=False) as rendered:
            rendered.write(TEXT)
        subprocess.run(['/bin/sh', '-n', rendered.name], check=True)
        subprocess.run(['/bin/sh', '-n', str(TEMPLATE)], check=True)

    def test_release_packages_and_hashes_are_pinned(self):
        self.assertIn('VERSION=1.0.0\n', TEXT)
        self.assertIn('BASE_URL=https://github.com/vaxman14/josi-ce/releases/download/v1.0.0\n', TEXT)
        for package, digest in SAMPLE.values():
            self.assertIn('package=' + package, TEXT)
            self.assertIn('expected=' + digest, TEXT)
        self.assertEqual(len(re.findall(r'expected=[a-f0-9]{64}', TEXT)), 4)
        self.assertIsNone(re.search(r'@[A-Z_]+@', TEXT))

    def test_template_placeholders_are_all_filled_or_refused(self):
        generator = load_generator()
        with self.assertRaises(ValueError):
            generator.render('1.0.0', 'https://example.invalid', {**SAMPLE, 'rpm': ('bad name', 'c' * 64)})
        with self.assertRaises(ValueError):
            generator.render('1.0.0', 'https://example.invalid', {**SAMPLE, 'arch': (SAMPLE['arch'][0], 'short')})

    def test_normal_path_is_one_complete_install(self):
        self.assertIn('sudo -n true', TEXT)
        self.assertIn('sudo -v', TEXT)
        self.assertEqual(TEXT.count('sudo /usr/bin/josi-ce-server-install --interactive-uid'), 1)
        self.assertNotIn('git ', TEXT)
        self.assertNotIn('docker', TEXT.lower())
        self.assertNotIn('josi-ce-native-status', TEXT)
        self.assertNotIn('/api/', TEXT)

    def test_rejects_root_and_unsupported_architectures(self):
        self.assertIn('interactive_uid=$(id -u)', TEXT)
        self.assertIn('[ "$interactive_uid" -ge 1000 ]', TEXT)
        self.assertIn('[ "$(uname -m)" = x86_64 ]', TEXT)


if __name__ == '__main__':
    unittest.main()
