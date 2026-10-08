"""Isolated Python service entry point; invoked by WinSW with -I -B."""
import json
import os
from pathlib import Path
import re
import runpy
import sys
from urllib.parse import urlsplit


def main():
    if sys.platform != 'win32' or len(sys.argv) != 3 or sys.argv[1] not in ('voice', 'voice-control'):
        raise ValueError('Invalid service selection')
    role = sys.argv[1]
    program = Path(__file__).resolve().parents[2]
    if Path(sys.executable).resolve() != program / 'python' / 'python.exe':
        raise ValueError('Private Python runtime required')
    config = Path(sys.argv[2])
    data = config.parent.parent
    if not config.is_absolute() or config != data / 'config' / 'runtime.json':
        raise ValueError('Invalid configuration location')
    if any(p.is_symlink() or p.is_junction() for p in (config, *config.parents)):
        raise ValueError('Configuration links are not allowed')
    if not config.is_file() or config.stat().st_size > 4096 or config.stat().st_nlink != 1:
        raise ValueError('Invalid configuration file')
    settings = json.loads(config.read_text(encoding='utf-8'))
    if set(settings) != {'schemaVersion', 'version', 'databasePort', 'apiPort', 'publicUrl', 'setupTokenSha256'}:
        raise ValueError('Unexpected configuration fields')
    if settings['schemaVersion'] != 1 or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-z0-9.]+)?', settings['version']):
        raise ValueError('Invalid installed version')
    metadata = json.loads((program / 'app' / 'package.json').read_text(encoding='utf-8'))
    if metadata['version'] != settings['version']:
        raise ValueError('Installed version mismatch')
    for key in ('databasePort', 'apiPort'):
        if type(settings[key]) is not int or not 1024 <= settings[key] <= 65535:
            raise ValueError('Invalid private port')
    if settings['databasePort'] == settings['apiPort'] or not re.fullmatch(r'[a-f0-9]{64}', settings['setupTokenSha256']):
        raise ValueError('Invalid configuration')
    url = urlsplit(settings['publicUrl'])
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('Invalid public address')
    windows = os.environ.get('SystemRoot')
    if not windows or not Path(windows).is_absolute():
        raise ValueError('Windows configuration is unavailable')
    os.environ.clear()
    os.environ.update({
        'SystemRoot': windows, 'WINDIR': windows,
        'PATH': str(program / 'python') + ';' + str(Path(windows) / 'System32'),
        'TEMP': str(data / 'temp' / role), 'TMP': str(data / 'temp' / role),
        'USERPROFILE': str(data / 'profiles' / role), 'HOME': str(data / 'profiles' / role),
        'JOSI_VERSION': settings['version'], 'JOSI_VOICE_PORT': '18081', 'JOSI_VOICE_HELPER_PORT': '18082',
        'JOSI_VOICE_STATE_DIR': str(data / 'voice' / 'gateway'),
        'JOSI_VOICE_HELPER_STATE_DIR': str(data / 'voice' / 'control'),
        'JOSI_VOICE_MODELS_DIR': str(program / 'voice-models'),
        'JOSI_VOICE_HELPER_TOKEN_FILE': str(data / 'secrets' / 'voice-control-token'),
    })
    service = program / 'app' / 'services' / 'voice-box'
    os.chdir(service)
    # -I deliberately removes the script directory from sys.path. Restore only
    # this installer-owned module directory, never a working/user directory.
    sys.path.insert(0, str(service))
    entry = service / ('gateway.py' if role == 'voice' else 'windows_helper.py')
    runpy.run_path(str(entry), run_name='__main__')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Josi speech could not start with its installed configuration. Use Repair in Josi CE Server Setup.', file=sys.stderr)
        sys.exit(1)
