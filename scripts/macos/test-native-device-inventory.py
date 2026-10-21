"""Compile the actual native model/views and test against disposable HTTP fixtures."""
import http.server
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time

repo = Path(__file__).resolve().parents[2]
scratch = Path(tempfile.mkdtemp(prefix='josi-native19-inventory-', dir='/private/tmp'))
owner = '11111111-1111-4111-8111-111111111111'
device = {'enrollmentId': '22222222-2222-4222-8222-222222222222', 'label': 'MBP', 'revokedAt': None,
          'identity': {'userId': owner, 'serverId': '33333333-3333-4333-8333-333333333333',
                       'deviceId': '44444444-4444-4444-8444-444444444444'}}
saved = {'reference': {'recordId': '914a736a-94bf-46f2-a602-82ff4180c45d', 'version': 1, 'epoch': 2, 'digest': 'a' * 64},
         'authorityEpoch': 2, 'reconciliationRequired': False, 'devices': [device]}
empty = {'reference': None, 'authorityEpoch': 1, 'reconciliationRequired': False, 'devices': []}

class Fixture(http.server.BaseHTTPRequestHandler):
    count = 0
    def log_message(self, *_): pass
    def do_GET(self):
        status, body = 200, {}
        if self.path == '/api/auth/csrf': body = {'csrfToken': 'disposable-native-fixture'}
        elif self.path == '/api/onboarding/state': body = {'completed': True}
        elif self.path == '/api/admin/automation/devices':
            Fixture.count += 1
            count = Fixture.count
            if count == 2: body = {'unexpected': 'not a device inventory'}
            elif count == 4:
                time.sleep(0.3)
                body = empty
            elif count == 6: status, body = 423, {'error': 'Fixture Vault locked'}
            else: body = saved
        elif self.path == '/api/admin/automation': status, body = 503, {'error': 'Unrelated settings unavailable'}
        elif self.path == '/api/admin/automation/storage': body = {'workspaces': []}
        elif self.path == '/api/assistant/automation/workspaces': body = {'workspaces': []}
        else: status = 404
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
origin = f'http://127.0.0.1:{server.server_port}'
device['identity']['serverOrigin'] = origin
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    source = repo / 'apps/macos-native/Sources'
    app = scratch / 'JosiApp.swift'
    app.write_text((source / 'JosiApp.swift').read_text().replace('@main struct JosiNativeApp', 'struct JosiNativeApp'))
    command = ['xcrun', 'swiftc', '-swift-version', '6', '-parse-as-library', '-target', 'arm64-apple-macos14.2',
               '-module-cache-path', str(scratch / 'module-cache'), '-o', str(scratch / 'check'),
               *[str(p) for p in sorted(source.glob('*.swift')) if p.name != 'JosiApp.swift'], str(app),
               str(repo / 'packaging/macos/NativeAuthorization.swift'),
               str(repo / 'apps/automation-macos/Sources/WorkspaceMachine.swift'),
               str(repo / 'apps/automation-macos/Sources/GuestLinkWire.swift'),
               str(repo / 'scripts/macos/test-native-device-inventory.swift')]
    subprocess.run(command, check=True, timeout=300)
    subprocess.run([str(scratch / 'check'), origin, str(scratch / 'enrolled-mac.png')], check=True, timeout=40)
    print(json.dumps({'nativeInventory': 'passed', 'evidence': str(scratch)}), flush=True)
finally:
    server.shutdown()
    server.server_close()
