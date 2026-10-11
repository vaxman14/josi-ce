from pathlib import Path
import re
import subprocess
import unittest


SCRIPT = Path(__file__).with_name('install-josi-ce-server.sh')
TEXT = SCRIPT.read_text()


class HeadlessInstallerTests(unittest.TestCase):
    def test_posix_shell_syntax(self):
        subprocess.run(['/bin/sh', '-n', str(SCRIPT)], check=True)

    def test_release_packages_and_hashes_are_pinned(self):
        self.assertIn('VERSION=0.1.78-linux.17', TEXT)
        self.assertIn('/releases/download/v0.1.78-linux.17', TEXT)
        expected = {
            'josi-ce-server-setup-0.1.78_linux.17-1-x86_64.pkg.tar.zst':
                'bbd83026d0c94efb7afb15983006fa7174fd0f37f713731e52d6a4ec17b2a9ea',
            'josi-ce-server-setup_0.1.78-linux.17_amd64.deb':
                'b8700230609633cb026e9c605abfae6fcf2695bcff3c0d9eac0b3a440cbe752c',
            'josi-ce-server-setup-0.1.78-linux.17.x86_64.rpm':
                'c86ceddffbcc30661f776470e49aae4561b297fb880fca64f48d3c6d0819c77a',
        }
        for package, digest in expected.items():
            self.assertIn('package=' + package, TEXT)
            self.assertIn('expected=' + digest, TEXT)
        self.assertEqual(len(re.findall(r'expected=[a-f0-9]{64}', TEXT)), 4)

    def test_normal_path_is_one_complete_install(self):
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
