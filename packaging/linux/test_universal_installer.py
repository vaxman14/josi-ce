import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import universal_installer_core as core
import universal_installer as gui


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
            manifest = {'version':'0.1.78-linux.18','baseUrl':'https://example.invalid/',
                'packages':{family:{'name':family+'.pkg','sha256':'a'*64} for family in ('arch','debian','rpm')}}
            path.write_text(json.dumps(manifest))
            self.assertEqual(core.load_manifest(path), manifest)
            manifest['packages']['rpm']['sha256']='nope'; path.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError): core.load_manifest(path)

    def test_host_browser_environment_removes_appimage_runtime(self):
        environment = {
            'APPDIR':'/tmp/AppDir', 'PYTHONHOME':'/tmp/AppDir/usr',
            'LD_LIBRARY_PATH':'/tmp/AppDir/usr/lib:/host/lib',
            'XDG_DATA_DIRS':'/tmp/AppDir/usr/share', 'GDK_BACKEND':'x11',
            'JOSI_HOST_LD_LIBRARY_PATH':'/host/lib',
            'JOSI_HOST_XDG_DATA_DIRS':'/usr/local/share:/usr/share',
            'JOSI_HOST_GDK_BACKEND':'wayland', 'DISPLAY':':0',
        }
        clean = core.host_environment(environment)
        self.assertNotIn('APPDIR', clean)
        self.assertNotIn('PYTHONHOME', clean)
        self.assertEqual(clean['LD_LIBRARY_PATH'], '/host/lib')
        self.assertEqual(clean['XDG_DATA_DIRS'], '/usr/local/share:/usr/share')
        self.assertEqual(clean['GDK_BACKEND'], 'wayland')
        self.assertEqual(clean['DISPLAY'], ':0')
        self.assertFalse(any(key.startswith('JOSI_HOST_') for key in clean))

    def test_browser_handoff_uses_private_page_and_checked_host_launcher(self):
        class Surface:
            manifest = {'version':'0.1.78-linux.18'}
            final_url = 'http://10.0.0.7:8080/setup#handoff=' + 'a'*64
            opened = False
            failed = False
            def ui(self, function): function()
            def browser_opened(self): self.opened = True
            def browser_failed(self): self.failed = True
        surface = Surface()
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(gui, 'STATE', Path(directory)), \
             patch.object(gui.subprocess, 'run', return_value=Mock(returncode=0)) as launched:
            gui.Installer.launch_browser(surface)
            command = launched.call_args.args[0]
            self.assertEqual(command[0], '/usr/bin/xdg-open')
            self.assertNotIn(surface.final_url, command)
            page = Path(command[1])
            self.assertEqual(page.stat().st_mode & 0o777, 0o600)
            self.assertIn(surface.final_url, page.read_text())
            self.assertNotIn('APPDIR', launched.call_args.kwargs['env'])
            self.assertTrue(surface.opened)
            self.assertFalse(surface.failed)

    def test_browser_handoff_reports_launcher_failure(self):
        class Surface:
            manifest = {'version':'0.1.78-linux.18'}
            final_url = 'http://127.0.0.1:8080/'
            opened = False
            failed = False
            def ui(self, function): function()
            def browser_opened(self): self.opened = True
            def browser_failed(self): self.failed = True
        surface = Surface()
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(gui, 'STATE', Path(directory)), \
             patch.object(gui.subprocess, 'run', return_value=Mock(returncode=1)):
            gui.Installer.launch_browser(surface)
            self.assertFalse(surface.opened)
            self.assertTrue(surface.failed)


if __name__ == '__main__':
    unittest.main()
