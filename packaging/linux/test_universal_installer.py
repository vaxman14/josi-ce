import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import universal_installer_core as core


class UniversalInstallerTest(unittest.TestCase):
    def test_detects_supported_families_from_id_and_id_like(self):
        self.assertEqual(core.distro_family({'ID':'arch'}), 'arch')
        self.assertEqual(core.distro_family({'ID':'ubuntu','ID_LIKE':'debian'}), 'debian')
        self.assertEqual(core.distro_family({'ID':'nobara','ID_LIKE':'fedora'}), 'rpm')

    def test_rejects_unknown_family_and_architecture(self):
        with self.assertRaises(ValueError): core.distro_family({'ID':'gentoo'})
        with self.assertRaises(ValueError): core.architecture('aarch64')

    def test_selects_native_package_manager_without_a_shell(self):
        package = Path('/tmp/josi.pkg')
        with patch('shutil.which', side_effect=lambda name: '/usr/bin/' + name):
            self.assertEqual(core.package_command('arch', package)[:3], ['/usr/bin/pacman','-U','--noconfirm'])
            self.assertEqual(core.package_command('debian', package)[:3], ['/usr/bin/apt-get','install','-y'])
            self.assertEqual(core.package_command('rpm', package)[:3], ['/usr/bin/dnf','install','-y'])

    def test_manifest_requires_all_packages_and_pinned_checksums(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'manifest.json'
            manifest = {'version':'0.1.78-linux.12','baseUrl':'https://example.invalid/',
                'packages':{family:{'name':family+'.pkg','sha256':'a'*64} for family in ('arch','debian','rpm')}}
            path.write_text(json.dumps(manifest))
            self.assertEqual(core.load_manifest(path), manifest)
            manifest['packages']['rpm']['sha256']='nope'; path.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError): core.load_manifest(path)


if __name__ == '__main__':
    unittest.main()
