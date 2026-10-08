"""Real Windows model inference. No service/microphone acceptance claim."""
import hashlib
import base64
import io
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import wave
import faulthandler

REPO = Path(__file__).resolve().parents[2]
BASE = REPO / 'artifacts/windows-native'
MODELS = BASE / 'cache/voice-models'
PROGRAM = Path(os.environ['JOSI_TEST_PROGRAM_ROOT']).resolve() if os.environ.get('JOSI_TEST_PROGRAM_ROOT') else None
if PROGRAM:
    if not PROGRAM.is_relative_to(BASE):
        raise ValueError('The relocated test runtime must be in this workspace')
    MODELS = PROGRAM / 'voice-models'
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                  OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='4')
sys.path.insert(0, str(PROGRAM / 'app/services/voice-box' if PROGRAM else REPO / 'services/voice-box'))


def main():
    faulthandler.dump_traceback_later(60, repeat=True)
    if sys.platform != 'win32' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('This acceptance spike requires Windows x64')
    import numpy as np
    import ctranslate2
    from faster_whisper import WhisperModel
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    from settings import DEFAULTS
    from tts import NeuralSpeech
    started = time.monotonic()
    speech = NeuralSpeech(DEFAULTS, root=MODELS)
    print('Kokoro loaded', flush=True)
    wav_bytes = speech.speech('Please remember to buy apples tomorrow.')
    with wave.open(io.BytesIO(wav_bytes)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 24000)
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768
    audio = np.interp(np.arange(0, len(pcm), 1.5), np.arange(len(pcm)), pcm).astype(np.float32)
    timestamps = get_speech_timestamps(audio, VadOptions())
    assert timestamps, 'Silero did not detect synthesized speech'
    print('Speech generation and VAD passed', flush=True)
    results = []
    for model_name in ('base.en', 'tiny.en'):
        print('Loading ' + model_name, flush=True)
        model = WhisperModel(str(MODELS / model_name), device='cpu', compute_type='int8',
                             cpu_threads=4, local_files_only=True)
        segments, _ = model.transcribe(audio, language='en', beam_size=1, vad_filter=True)
        text = ' '.join(part.text for part in segments).lower()
        assert 'apples' in text and 'tomorrow' in text, text
        print(model_name + ' transcription passed', flush=True)
        results.append({'model': model_name, 'transcript': text})
        del model
    # Inspect actual loaded modules, not just PATH or import locations. System
    # DLLs may come from Windows; redistributable C++ libraries must be private.
    import ctypes
    from ctypes import wintypes
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi.EnumProcessModules.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.HMODULE), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    psapi.GetModuleFileNameExW.argtypes = [wintypes.HANDLE, wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    process = kernel.GetCurrentProcess()
    handles = (wintypes.HMODULE * 2048)()
    needed = wintypes.DWORD()
    assert psapi.EnumProcessModules(process, handles, ctypes.sizeof(handles), ctypes.byref(needed))
    assert needed.value <= ctypes.sizeof(handles)
    modules = []
    security_modules = []
    private = Path(sys.executable).resolve().parent
    windows = Path(os.environ['SystemRoot']).resolve()
    for handle in handles[:needed.value // ctypes.sizeof(wintypes.HMODULE)]:
        name = ctypes.create_unicode_buffer(32768)
        assert psapi.GetModuleFileNameExW(process, handle, name, len(name))
        path = Path(name.value).resolve()
        if not path.is_relative_to(private) and not path.is_relative_to(windows):
            # Defender's signed AMSI provider is OS security software, not a
            # dependency supplied by a developer toolchain. Never disable it.
            defender = Path(os.environ['ProgramData']) / 'Microsoft/Windows Defender/Platform'
            assert path.is_relative_to(defender) and path.name.lower() == 'mpoav.dll' and re.fullmatch(r'[0-9.]+-\d+', path.parent.name), 'Non-private runtime dependency: ' + str(path)
            check = "$s=Get-AuthenticodeSignature -LiteralPath '" + str(path).replace("'", "''") + "'; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){exit 1}"
            encoded = base64.b64encode(check.encode('utf-16-le')).decode('ascii')
            clean = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR', 'ProgramData', 'ProgramFiles', 'TEMP', 'TMP') if key in os.environ}
            subprocess.run([str(windows / 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], env=clean, check=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
            security_modules.append(str(path))
        if path.name.lower() in ('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'vcomp140.dll'):
            assert path.is_relative_to(private), 'Global Microsoft runtime was used'
        assert not any(word in path.name.lower() for word in ('mkl', 'cudnn', 'cublas', 'dnnl')), 'Unapproved CPU dependency'
        modules.append(str(path))
    assert any(Path(path).name.lower() == 'ctranslate2.dll' for path in modules)
    assert ctranslate2.__version__ == '4.8.2+josi.windows2'
    evidence = {'passed': True, 'platform': platform.platform(), 'python': sys.version,
                'executable': sys.executable, 'seconds': round(time.monotonic() - started, 2),
                'models': results, 'vadRegions': timestamps,
                'speechSha256': hashlib.sha256(wav_bytes).hexdigest(),
                'engineVersion': ctranslate2.__version__, 'loadedModules': modules,
                'signedWindowsSecurityModules': security_modules,
                'privateRuntimeDependencyClosure': True,
                'microphoneTested': False, 'assistantTurnTested': False,
                'redistributionApproved': False}
    name = 'voice-runtime' if PROGRAM else 'voice-spike'
    (BASE / ('evidence/' + name + '.wav')).write_bytes(wav_bytes)
    (BASE / ('evidence/' + name + '.json')).write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    print(json.dumps(evidence, indent=2))
    faulthandler.cancel_dump_traceback_later()


if __name__ == '__main__':
    main()
