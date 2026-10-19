import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('storage_helper', Path(__file__).with_name('storage_helper.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class StorageProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.root = Path(self.temp.name)
        with patch.object(module.shutil, 'which', return_value='/usr/bin/docker'):
            self.manager = module.Manager(self.root, self.root / 'state', 'synthetic:test')
        self.calls = []
        def run(args, **kwargs):
            self.calls.append(args)
            return SimpleNamespace(stdout='["daily"]')
        self.manager.run = run
        self.body = {'protocol': 'smb', 'host': 'nas.fixture.test', 'share': 'backup', 'folder': 'daily',
                     'username': 'synthetic-user', 'password': 'synthetic-password', 'configurationRevision': str(uuid.uuid4())}
    def tearDown(self):
        self.temp.cleanup()
    def test_browse_never_replaces_active_mount_or_credential(self):
        active = self.manager.state / 'nas.credentials'
        active.write_text('existing active projection')
        self.assertEqual(self.manager.browse(self.body), {'folders': ['daily']})
        self.assertEqual(active.read_text(), 'existing active projection')
        self.assertTrue(all(self.manager.volume not in call for call in self.calls))
        self.assertEqual(list(self.manager.state.glob('josi-ce_nas_browse_*.credentials')), [])
    def test_replacement_never_falls_back_to_previous_file(self):
        active = self.manager.state / 'nas.credentials'
        active.write_text('previous secret')
        status = self.manager.configure({**self.body, 'username': '', 'password': ''})
        self.assertEqual(active.read_text(), 'username=\npassword=\n')
        self.assertEqual(status['configurationRevision'], self.body['configurationRevision'])
        self.assertEqual(self.manager.status(), status)
    def test_failed_application_has_no_success_receipt(self):
        self.manager.configure(self.body)
        def fail(*args, **kwargs):
            raise RuntimeError('synthetic controller failure')
        self.manager.run = fail
        with self.assertRaises(RuntimeError):
            self.manager.configure({**self.body, 'configurationRevision': str(uuid.uuid4())})
        self.assertIsNone(self.manager.status())
    def test_old_remove_cannot_remove_a_newer_mount(self):
        status = self.manager.configure(self.body)
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.manager.remove({'expectedRevision': str(uuid.uuid4())})
        self.assertEqual(self.manager.status(), status)
        self.manager.remove({'expectedRevision': self.body['configurationRevision']})
        self.assertIsNone(self.manager.status())
        self.assertFalse((self.manager.state / 'nas.credentials').exists())
    def test_credentials_cannot_add_mount_option_lines(self):
        with self.assertRaisesRegex(ValueError, 'control characters'):
            self.manager.configure({**self.body, 'password': 'first\nusername=other'})
        self.assertIsNone(self.manager.status())

if __name__ == '__main__':
    unittest.main()
