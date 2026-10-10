#!/usr/bin/env python3
"""Root-only CLI entry point for the complete native Linux server install."""
import http.cookiejar
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

PYTHON = Path('/usr/lib/josi-ce-server-setup/runtime/python/bin/python3.12')
LIFECYCLE = Path('/usr/lib/josi-ce-server-setup/runtime/app/native/lifecycle.py')
ROOT = Path('/var/lib/josi-ce-server')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def fail(message):
    print(f'Josi installer: {message}', file=sys.stderr)
    raise SystemExit(1)


def parse_uid(argv):
    if len(argv) != 3 or argv[1] != '--interactive-uid' or not argv[2].isascii() or not argv[2].isdecimal():
        fail('internal invocation is invalid')
    uid = int(argv[2])
    if uid < 1000:
        fail('run the one-command installer from a normal user account')
    return uid


def run_install(uid):
    process = subprocess.Popen(
        [str(PYTHON), '-I', '-B', str(LIFECYCLE), 'install', str(uid)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8','LC_ALL':'C.UTF-8'},
    )
    for line in process.stdout:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get('error'):
            print(f"Stopped: {event.get('component') or event['error']} failed", file=sys.stderr)
        elif event.get('phase'):
            service = f" ({event['service']})" if event.get('service') else ''
            print(f"{event['phase']}{service}", flush=True)
    if process.wait() != 0:
        fail('installation failed; protected recovery evidence was retained')


def primary_ip():
    try:
        result = subprocess.run(['/usr/bin/ip','-json','route','get','1.1.1.1'], check=True,
            capture_output=True, text=True, timeout=5)
        address = json.loads(result.stdout)[0].get('prefsrc','')
        parsed = ipaddress.ip_address(address)
        if parsed.version == 4 and not (parsed.is_loopback or parsed.is_link_local):
            return address
    except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError, json.JSONDecodeError):
        pass
    return '127.0.0.1'


def browser_target(port, address, bootstrap):
    if not re.fullmatch(r'[a-f0-9]{64}', bootstrap):
        fail('browser handoff secret is invalid')
    origin = f'http://127.0.0.1:{port}'
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect())
    def request(path, method='GET', headers=None):
        value = urllib.request.Request(origin + path, data=b'{}' if method == 'POST' else None,
            method=method, headers=headers or {})
        with opener.open(value, timeout=10) as response:
            body = response.read(8193)
            if response.status != 200 or len(body) > 8192:
                fail('browser handoff response is invalid')
            return json.loads(body)
    state = request('/api/onboarding/state')
    target = f'http://{address}:{port}/'
    if state.get('completed') is True:
        return target
    csrf = request('/api/auth/csrf').get('csrfToken')
    if not isinstance(csrf, str) or not csrf or len(csrf) > 256:
        fail('browser handoff CSRF response is invalid')
    token = request('/api/onboarding/launch', 'POST', {'Content-Type':'application/json',
        'x-josi-csrf':csrf, 'x-josi-setup-token':bootstrap}).get('token')
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token):
        fail('browser handoff token is invalid')
    return target + 'setup#handoff=' + token


def main():
    if os.geteuid() != 0:
        fail('administrator authorization is required')
    uid = parse_uid(sys.argv)
    print('Installing Josi CE Server. This can take several minutes.', flush=True)
    run_install(uid)
    status = json.loads((ROOT/'status.json').read_text())
    handoff = json.loads((ROOT/'handoff'/str(uid)/'bootstrap.json').read_text())
    if status.get('installed') is not True or status.get('publicPort') != handoff.get('port'):
        fail('installed status is inconsistent')
    url = browser_target(status['publicPort'], primary_ip(), handoff.get('token',''))
    print('\nJosi CE Server is ready.')
    print('Open this URL to finish setup:')
    print(url)


if __name__ == '__main__':
    main()
