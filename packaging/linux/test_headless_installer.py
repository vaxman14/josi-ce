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
        self.assertIn('VERSION=0.1.78-linux.20', TEXT)
        self.assertIn('/releases/download/v0.1.78-linux.20', TEXT)
        expected = {
            'josi-ce-server-setup-0.1.78_linux.20-1-x86_64.pkg.tar.zst':
                'bb5ecc77d0f9a99e05d697b8f246bf32398efae65f5a18a5fba99e14648ce698',
            'josi-ce-server-setup_0.1.78-linux.20_amd64.deb':
                'f8ba987ed17c07216ea191eb33ab75121bb3739968bec01b0a49189784b0f837',
            'josi-ce-server-setup-0.1.78-linux.20.x86_64.rpm':
                'cf13d79979951f124a6458e2e95edb52db852b2ea5f9b39b4a4835cd49bb6447',
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
