"""Fixed authenticated speech control; no launchctl, root, shell or downloads.
launchd keeps the unprivileged transport alive; model work is enabled on demand.
"""
import http.client
import json
import os
import time
from pathlib import Path
from windows_helper import Manager, Server, Handler

class VoiceService:
    def __init__(self, state, port):
        self.token = (Path(state) / 'token').read_text().strip()
        self.port = port
    def change(self, running):
        deadline=time.monotonic()+30
        while True:
            try:return self.request_change(running)
            except ConnectionRefusedError:
                if time.monotonic()>=deadline:raise
                time.sleep(.2)
    def request_change(self,running):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        try:
            c.request('POST', '/control/start' if running else '/control/stop', b'{}',
                      {'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
            r = c.getresponse()
            r.read(4096)
            if r.status != 200:
                raise RuntimeError('Speech control unavailable')
        finally:
            c.close()

if __name__ == '__main__':
    state = os.environ['JOSI_VOICE_STATE_DIR']
    port = int(os.environ['JOSI_VOICE_PORT'])
    manager = Manager(os.environ['JOSI_VOICE_HELPER_STATE_DIR'], state,
                      os.environ['JOSI_VOICE_HELPER_TOKEN_FILE'], port, os.environ['JOSI_VERSION'],
                      service=VoiceService(state, port))
    with Server(('127.0.0.1', int(os.environ['JOSI_VOICE_HELPER_PORT'])), Handler) as server:
        server.manager = manager
        manager.resume()
        server.serve_forever()
