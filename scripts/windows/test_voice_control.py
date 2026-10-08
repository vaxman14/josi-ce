"""Real gateway/control acceptance; SCM is deliberately reported separately."""
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time

REPO = Path(__file__).resolve().parents[2]
BASE = REPO / 'artifacts/windows-native'
sys.path.insert(0, str(REPO / 'services/voice-box'))
from settings import DEFAULTS
from windows_helper import Manager, Server, Handler


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def main():
    root = Path(sys.argv[1])  # ACL-protected exclusive directory from Node.
    state, gateway = root / 'helper', root / 'gateway'
    state.mkdir()
    gateway.mkdir()
    token = secrets.token_hex(32)
    (root / 'control-token').write_text(token, encoding='ascii')
    (gateway / 'token').write_text(secrets.token_hex(32), encoding='ascii')
    (gateway / 'settings.json').write_text(json.dumps(DEFAULTS), encoding='utf-8')
    gateway_port = free_port()
    log = (BASE / 'logs/voice-control-gateway.log').open('w', encoding='utf-8')
    env = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR') if key in os.environ}
    env.update(TEMP=str(root), TMP=str(root), PATH=str(Path(sys.executable).parent),
               JOSI_VOICE_STATE_DIR=str(gateway), JOSI_VOICE_PORT=str(gateway_port),
               JOSI_VOICE_MODELS_DIR=str(BASE / 'cache/voice-models'),
               HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1')

    class OwnedProcess:
        child = None
        fail_next_start = False

        def change(self, running):
            if not running and self.child:
                self.child.terminate()
                self.child.wait(timeout=10)
                self.child = None
            if running:
                if self.fail_next_start:
                    self.fail_next_start = False
                    raise RuntimeError('Deliberate acceptance failure')
                assert self.child is None
                self.child = subprocess.Popen([sys.executable, '-B', str(REPO / 'services/voice-box/gateway.py')],
                                              env=env, stdout=log, stderr=log,
                                              creationflags=subprocess.CREATE_NO_WINDOW)

    service = OwnedProcess()
    manager = Manager(state, gateway, root / 'control-token', gateway_port, '0.1.0-test', service=service)
    server = Server(('127.0.0.1', 0), Handler)
    server.manager = manager
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]

    def request(path, body=None, authorized=True, extra=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=50)
        headers = {'Authorization': 'Bearer ' + token} if authorized else {}
        headers.update(extra or {})
        try:
            connection.request('GET' if body is None else 'POST', path,
                               None if body is None else json.dumps(body), headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def wait_operation():
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            if manager.state['phase'] != 'working':
                return manager.status()
            time.sleep(.2)
        raise RuntimeError('Native voice operation timed out')

    try:
        assert request('/status', authorized=False)[0] == 401
        assert request('/operation/restart', {}, authorized=False)[0] == 401
        assert request('/status', extra={'Authorization': 'Bearer invalid'})[0] == 401
        manager.resume()
        assert wait_operation()['healthy'] is True
        assert request('/exec', {})[0] == 404
        assert request('/operation/update', {})[0] == 400
        assert request('/operation/restart', {'command': 'no'})[0] == 400
        assert request('/operation/settings', {**DEFAULTS, 'device': 'cuda'})[0] == 400
        assert request('/speech', {}, extra={'Content-Length': '100001'})[0] == 400
        assert request('/speech', [1, 2])[0] == 400
        code, data = request('/speech', {'text': 'Windows voice control is ready.'})
        assert code == 200 and data[:4] == b'RIFF' and len(data) > 24000
        code, data = request('/session', {})
        assert code == 200
        assert request('/close', {'session': json.loads(data)['session']})[0] == 200
        assert request('/operation/settings', {**DEFAULTS, 'voice': 'af_bella'})[0] == 200
        assert wait_operation()['settings']['voice'] == 'af_bella'
        assert manager.state['verified'] is True
        assert request('/operation/rollback', {})[0] == 200
        assert wait_operation()['settings']['voice'] == 'af_heart'
        service.fail_next_start = True
        assert request('/operation/settings', {**DEFAULTS, 'model': 'tiny.en'})[0] == 200
        recovered = wait_operation()
        assert recovered['healthy'] and recovered['phase'] == 'ready'
        assert recovered['settings']['model'] == 'base.en' and recovered['error']
        assert request('/operation/uninstall', {})[0] == 200
        assert wait_operation()['phase'] == 'absent'
        restarted = Manager(state, gateway, root / 'control-token', gateway_port, '0.1.0-test', service=service)
        restarted.resume()
        assert restarted.state['enabled'] is False and service.child is None
        assert request('/operation/install', {})[0] == 200
        assert wait_operation()['healthy'] is True
        report = {'passed': True, 'authenticatedLoopbackControl': True, 'boundedRequests': True,
                  'realSpeechThroughHelper': True, 'settingsVerified': True,
                  'settingsRollback': True, 'failedSettingsRecovered': True,
                  'disablementPersistsAcrossHelperRestart': True,
                  'windowsServiceTested': False, 'microphoneTested': False}
        (BASE / 'evidence/voice-control.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        service.change(False)
        log.close()


if __name__ == '__main__':
    main()
