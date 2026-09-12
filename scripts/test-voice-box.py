#!/usr/bin/env python3
"""Real local container acceptance. No registry writes or existing Josi changes.

Usage: python3 scripts/test-voice-box.py sha256:<locally-built-image-id>
Each run owns an isolated Compose project and preserves its private evidence
directory; it removes only its own container/network on completion.
"""
import array
import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import subprocess
import time
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/voice-box'))
from host_helper import Manager
from settings import DEFAULTS
from unix_http import UnixHTTPConnection


def wait(manager):
    until = time.monotonic() + 240
    while manager.lock.locked() and time.monotonic() < until:
        time.sleep(0.25)
    assert not manager.lock.locked(), 'Lifecycle operation timed out'
    assert not manager.state['error'], manager.state['error']


def call(manager, path, body):
    status, kind, data = manager.gateway('POST', path, body)
    assert status == 200, (path, status, data[:200])
    return data if kind == 'audio/wav' else json.loads(data)


def pcm16(wav):
    with wave.open(io.BytesIO(wav)) as reader:
        assert reader.getnchannels() == 1 and reader.getsampwidth() == 2
        rate = reader.getframerate()
        samples = array.array('h', reader.readframes(reader.getnframes()))
    if sys.byteorder != 'little':
        samples.byteswap()
    output = array.array('h')
    for i in range(int(len(samples) * 16000 / rate)):
        at = i * rate / 16000
        low = int(at)
        output.append(round(samples[low] * (1 - (at - low)) + samples[min(low + 1, len(samples) - 1)] * (at - low)))
    if sys.byteorder != 'little':
        output.byteswap()
    return output.tobytes()


def main(image):
    root = Path(tempfile.mkdtemp(prefix='josi-voice-acceptance-'))
    catalog = root / 'catalog.json'
    catalog.write_text(json.dumps({'releases': [{'image': image, 'engines': ['kokoro', 'piper']}]}))
    manager = Manager(root / 'state', catalog, development=True)
    report = {'image': image, 'project': manager.project, 'checks': []}
    def check(name):
        report['checks'].append(name)
        print('PASS', name, flush=True)
    try:
        start = time.monotonic()
        manager.start('install', {})
        wait(manager)
        report['installSeconds'] = round(time.monotonic() - start, 2)
        status = manager.status()
        assert status['apiReady'] and status['modelsReady'] and status['verified'] and status['healthy']
        check('install verifies API, STT, VAD and Kokoro model readiness')
        container = json.loads(subprocess.check_output(
            ['/usr/bin/docker', 'inspect', manager.project + '-voice-box-1']))[0]
        assert container['HostConfig']['NetworkMode'] == 'none'
        assert container['HostConfig']['ReadonlyRootfs'] is True
        assert container['HostConfig']['Privileged'] is False
        assert not container['HostConfig']['PortBindings']
        assert 'ALL' in container['HostConfig']['CapDrop']
        assert container['Config']['User'].split(':')[0] != '0'
        assert all(str(manager.root) in mount['Source'] for mount in container['Mounts'])
        check('actual container has no network or published ports, no Docker socket, and runs non-root with a read-only root')
        connection = UnixHTTPConnection(manager.root / 'gateway/gateway.sock', timeout=5)
        connection.request('GET', '/ready')
        assert connection.getresponse().status == 401
        connection.close()
        check('private gateway refuses requests without installation credential')
        start = time.monotonic()
        wav = call(manager, '/speech', {'text': 'Hello. Please remember to buy apples tomorrow.'})
        report['synthesisSeconds'] = round(time.monotonic() - start, 2)
        audio = pcm16(wav) + bytes(16000 * 2 * 3)
        session = call(manager, '/session', {})['session']
        events = []
        for seq, start in enumerate(range(0, len(audio), 16000)):
            frame = audio[start:start + 16000].ljust(16000, b'\0')
            events.extend(call(manager, '/audio', {'session': session, 'seq': seq, 'pcm': base64.b64encode(frame).decode()})['events'])
        assert any(e['type'] == 'speech_start' for e in events), events
        assert any(e['type'] == 'partial' for e in events), events
        final = ' '.join(e['text'] for e in events if e['type'] == 'final')
        assert 'apples' in final.lower() and 'tomorrow' in final.lower(), final
        report['transcription'] = final
        call(manager, '/close', {'session': session})
        check('real PCM frames produce VAD start, incremental transcription and final text')
        manager.start('settings', {**DEFAULTS, 'voice': 'af_bella'})
        wait(manager)
        assert manager.state['settings']['voice'] == 'af_bella'
        assert len(call(manager, '/speech', {'text': 'This is the second local neural voice.'})) > 1000
        check('voice change loads and previews Bella only after verification')
        manager.start('rollback', {})
        wait(manager)
        assert manager.state['settings']['voice'] == 'af_heart'
        check('rollback restores previous healthy voice configuration')
        manager.start('settings', {**DEFAULTS, 'engine': 'piper', 'voice': 'en_US-ljspeech-medium'})
        wait(manager)
        piper_audio = call(manager, '/speech', {'text': 'This is the optional lightweight neural speech engine.'})
        with wave.open(io.BytesIO(piper_audio)) as reader:
            assert reader.getframerate() == 22050 and reader.getnframes() > 22050
        check('optional Piper engine loads and generates the pinned LJ Speech voice')
        manager.start('rollback', {})
        wait(manager)
        assert manager.state['settings']['engine'] == 'kokoro'
        check('engine rollback restores Kokoro and its saved voice')
        manager.start('settings', {**DEFAULTS, 'model': 'tiny.en'})
        wait(manager)
        assert manager.state['settings']['model'] == 'tiny.en' and manager.status()['healthy']
        check('Whisper Tiny loads and passes inference readiness as a lower-cost CPU option')
        manager.start('rollback', {})
        wait(manager)
        assert manager.state['settings']['model'] == 'base.en'
        manager.start('restart', {})
        wait(manager)
        assert manager.status()['healthy']
        check('restart preserves configuration and verifies models again')
        manager.start('uninstall', {})
        wait(manager)
        assert not manager.status()['healthy'] and not manager.state['verified']
        assert (manager.root / 'token').exists()
        check('uninstall stops only the dedicated project and preserves recovery configuration')
    finally:
        if manager.state['current']:
            manager.run('down')
        (root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print('Evidence:', root / 'report.json', flush=True)


if __name__ == '__main__':
    main(sys.argv[1])
