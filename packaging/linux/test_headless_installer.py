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
    'arch-x86_64': ('josi-1.1.0-1-x86_64.pkg.tar.zst', 'a' * 64),
    'debian-x86_64': ('josi_1.1.0_amd64.deb', 'b' * 64),
}


def load_generator():
    sys.path.insert(0, str(REPO / 'scripts/linux'))
    spec = importlib.util.spec_from_file_location('build_headless_installer', REPO / 'scripts/linux/build-headless-installer.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TEXT = load_generator().render('1.1.0', 'https://github.com/vaxman14/josi-ce/releases/download/v1.1.0', SAMPLE)


class HeadlessInstallerTests(unittest.TestCase):
    @unittest.skipUnless(Path('/bin/bash').exists(), 'bash required')
    def test_bash_syntax(self):
        with tempfile.NamedTemporaryFile('w', suffix='.sh', delete=False) as rendered:
            rendered.write(TEXT)
        subprocess.run(['/bin/bash', '-n', rendered.name], check=True)
        subprocess.run(['/bin/bash', '-n', str(TEMPLATE)], check=True)

    def test_release_packages_and_hashes_are_pinned(self):
        self.assertIn('VERSION=1.1.0\n', TEXT)
        self.assertIn('BASE_URL=https://github.com/vaxman14/josi-ce/releases/download/v1.1.0\n', TEXT)
        for key, (package, digest) in SAMPLE.items():
            family, processor = key.split('-')
            self.assertIn(f'{family} {processor} {package} {digest}', TEXT)
        self.assertIsNone(re.search(r'@[A-Z_]+@', TEXT))

    def test_template_placeholders_are_all_filled_or_refused(self):
        generator = load_generator()
        with self.assertRaises(ValueError):
            generator.render('1.1.0', 'https://example.invalid', {**SAMPLE, 'debian-x86_64': ('bad name', 'c' * 64)})
        with self.assertRaises(ValueError):
            generator.render('1.1.0', 'https://example.invalid', {**SAMPLE, 'arch-x86_64': (SAMPLE['arch-x86_64'][0], 'short')})
        with self.assertRaises(ValueError):
            generator.render('1.1.0', 'https://example.invalid', {'rpm-x86_64': ('josi.rpm', 'c' * 64)})
        with self.assertRaises(ValueError):
            generator.render('1.1.0', "https://example.invalid/'; rm -rf /", SAMPLE)

    def test_one_root_command_and_one_line_of_output(self):
        self.assertIn('[ "$(id -u)" = 0 ]', TEXT)
        self.assertEqual(TEXT.count('/usr/bin/josi-ce-server-install'), 1)
        self.assertEqual(len(re.findall(r"^printf '%s\\n' \"\$url\"$", TEXT, re.M)), 1)
        self.assertNotIn('sudo ', TEXT.replace('| sudo bash', ''))
        self.assertNotIn('git ', TEXT)
        self.assertNotIn('docker', TEXT.lower())

    def test_checksum_is_verified_before_the_package_manager_runs(self):
        verify = TEXT.index('[ "$actual" = "$expected" ]')
        self.assertLess(verify, TEXT.index('pacman -U'))
        self.assertLess(verify, TEXT.index('apt-get install -y -q "$work/$package"'))

    def test_detects_both_families_and_processors(self):
        for text in ('command -v pacman', 'command -v apt-get', 'aarch64|arm64) processor=aarch64', 'x86_64|amd64) processor=x86_64'):
            self.assertIn(text, TEXT)


if __name__ == '__main__':
    unittest.main()
