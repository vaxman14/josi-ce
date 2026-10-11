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
        self.assertIn('VERSION=0.1.78-linux.19', TEXT)
        self.assertIn('/releases/download/v0.1.78-linux.19', TEXT)
        expected = {
            'josi-ce-server-setup-0.1.78_linux.19-1-x86_64.pkg.tar.zst':
                'dafa13226317d1a5e9a5eacd730c551aa3d5a1ab45d468d856eb8a5e9a7608a8',
            'josi-ce-server-setup_0.1.78-linux.19_amd64.deb':
                '2c34b1b20fadaf11ac0a5d30d921685b1e004f5adc090f1e7567763a340276fb',
            'josi-ce-server-setup-0.1.78-linux.19.x86_64.rpm':
                '13866bae833f562452ae8c78f8d09274559f4b98a2828810dcb391c7be6c855b',
        }
        for package, digest in expected.items():
            self.assertIn('package=' + package, TEXT)
            self.assertIn('expected=' + digest, TEXT)
        self.assertEqual(len(re.findall(r'expected=[a-f0-9]{64}', TEXT)), 4)

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
