"""Trusted startup configuration; HTTP clients cannot select paths or listeners."""
import os
from pathlib import Path
import sys


def runtime_config(env=None, platform=None):
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    windows = platform in ('win32', 'darwin')
    state = env.get('JOSI_VOICE_STATE_DIR', '' if windows else '/run/voice')
    models = env.get('JOSI_VOICE_MODELS_DIR', '' if windows else '/models')
    if not state or not models or not Path(state).is_absolute() or not Path(models).is_absolute():
        raise ValueError('Voice Box requires absolute state and model directories')
    port = env.get('JOSI_VOICE_PORT', '18081')
    if not port.isascii() or not port.isdecimal() or not 1024 <= int(port) <= 65535:
        raise ValueError('Invalid private voice port')
    return {'state': Path(state), 'models': Path(models), 'windows': windows,
            'address': ('127.0.0.1', int(port)) if windows else str(Path(state) / 'gateway/gateway.sock')}
