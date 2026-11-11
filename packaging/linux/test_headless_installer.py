import importlib.util
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = Path(__file__).with_name('install-josi-ce-server.sh')
X86 = {
    'arch': ('josi-ce-server-setup-1.0.0-1-x86_64.pkg.tar.zst', 'a' * 64),
    'debian': ('josi-ce-server-setup_1.0.0_amd64.deb', 'b' * 64),
    'rpm': ('josi-ce-server-setup-1.0.0.x86_64.rpm', 'c' * 64),
}
ARM = {
    'arch': ('josi-ce-server-setup-1.0.0-1-aarch64.pkg.tar.zst', 'd' * 64),
    'debian': ('josi-ce-server-setup_1.0.0_arm64.deb', 'e' * 64),
    'rpm': ('josi-ce-server-setup-1.0.0.aarch64.rpm', 'f' * 64),
}
SAMPLE = {'x86_64': X86, 'aarch64': ARM}
URL = 'https://github.com/vaxman14/josi-ce/releases/download/v1.0.0'


def load_generator():
    sys.path.insert(0, str(REPO / 'scripts/linux'))
    spec = importlib.util.spec_from_file_location('build_headless_installer', REPO / 'scripts/linux/build-headless-installer.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TEXT = load_generator().render('1.0.0', URL, SAMPLE)
X86_ONLY = load_generator().render('1.0.0', URL, {'x86_64': X86})


class HeadlessInstallerTests(unittest.TestCase):
    @unittest.skipUnless(Path('/bin/sh').exists(), 'POSIX shell required')
    def test_posix_shell_syntax(self):
        for text in (TEXT, X86_ONLY):
            with tempfile.NamedTemporaryFile('w', suffix='.sh', delete=False) as rendered:
                rendered.write(text)
            subprocess.run(['/bin/sh', '-n', rendered.name], check=True)
        subprocess.run(['/bin/sh', '-n', str(TEMPLATE)], check=True)

    def test_release_packages_and_hashes_are_pinned(self):
        self.assertIn('VERSION=1.0.0\n', TEXT)
        self.assertIn('BASE_URL=' + URL + '\n', TEXT)
        for arch, built in SAMPLE.items():
            for family, (package, digest) in built.items():
                self.assertIn(f'{family}-{arch}) package={package}; expected={digest} ;;', TEXT)
        self.assertEqual(len(re.findall(r'expected=[a-f0-9]{64}', TEXT)), 6)
        self.assertIsNone(re.search(r'@[A-Z0-9_]+@', TEXT))

    def test_an_architecture_that_was_not_built_is_refused_by_name(self):
        self.assertIn('debian-aarch64) package=; expected= ;;', X86_ONLY)
        self.assertEqual(len(re.findall(r'expected=[a-f0-9]{64}', X86_ONLY)), 3)
        self.assertIn('[ -n "$package" ] || fail', X86_ONLY)
        self.assertIsNone(re.search(r'@[A-Z0-9_]+@', X86_ONLY))

    def test_template_placeholders_are_all_filled_or_refused(self):
        generator = load_generator()
        with self.assertRaises(ValueError):
            generator.render('1.0.0', 'https://example.invalid', {'x86_64': {**X86, 'rpm': ('bad name', 'c' * 64)}})
        with self.assertRaises(ValueError):
            generator.render('1.0.0', 'https://example.invalid', {'aarch64': {**ARM, 'arch': (ARM['arch'][0], 'short')}})
        with self.assertRaises(ValueError):
            generator.render('1.0.0', 'https://example.invalid', {'riscv64': X86})
        with self.assertRaises(ValueError):
            generator.render('1.0.0', 'https://example.invalid', {})

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
        self.assertIn('x86_64|amd64) machine=x86_64 ;;', TEXT)
        self.assertIn('aarch64|arm64) machine=aarch64 ;;', TEXT)
        self.assertIn("*) fail 'this release supports x86_64 and arm64 (aarch64) machines only' ;;", TEXT)
        self.assertIn('getconf LONG_BIT', TEXT)


if __name__ == '__main__':
    unittest.main()
