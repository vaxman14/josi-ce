"""Check HRESULT and result boundaries without changing the installed antivirus."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('windows_amsi', Path(__file__).resolve().parents[2] / 'services/scanner/windows_amsi.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class VerdictTests(unittest.TestCase):
    def test_only_successful_known_clean_verdicts_are_clean(self):
        for verdict in (0, 1):
            self.assertEqual(adapter.classify(0, verdict), 'clean')
        for verdict in (-1, 2, 16383, 20480, 32767):
            self.assertEqual(adapter.classify(0, verdict), 'error')

    def test_policy_and_malware_results_block(self):
        for verdict in (16384, 20479, 32768, 65535):
            self.assertEqual(adapter.classify(0, verdict), 'blocked')

    def test_failure_hresult_never_becomes_clean_or_blocked(self):
        for result in (0, 1, 32768):
            for code in (0x80070057, -2147024809, 0x80004005, 1):
                self.assertEqual(adapter.classify(code, result), 'error')
            for code in (0x80040154, 0x80004001, 0x80004002, 0x80070032):
                self.assertEqual(adapter.classify(code, result), 'unavailable')


if __name__ == '__main__':
    unittest.main()
