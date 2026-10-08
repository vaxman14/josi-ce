"""Native Voice Box control. SCM owns the process; WinSW is the service host.

Only the fixed JosiVoice service can be queried, started or stopped. This
unprivileged helper cannot install services, change their executable/account,
download payloads, select models outside settings.py, or execute commands.
"""
import ctypes
from ctypes import wintypes
import hmac
import http.client
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import re
import secrets
import socketserver
import threading
import time

from bounded_http import BoundedRequests
from settings import validate


def atomic(path, value):
    temporary = path.with_name(path.name + '.' + secrets.token_hex(12) + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class VoiceService:
    """Minimal fixed-service client of Windows SCM, with no management rights."""
    class Status(ctypes.Structure):
        _fields_ = [(name, wintypes.DWORD) for name in (
            'service_type', 'state', 'accepted', 'exit_code', 'specific_exit',
            'checkpoint', 'wait_hint')]

    def __init__(self):
        self.api = ctypes.WinDLL('advapi32', use_last_error=True)
        for name, args, result in (
            ('OpenSCManagerW', [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD], wintypes.HANDLE),
            ('OpenServiceW', [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.DWORD], wintypes.HANDLE),
            ('CloseServiceHandle', [wintypes.HANDLE], wintypes.BOOL),
            ('QueryServiceStatus', [wintypes.HANDLE, ctypes.POINTER(self.Status)], wintypes.BOOL),
            ('ControlService', [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(self.Status)], wintypes.BOOL),
            ('StartServiceW', [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
        ):
            function = getattr(self.api, name)
            function.argtypes, function.restype = args, result

    def change(self, running):
        manager = self.api.OpenSCManagerW(None, None, 1)  # SC_MANAGER_CONNECT
        if not manager:
            raise RuntimeError('Voice service control is unavailable')
        service = None
        try:
            # QUERY_STATUS plus exactly START or STOP; never ALL_ACCESS.
            service = self.api.OpenServiceW(manager, 'JosiVoice', 4 | (16 if running else 32))
            if not service:
                raise RuntimeError('Voice service access is unavailable')
            target, deadline = (4 if running else 1), time.monotonic() + 60
            requested = False
            while time.monotonic() < deadline:
                status = self.Status()
                if not self.api.QueryServiceStatus(service, ctypes.byref(status)):
                    raise RuntimeError('Voice service status is unavailable')
                if status.state == target:
                    return
                if not requested and status.state in (1, 4):
                    okay = (self.api.StartServiceW(service, 0, None) if running else
                            self.api.ControlService(service, 1, ctypes.byref(status)))
                    if not okay:
                        raise RuntimeError('Voice service could not change state')
                    requested = True
                time.sleep(.2)
            raise RuntimeError('Voice service did not become ready in time')
        finally:
            if service:
                self.api.CloseServiceHandle(service)
            self.api.CloseServiceHandle(manager)


class Manager:
    def __init__(self, state, gateway_state, token_file, gateway_port, version, service=None):
        self.root, self.gateway_root = Path(state), Path(gateway_state)
        for root in (self.root, self.gateway_root):
            if not root.is_absolute() or not root.is_dir():
                raise ValueError('Private voice storage is unavailable')
            if any(path.is_symlink() or path.is_junction() for path in (root, *root.parents)):
                raise ValueError('Voice storage must not contain links')
        if not 1024 <= gateway_port <= 65535 or not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', version):
            raise ValueError('Invalid installed voice configuration')
        self.port, self.version = gateway_port, version
        self.token = Path(token_file).read_text(encoding='ascii').strip()
        self.gateway_token = (self.gateway_root / 'token').read_text(encoding='ascii').strip()
        if any(not re.fullmatch(r'[a-f0-9]{64}', value) for value in (self.token, self.gateway_token)):
            raise ValueError('Private voice credential unavailable')
        if hmac.compare_digest(self.token, self.gateway_token):
            raise ValueError('Voice control requires a separate credential')
        self.file = self.root / 'state.json'
        settings = validate(json.loads((self.gateway_root / 'settings.json').read_text(encoding='utf-8')))
        if settings['device'] != 'cpu':
            raise ValueError('This installation supports CPU speech only')
        self.state = {'phase': 'absent', 'verified': False, 'current': None,
                      'previous': None, 'settings': settings, 'enabled': True, 'error': None}
        if self.file.exists():
            persisted = json.loads(self.file.read_text(encoding='utf-8'))
            if type(persisted.get('enabled')) is not bool:
                raise ValueError('Invalid saved voice state')
            self.state.update(persisted)
            self.state['settings'] = validate(self.state['settings'])
        self.lock = threading.Lock()
        self.service = VoiceService() if service is None else service

    def save(self):
        atomic(self.file, self.state)

    def gateway(self, method, path, body=None, timeout=45):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        try:
            connection.request(method, path, json.dumps(body) if body is not None else None,
                               {'Authorization': 'Bearer ' + self.gateway_token, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError('Voice response exceeded its limit')
            return response.status, response.getheader('Content-Type', 'application/json'), data
        finally:
            connection.close()

    def health(self):
        try:
            code, _, data = self.gateway('GET', '/health', timeout=3)
            value = json.loads(data)
            return {'apiReady': code == 200 and value.get('apiReady') is True,
                    'modelsReady': code == 200 and value.get('modelsReady') is True}
        except (OSError, ValueError, http.client.HTTPException):
            return {'apiReady': False, 'modelsReady': False}

    def status(self):
        health = self.health() if self.state['enabled'] else {'apiReady': False, 'modelsReady': False}
        return {**self.state, **health, 'healthy': all(health.values()), 'helperAvailable': True,
                'managedByInstaller': True, 'releaseAvailable': True, 'gpuAvailable': False,
                'requirements': ['Josi CE Server for Windows', '4 GB available RAM and 2+ CPU cores',
                                 'HTTPS or localhost for browser microphone access',
                                 'Speech models are installed locally with Josi']}

    def activate(self, settings):
        self.service.change(False)
        atomic(self.gateway_root / 'settings.json', settings)
        self.service.change(True)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if all(self.health().values()):
                return
            time.sleep(1)
        raise RuntimeError('Speech models did not pass their readiness check')

    def resume(self):
        # The helper starts automatically; JosiVoice is demand-start. Disabled
        # voice therefore stays disabled across reboots without CHANGE_CONFIG.
        if self.state['enabled']:
            self.start('restart', {})

    def start(self, operation, body):
        if operation not in ('install', 'restart', 'uninstall', 'rollback', 'settings'):
            raise ValueError('Voice runtime updates are part of the Josi installer')
        if operation == 'settings':
            body = validate(body)
            if body['device'] != 'cpu':
                raise ValueError('This installation supports CPU speech only')
        elif body != {}:
            raise ValueError('This operation accepts no parameters')
        if not self.lock.acquire(blocking=False):
            raise ValueError('A voice operation is already running')
        try:
            if operation == 'rollback' and not self.state.get('previous'):
                raise ValueError('No previous speech settings are available')
            if operation in ('settings', 'rollback') and not self.state['verified']:
                raise ValueError('Enable and verify Voice Box first')
            old = dict(self.state)
            self.state.update(phase='working', error=None)
            self.save()
            threading.Thread(target=self.perform, args=(operation, body, old), daemon=True).start()
        except Exception:
            self.lock.release()
            raise

    def perform(self, operation, body, old):
        try:
            if operation == 'uninstall':
                # Persist disablement before stopping, so a power failure cannot
                # silently re-enable speech at the next helper start.
                self.state.update(enabled=False)
                self.save()
                self.service.change(False)
                self.state.update(phase='absent', verified=False, current=None)
            else:
                settings = (body if operation == 'settings' else
                            old['previous'] if operation == 'rollback' else old['settings'])
                settings = validate(settings)
                if settings['device'] != 'cpu':
                    raise ValueError('This installation supports CPU speech only')
                self.activate(settings)
                self.state.update(phase='ready', enabled=True, verified=True,
                                  current=self.version, settings=settings)
                if operation in ('settings', 'rollback'):
                    self.state['previous'] = old['settings']
        except Exception:
            recovered = False
            try:
                if old['enabled']:
                    self.activate(old['settings'])
                    recovered = True
                else:
                    self.service.change(False)
                    atomic(self.gateway_root / 'settings.json', old['settings'])
            except Exception:
                pass
            self.state = {**old, 'phase': 'ready' if recovered else 'failed',
                          'verified': recovered, 'error': 'Voice changes failed. Previous settings were retained; retry or repair Josi.'}
        finally:
            try:
                self.save()
            finally:
                self.lock.release()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def dispatch(self):
        try:
            manager = self.server.manager
            credentials = self.headers.get_all('Authorization', [])
            if len(credentials) != 1 or not hmac.compare_digest(credentials[0], 'Bearer ' + manager.token):
                self.reply(401, b'{"error":"Unauthorized"}')
                return
            lengths = self.headers.get_all('Content-Length', [])
            if self.headers.get('Transfer-Encoding') or len(lengths) > 1:
                raise ValueError('Ambiguous framing')
            length = int(lengths[0]) if lengths else 0
            if not 0 <= length <= 100000:
                raise ValueError('Request is too large')
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete request')
            body = json.loads(raw) if raw else {}
            if not isinstance(body, dict):
                raise ValueError('Invalid request')
            if self.command == 'GET' and self.path == '/status' and length == 0:
                self.reply(200, json.dumps(manager.status()).encode())
            elif self.command == 'POST' and self.path.startswith('/operation/'):
                manager.start(self.path.removeprefix('/operation/'), body)
                self.reply(200, b'{"accepted":true}')
            elif self.command == 'POST' and self.path in ('/session', '/audio', '/close', '/speech'):
                if not manager.state['verified'] or manager.state['phase'] != 'ready':
                    raise ValueError('Voice is not ready')
                code, content_type, data = manager.gateway('POST', self.path, body)
                self.reply(code, data, content_type)
            else:
                self.reply(404, b'{"error":"Unknown operation"}')
        except (ValueError, KeyError, TypeError):
            self.reply(400, b'{"error":"Voice request refused. Check its status and settings."}')
        except Exception:
            self.reply(503, b'{"error":"Voice Box is unavailable"}')

    def reply(self, status, data, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)


class Server(BoundedRequests, socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = False


if __name__ == '__main__':
    manager = Manager(os.environ['JOSI_VOICE_HELPER_STATE_DIR'], os.environ['JOSI_VOICE_STATE_DIR'],
                      os.environ['JOSI_VOICE_HELPER_TOKEN_FILE'], int(os.environ.get('JOSI_VOICE_PORT', '18081')),
                      os.environ['JOSI_VERSION'])
    port = int(os.environ.get('JOSI_VOICE_HELPER_PORT', '18082'))
    if not 1024 <= port <= 65535 or port == manager.port:
        raise ValueError('Invalid private voice control port')
    with Server(('127.0.0.1', port), Handler) as server:
        server.manager = manager
        manager.resume()
        server.serve_forever()
