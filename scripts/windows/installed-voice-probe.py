"""One CPU TTS -> VAD -> STT acceptance through the installed SCM gateway."""
import base64
import http.client
import io
import json
from pathlib import Path
import sys
import time
import wave
import numpy as np

program, data = map(Path, sys.argv[1:])
assert Path(sys.executable).resolve() == program / 'python/python.exe'
assert json.loads((data / 'installation.json').read_text())['installationId'] == 'b5a3b94c72624209908a5a965bf6867d'
assert json.loads((data / 'voice/gateway/settings.json').read_text())['device'] == 'cpu'
token = (data / 'voice/gateway/token').read_text(encoding='ascii')
def request(path, body=None):
    connection = http.client.HTTPConnection('127.0.0.1', 18081, timeout=50)
    headers = {'Authorization':'Bearer ' + token}
    payload = None if body is None else json.dumps(body)
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    try:
        connection.request('GET' if body is None else 'POST',path,payload,headers)
        response=connection.getresponse()
        return response.status,response.read()
    finally:
        connection.close()
session=None
try:
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        try:
            if request('/ready')[0]==200:
                break
        except OSError:
            pass
        time.sleep(.3)
    else:
        raise RuntimeError('Installed voice did not become ready')
    code, spoken=request('/speech',{'text':'Please remember to buy apples tomorrow.'})
    assert code==200
    with wave.open(io.BytesIO(spoken)) as wav:
        assert wav.getframerate()==24000
        samples=np.frombuffer(wav.readframes(wav.getnframes()),dtype='<i2').astype(np.float32)
    samples=np.interp(np.arange(0,len(samples),1.5),np.arange(len(samples)),samples)
    samples=np.concatenate([samples,np.zeros(16000)]).astype('<i2')
    code,response=request('/session',{})
    assert code==200
    session=json.loads(response)['session'];events=[]
    for sequence,start in enumerate(range(0,len(samples),8000)):
        code,response=request('/audio',{'session':session,'seq':sequence,'pcm':base64.b64encode(samples[start:start+8000].tobytes()).decode()})
        assert code==200
        events.extend(json.loads(response)['events'])
    assert any(event['type']=='speech_start' for event in events)
    assert any(event['type']=='final' and 'apples' in event['text'].lower() for event in events)
    print(json.dumps({'passed':True,'cpu':True,'tts':True,'vad':True,'stt':True,'physicalMicrophoneTested':False}))
finally:
    if session:
        assert request('/close',{'session':session})[0]==200
