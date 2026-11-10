#!/usr/bin/env python3
"""Root-only entry point for the headless Josi server install on Linux.

    josi-ce-server-install [answers]  install, repair, reconfigure or rerun; print the browser URL
    josi-ce-server-install --upgrade  run by the web updater after a newer package
    josi-ce-server-install --recover  roll back an interrupted upgrade and start Josi again
    josi-ce-server-install --interactive-uid N   older callers (the graphical setup)

The answers (the one-command installer asks for them, or passes its own flags):

    --address-mode lan|domain|proxy   how people reach Josi
    --lan-address HOST                lan: this server's address (default: detected)
    --domain NAME --email ADDRESS     domain: HTTPS from the bundled Caddy on 80 and 443
    --public-url https://HOST         proxy: the address of your own reverse proxy
    --port N                          the browser port (default 8080)
    --pc-control-user USER | --no-pc-control

Anything not given keeps the saved answer in /etc/josi/install.json, or the
default. The one-command installer (`curl ... | sudo bash`) runs the first
form. It prints exactly one line on success: the address to open in a
browser. Before setup is finished that address carries a one-use, ten-minute
handoff, because the setup page refuses anyone who does not hold one;
rerunning the same install command prints a fresh one.
"""
import fcntl
import http.cookiejar
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

LIB = Path('/usr/lib/josi')
PYTHON = LIB / 'runtime/python/bin/python3.12'
LIFECYCLE = LIB / 'runtime/app/native/lifecycle.py'
MAINTENANCE = LIB / 'runtime/app/native/maintenance.py'
UPDATER = LIB / 'josi_update.py'
ROOT = Path('/var/lib/josi')
LEGACY_ROOT = Path('/var/lib/josi-ce-server')
CONFIG = Path('/etc/josi')
SETTINGS = CONFIG / 'install.json'
UNITS = Path('/etc/systemd/system')
ROLES = ('database', 'voice', 'voice-control', 'web', 'worker', 'proxy')
CHILDREN = ' '.join('josi-ce-' + role + '.service' for role in ROLES)
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}

# The parent unit. It does no work itself: starting it starts the six isolated
# services (Wants), and stopping or restarting it reaches them (each is PartOf
# josi.service). Each child restarts itself after a crash.
PARENT = f"""[Unit]
Description=Josi server
Wants={CHILDREN}
After={CHILDREN}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true

[Install]
WantedBy=multi-user.target
"""

# The web updater. The web service may only drop a small request file in its
# own state folder; root reads it, checks the release feed named in
# /etc/josi/update.json and verifies the package checksum before installing.
UPDATE_UNITS = {
    'josi-update.path': """[Unit]
Description=Josi web updater request

[Path]
PathExists=/var/lib/josi/data/state/update-request
Unit=josi-update.service

[Install]
WantedBy=multi-user.target
""",
    'josi-update.service': f"""[Unit]
Description=Josi web updater
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I -B {UPDATER} request
TimeoutStartSec=3600
""",
    'josi-update-check.service': f"""[Unit]
Description=Josi update check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I -B {UPDATER} check
TimeoutStartSec=120
""",
    'josi-update.timer': """[Unit]
Description=Josi update check, twice a day

[Timer]
OnBootSec=3min
OnUnitActiveSec=12h
RandomizedDelaySec=20min
Unit=josi-update-check.service

[Install]
WantedBy=timers.target
""",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


LEGACY_MESSAGE = f"""an earlier Josi CE Server from before the rename is on this machine
({LEGACY_ROOT}). Its services and accounts have the same names as this one's,
so it has to go first. To delete it and its data, as root:

  systemctl disable --now josi-ce-database josi-ce-voice josi-ce-voice-control josi-ce-web josi-ce-worker josi-ce-proxy
  rm -f /etc/systemd/system/josi-ce-*.service; systemctl daemon-reload
  for a in database voice control web worker proxy; do userdel josi-ce-$a; groupdel josi-ce-$a; done
  groupdel josi-ce-app; groupdel josi-ce-voice-shared
  rm -rf {LEGACY_ROOT}

Then run the install command again. To keep its chats, make a backup in its
Administration > Backups first and restore it during the new setup."""

FLAGS = {'--address-mode': 'addressMode', '--lan-address': 'lanAddress', '--domain': 'domain',
         '--email': 'email', '--public-url': 'publicUrl', '--port': 'port', '--pc-control-user': 'pcControlUser'}


def fail(message):
    print(f'Josi installer: {message}', file=sys.stderr)
    raise SystemExit(1)


def lifecycle_module():
    """The validation rules of lifecycle.py, shared so both sides agree."""
    path = LIFECYCLE if LIFECYCLE.is_file() else Path(__file__).resolve().with_name('lifecycle.py')
    spec = importlib.util.spec_from_file_location('josi_lifecycle', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse(argv):
    """Returns (mode, uid, answers). mode is install, upgrade or recover."""
    args = argv[1:]
    if args == ['--upgrade']:
        return 'upgrade', 0, {}
    if args == ['--recover']:
        return 'recover', 0, {}
    sudo = os.environ.get('SUDO_UID', '')
    uid = int(sudo) if sudo.isascii() and sudo.isdecimal() and int(sudo) >= 1000 else 0
    answers, index = {}, 0
    while index < len(args):
        name, value = args[index], None
        if '=' in name and name.startswith('--'):
            name, value = name.split('=', 1)
        if name in ('--yes', '-y'):
            index += 1; continue  # this command never asks; accepted for symmetry
        if name == '--no-pc-control' and value is None:
            answers['pcControlUser'] = None; index += 1; continue
        if name not in FLAGS and name != '--interactive-uid':
            fail(f'unknown option {name[:40]}; see the top of {__file__}')
        if value is None:
            if index + 1 >= len(args):
                fail(f'{name} needs a value')
            value, index = args[index + 1], index + 2
        else:
            index += 1
        if name == '--interactive-uid':
            if not (value.isascii() and value.isdecimal()) or int(value) < 1000:
                fail('run the one-command installer from a normal user account')
            uid = int(value)
        elif name == '--port':
            if not (value.isascii() and value.isdecimal()):
                fail('--port needs a number')
            answers['port'] = int(value)
        else:
            answers[FLAGS[name]] = value
    return 'install', uid, answers


def resolve_settings(answers, current, lifecycle=None):
    """Flags over the saved answers over the defaults, validated."""
    lifecycle = lifecycle or lifecycle_module()
    try:
        saved = lifecycle.load_settings(SETTINGS) if SETTINGS.exists() else None
    except (OSError, ValueError) as error:
        fail(f'{SETTINGS} is not valid ({error}); fix it or delete it and run this again')
    base = dict(saved) if saved else {'addressMode': 'lan', 'lanAddress': primary_ip(),
        'port': current.get('publicPort') if isinstance(current.get('publicPort'), int) else 8080}
    base.update(answers)
    if base.get('addressMode') == 'lan' and not base.get('lanAddress'):
        base['lanAddress'] = primary_ip()
    try:
        settings = lifecycle.normalize_settings(base)
    except ValueError as error:
        fail(str(error).lower())
    if settings['pcControlUser']:
        try:
            lifecycle.pc_account(settings['pcControlUser'])
        except KeyError:
            fail(f"there is no Linux user {settings['pcControlUser']} for PC control")
        except ValueError as error:
            fail(str(error))
        if not (LIB / 'runtime' / lifecycle.PC_EXECUTOR).is_file() and LIB.exists():
            fail('this Josi version has no PC control yet; run again with --no-pc-control')
    josi_port = current.get('publicPort') if current.get('installed') is True else None
    if settings['port'] != josi_port and not lifecycle.port_is_free(settings['port']):
        if 'port' in answers:
            fail(f"port {settings['port']} is in use by another program; choose another with --port")
        port = next((p for p in range(settings['port'] + 1, 65536) if lifecycle.port_is_free(p)), None)
        if port is None:
            fail('no free port for Josi')
        settings = lifecycle.normalize_settings({**settings, 'port': port})
    if settings['addressMode'] == 'domain' and (saved or {}).get('addressMode') != 'domain':
        busy = [str(p) for p in (80, 443) if not lifecycle.port_is_free(p)]
        if busy:
            fail(f"port {' and '.join(busy)} is in use by another program; the bundled Caddy needs 80 and 443 "
                 'for the certificate. Stop that program, or choose --address-mode proxy')
    return settings


def save_settings(settings):
    CONFIG.mkdir(mode=0o755, exist_ok=True)
    os.chmod(CONFIG, 0o755)
    write_if_changed(SETTINGS, json.dumps(settings, indent=2, sort_keys=True) + '\n', 0o644)


def status():
    try:
        return json.loads((ROOT / 'status.json').read_text())
    except (OSError, ValueError):
        return {}


def package_version():
    return json.loads((LIB / 'runtime/app/package.json').read_text())['version']


def run_lifecycle(*command):
    process = subprocess.Popen(
        [str(PYTHON), '-I', '-B', str(LIFECYCLE), *[str(value) for value in command]],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=ENV,
    )
    for line in process.stdout:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get('error'):
            detail = event.get('component') or event.get('cause') or event['error']
            print(f"Stopped: {detail}", file=sys.stderr)
    if process.wait() != 0:
        fail('installation failed; your data and the recovery record were kept in /var/lib/josi')


def transactions():
    """(folder name, phases, identity) of every upgrade record, oldest first."""
    found = []
    folder = ROOT / 'transactions'
    if not folder.is_dir():
        return found
    for path in sorted(folder.iterdir()):
        records = sorted(path.glob('[0-9][0-9][0-9][0-9].json')) if path.is_dir() and not path.is_symlink() else []
        if not records or not re.fullmatch(r'[a-f0-9]{32}', path.name):
            continue
        try:
            values = [json.loads(record.read_text()) for record in records]
            found.append((path.name, [value['phase'] for value in values], values[-1]['identity']))
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return found


def lifecycle_busy():
    """True while another install, update or recovery holds the lifecycle lock."""
    try:
        descriptor = os.open(ROOT / 'lifecycle.lock', os.O_RDWR | os.O_NOFOLLOW)
    except OSError:
        return False
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        return False
    except OSError:
        return True
    finally:
        os.close(descriptor)


def recover_upgrades():
    """Put back the snapshot of an upgrade that stopped before the new version
    was activated (a failed migration, Ctrl-C, a dropped SSH session), so the
    previous version runs again with its data. Returns how many were rolled back."""
    if lifecycle_busy():
        fail('another Josi install or update is still running; wait for it to finish and run this again')
    count = 0
    for name, phases, identity in transactions():
        if phases[-1] in ('committed', 'rolled-back') or not isinstance(identity, dict) or not identity.get('from') \
                or 'activating' in phases:
            continue  # a fresh install or an activated one: the install itself settles those
        result = subprocess.run([str(PYTHON), '-I', '-B', str(MAINTENANCE), 'recover', name], env=ENV,
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=3600)
        if result.returncode:
            cause = ''
            for line in result.stdout.splitlines():
                try:
                    cause = json.loads(line).get('cause') or cause
                except (ValueError, AttributeError):
                    pass
            fail(f'the interrupted update to {identity.get("to")} could not be rolled back: {cause[:300]}; '
                 f'its snapshot is kept in /var/lib/josi/transactions/{name}')
        print(f'Rolled back the interrupted update to {identity.get("to")}', file=sys.stderr)
        count += 1
    return count


def write_if_changed(path, text, mode=0o644):
    path = Path(path)
    if path.is_symlink():
        path.unlink()
    if path.exists() and path.read_text() == text:
        return
    temporary = path.with_name('.' + path.name + '.josi-new')
    temporary.write_text(text)
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def configure():
    """josi.service, the updater units and /etc/josi. Safe to repeat."""
    for name, text in [('josi.service', PARENT), *UPDATE_UNITS.items()]:
        write_if_changed(UNITS / name, text)
    CONFIG.mkdir(mode=0o755, exist_ok=True)
    os.chmod(CONFIG, 0o755)
    # Josi's services read their settings from the data folder, where their
    # sandbox lets them; /etc/josi links to that file so an administrator
    # finds it in the usual place.
    link = CONFIG / 'runtime.json'
    if not link.is_symlink():
        if link.exists():
            link.unlink()
        link.symlink_to(ROOT / 'data/config/runtime.json')
    defaults = LIB / 'update-defaults.json'
    if not (CONFIG / 'update.json').exists() and defaults.is_file():
        write_if_changed(CONFIG / 'update.json', defaults.read_text())
    readme = LIB / 'etc-README.txt'
    if readme.is_file():
        write_if_changed(CONFIG / 'README', readme.read_text())
    subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True, env=ENV)
    subprocess.run(['/usr/bin/systemctl', 'enable', '--now', 'josi.service', 'josi-update.path', 'josi-update.timer'],
        check=True, env=ENV, capture_output=True)


def primary_ip():
    try:
        result = subprocess.run(['/usr/bin/ip', '-json', 'route', 'get', '1.1.1.1'], check=True,
            capture_output=True, text=True, timeout=5)
        address = json.loads(result.stdout)[0].get('prefsrc', '')
        parsed = ipaddress.ip_address(address)
        if parsed.version == 4 and not (parsed.is_loopback or parsed.is_link_local):
            return address
    except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError, json.JSONDecodeError):
        pass
    return '127.0.0.1'


def browser_target(port, app_url, bootstrap):
    """app_url is the chosen address (http://<lan>:<port>, https://<domain>
    or the own proxy's https address); the handoff is made over loopback."""
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
            try:
                value = json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                fail('browser handoff response is invalid')
            if not isinstance(value, dict):
                fail('browser handoff response is invalid')
            return value
    state = request('/api/onboarding/state')
    target = app_url.rstrip('/') + '/'
    if state.get('completed') is True:
        return target
    csrf = request('/api/auth/csrf').get('csrfToken')
    if not isinstance(csrf, str) or not csrf or len(csrf) > 256:
        fail('browser handoff CSRF response is invalid')
    token = request('/api/onboarding/launch', 'POST', {'Content-Type': 'application/json',
        'x-josi-csrf': csrf, 'x-josi-setup-token': bootstrap}).get('token')
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token):
        fail('browser handoff token is invalid')
    return target + 'setup#handoff=' + token


def wait_ready(port, seconds=240):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/ready', timeout=3) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(2)
    fail('Josi did not become ready; see: journalctl -u "josi-ce-*"')


def main():
    if os.geteuid() != 0:
        fail('run it as root: with sudo, or from a root shell')
    mode, uid, answers = parse(sys.argv)
    if mode == 'recover':
        recover_upgrades()
        subprocess.run(['/usr/bin/systemctl', 'start', 'josi.service'], env=ENV, capture_output=True, timeout=300)
        if (UNITS / 'josi-pc.service').exists():
            subprocess.run(['/usr/bin/systemctl', 'start', 'josi-pc.service'], env=ENV, capture_output=True, timeout=120)
        return
    if LEGACY_ROOT.exists() and not (ROOT / 'installation.json').exists():
        fail(LEGACY_MESSAGE)
    version, current = package_version(), status()
    settings = resolve_settings(answers, current)
    # An update that stopped half-way (a failed migration, Ctrl-C, a dropped
    # SSH session) is rolled back to its snapshot before anything else.
    recover_upgrades()
    current = status()
    save_settings(settings)
    if current.get('installed') is True and current.get('version') == version:
        pass  # The install command again: nothing to install; apply the answers, print a fresh address.
    elif current.get('installed') is False and current.get('version') == version:
        run_lifecycle('repair', uid)  # The same version back over data an uninstall kept.
    else:
        run_lifecycle('install', uid)  # A fresh install, or an upgrade.
    run_lifecycle('configure')
    configure()
    current = status()
    if current.get('installed') is not True or current.get('version') != version:
        fail('installed status is inconsistent')
    port = current['publicPort']
    wait_ready(port)
    if mode == 'upgrade':
        print(json.dumps({'installed': True, 'version': version}))
        return
    bootstrap = (ROOT / 'data/secrets/bootstrap/browser-token').read_text().strip()
    print(browser_target(port, settings['appUrl'], bootstrap))


if __name__ == '__main__':
    main()
