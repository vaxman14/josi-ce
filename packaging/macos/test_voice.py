import socket
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'services/voice-box'))
import gateway
import windows_helper

@unittest.skipUnless(sys.platform=='darwin','Darwin TCP restart contract')
class Restart(unittest.TestCase):
    def test_gateway_and_control_rebind_after_time_wait_but_not_over_live_listener(self):
        for cls,handler in [(gateway.Server,gateway.Handler),(windows_helper.Server,windows_helper.Handler)]:
            first=cls(('127.0.0.1',0),handler);address=first.server_address
            client=socket.create_connection(address);accepted,_=first.socket.accept()
            accepted.close();client.close();first.server_close()
            second=cls(address,handler)
            try:
                self.assertTrue(second.allow_reuse_address)
                with self.assertRaises(OSError):cls(address,handler)
            finally:second.server_close()

if __name__=='__main__':unittest.main()
