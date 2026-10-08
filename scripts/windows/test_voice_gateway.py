"""Real private gateway acceptance with approved models; uses no mock engine."""
import base64
import http.client
import io
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import wave

REPO = Path(__file__).resolve().parents[2]
BASE = REPO / 'artifacts/windows-native'
PROGRAM = Path(os.environ['JOSI_TEST_PROGRAM_ROOT']).resolve() if os.environ.get('JOSI_TEST_PROGRAM_ROOT') else None
sys.path.insert(0, str(PROGRAM / 'app/services/voice-box' if PROGRAM else REPO / 'services/voice-box'))
from settings import DEFAULTS


def main():
    import numpy as np
    if sys.platform != 'win32':
        raise RuntimeError('Windows physical development test only')
    child = log = None
    if PROGRAM:
        assert PROGRAM.is_relative_to(BASE) and Path(sys.executable).resolve() == PROGRAM / 'python/python.exe'
        state = Path(os.environ['JOSI_TEST_DATA_ROOT']) / 'voice/gateway'
        token = (state / 'token').read_text(encoding='ascii')
        port = 18081
    else:
        state = BASE / 'test-installations/voice-gateway'
        state.mkdir(parents=True, exist_ok=True)
        # This is a disposable test token, not product/recovery material.
        token = secrets.token_hex(32)
        (state / 'token').write_text(token, encoding='ascii')
        (state / 'settings.json').write_text(json.dumps(DEFAULTS), encoding='utf-8')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        env = {**os.environ, 'JOSI_VOICE_STATE_DIR': str(state),
               'JOSI_VOICE_MODELS_DIR': str(BASE / 'cache/voice-models'),
               'JOSI_VOICE_PORT': str(port), 'HF_HUB_OFFLINE': '1',
               'TRANSFORMERS_OFFLINE': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
        log = (BASE / 'logs/voice-gateway.log').open('w', encoding='utf-8')
        child = subprocess.Popen([sys.executable, str(REPO / 'services/voice-box/gateway.py')],
                                 env=env, stdout=log, stderr=log,
                                 creationflags=subprocess.CREATE_NO_WINDOW)

    def request(path, body=None, authorized=True):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=50)
        headers = {'Authorization': 'Bearer ' + token} if authorized else {}
        payload = None if body is None else json.dumps(body)
        if payload is not None:
            headers['Content-Type'] = 'application/json'
        try:
            connection.request('GET' if body is None else 'POST', path, payload, headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if child and child.poll() is not None:
                raise RuntimeError('Voice gateway exited; inspect its sanitized log')
            try:
                if request('/ready')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(.25)
        else:
            raise RuntimeError('Voice warm-up timed out')
        assert request('/ready', authorized=False)[0] == 401
        assert request('/session', {}, authorized=False)[0] == 401
        assert request('/speech', {'text': 'a' * 601})[0] == 400
        assert request('/exec', {'command': 'anything'})[0] in (400, 404)
        code, spoken = request('/speech', {'text': 'Please remember to buy apples tomorrow.'})
        assert code == 200
        with wave.open(io.BytesIO(spoken)) as wav:
            assert wav.getframerate() == 24000
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32)
        samples = np.interp(np.arange(0, len(samples), 1.5), np.arange(len(samples)), samples)
        samples = np.concatenate([samples, np.zeros(16000)]).astype('<i2')
        code, response = request('/session', {})
        assert code == 200
        session = json.loads(response)['session']
        events = []
        for sequence, start in enumerate(range(0, len(samples), 8000)):
            code, response = request('/audio', {'session': session, 'seq': sequence,
                'pcm': base64.b64encode(samples[start:start + 8000].tobytes()).decode()})
            assert code == 200
            events.extend(json.loads(response)['events'])
        assert any(event['type'] == 'speech_start' for event in events)
        assert any(event['type'] == 'final' and 'apples' in event['text'].lower() for event in events), events
        assert request('/close', {'session': session})[0] == 200
        sessions = [json.loads(request('/session', {})[1])['session'] for _ in range(4)]
        assert request('/session', {})[0] == 429
        for session in sessions:
            assert request('/close', {'session': session})[0] == 200
        report = {'passed': True, 'authenticationRequired': True, 'sessionLimit': 4,
                  'realInference': True, 'events': events, 'microphoneTested': False,
                  'windowsServiceTested': False, 'assistantTurnTested': False}
        name = 'voice-runtime-gateway.json' if PROGRAM else 'voice-gateway.json'
        (BASE / 'evidence' / name).write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
    finally:
        if child:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
            log.close()
            (state / 'token').unlink(missing_ok=True)


if __name__ == '__main__':
    main()
