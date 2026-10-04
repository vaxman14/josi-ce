import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('maintenance_helper',Path(__file__).with_name('maintenance_helper.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class MaintenanceHelperEnvironment(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory()
  self.manager=module.Manager(Path(self.temp.name),'installer:test',1000,1000,999)
 def tearDown(self):self.temp.cleanup()
 def test_preserves_configured_compose_overlays_for_doctor_and_update(self):
  overlays='docker-compose.yml:docker-compose.workspace.yml:docker-compose.gate.yml'
  with patch.dict(os.environ,{'JOSI_COMPOSE_FILES':overlays},clear=False):
   doctor=self.manager.operation_env('doctor');update=self.manager.operation_env('update')
  self.assertEqual(doctor['JOSI_COMPOSE_FILES'],overlays)
  self.assertEqual(update['JOSI_COMPOSE_FILES'],overlays)
  self.assertEqual(doctor['JOSI_DOCTOR_LOCAL_ONLY'],'1')
  self.assertEqual(update['JOSI_UPDATE_LOCAL_ONLY'],'1')
 def test_does_not_copy_unrelated_host_environment(self):
  with patch.dict(os.environ,{'SECRET_CANARY':'do-not-copy'},clear=False):
   env=self.manager.operation_env('update')
  self.assertNotIn('SECRET_CANARY',env)

if __name__=='__main__':unittest.main()
