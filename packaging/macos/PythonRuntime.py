"""Fixed launchd speech entry, invoked with the bundled interpreter and -I -B."""
import json
import os
from pathlib import Path
import runpy
import sys

def main():
    if sys.platform != 'darwin' or len(sys.argv) not in (3, 4) or sys.argv[1] not in ('voice', 'voice-control'):
        raise ValueError('Invalid speech entry')
    role = sys.argv[1]
    program = Path(__file__).resolve().parents[2]
    if Path(sys.executable).resolve() != (program / 'python/bin/python3.11').resolve():
        raise ValueError('Private interpreter required')
    config = Path(sys.argv[2])
    data = config.parent.parent
    isolated = len(sys.argv) == 4 and sys.argv[3] == '--isolated'
    if isolated:
        if os.getuid() == 0 or not str(data).startswith('/Volumes/JosiOS/JosiDrive/BuildTemp/josi-ce-native-macos-20261009/tmp/port/tests/') or json.loads((data / 'isolated-test.json').read_text())['purpose'] != 'disposable-native-acceptance':
            raise ValueError('Invalid disposable context')
    elif str(data) != '/Library/Application Support/Josi CE Server/data':
        raise ValueError('Invalid installation')
    if config != data / 'config/runtime.json' or any(p.is_symlink() for p in (config, *config.parents)):
        raise ValueError('Invalid configuration')
    info = config.stat()
    if info.st_uid != (os.getuid() if isolated else 0) or info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > 8192:
        raise ValueError('Unsafe configuration')
    settings = json.loads(config.read_text())
    if settings['version'] != json.loads((program / 'app/package.json').read_text())['version']:
        raise ValueError('Unactivated runtime')
    os.environ.clear()
    os.environ.update({'PATH':'/usr/bin:/bin', 'TMPDIR':str(data / 'temp' / role),
        'JOSI_VERSION':settings['version'], 'JOSI_VOICE_PORT':str(settings['voicePort']),
        'JOSI_VOICE_HELPER_PORT':str(settings['controlPort']), 'JOSI_VOICE_STATE_DIR':str(data / 'voice/gateway'),
        'JOSI_VOICE_HELPER_STATE_DIR':str(data / 'voice/control'), 'JOSI_VOICE_MODELS_DIR':str(program / 'voice-models'),
        'JOSI_VOICE_HELPER_TOKEN_FILE':str(data / 'secrets/voice-control/voice-control-token'),
        'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','TOKENIZERS_PARALLELISM':'false',
        'OMP_NUM_THREADS':'4','OPENBLAS_NUM_THREADS':'1'})
    os.umask(0o027)
    service = program / 'app/services/voice-box'
    os.chdir(service)
    sys.path.insert(0,str(service))
    runpy.run_path(str(service / ('gateway.py' if role == 'voice' else 'macos_helper.py')), run_name='__main__')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Native speech configuration or runtime failed ('+type(error).__name__+'). Preserve installer diagnostics.',file=sys.stderr)
        sys.exit(1)
