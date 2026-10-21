# Voice Box on the Windows development server

Development only. The installed server builds its speech runtime in the release pipeline (`scripts/windows/Build-VoiceNative.ps1`, `build_runtimes.py`), including CTranslate2 compiled from source with the reviewed Windows shutdown patch, and runs Voice Box as the `JosiVoice` and `JosiVoiceControl` services.

The development server (`scripts/windows/dev`) uses the same pinned inputs without Windows services:

1. **Runtime**: a copy of the pinned Python 3.12.15 at `C:\Dev\josi-dev\voice-python`, with every package from `services/voice-box/requirements.lock` and `requirements-windows.lock` installed with `--require-hashes --no-deps`. CTranslate2 is the upstream 4.8.2 wheel, hash-pinned in `requirements-gpu.lock`, rather than the release pipeline's source build; the shutdown patch it lacks only affects shutting the process down. `patch_whisper.py` adapts faster-whisper exactly as in the release build.
2. **Models**: `download_models.py C:\Dev\josi-dev\voice-models`, verified against `models.lock.json`.
3. **ffmpeg**: `scripts/windows/dev/Get-Ffmpeg.ps1`, verified against `packaging/windows/ffmpeg.lock.json`.
4. **Start**: `Start-DevServer.ps1` starts the control helper (`windows_helper.py`) as this user with the installed services' environment, plus `JOSI_VOICE_DEVELOPMENT=1`, which makes it run the speech gateway as its own hidden process instead of starting the `JosiVoice` service. `Stop-DevServer.ps1` stops both.

Commands, from the repository root:

```powershell
robocopy C:\Dev\josi-dev\python C:\Dev\josi-dev\voice-python /E
C:\Dev\josi-dev\voice-python\python.exe -m pip install --require-hashes --no-deps --prefer-binary -r services\voice-box\requirements.lock -r services\voice-box\requirements-windows.lock
# ctranslate2==4.8.2 and its hashes, taken from services\voice-box\requirements-gpu.lock:
C:\Dev\josi-dev\voice-python\python.exe -m pip install --require-hashes --no-deps --only-binary=:all: -r <ctranslate2 lines>
C:\Dev\josi-dev\voice-python\python.exe -I -B services\voice-box\patch_whisper.py
C:\Dev\josi-dev\voice-python\python.exe -I -B services\voice-box\download_models.py C:\Dev\josi-dev\voice-models
powershell -ExecutionPolicy Bypass -File scripts\windows\dev\Get-Ffmpeg.ps1
```
