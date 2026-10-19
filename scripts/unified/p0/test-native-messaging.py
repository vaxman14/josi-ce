from pathlib import Path
import json
import struct
import subprocess
import sys
import unittest

HOST = Path(__file__).with_name('native-message-host.py')


def frame(value):
    data = json.dumps(value, ensure_ascii=False).encode()
    return struct.pack('=I', len(data)) + data


def run(data):
    return subprocess.run([sys.executable, str(HOST)], input=data, capture_output=True, timeout=5)


class NativeMessagingTest(unittest.TestCase):
    def test_roundtrip_and_multiple_messages(self):
        values = [{'version': 1, 'method': 'probe', 'nonce': value} for value in ['plain', 'héllo 🌍']]
        result = run(b''.join(map(frame, values)))
        self.assertEqual(result.returncode, 0)
        remaining = result.stdout
        for value in values:
            size = struct.unpack('=I', remaining[:4])[0]
            self.assertEqual(json.loads(remaining[4:4 + size]), value)
            remaining = remaining[4 + size:]
        self.assertEqual(remaining, b'')

    def test_malformed_and_unsupported_messages_are_not_executed(self):
        invalid = [b'\0', struct.pack('=I', 0), struct.pack('=I', 65537),
                   struct.pack('=I', 9) + b'{}', frame([]),
                   frame({'version': 1, 'method': 'execute', 'nonce': 'test'}),
                   frame({'version': True, 'method': 'probe', 'nonce': 'test'}),
                   frame({'version': 1, 'method': 'probe', 'nonce': 'test', 'command': 'untrusted'})]
        for data in invalid:
            with self.subTest(data=data):
                result = run(data)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b'')
                self.assertNotIn(b'untrusted', result.stderr)


if __name__ == '__main__':
    unittest.main()
