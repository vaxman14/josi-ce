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
        self.assertIn('VERSION=0.1.78-linux.16', TEXT)
        self.assertIn('/releases/download/v0.1.78-linux.16', TEXT)
        expected = {
            'josi-ce-server-setup-0.1.78_linux.16-1-x86_64.pkg.tar.zst':
                '6548b09f15711d401b17a8f8e3f86997aa38d6f444c41537cc37a64d5d8312d3',
            'josi-ce-server-setup_0.1.78-linux.16_amd64.deb':
                'ef4d4d618592fe650227cf32edd2223c2cf1cfdba46adac38159a6ede6da701d',
            'josi-ce-server-setup-0.1.78-linux.16.x86_64.rpm':
                '17e42ff467c7d4cfff1cf1b845847134f8d8fa02a169afab6b8f404f15b2277b',
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
